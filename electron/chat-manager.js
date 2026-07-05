'use strict';
const { WebContentsView } = require('electron');
const { WebSocketServer } = require('ws');

// ── Injection source ──────────────────────────────────────────────────────────
// Built per-platform so CFG and PLATFORM are baked in at create time.
// Injected via CDP Runtime.addScriptToEvaluateOnNewDocument — runs before ANY
// page JS, on every navigation, including SPA soft-navigations that replace DOM.
function makeInjection(selectors, platformId) {
  return `(function () {
  'use strict';
  var CFG      = ${JSON.stringify(selectors)};
  var PLATFORM = ${JSON.stringify(platformId)};

  // Tracks message IDs already emitted so we never duplicate.
  var seen = new Set();

  function emit(id, username, text) {
    if (!text || !text.trim()) return;
    console.log('__CHAT__' + JSON.stringify({
      platform:  PLATFORM,
      type:      'chat',
      username:  (username || '').trim(),
      text:      text.trim(),
      timestamp: Date.now(),
    }));
    if (id) seen.add(id);
  }

  function processMessage(el) {
    var id = el.getAttribute('data-message-id') || null;
    if (id && seen.has(id)) return;  // already emitted

    var userEl   = CFG.username ? el.querySelector(CFG.username) : null;
    var textEl   = CFG.text     ? el.querySelector(CFG.text)     : null;
    var username = userEl ? userEl.textContent.trim() : '';
    var text     = textEl ? textEl.textContent.trim() : el.textContent.trim();
    // When falling back to el.textContent the username prefix is included — strip it.
    if (username && text.toLowerCase().startsWith(username.toLowerCase())) {
      text = text.slice(username.length).replace(/^[\s:]+/, '');
    }
    emit(id, username, text);
  }

  // Every 5 s: scan all message nodes, emit any we haven't seen yet.
  function poll() {
    var msgSel = CFG.message || '[data-message-id]';
    // Try the scoped container first; fall back to full document.
    var root = (CFG.container && document.querySelector(CFG.container)) || document;
    var nodes = Array.from(root.querySelectorAll(msgSel));
    if (nodes.length === 0) return;
    if (!root.__tmtLogged) {
      root.__tmtLogged = true;
      console.log('__CHAT_LOG__poll found container for ' + PLATFORM + ' (' + nodes.length + ' msgs)');
    }
    for (var i = 0; i < nodes.length; i++) processMessage(nodes[i]);
  }

  setInterval(poll, 5000);
  // Also run once after 2 s to catch messages already on screen at page-load.
  setTimeout(poll, 2000);
})();`;
}

// ── ChatManager ───────────────────────────────────────────────────────────────
class ChatManager {
  constructor({ mainWindow, onEvent, onLog }) {
    this.mainWindow = mainWindow;
    this.onEvent    = onEvent || (() => {});
    this.onLog      = onLog   || (msg => console.log('[chat]', msg));
    this.views      = new Map();   // platform.id → WebContentsView
    this.wsClients  = new Set();
    this.wss        = null;
  }

  start(config) {
    this._startWsServer(config.wsPort || 8765);
    for (const p of (config.platforms || [])) {
      if (p.enabled) this._createView(p);
    }
  }

  // ── Local WebSocket server (OBS overlay connects here) ────────────────────
  _startWsServer(port) {
    try {
      this.wss = new WebSocketServer({ port });
    } catch (e) {
      this.onLog('WS server failed to start on port ' + port + ': ' + e.message);
      return;
    }
    this.wss.on('connection', ws => {
      this.wsClients.add(ws);
      ws.on('close', () => this.wsClients.delete(ws));
      ws.on('error', () => this.wsClients.delete(ws));
      try { ws.send(JSON.stringify({ type: 'connected', platform: 'system', timestamp: Date.now() })); } catch {}
    });
    this.wss.on('error', e => this.onLog('WS server error: ' + e.message));
    this.onLog('WS overlay server → ws://localhost:' + port);
  }

  _broadcast(event) {
    const json = JSON.stringify(event);
    for (const ws of this.wsClients) {
      try { ws.send(json); } catch {}
    }
  }

  // ── Per-platform hidden view ──────────────────────────────────────────────
  _createView(platform) {
    const view = new WebContentsView({
      webPreferences: {
        partition:            platform.partition,
        backgroundThrottling: false,
        contextIsolation:     true,
        nodeIntegration:      false,
      },
    });

    // Hidden background view — 800×600 so Stripchat's SPA fully renders the
    // chat container (intersection-observer / viewport-based lazy rendering
    // will never fire in a 1×1 view).  setVisible(false) keeps it invisible.
    view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
    view.setVisible(false);
    this.mainWindow.contentView.addChildView(view);
    this.views.set(platform.id, view);

    // Attach CDP and inject the MutationObserver before any page code runs
    try {
      view.webContents.debugger.attach('1.3');
      view.webContents.debugger.sendCommand('Page.enable');
      view.webContents.debugger.sendCommand('Runtime.addScriptToEvaluateOnNewDocument', {
        source: makeInjection(platform.selectors || {}, platform.id),
      });
      this.onLog(platform.id + ': CDP attached, loading ' + platform.roomUrl);
    } catch (e) {
      this.onLog(platform.id + ': CDP attach failed — ' + e.message);
    }

    // Receive chat events and diagnostic logs from the injected script
    view.webContents.on('console-message', (_e, _level, message) => {
      if (message.startsWith('__CHAT_LOG__')) {
        this.onLog(message.slice(12));
        return;
      }
      if (!message.startsWith('__CHAT__')) return;
      try {
        const event = JSON.parse(message.slice(8));
        this._broadcast(event);
        this.onEvent(event);
      } catch {}
    });

    // Keep the view on the room URL — if Stripchat navigates away (login redirect,
    // session expiry, etc.) snap it back so chat capture never stops.
    view.webContents.on('did-navigate', (_e, url) => {
      if (!url.startsWith(platform.roomUrl)) {
        this.onLog(platform.id + ': strayed to ' + url + ' — returning to room');
        setTimeout(() => view.webContents.loadURL(platform.roomUrl), 1500);
      }
    });

    // Recover from renderer crashes / kills
    view.webContents.on('render-process-gone', () => {
      this.onLog(platform.id + ': renderer gone — reloading');
      setTimeout(() => view.webContents.loadURL(platform.roomUrl), 3000);
    });

    view.webContents.loadURL(platform.roomUrl);
  }

  // Returns the WebContentsView for a platform (for external JS execution)
  getView(platformId) {
    return this.views.get(platformId) || null;
  }

  // Forward a chat event through both the WS broadcast and the IPC callback.
  emitEvent(event) {
    this._broadcast(event);
    this.onEvent(event);
  }

  stop() {
    try { this.wss?.close(); } catch {}
    for (const view of this.views.values()) {
      try { view.webContents.debugger.detach(); } catch {}
    }
  }
}

ChatManager.makeInjection = makeInjection;
module.exports = ChatManager;
