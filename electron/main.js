'use strict';
const { app, BrowserWindow, ipcMain, safeStorage, session, WebContentsView, shell, dialog } = require('electron');
const path       = require('path');
const fs         = require('fs');
const https      = require('https');
const { execSync } = require('child_process');
const obsMan      = require('./obs-manager');
const ChatManager = require('./chat-manager');
const chatConfig  = require('./chat-config');
const cookieSync  = require('./cookie-sync');
const logger      = require('./logger');
const { ToyManager, parseTipText } = require('./toy-manager');
const { createEventsPoller } = require('./events-poller');
const { friendlyStreamError } = require('./friendly-errors');

// ── Safety nets ───────────────────────────────────────────────────────────────
// A second copy of the app would kill the first one's OBS (killStaleObs) and drop
// a live stream — so only one instance may run; a second launch just focuses the first.
if (!process.env.TMT_ALLOW_MULTI && !app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.on('second-instance', () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});
// Never let a stray exception pop Electron's blocking error dialog mid-stream.
process.on('uncaughtException',  e => { try { logger.error('uncaughtException',  { error: String((e && e.stack) || e) }); } catch {} console.error('[uncaught]', e); });
process.on('unhandledRejection', e => { try { logger.error('unhandledRejection', { error: String((e && e.stack) || e) }); } catch {} console.error('[unhandled]', e); });

// ── Config ────────────────────────────────────────────────────────────────────
const API_BASE           = process.env.API_BASE || 'https://admin.agencytmt.com';
const OBS_WS_PORT        = Number(process.env.OBS_WS_PORT) || 4455;
// Admin-gate + dashboard credentials load from a gitignored ./secrets.js (so
// they never enter source control), with env-var fallback. See secrets.example.js.
let _secrets = {};
try { _secrets = require('./secrets'); } catch {}
// Local admin gate for the in-app Admin overview (separate from any model login).
const ADMIN_USER         = _secrets.ADMIN_USER || process.env.ADMIN_USER || 'admin';
const ADMIN_PASS         = _secrets.ADMIN_PASS || process.env.ADMIN_PASS || '';
const STATUS_INTERVAL_MS = 3000;

// ── State ─────────────────────────────────────────────────────────────────────
let mainWindow         = null;
let obsClient          = null;
let obsConnected       = false;  // true only between a successful connect and the next close
let obsReconnectTimer  = null;   // single guarded reconnect timer (avoids stacked retries during OBS boot)
let adminSessionCookie = null;   // admin-console session cookie (admin overview / all-user logs)
let statusInterval     = null;
let storedToken        = null;
let streamPlatforms    = [];
let streamDestinations = [];
let lastTotalBytes     = 0;
let lastPollTime       = Date.now();
let scView             = null;
let scViewVisible      = false;
let scViewReady        = false;  // true after did-finish-load fires on the broadcast view
let lastMultiRtmpSig   = null;   // signature of the dest set last pushed to obs-multi-rtmp (avoids redundant, crash-prone reloads)
const TITLEBAR_H       = 30;
const SC_BAR_H         = 35;
// Returns the Stripchat broadcast-centre URL for the logged-in model,
// or null when destinations haven't loaded yet (before TMT login).
function getScRoomUrl() {
  const scDest = streamDestinations.find(d => d.username && d.name.toLowerCase() === 'stripchat');
  return scDest?.username ? `https://stripchat.com/${scDest.username}` : null;
}
function getCbRoomUrl() {
  const cbDest = streamDestinations.find(d => d.username && d.name.toLowerCase() === 'chaturbate');
  return cbDest?.username ? `https://chaturbate.com/${cbDest.username}/` : null;
}

// Stripchat paths that are NOT a model username (so we never mistake them for one).
const SC_RESERVED_PATHS = new Set([
  '', 'login', 'signin', 'signup', 'logout', 'start-broadcasting', 'my', 'security',
  'settings', 'account', 'cam', 'cams', 'girls', 'trans', 'couples', 'men', 'api',
  'payout', 'wallet', 'tags', 'categories', 'search', 'favorites', 'about', 'feed',
  'terms', 'privacy', 'support', 'help', 'studios', 'messages', 'notifications',
]);

// Extract a model username from a Stripchat room URL like
// https://stripchat.com/<username>. Returns null for reserved/non-room paths.
function extractScUsername(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.includes('stripchat.com')) return null;
    const seg = u.pathname.split('/').filter(Boolean);
    if (seg.length !== 1) return null;                       // only /<slug>, not /a/b
    const slug = seg[0];
    if (SC_RESERVED_PATHS.has(slug.toLowerCase())) return null;
    if (!/^[A-Za-z0-9_.-]{2,40}$/.test(slug)) return null;
    return slug;
  } catch { return null; }
}

// Persist an auto-detected Stripchat username so auto-start, chat, and the room
// URL work on any machine without the model typing it in. Stored alongside the
// manually-set username (dest-ext.json + in-memory + disk cache).
function persistScUsername(username) {
  const scDest = streamDestinations.find(d => d.name.toLowerCase() === 'stripchat');
  if (!scDest || !username) return false;
  if ((scDest.username || '').toLowerCase() === username.toLowerCase()) return false; // unchanged
  scDest.username = username;
  const ext = loadDestExtProps();
  if (!ext.props) ext.props = {};
  const key = String(scDest.id);
  if (!ext.props[key]) ext.props[key] = { eventsToken: scDest.eventsToken || '' };
  ext.props[key].username = username;
  saveDestExtProps(ext);
  saveDestCache(streamDestinations);
  logger.info('SC username auto-detected from session', { username });
  scLog(`[sc-view] auto-detected Stripchat username: ${username}`);
  return true;
}
let chatManager        = null;
let disabledDestIds    = new Set(); // ids of destinations turned off by the user
let cachedMicName      = null;      // resolved once on first OBS connect, reused for toggle
let scChatScript       = null;      // set in setupBroadcastView, reused by auto-fixer
let lastScChatEventMs  = 0;         // timestamp of last SC chat event (auto-fixer health check)
let chatFixInterval    = null;      // auto-fixer setInterval handle
let cbView             = null;
let cbViewVisible      = false;

function getActiveDestinations() {
  if (disabledDestIds.size === 0) return streamDestinations;
  return streamDestinations.filter(d => !disabledDestIds.has(String(d.id)));
}

// ── Startup status (sent to renderer to drive the progress bar) ───────────────
function sendStartupStatus(step, status, msg) {
  mainWindow?.webContents.send('startup-status', { step, status, msg });
}

// ── Auto-fixer: runs every 30s, recovers dead chat observer + off-domain SC view ─
function startAutoFixer() {
  stopAutoFixer();
  lastScChatEventMs = 0;
  chatFixInterval = setInterval(async () => {
   try {
    if (!scView || scView.webContents.isDestroyed() || !storedToken) return;
    const url = scView.webContents.getURL();
    // Guard 1: SC view drifted off stripchat.com → redirect back
    if (url && url.startsWith('http') && !url.includes('stripchat.com')) {
      const back = getScRoomUrl() || 'https://stripchat.com/start-broadcasting';
      logger.info('[auto-fix] SC view off-domain — redirecting', { from: url.slice(0, 80), to: back });
      sendStartupStatus('broadcast', 'loading', 'Reloading broadcast page…');
      scView.webContents.loadURL(back);
      return;
    }
    // Guard 2: chat observer dead (no events for >90s) → re-inject
    if (scChatScript && lastScChatEventMs > 0 && Date.now() - lastScChatEventMs > 90_000) {
      const staleSec = Math.round((Date.now() - lastScChatEventMs) / 1000);
      logger.info('[auto-fix] re-injecting SC chat observer', { staleSec });
      try {
        await scView.webContents.executeJavaScript('window.__tmtChatInjected = false;', true);
        await scView.webContents.executeJavaScript(scChatScript, true);
        scLog('[sc-chat] auto-fix: observer re-injected');
        lastScChatEventMs = 0;
        sendStartupStatus('chat', 'loading', 'Reconnecting chat…');
      } catch (e) {
        scLog('[sc-chat] auto-fix inject error: ' + e.message);
      }
    }
   } catch (e) {
    logger.warn('[auto-fix] tick failed', { error: e.message });
   }
  }, 30_000);
}

function stopAutoFixer() {
  if (chatFixInterval) { clearInterval(chatFixInterval); chatFixInterval = null; }
  lastScChatEventMs = 0;
}

// ── Destination storage ───────────────────────────────────────────────────────
// Cloud is the source of truth. destinations.json = offline cache.
// dest-ext.json = extended props not in cloud schema (username, eventsToken).
const destCachePath = () => path.join(app.getPath('userData'), 'destinations.json');
const destExtPath   = () => path.join(app.getPath('userData'), 'dest-ext.json');

function loadDestCache() {
  try {
    const raw    = fs.readFileSync(destCachePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function saveDestCache(destinations) {
  try { fs.writeFileSync(destCachePath(), JSON.stringify(destinations, null, 2), 'utf8'); }
  catch (err) { console.error('[dest cache]', err.message); }
}

function loadDestExtProps() {
  try {
    const raw    = fs.readFileSync(destExtPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : { migrated: false, props: {} };
  } catch { return { migrated: false, props: {} }; }
}

function saveDestExtProps(ext) {
  try { fs.writeFileSync(destExtPath(), JSON.stringify(ext, null, 2), 'utf8'); }
  catch (err) { console.error('[dest ext]', err.message); }
}

// Merge cloud destinations with local extended properties (username, eventsToken).
function mergeWithExt(cloudDests, ext) {
  return cloudDests.map(d => ({
    ...d,
    username:    ext.props?.[String(d.id)]?.username    || '',
    eventsToken: ext.props?.[String(d.id)]?.eventsToken || '',
  }));
}

// ── Token storage ─────────────────────────────────────────────────────────────
const tokenFilePath = () => path.join(app.getPath('userData'), 'session.enc');

function saveToken(token) {
  storedToken = token;
  try {
    const buf = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(token)
      : Buffer.from(token, 'utf8');
    fs.writeFileSync(tokenFilePath(), buf);
  } catch (err) { console.error('[token save]', err.message); }
}

function loadToken() {
  try {
    const raw = fs.readFileSync(tokenFilePath());
    storedToken = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8');
    return storedToken;
  } catch { return null; }
}

function clearToken() {
  storedToken = null;
  try { fs.unlinkSync(tokenFilePath()); } catch {}
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function apiFetch(method, endpoint, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res  = await fetch(`${API_BASE}${endpoint}`, {
      method,
      headers,
      body:   body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

// ── Cloud auth error handler ──────────────────────────────────────────────────
function handleCloudAuthError(code, message) {
  if (code === 401) {
    clearToken();
    streamDestinations = [];
    mainWindow?.webContents.send('desktop:auth-error', { code: 401, message: 'Session expired — please sign in again.' });
  } else if (code === 403) {
    mainWindow?.webContents.send('desktop:auth-error', { code: 403, message: message || 'Account access denied.' });
  }
}

// ── Cloud destinations API ────────────────────────────────────────────────────
async function cloudLoadDestinations(token) {
  const { status, data } = await apiFetch('GET', '/api/desktop/destinations', null, token);
  if (status === 401) { handleCloudAuthError(401); return null; }
  if (status === 403) { handleCloudAuthError(403, data.error); return null; }
  if (status !== 200) throw new Error(`GET /destinations: ${status}`);
  return data.destinations || [];
}

async function cloudAddDestination(token, { name, rtmpUrl, streamKey }) {
  const { status, data } = await apiFetch('POST', '/api/desktop/destinations', { name, rtmpUrl, streamKey }, token);
  if (status === 401) { handleCloudAuthError(401); return { ok: false, authError: true }; }
  if (status === 403) { handleCloudAuthError(403, data.error); return { ok: false, authError: true }; }
  if (status === 400) return { ok: false, error: data.error || 'Validation failed.' };
  if (status !== 201) return { ok: false, error: `Server error (${status})` };
  return { ok: true, destination: data.destination };
}

async function cloudDeleteDestination(token, id) {
  const { status, data } = await apiFetch('DELETE', `/api/desktop/destinations/${id}`, null, token);
  if (status === 401) { handleCloudAuthError(401); return { ok: false, authError: true }; }
  if (status === 403) { handleCloudAuthError(403, data.error); return { ok: false, authError: true }; }
  if (status === 404) return { ok: false, status: 404, error: 'Not found on server' };
  if (status !== 200) return { ok: false, error: `Server error (${status})` };
  return { ok: true };
}

// ── Migration: upload legacy local destinations to cloud (one-time) ───────────
async function migrateLocalToCloud(token, cloudDests, ext) {
  if (ext.migrated) return;

  // Cloud already has the model's own rows — no migration needed
  if (cloudDests.some(d => d.id !== null)) {
    ext.migrated = true;
    saveDestExtProps(ext);
    return;
  }

  // Legacy destinations.json used Date.now() as id (large timestamp > 1e10)
  let legacyDests = [];
  try {
    const raw    = fs.readFileSync(destCachePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.some(d => typeof d.id === 'number' && d.id > 1e10)) {
      legacyDests = parsed;
    }
  } catch {}

  if (legacyDests.length > 0) {
    console.log('[migrate] uploading', legacyDests.length, 'local destinations to cloud');
    if (!ext.props) ext.props = {};
    for (const d of legacyDests) {
      try {
        const r = await cloudAddDestination(token, {
          name: d.name, rtmpUrl: d.rtmpUrl, streamKey: d.streamKey || '',
        });
        if (r.ok && r.destination) {
          const cloudId = String(r.destination.id);
          ext.props[cloudId] = { username: d.username || '', eventsToken: d.eventsToken || '' };
          console.log('[migrate] uploaded:', d.name, '→ cloud id', cloudId);
        }
      } catch (err) {
        console.error('[migrate] failed for', d.name, ':', err.message);
      }
    }
  }

  ext.migrated = true;
  saveDestExtProps(ext);
}

// ── One-time firewall rule setup ──────────────────────────────────────────────
function ensureFirewallRule() {
  if (process.platform !== 'win32') return;
  try {
    const obsBin = obsMan.getObsBin(obsMan.getObsDir());
    if (!fs.existsSync(obsBin)) return;
    const ruleName = 'TMT Native - Streaming Engine';
    const existing = execSync(
      `netsh advfirewall firewall show rule name="${ruleName}"`,
      { stdio: 'pipe', timeout: 5000 }
    ).toString();
    if (existing.toLowerCase().includes('rule name')) return;
    execSync(
      `netsh advfirewall firewall add rule name="${ruleName}" dir=in action=allow program="${obsBin}" enable=yes`,
      { stdio: 'ignore', timeout: 5000 }
    );
    console.log('[firewall] rule added for obs engine');
  } catch {}
}

// ── Chaturbate Events API polling ─────────────────────────────────────────────
let eventsPoller          = null;
let viewerPollInterval    = null;
const viewerCounts = require('./viewer-counts').createViewerCounts(snap => mainWindow?.webContents.send('desktop:viewer-count', snap));

async function startEventsPolling() {
  if (eventsPoller?.isActive()) return;
  const dest = streamDestinations.find(
    d => d.eventsToken && d.username && d.name.toLowerCase() === 'chaturbate'
  );
  if (!dest) return;

  console.log('[events] starting for', dest.username);
  mainWindow?.webContents.send('desktop:chat-status', buildChatStatus());
  eventsPoller = createEventsPoller({
    baseUrl:   `https://eventsapi.chaturbate.com/events/${encodeURIComponent(dest.username)}/${encodeURIComponent(dest.eventsToken)}/?timeout=20`,
    fetchFn:   fetch,
    sleep:     ms => new Promise(r => setTimeout(r, ms)),
    isAllowed: () => !!storedToken,
    onEvent:   handleChaturbateEvent,
    notify:    msg => {
      logger.warn('[events] ' + msg);
      mainWindow?.webContents.send('desktop:chat-message', { type: 'system', platform: 'chaturbate', user: '', msg });
    },
  });
  await eventsPoller.run();
}

function handleChaturbateEvent(ev) {
  scLog(`[cb-event] ${ev.method}`);
  switch (ev.method) {
    case 'roomCount': {
      const n = ev.object?.count ?? ev.object?.num_users ?? ev.object?.viewers;
      if (n !== undefined && n !== null) {
        viewerCounts.set('Chaturbate', n);
        scLog(`[cb-viewers] ${n} viewers (event)`);
      }
      return;
    }
    case 'chatMessage': {
      const rawMsg  = ev.object?.message;
      const msgText = typeof rawMsg === 'string' ? rawMsg
        : (rawMsg?.message || rawMsg?.text || rawMsg?.body || '');
      const user = ev.object?.from_user?.username || ev.object?.user?.username || 'anon';
      mainWindow?.webContents.send('desktop:chat-message', {
        type: 'chat', platform: 'chaturbate',
        user,
        msg: msgText,
      });
      break;
    }
    case 'tip': {
      const user = ev.object?.from_user?.username || ev.object?.user?.username || 'anon';
      mainWindow?.webContents.send('desktop:chat-message', {
        type: 'tip', platform: 'chaturbate',
        user,
        msg:  `tipped ${ev.object?.tokens || ev.object?.tip?.tokens || '?'} tokens`,
      });
      noteTip('chaturbate', user, ev.object?.tokens || ev.object?.tip?.tokens);
      break;
    }
    case 'broadcastStart':
      mainWindow?.webContents.send('desktop:chat-message', { type: 'system', platform: 'chaturbate', user: '', msg: 'Broadcast started' });
      break;
    case 'broadcastStop':
      mainWindow?.webContents.send('desktop:chat-message', { type: 'system', platform: 'chaturbate', user: '', msg: 'Broadcast ended' });
      break;
    case 'follow':
      mainWindow?.webContents.send('desktop:chat-message', {
        type: 'follow', platform: 'chaturbate',
        user: ev.object?.user?.username || 'someone',
        msg:  'followed',
      });
      break;
  }
}

function stopEventsPolling() {
  eventsPoller?.stop();
  eventsPoller = null;
}

async function startViewerCountPolling() {
  if (viewerPollInterval) clearInterval(viewerPollInterval);

  const cbDest = streamDestinations.find(d => d.username && d.name.toLowerCase() === 'chaturbate');
  const scDest = streamDestinations.find(d => d.username && d.name.toLowerCase() === 'stripchat');
  if (!cbDest && !scDest) return;

  let polling = false;
  const poll = async () => {
    if (polling) return;          // previous tick still running (slow network)
    polling = true;
    try { await pollOnce(); } finally { polling = false; }
  };
  const pollOnce = async () => {
    try {
      if (cbDest) {
        const res = await fetch(
          `https://chaturbate.com/api/public/affiliates/onlinerooms/?wm=0&format=json&username=${encodeURIComponent(cbDest.username)}`,
          { signal: AbortSignal.timeout(10000) }
        );
        if (res.ok) {
          const data = await res.json();
          const room = (data.results || []).find(r => r.username === cbDest.username);
          if (room?.num_users !== undefined) {
            viewerCounts.set('Chaturbate', room.num_users);
            scLog(`[cb-viewers] ${room.num_users}`);
          }
        }
      }
    } catch {}
    try {
      if (scDest) {
        const res = await fetch(
          `https://stripchat.com/api/front/v2/models/username/${encodeURIComponent(scDest.username.toLowerCase())}`,
          { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) }
        );
        if (res.ok) {
          const data = await res.json();
          const v = data?.model?.viewersCount ?? data?.model?.viewers ?? null;
          if (v !== null) { viewerCounts.set('Stripchat', v); scLog(`[sc-viewers] ${v}`); }
        }
      }
    } catch {}
  };
  poll();
  viewerPollInterval = setInterval(poll, 30000);
}

function stopViewerCountPolling() {
  viewerCounts.clear();
  if (viewerPollInterval) { clearInterval(viewerPollInterval); viewerPollInterval = null; }
}

// ── Stripchat chat WebSocket (socket.io 4.x protocol) ────────────────────────
let stripchatWs        = null;
let stripchatPingTimer  = null;
let stripchatRetryTimer = null;
const scWsLog = [];  // ring buffer of last 80 raw WS frames for debug panel
function scLog(msg) {
  scWsLog.push(`${new Date().toISOString().slice(11,23)}  ${msg}`);
  if (scWsLog.length > 80) scWsLog.shift();
}

async function startStripchatChat() {
  const dest = streamDestinations.find(d => d.username && d.name.toLowerCase() === 'stripchat');
  if (!dest?.username) { scLog('startStripchatChat: no dest with username'); return; }
  if (stripchatWs) { scLog('startStripchatChat: already connected'); return; }
  if (stripchatRetryTimer) { clearTimeout(stripchatRetryTimer); stripchatRetryTimer = null; }

  scLog(`startStripchatChat: starting for ${dest.username}`);

  // Pull cookies from the persist:stripchat session (user logs in via the SC panel)
  let cookieHeader = '';
  try {
    const scSession = session.fromPartition('persist:stripchat');
    const cookies   = await scSession.cookies.get({ domain: 'stripchat.com' });
    cookieHeader    = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    scLog(`cookies: ${cookies.length} found`);
  } catch (e) {
    scLog(`cookie fetch error: ${e.message}`);
  }

  // Fetch model info to get their numeric room ID — 5 s timeout, with cookies
  let modelId = null;
  try {
    const ctl = new AbortController();
    const tid = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch(
      `https://stripchat.com/api/front/v2/models/username/${encodeURIComponent(dest.username.toLowerCase())}`,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36',
          Cookie: cookieHeader,
        },
        signal: ctl.signal,
      }
    );
    clearTimeout(tid);
    if (res.ok) {
      const data = await res.json();
      modelId = data?.model?.id ?? null;
      scLog(`modelId lookup ok: ${modelId} topKeys=${Object.keys(data || {}).join(',')}`);
    } else {
      scLog(`modelId fetch http ${res.status}`);
    }
  } catch (e) {
    scLog(`modelId fetch error: ${e.message}`);
  }

  try {
    const WS = require('ws');
    stripchatWs = new WS('wss://chatws.stripchat.global/socket.io/?EIO=4&transport=websocket', {
      headers: {
        Origin:     'https://stripchat.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36',
        Cookie:     cookieHeader,
      },
    });

    stripchatWs.on('open', () => {
      scLog(`OPEN connected for ${dest.username} modelId=${modelId}`);
    });

    stripchatWs.on('message', raw => {
      const msg = raw.toString();
      scLog(msg.length < 400 ? msg : msg.slice(0, 400) + '…');

      // Engine.io OPEN — respond with socket.io CONNECT
      if (msg.startsWith('0')) {
        try {
          const info = JSON.parse(msg.slice(1));
          stripchatWs.send('40');
          if (stripchatPingTimer) clearInterval(stripchatPingTimer);
          stripchatPingTimer = setInterval(() => {
            if (stripchatWs?.readyState === 1) stripchatWs.send('3');
          }, info.pingInterval || 25000);
        } catch {}
        return;
      }

      if (msg === '2') { stripchatWs?.send('3'); return; } // ping → pong

      // Socket.io CONNECT ack — join the model's room
      if (msg.startsWith('40')) {
        const joinPayload = modelId
          ? JSON.stringify(['join', { roomId: String(modelId), viewerUsername: '' }])
          : JSON.stringify(['join', { username: dest.username.toLowerCase(), viewerUsername: '' }]);
        stripchatWs.send('42' + joinPayload);
        scLog(`SENT join roomId=${modelId} username=${dest.username}`);
        mainWindow?.webContents.send('desktop:chat-status', buildChatStatus());
        return;
      }

      if (!msg.startsWith('42')) return;
      try {
        const parsed = JSON.parse(msg.slice(2));
        if (!Array.isArray(parsed)) return;
        const [event, data] = parsed;
        if (!data) return;

        // User can be nested in different places depending on the event
        const user = data?.user?.username || data?.from?.username || data?.username
          || data?.message?.user?.username || 'anon';

        switch (event) {
          case 'message':
          case 'chatMessage':
          case 'broadcast:user:message':
          case 'chat:message':
          case 'userMessage': {
            const text = data?.text || data?.message?.text || data?.message || data?.body || '';
            mainWindow?.webContents.send('desktop:chat-message', { type: 'chat', platform: 'stripchat', user, msg: text });
            break;
          }
          case 'tip':
          case 'tokenTip':
          case 'broadcast:tip': {
            const amount = data?.amount || data?.tokens || data?.tip?.amount || data?.tokensAmount || '?';
            mainWindow?.webContents.send('desktop:chat-message', {
              type: 'tip', platform: 'stripchat', user,
              msg: `tipped ${amount} tokens`,
            });
            noteTip('stripchat', user, amount);
            break;
          }
          case 'follow':
          case 'fanclub':
          case 'fanclubJoin':
          case 'broadcast:follow':
            mainWindow?.webContents.send('desktop:chat-message', { type: 'follow', platform: 'stripchat', user, msg: 'followed' });
            break;
          default:
            // Unknown event — surface it in chat as a raw debug line so we can identify the real name
            mainWindow?.webContents.send('desktop:chat-message', {
              type: 'system', platform: 'stripchat', user: '',
              msg: `[SC:${event}] ${JSON.stringify(data).slice(0, 120)}`,
            });
        }
      } catch {}
    });

    stripchatWs.on('close', () => {
      scLog('WS closed — will retry in 6s');
      stripchatWs = null;
      if (stripchatPingTimer) { clearInterval(stripchatPingTimer); stripchatPingTimer = null; }
      if (storedToken) stripchatRetryTimer = setTimeout(() => startStripchatChat(), 6000);
    });

    stripchatWs.on('error', err => {
      scLog(`WS error: ${err.message}`);
      stripchatWs?.terminate();
      stripchatWs = null;
    });
  } catch (err) {
    scLog(`startStripchatChat threw: ${err.message}`);
  }
}

function stopStripchatChat() {
  if (stripchatRetryTimer) { clearTimeout(stripchatRetryTimer); stripchatRetryTimer = null; }
  if (stripchatPingTimer)  { clearInterval(stripchatPingTimer); stripchatPingTimer = null; }
  stripchatWs?.terminate();
  stripchatWs = null;
}

// ── Toys (tip-activated; see toy-manager.js) ──────────────────────────────────
const toysConfigPath = () => path.join(app.getPath('userData'), 'toys.json');
let toyMan = null;

function getToyMan() {
  if (toyMan) return toyMan;
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(toysConfigPath(), 'utf8')); } catch {}
  toyMan = new ToyManager({ logger, settings: saved });
  toyMan.on('status', st => mainWindow?.webContents.send('desktop:toy-status', st));
  return toyMan;
}
function saveToySettings() {
  try { fs.writeFileSync(toysConfigPath(), JSON.stringify(getToyMan().getSettings()), 'utf8'); } catch {}
}

// Every platform's tip handler funnels through here → one shared queue.
function noteTip(platform, user, amount) {
  try {
    const tokens = Number(amount);
    if (!Number.isFinite(tokens) || tokens < 1) return;
    getToyMan().enqueueTip({ platform, user, tokens });
  } catch (e) { logger.warn('[toys] noteTip failed', { error: e.message }); }
  try { getTipGoal().addTip(user, amount); } catch (e) { logger.warn('[goal] addTip failed', { error: e.message }); }
}

// BongaCams: no events API is wired up; best-effort text heuristic on DOM-scraped rows.
// Opt-in only — a viewer could type "tipped 500 tokens" in public chat to spoof it.
function handleBongaDomEvent(event) {
  if (event?.platform !== 'bongacams') return;
  try {
    if (!getToyMan().getSettings().bongaTipParsing) return;
    const tokens = parseTipText(event.text);
    if (tokens) noteTip('bongacams', event.username || 'anon', tokens);
  } catch {}
}

ipcMain.handle('desktop:toys-get', () => ({ settings: getToyMan().getSettings(), status: getToyMan().getStatus() }));
ipcMain.handle('desktop:toys-set-settings', (_e, s) => {
  const out = getToyMan().setSettings(s || {});
  saveToySettings();
  return out;
});
ipcMain.handle('desktop:toys-connect',    async () => getToyMan().connect());
ipcMain.handle('desktop:toys-disconnect', () => getToyMan().disconnect());
ipcMain.handle('desktop:toys-stop',       () => getToyMan().stopAll('user'));
ipcMain.handle('desktop:toys-test',       (_e, { intensity, seconds }) => getToyMan().testVibrate(intensity, seconds));

// Test-only: push a synthetic raw platform event through the real parsing code.
// Disabled unless the app is launched with TMT_TEST_HOOKS=1.
if (process.env.TMT_TEST_HOOKS === '1') {
  ipcMain.handle('desktop:test-inject', (_e, { kind, payload }) => {
    if (kind === 'chaturbate') handleChaturbateEvent(payload);                 // payload = CB events-API event object
    else if (kind === 'stripchat') handleScWsFrame(payload);                   // payload = raw socket.io frame string
    else if (kind === 'bongacams') handleBongaDomEvent(payload);               // payload = chat-manager DOM event
    return true;
  });
}

// ── Chat status ───────────────────────────────────────────────────────────────
function buildChatStatus() {
  const sc = streamDestinations.find(d => d.name.toLowerCase() === 'stripchat');
  const cb = streamDestinations.find(d => d.name.toLowerCase() === 'chaturbate');
  return {
    stripchat:  { active: !!sc?.username, username: sc?.username || '' },
    chaturbate: { active: !!(cb?.username && cb?.eventsToken), username: cb?.username || '', hasToken: !!cb?.eventsToken },
  };
}

ipcMain.handle('desktop:get-chat-status', () => buildChatStatus());

// ── OBS websocket ─────────────────────────────────────────────────────────────
let OBSWebSocket;
async function getOBSClass() {
  if (!OBSWebSocket) OBSWebSocket = (await import('obs-websocket-js')).default;
  return OBSWebSocket;
}

// Push the first destination's RTMP settings directly into OBS memory.
// Bypasses service.json — OBS may have loaded the wrong profile (Untitled default) at boot.
async function applyStreamService() {
  if (!obsClient || streamDestinations.length === 0) return;
  const primary = streamDestinations[0];
  try {
    await obsClient.call('SetStreamServiceSettings', {
      streamServiceType: 'rtmp_custom',
      streamServiceSettings: {
        server:   primary.rtmpUrl,
        key:      primary.streamKey,
        use_auth: false,
      },
    });
    console.log('[OBS ws] stream service set →', primary.name, primary.rtmpUrl);
  } catch (err) {
    console.warn('[OBS ws] SetStreamServiceSettings failed:', err.message);
  }
}

// The TMT scene collection ships with an empty scene. Without a video source
// OBS streams a black screen even though RTMP connects fine. This ensures a
// webcam source exists, and (re)applies the device so OBS opens the capture.
// Re-applying matters because the app's own preview holds the webcam (Windows
// allows only one DirectShow owner) — once the renderer releases it at go-live,
// re-applying makes OBS grab the now-free device.
//
// Written to work across machines: detects the right camera input kind for the
// OS (Windows dshow / macOS avcapture), and skips IR (Windows Hello) and virtual
// cameras when choosing a device so it lands on the real webcam everywhere.
async function ensureCameraSource() {
  if (!obsClient) return;
  try {
    // Pick the camera input kind this OBS/OS actually supports.
    let inputKinds = [];
    try { ({ inputKinds } = await obsClient.call('GetInputKindList')); } catch {}
    const camKind = ['dshow_input', 'av_capture_input_v2', 'av_capture_input', 'macos-avcapture']
      .find(k => inputKinds.includes(k)) || 'dshow_input';
    const devProp = camKind === 'dshow_input' ? 'video_device_id' : 'device';

    const { currentProgramSceneName: scene } = await obsClient.call('GetCurrentProgramScene');
    const { sceneItems } = await obsClient.call('GetSceneItemList', { sceneName: scene });
    const existing = sceneItems.find(it => it.inputKind === camKind);

    let inputName   = existing?.sourceName || 'Camera';
    let sceneItemId = existing?.sceneItemId;
    const isNew     = !existing;

    if (isNew) {
      // Reuse an orphan webcam input if one exists outside this scene; else create one.
      const { inputs } = await obsClient.call('GetInputList', { inputKind: camKind });
      if (inputs.length > 0) {
        inputName = inputs[0].inputName;
        ({ sceneItemId } = await obsClient.call('CreateSceneItem', {
          sceneName: scene, sourceName: inputName, sceneItemEnabled: true,
        }));
      } else {
        ({ sceneItemId } = await obsClient.call('CreateInput', {
          sceneName: scene, inputName, inputKind: camKind,
          inputSettings: {}, sceneItemEnabled: true,
        }));
      }
    }

    // (Re)apply a device. Re-applying the same id still forces OBS to re-open the
    // capture — that's what flips it from "busy/black" (while the app preview held
    // it) to live (after the renderer released it). Choose a REAL webcam: skip
    // Windows Hello IR cameras and virtual cameras (OBS/NVIDIA/Streamlabs etc.),
    // which would otherwise be picked first on many machines and show black.
    try {
      const { propertyItems } = await obsClient.call('GetInputPropertiesListPropertyItems', {
        inputName, propertyName: devProp,
      });
      const usable = propertyItems.filter(p => p.itemEnabled && p.itemValue);
      const isUndesirable = name => /virtual|obs|streamlabs|nvidia|infrared|\bir\b/i.test(name || '');
      const dev = usable.find(p => !isUndesirable(p.itemName)) || usable[0];
      if (dev) {
        const inputSettings = camKind === 'dshow_input'
          ? { video_device_id: dev.itemValue, last_video_device_id: dev.itemValue }
          : { device: dev.itemValue, device_name: dev.itemName };
        // Force OBS to actually (re)open the capture. Re-applying an UNCHANGED
        // device id is a no-op in OBS — so a source first created while the
        // webcam was still held by the app preview stays black forever. Clearing
        // the device then setting it is a real change OBS can't skip, which
        // re-opens the capture on the now-free device.
        const clearSettings = camKind === 'dshow_input' ? { video_device_id: '' } : { device: '' };
        await obsClient.call('SetInputSettings', { inputName, overlay: true, inputSettings: clearSettings });
        await new Promise(r => setTimeout(r, 250));
        await obsClient.call('SetInputSettings', { inputName, overlay: true, inputSettings });
        logger.info('OBS camera device applied', { device: dev.itemName, kind: camKind, isNew });
      } else {
        logger.warn('OBS no camera devices available to select', { kind: camKind });
      }
    } catch (e) {
      logger.warn('OBS camera device pick failed', { error: e.message });
    }

    // Scale to canvas only when we just added the source (avoid resetting a
    // model's manual framing on every go-live).
    if (isNew) {
      try {
        const v = await obsClient.call('GetVideoSettings');
        await obsClient.call('SetSceneItemTransform', {
          sceneName: scene, sceneItemId,
          sceneItemTransform: {
            boundsType:   'OBS_BOUNDS_SCALE_INNER',
            boundsWidth:  v.baseWidth,
            boundsHeight: v.baseHeight,
            positionX: 0, positionY: 0,
          },
        });
      } catch (e) {
        logger.warn('OBS camera transform failed', { error: e.message });
      }
    }
    logger.info('OBS camera source ensured', { scene, inputName, isNew });
  } catch (e) {
    logger.warn('ensureCameraSource failed', { error: e.message });
  }
}

// ── Promo text overlay (top-left of the stream) ───────────────────────────────
let overlayConfig = null; // { text, enabled }
const overlayConfigPath = () => path.join(app.getPath('userData'), 'overlay.json');

function loadOverlayConfig() {
  if (overlayConfig) return overlayConfig;
  try { overlayConfig = JSON.parse(fs.readFileSync(overlayConfigPath(), 'utf8')); }
  catch { overlayConfig = { text: '', enabled: false }; }
  if (typeof overlayConfig.text !== 'string') overlayConfig.text = '';
  overlayConfig.enabled = !!overlayConfig.enabled;
  return overlayConfig;
}
function saveOverlayConfig(cfg) {
  overlayConfig = { text: String(cfg?.text || '').slice(0, 500), enabled: !!cfg?.enabled };
  try { fs.writeFileSync(overlayConfigPath(), JSON.stringify(overlayConfig), 'utf8'); } catch {}
  return overlayConfig;
}

// Create/update an OBS text source named "Promo" pinned to the top-left corner,
// used to promote socials on stream. Cross-platform: GDI+ text on Windows,
// FreeType2 on macOS/Linux. Idempotent — safe to call on every connect/change.
async function ensureOverlaySource() {
  const cfg = loadOverlayConfig();
  await ensureTextSource(obsClient, { name: 'Promo', text: cfg.text, enabled: cfg.enabled, alignment: 5, x: 48, y: 40, size: 42 }, logger); // 5 = top|left
}

// ── Tip goal (dashboard bar + OBS text source "TipGoal", bottom-left) ─────────
const { createTipGoal } = require('./tip-goal');
const { ensureTextSource, parseTipMenu, tipMenuText } = require('./obs-text-source');
const goalConfigPath = () => path.join(app.getPath('userData'), 'tipgoal.json');
let tipGoal = null;
let goalObsTimer = null;
let goalSaveTimer = null;
const goalStatePath = () => path.join(app.getPath('userData'), 'tipgoal-state.json');
function saveGoalState() {
  clearTimeout(goalSaveTimer);
  goalSaveTimer = setTimeout(() => {
    try { fs.writeFileSync(goalStatePath(), JSON.stringify(getTipGoal().snapshot()), 'utf8'); } catch {}
  }, 500);
}
function getTipGoal() {
  if (tipGoal) return tipGoal;
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(goalConfigPath(), 'utf8')); } catch {}
  tipGoal = createTipGoal(saved, (view) => {
    mainWindow?.webContents.send('desktop:goal-update', view);
    clearTimeout(goalObsTimer);           // tips can arrive in bursts — coalesce OBS updates
    goalObsTimer = setTimeout(() => { ensureGoalSource().catch(() => {}); }, 600);
    if (tipGoal) saveGoalState();
  });
  try {
    if (tipGoal.restore(JSON.parse(fs.readFileSync(goalStatePath(), 'utf8')))) logger.info('[goal] restored running total after restart');
  } catch {}
  return tipGoal;
}
function saveGoalConfig() {
  try { fs.writeFileSync(goalConfigPath(), JSON.stringify(getTipGoal().getConfig()), 'utf8'); } catch {}
}
async function ensureGoalSource() {
  const goal = getTipGoal(), cfg = goal.getConfig();
  await ensureTextSource(obsClient, { name: 'TipGoal', text: goal.overlayText(), enabled: cfg.enabled, alignment: 9, x: 48, y: 1040, size: 38, createIfMissing: false }, logger); // 9 = bottom|left
}

// ── Tip menu (OBS text source "TipMenu", top-right) ───────────────────────────
const tipMenuPath = () => path.join(app.getPath('userData'), 'tipmenu.json');
let tipMenuCfg = null;
function loadTipMenu() {
  if (tipMenuCfg) return tipMenuCfg;
  try { tipMenuCfg = JSON.parse(fs.readFileSync(tipMenuPath(), 'utf8')); } catch { tipMenuCfg = {}; }
  tipMenuCfg = { text: String(tipMenuCfg.text || '').slice(0, 800), enabled: !!tipMenuCfg.enabled };
  return tipMenuCfg;
}
async function ensureTipMenuSource() {
  const cfg = loadTipMenu();
  await ensureTextSource(obsClient, { name: 'TipMenu', text: tipMenuText(parseTipMenu(cfg.text)), enabled: cfg.enabled, alignment: 6, x: 1872, y: 40, size: 34, createIfMissing: false }, logger); // 6 = top|right
}

// Auto-resume the stream if it drops while the model wants to be live.
const { createStreamGuard } = require('./stream-guard');
const streamGuard = createStreamGuard({
  start: async () => {
    if (!obsClient) throw new Error('OBS not connected');
    const st = await obsClient.call('GetStreamStatus');
    if (st.outputActive) return;
    await obsClient.call('StartStream');
  },
  notify: (m) => mainWindow?.webContents.send('desktop:stream-error', m),
  log: (m, d) => logger.info('[stream-guard] ' + m, d),
});

// If OBS crashes (or is closed) while the app is running, bring it back automatically.
const obsRespawnOk = obsMan.createRespawnLimiter();
obsMan.onUnexpectedExit((code) => {
  if (!storedToken) return;
  logger.warn('OBS exited unexpectedly', { code });
  if (!obsRespawnOk()) {
    logger.error('OBS keeps crashing — giving up auto-restart');
    mainWindow?.webContents.send('desktop:stream-error', 'The video engine keeps stopping. Please close and reopen the app.');
    return;
  }
  mainWindow?.webContents.send('desktop:stream-error', 'The video engine stopped — restarting it now. If you were live, your stream will resume automatically.');
  setTimeout(() => {
    if (!storedToken) return;
    try { obsMan.spawnObs(); logger.info('OBS respawned'); } catch (e) { logger.error('OBS respawn failed', { error: e.message }); }
  }, 2000);
});

// Schedule a single reconnect attempt. Guarded so the ConnectionClosed handler
// and the connect-failure catch block can't stack multiple timers (which during
// OBS's boot produced a storm of overlapping reconnect attempts).
function scheduleObsReconnect(wsPassword) {
  if (!storedToken || obsReconnectTimer) return;
  obsReconnectTimer = setTimeout(() => {
    obsReconnectTimer = null;
    connectObs(wsPassword);
  }, 3000);
}

async function connectObs(wsPassword) {
  if (obsClient) return;
  const OBS = await getOBSClass();
  obsClient = new OBS();

  obsClient.on('ConnectionClosed', () => {
    obsClient     = null;
    cachedMicName = null;
    // Only warn on a genuine drop of an already-established connection. During
    // OBS's ~20s boot the socket closes repeatedly before its WS server is up —
    // that's expected, so don't flood the logs with false disconnect warnings.
    if (obsConnected) logger.warn('OBS disconnected — will retry');
    obsConnected = false;
    mainWindow?.webContents.send('desktop:obs-status', { connected: false });
    scheduleObsReconnect(wsPassword);
  });

  obsClient.on('StreamStateChanged', ({ outputActive, outputState }) => {
    if (outputState === 'OBS_WEBSOCKET_OUTPUT_ERROR') {
      logger.error('OBS stream error', { outputState });
      if (streamGuard.isWantLive()) streamGuard.onStreamStopped('error');
      else mainWindow?.webContents.send('desktop:stream-error', 'Stream failed — check your network or stream settings.');
    } else if (outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') {
      logger.info('OBS stream state changed', { outputState, outputActive });
      streamGuard.onStreamStopped('stopped');
    } else if (outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') {
      logger.info('OBS stream state changed', { outputState, outputActive });
      streamGuard.onStreamStarted();
    } else {
      logger.info('OBS stream state changed', { outputState, outputActive });
    }
  });

  sendStartupStatus('obs', 'loading', 'Connecting to OBS…');
  try {
    await obsClient.connect(`ws://127.0.0.1:${OBS_WS_PORT}`, wsPassword);
    console.log('[OBS ws] connected');

    // Only switch profile / scene-collection when NOT already current.
    // Re-selecting the active scene collection forces OBS to tear down and
    // reload every source (OBSBasic::ClearSceneData). In libobs 32.1.2 that
    // races the always-running audio thread (audio_callback hits a freed
    // mutex) and crashes OBS. On a WS reconnect we're already on TMT/TMT, so
    // these calls would be pure no-op reloads — skip them.
    try {
      const { currentProfileName } = await obsClient.call('GetProfileList');
      if (currentProfileName !== 'TMT')
        await obsClient.call('SetCurrentProfile', { profileName: 'TMT' });
    } catch {}
    try {
      const { currentSceneCollectionName } = await obsClient.call('GetSceneCollectionList');
      if (currentSceneCollectionName !== 'TMT')
        await obsClient.call('SetCurrentSceneCollection', { sceneCollectionName: 'TMT' });
    } catch {}
    await ensureCameraSource();
    await ensureOverlaySource();
    await ensureGoalSource();
    await ensureTipMenuSource();
    await applyStreamService();
    startViewerCountPolling();
    startEventsPolling();

    try {
      const specials = await obsClient.call('GetSpecialInputs');
      cachedMicName  = specials.mic1 || specials.mic2 || 'Mic/Aux';
      const { inputMuted } = await obsClient.call('GetInputMute', { inputName: cachedMicName });
      mainWindow?.webContents.send('desktop:mute-state', { muted: inputMuted });
    } catch {}

    // Keep UI in sync if OBS itself changes mute state (hotkey, OBS UI, etc.)
    obsClient.on('InputMuteStateChanged', ({ inputName, inputMuted }) => {
      if (cachedMicName && inputName === cachedMicName) {
        logger.info('Mic mute changed', { muted: inputMuted, source: 'obs' });
        mainWindow?.webContents.send('desktop:mute-state', { muted: inputMuted });
      }
    });

    // Log encoder and stream service info on connect
    try {
      const svc = await obsClient.call('GetStreamServiceSettings');
      const server = (svc.streamServiceSettings?.server || '').replace(/\/[^/]*$/, '/***');
      logger.info('OBS connected', { port: OBS_WS_PORT, mic: cachedMicName, rtmpServer: server, platforms: streamPlatforms });
    } catch {
      logger.info('OBS connected', { port: OBS_WS_PORT, mic: cachedMicName, platforms: streamPlatforms });
    }
    sendStartupStatus('obs', 'done', 'OBS ready');
    obsConnected = true;
    if (obsReconnectTimer) { clearTimeout(obsReconnectTimer); obsReconnectTimer = null; }
    mainWindow?.webContents.send('desktop:obs-status', { connected: true });
    streamGuard.onObsReconnected();
  } catch (err) {
    obsClient = null;
    mainWindow?.webContents.send('desktop:obs-status', { connected: false, status: 'Starting OBS…' });
    scheduleObsReconnect(wsPassword);
  }
}

// ── Status polling ────────────────────────────────────────────────────────────
function startStatusPolling(token) {
  if (statusInterval) return;
  let inFlight = false;
  statusInterval = setInterval(async () => {
    if (!obsClient || !token || inFlight) return;   // skip if OBS is slow to answer
    inFlight = true;
    try {
      const stream = await obsClient.call('GetStreamStatus');

      const now         = Date.now();
      const deltaBytes  = Math.max(0, (stream.outputBytes ?? 0) - lastTotalBytes);
      const deltaSec    = (now - lastPollTime) / 1000;
      const bitrateKbps = deltaSec > 0 ? Math.round((deltaBytes * 8) / deltaSec / 1000) : 0;
      lastTotalBytes = stream.outputBytes ?? 0;
      lastPollTime   = now;

      const payload = {
        live:          stream.outputActive,
        platforms:     streamPlatforms,
        bitrate:       bitrateKbps,
        droppedFrames: stream.outputDroppedFrames,
        cpuUsage:      0,
      };

      mainWindow?.webContents.send('desktop:status-update', payload);
      apiFetch('POST', '/api/desktop/status', payload, token).catch(() => {});

      // Log stream health warnings while live
      if (stream.outputActive) {
        if (stream.outputDroppedFrames > 0 && stream.outputDroppedFrames % 30 === 0) {
          logger.warn('Dropped frames detected', { droppedFrames: stream.outputDroppedFrames, bitrateKbps });
        }
        if (bitrateKbps > 0 && bitrateKbps < 500) {
          logger.warn('Very low bitrate while streaming', { bitrateKbps, platforms: streamPlatforms });
        }
      }
    } catch (err) {
      console.debug('[poll]', err.message);
    } finally {
      inFlight = false;
    }
  }, STATUS_INTERVAL_MS);
}

function stopStatusPolling() {
  clearInterval(statusInterval);
  statusInterval = null;
}

// Bootstrap a full model session from a desktop token — shared by normal login
// and admin impersonation. Loads cloud destinations, configures + launches OBS,
// restores synced cookies, and starts polling. The caller shows the dashboard.
async function bootstrapModelSession(token, username) {
  saveToken(token);
  logger.start(token, API_BASE);
  logger.info('Session bootstrap', { username, platform: logger.platform, appVersion: logger.appVersion });

  let cloudDests = null;
  try {
    cloudDests = await cloudLoadDestinations(token);
  } catch (err) {
    console.warn('[session] cloud fetch failed, using local cache:', err.message);
  }

  const ext = loadDestExtProps();

  if (cloudDests !== null) {
    await migrateLocalToCloud(token, cloudDests, ext);
    try { cloudDests = await cloudLoadDestinations(token); } catch {}
    streamDestinations = mergeWithExt(cloudDests ?? [], ext);
    saveDestCache(streamDestinations);
  } else {
    streamDestinations = loadDestCache();
  }

  streamPlatforms = streamDestinations.map(d => d.name);
  logger.info('Destinations loaded', {
    count: streamDestinations.length,
    platforms: streamDestinations.map(d => ({ name: d.name, hasUsername: !!d.username, hasKey: !!d.streamKey })),
  });

  const wsPassword = obsMan.getOrCreateWsPassword();
  obsMan.initObsConfig({ destinations: streamDestinations, wsPort: OBS_WS_PORT, wsPassword });

  let obsLaunched = obsMan.isObsRunning();
  if (!obsLaunched) {
    try {
      obsMan.spawnObs();
      obsLaunched = true;
      logger.info('OBS spawned');
    } catch (err) {
      console.error('[OBS spawn]', err.message);
      logger.error('OBS spawn failed', { error: err.message });
      mainWindow?.webContents.send('desktop:obs-status', {
        connected: false,
        error: 'OBS not found. Extract the OBS portable ZIP into electron/obs/ then rebuild.',
      });
    }
  }

  if (obsLaunched) connectObs(wsPassword);
  startStatusPolling(token);

  // Restore Stripchat session from cloud — if found, reload the broadcast view
  // so the model skips the login screen on this machine too.
  sendStartupStatus('session', 'loading', 'Syncing session…');
  cookieSync.restoreCookies(token, 'stripchat', 'persist:stripchat')
    .then(r => {
      scLog(`[cookie-sync] restore@login → ${r.ok ? `OK (${r.injected} cookies)` : ('FAIL ' + (r.reason || ''))}`);
      if (r.ok) {
        logger.info('Cookie sync restored', { platform: 'stripchat', injected: r.injected });
        sendStartupStatus('session', 'done', 'Session synced');
        const scRoomUrl = getScRoomUrl();
        if (scRoomUrl) scView?.webContents.loadURL(scRoomUrl);
      } else {
        logger.warn('Cookie sync failed', { platform: 'stripchat', reason: r.reason });
        sendStartupStatus('session', 'error', 'Session sync failed');
      }
    })
    .catch(e => {
      scLog('[cookie-sync] restore@login error: ' + e.message);
      logger.warn('Cookie sync error', { platform: 'stripchat', error: e.message });
      sendStartupStatus('session', 'error', 'Session sync error');
    });
  cookieSync.restoreCookies(token, 'chaturbate', 'persist:chaturbate')
    .then(r => {
      scLog(`[cookie-sync] cb restore@login → ${r.ok ? `OK (${r.injected} cookies)` : ('FAIL ' + (r.reason || ''))}`);
      if (r.ok) {
        logger.info('Cookie sync restored', { platform: 'chaturbate', injected: r.injected });
        const cbRoomUrl = getCbRoomUrl();
        if (cbRoomUrl) cbView?.webContents.loadURL(cbRoomUrl);
      }
    })
    .catch(e => scLog('[cookie-sync] cb restore@login error: ' + e.message));

  startAutoFixer();
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('desktop:login', async (_e, { username, password }) => {
  // Local admin gate — opens the in-app Admin overview. Our own fixed creds,
  // independent of any model account or the website admin login.
  if ((username || '').toLowerCase() === ADMIN_USER && password === ADMIN_PASS) {
    logger.info('Admin overview login (desktop)');
    return { ok: true, admin: true };
  }
  try {
    const auth = await apiFetch('POST', '/api/desktop/auth/login', { username, password });
    if (auth.status === 401) { logger.warn('Login failed: wrong credentials', { username, status: 401 }); return { ok: false, error: auth.data.error || 'Incorrect username or password.' }; }
    if (auth.status === 403) { logger.warn('Login failed: no model access', { username, status: 403 }); return { ok: false, error: auth.data.error || 'This account does not have model access. Contact your agency.' }; }
    if (auth.status === 404) { logger.warn('Login failed: account not found', { username, status: 404 }); return { ok: false, error: 'Account not found. Check your username and try again.' }; }
    if (auth.status !== 200) { logger.error('Login failed: unexpected status', { username, status: auth.status }); return { ok: false, error: auth.data.error || `Login failed (error ${auth.status}). Contact support if this persists.` }; }
    logger.info('Login successful', { username });
    await bootstrapModelSession(auth.data.token, username);
    return { ok: true };
  } catch (err) {
    console.error('[desktop:login]', err);
    const code = err.code || err.name || 'UNKNOWN';
    logger.error('Login network error', { code, message: err.message });
    // Flush now even without a token — pre-auth logs will be sent once logger has a token later
    if (err.name === 'AbortError') {
      return { ok: false, error: 'Connection timed out — server took too long to respond. Try again.' };
    }
    if (code === 'ENOTFOUND') {
      return { ok: false, error: 'Cannot find the server (DNS error). Check your internet or try restarting your router.' };
    }
    if (code === 'ECONNREFUSED') {
      return { ok: false, error: 'Connection refused by server. Please contact support.' };
    }
    if (code === 'ECONNRESET' || code === 'EPIPE') {
      return { ok: false, error: 'Connection was interrupted. Try again, or check if antivirus is blocking the app.' };
    }
    if (code === 'EPERM' || code === 'EACCES') {
      logger.error('OBS config permission error — app may be installed in Program Files', { code, message: err.message });
      return { ok: false, error: 'Permission denied writing OBS config. Try reinstalling TMT Native outside of Program Files (e.g. your Desktop or Documents).' };
    }
    return { ok: false, error: `Cannot reach the server (${code}). Check your internet — if it keeps happening, your antivirus may be blocking TMT Native.` };
  }
});

ipcMain.handle('desktop:get-token', () => storedToken || loadToken());

ipcMain.handle('desktop:logout', () => {
  logger.info('Logout');
  logger.stop();
  logger.clearToken();
  const tokenToDelete = storedToken;   // capture before clearToken() nulls it
  clearToken();
  stopStatusPolling();
  stopEventsPolling();
  stopViewerCountPolling();
  stopStripchatChat();
  stopAutoFixer();
  try { obsClient?.disconnect(); } catch {}
  obsClient = null;
  obsMan.killObs();
  if (tokenToDelete) cookieSync.deleteAllCookies(tokenToDelete).catch(() => {});
});

ipcMain.handle('desktop:start-stream', async () => {
  if (!obsClient) return { ok: false, error: 'OBS not connected yet' };

  // Refresh destinations from cloud before going live — prevents streaming to stale/deleted dest
  if (storedToken) {
    try {
      const ext   = loadDestExtProps();
      const fresh = await cloudLoadDestinations(storedToken);
      if (fresh !== null) {
        streamDestinations = mergeWithExt(fresh, ext);
        saveDestCache(streamDestinations);
        streamPlatforms = streamDestinations.map(d => d.name);
        await applyStreamService();
      }
    } catch { /* use cached destinations */ }
  }

  if (streamPlatforms.length === 0) return { ok: false, error: 'No stream destinations configured for your account.' };
  try {
    await obsClient.call('StartStream');
    streamGuard.setWantLive(true);
    lastTotalBytes = 0;
    lastPollTime   = Date.now();
    logger.info('Stream started', { platforms: streamPlatforms });
    return { ok: true };
  } catch (err) {
    logger.error('Stream start failed', { error: err.message });
    return { ok: false, error: friendlyStreamError(err) };
  }
});

ipcMain.handle('desktop:stop-stream', async () => {
  streamGuard.setWantLive(false);
  if (!obsClient) return { ok: false, error: friendlyStreamError('Not connected') };
  try {
    await obsClient.call('StopStream');
    logger.info('Stream stopped');
    return { ok: true };
  } catch (err) {
    logger.error('Stream stop failed', { error: err.message });
    return { ok: false, error: friendlyStreamError(err) };
  }
});

ipcMain.handle('desktop:go-live', async () => {
  // ── OBS ──────────────────────────────────────────────────────────────
  if (!obsClient) return { ok: false, stage: 'obs', error: friendlyStreamError('Not connected') };
  const activeDests = getActiveDestinations();
  if (activeDests.length === 0)
    return { ok: false, stage: 'obs', error: 'All your platforms are switched off. Turn at least one on in the left panel, then press Go Live.' };

  // Rewrite obs-multi-rtmp.json with only active destinations, then reload
  // the OBS profile so the plugin picks up the new config before stream start.
  // The profile bounce is heavy (full profile reload) so only do it when the
  // active-destination set actually changed since the last go-live — re-running
  // it needlessly on every go-live just adds crash risk for no benefit.
  try {
    const sig = activeDests.map(d => `${d.name}|${d.rtmpUrl}|${d.streamKey}`).join('::');
    const primary = activeDests[0];
    if (sig !== lastMultiRtmpSig) {
      const configDir = obsMan.getObsConfigDir(obsMan.getObsDir());
      obsMan.writeMultiRtmpConfig(configDir, activeDests);
      // Profile reload: switch away then back so obs-multi-rtmp re-reads its JSON
      await obsClient.call('SetCurrentProfile', { profileName: 'Untitled' }).catch(() => {});
      await obsClient.call('SetCurrentProfile', { profileName: 'TMT' });
      lastMultiRtmpSig = sig;
      scLog('[go-live] obs-multi-rtmp reloaded (destinations changed)');
    }
    // Always re-apply primary stream service (cheap, no source teardown)
    await obsClient.call('SetStreamServiceSettings', {
      streamServiceType: 'rtmp_custom',
      streamServiceSettings: { server: primary.rtmpUrl, key: primary.streamKey, use_auth: false },
    });
  } catch (err) {
    console.warn('[go-live] config reload failed:', err.message);
  }

  // Safety net: guarantee a camera source exists before we start streaming,
  // so we never push a black screen even if OBS connected before the device
  // was ready. Idempotent — no-op when a camera is already in the scene.
  await ensureCameraSource();
  await ensureOverlaySource();
  await ensureGoalSource();
  await ensureTipMenuSource();

  // Log OBS scene and sources so we can diagnose black-camera issues
  try {
    const [sceneRes, videoRes] = await Promise.all([
      obsClient.call('GetCurrentProgramScene').catch(() => null),
      obsClient.call('GetVideoSettings').catch(() => null),
    ]);
    if (!sceneRes) throw new Error('GetCurrentProgramScene failed');
    const sceneName = sceneRes.currentProgramSceneName;
    const itemsRes  = await obsClient.call('GetSceneItemList', { sceneName });
    const sources   = itemsRes.sceneItems.map(i => ({
      name:    i.sourceName,
      type:    i.inputKind ?? i.sourceType ?? 'unknown',
      enabled: i.sceneItemEnabled,
    }));
    logger.info('OBS scene at stream start', {
      scene:      sceneName,
      resolution: `${videoRes.baseWidth}x${videoRes.baseHeight}`,
      fps:        videoRes.fpsNumerator,
      sources,
    });
    scLog(`[go-live] OBS scene="${sceneName}" sources=${JSON.stringify(sources)}`);
  } catch (e) {
    scLog('[go-live] could not query OBS scene info: ' + e.message);
  }

  logger.info('Go live: OBS stream starting', { platforms: activeDests.map(d => d.name) });
  try {
    await obsClient.call('StartStream');
    streamGuard.setWantLive(true);
    lastTotalBytes = 0;
    lastPollTime   = Date.now();
    logger.info('Go live: OBS stream started');
    // Log stream status 5s after start to confirm bytes are flowing
    setTimeout(async () => {
      try {
        const st = await obsClient.call('GetStreamStatus');
        logger.info('OBS stream status (5s after start)', {
          active:       st.outputActive,
          bytes:        st.outputBytes,
          reconnecting: st.outputReconnecting,
        });
        scLog(`[go-live] stream status @5s: active=${st.outputActive} bytes=${st.outputBytes}`);
      } catch {}
    }, 5000);
  } catch (err) {
    logger.error('Go live: OBS start failed', { error: err.message });
    return { ok: false, stage: 'obs', error: friendlyStreamError(err) };
  }

  // ── Stripchat click (only when Stripchat is an active destination) ────
  const scDest = activeDests.find(d => d.name.toLowerCase() === 'stripchat');
  if (scDest) {
    logger.info('SC auto-click starting', { platforms: activeDests.map(d => d.name) });

    // If the username isn't known on this machine, auto-detect it from the
    // logged-in session: /start-broadcasting redirects a logged-in model to
    // their own room (/<username>), which the navigation handler captures and
    // persists. This makes auto-start work on any computer with no config —
    // just log into Stripchat (cookies sync) and it figures out who you are.
    if (!scDest.username) {
      scLog('[sc-click] Stripchat username unknown — auto-detecting from session…');
      const scUserOf = () => streamDestinations.find(d => d.name.toLowerCase() === 'stripchat')?.username;
      if (scView) {
        scViewReady = false;
        scView.webContents.loadURL('https://stripchat.com/start-broadcasting');
        const detectDeadline = Date.now() + 20000;
        while (!scUserOf() && Date.now() < detectDeadline) {
          await new Promise(r => setTimeout(r, 500));
        }
      }
      const detected = scUserOf();
      if (detected) {
        scDest.username = detected;
        scLog(`[sc-click] auto-detected Stripchat username: ${detected}`);
      } else {
        scLog('[sc-click] could not auto-detect username — opening SC panel for manual start');
        logger.warn('SC auto-click skipped: username not detected (not logged in?)');
        return { ok: true, stripchatManual: true, openPanel: true, scUrl: 'https://stripchat.com/start-broadcasting' };
      }
    }

    // Ensure scView is on this model's broadcast centre before looking for START SHOW.
    // On a new machine the view may still be on stripchat.com/login.
    const scRoomUrl = getScRoomUrl();
    if (scView && scRoomUrl) {
      const currentUrl = scView.webContents.getURL();
      if (!currentUrl.startsWith(scRoomUrl)) {
        scLog(`[sc-click] SC view on wrong page (${currentUrl}) — navigating to broadcast centre`);
        scViewReady = false;
        scView.webContents.loadURL(scRoomUrl);
      }
    }

    // Wait for the SC broadcast page to be ready, then make sure the document is
    // fully loaded AND React has settled before clicking. scViewReady can flip
    // true on SPA in-page navigation before the page actually renders, so we
    // also poll document.readyState and add a settle — clicking too early either
    // does nothing or the confirmation modal never opens.
    scLog('[sc-click] ── STEP 1/3 ── waiting for SC broadcast page to be ready…');
    const readyStart    = Date.now();
    const readyDeadline = readyStart + 40000;
    while (!scViewReady && Date.now() < readyDeadline) {
      await new Promise(r => setTimeout(r, 500));
    }
    // Wait until the document reports fully loaded (readyState complete).
    if (scView) {
      const loadDeadline = Date.now() + 15000;
      while (Date.now() < loadDeadline) {
        let state = 'loading';
        try { state = await scView.webContents.executeJavaScript('document.readyState', true); } catch {}
        if (state === 'complete') break;
        await new Promise(r => setTimeout(r, 500));
      }
    }
    const loadedInMs = Date.now() - readyStart;
    scLog(`[sc-click] ── STEP 1/3 ── SC page loaded (${Math.round(loadedInMs / 1000)}s) — settling 3.5s for React…`);
    await new Promise(r => setTimeout(r, 3500));

    // Always ensure SC view is at full size and visible before clicking —
    // sendInputEvent is unreliable on hidden/zero-size views.
    if (scView && mainWindow) {
      const [winW, winH] = mainWindow.getContentSize();
      const top = TITLEBAR_H + SC_BAR_H;
      scView.setBounds({ x: 0, y: top, width: winW, height: winH - top });
      scView.setVisible(true);
      scViewVisible = true;
      await new Promise(r => setTimeout(r, 400));
    }

    // Step 1: click START SHOW — opens a confirmation modal.
    scLog('[sc-click] ── STEP 1/3 ── looking for "START SHOW" button…');
    // After the click flow finishes, hide the SC view and return to the main
    // dashboard. On failure paths the renderer re-opens it (openPanel) so the
    // model can finish starting the show manually.
    const restoreScView = () => {
      if (scView && mainWindow) {
        scView.setBounds({ x: 0, y: TITLEBAR_H + SC_BAR_H, width: 0, height: 0 });
        scView.setVisible(false);
        scViewVisible = false;
      }
    };

    const r1 = await clickStripchatButton(/start\s*show/i, 20000, { skipVerify: true });
    if (!r1.ok) {
      const scUrl = scDest.username ? `https://stripchat.com/${scDest.username}` : 'https://stripchat.com';
      scLog(`[sc-click] ✗ STEP 1 FAILED — START SHOW not found: ${r1.error}`);
      logger.warn('SC auto-click failed (START SHOW)', { scUrl, error: r1.error });
      restoreScView();
      return { ok: true, stripchatManual: true, openPanel: true, scUrl };
    }
    scLog('[sc-click] ✓ STEP 1 — START SHOW clicked, confirmation modal should open');

    // Step 2: tick the terms checkbox (data-testid="BroadcastAgreement").
    scLog('[sc-click] ── STEP 2/3 ── waiting 2s for modal to render…');
    await new Promise(r => setTimeout(r, 2000));

    const scViews = [scView, chatManager?.getView('stripchat')].filter(Boolean);
    const checkboxScript = `(function(){
  var el = document.querySelector('[data-testid="BroadcastAgreement"]');
  if (!el) return 'not-found';
  var fk = Object.keys(el).find(function(k){ return k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'); });
  if (fk) {
    var f = el[fk];
    for (var d = 0; f && d < 8; d++, f = f.return) {
      var p = f.memoizedProps || f.pendingProps;
      if (p && typeof p.onChange === 'function') {
        p.onChange({ preventDefault:function(){}, stopPropagation:function(){}, nativeEvent:{}, target:el, currentTarget:el, type:'change', checked:true });
        return 'fiber-onChange';
      }
      if (p && typeof p.onClick === 'function') {
        p.onClick({ preventDefault:function(){}, stopPropagation:function(){}, nativeEvent:{}, target:el, currentTarget:el, type:'click' });
        return 'fiber-onClick';
      }
    }
  }
  try { el.click(); return 'native'; } catch(e) { return 'err:'+e.message; }
})()`;

    let checkboxResult = 'not-found';
    for (const v of scViews) {
      try {
        const res = await v.webContents.mainFrame.executeJavaScript(checkboxScript, true);
        if (res && res !== 'not-found') { checkboxResult = res; break; }
      } catch {}
    }
    if (checkboxResult === 'not-found') {
      scLog('[sc-click] ✗ STEP 2 — checkbox [BroadcastAgreement] not found in DOM (modal may not have opened)');
      logger.warn('SC checkbox not found — modal may not have opened');
    } else {
      scLog(`[sc-click] ✓ STEP 2 — terms checkbox ticked (${checkboxResult})`);
    }

    // Step 3: click Go Live (data-testid="StartBroadcastSubmit"), verify START SHOW disappears.
    scLog('[sc-click] ── STEP 3/3 ── clicking Go Live button…');
    await new Promise(r => setTimeout(r, 600));

    const goLiveScript = `(function(){
  var el = document.querySelector('[data-testid="StartBroadcastSubmit"]');
  if (!el) return 'not-found';
  var fk = Object.keys(el).find(function(k){ return k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'); });
  if (fk) {
    var f = el[fk];
    for (var d = 0; f && d < 8; d++, f = f.return) {
      var p = f.memoizedProps || f.pendingProps;
      if (p && typeof p.onClick === 'function') {
        p.onClick({ preventDefault:function(){}, stopPropagation:function(){}, nativeEvent:{}, target:el, currentTarget:el, type:'click', bubbles:true });
        return 'fiber';
      }
    }
  }
  try { el.click(); return 'native'; } catch(e) { return 'err:'+e.message; }
})()`;

    const checkGoneFinal = `(function(){
  var re = /start\\s*show/i;
  return !Array.from(document.querySelectorAll('button,[role="button"]'))
    .find(function(b){ return re.test((b.innerText||b.textContent||'').trim()); });
})()`;

    let goLiveResult = 'not-found';
    for (const v of scViews) {
      try {
        const res = await v.webContents.mainFrame.executeJavaScript(goLiveScript, true);
        if (res && res !== 'not-found') { goLiveResult = res; break; }
      } catch {}
    }

    if (goLiveResult === 'not-found') {
      // Button missing — the checkbox onChange may have already submitted the form.
      // Check if START SHOW is gone before declaring failure.
      scLog('[sc-click] [StartBroadcastSubmit] not found — checking if show already started…');
      let alreadyLive = false;
      for (const v of scViews) {
        try {
          const gone = await v.webContents.mainFrame.executeJavaScript(checkGoneFinal, true);
          if (gone) { alreadyLive = true; break; }
        } catch {}
      }
      if (alreadyLive) {
        scLog('[sc-click] ✓ ✓ ✓ ALL STEPS DONE — START SHOW gone (form submitted via checkbox) → show is LIVE');
        logger.info('SC auto-click succeeded — show started (submitted via checkbox)');
      } else {
        const scUrl = scDest.username ? `https://stripchat.com/${scDest.username}` : 'https://stripchat.com';
        scLog('[sc-click] ✗ STEP 3 FAILED — Go Live button not found and START SHOW still present');
        logger.warn('SC Go Live button not found', { scUrl });
        restoreScView();
        return { ok: true, stripchatManual: true, scUrl };
      }
    } else {
      scLog(`[sc-click] ✓ STEP 3 — Go Live clicked (${goLiveResult}), verifying in 3s…`);

      await new Promise(r => setTimeout(r, 3000));
      let verified = false;
      for (const v of scViews) {
        try {
          const gone = await v.webContents.mainFrame.executeJavaScript(checkGoneFinal, true);
          if (gone) { verified = true; break; }
        } catch {}
      }

      if (verified) {
        scLog('[sc-click] ✓ ✓ ✓ ALL STEPS DONE — START SHOW button gone → show is LIVE on Stripchat');
        logger.info('SC auto-click succeeded — show started');
      } else {
        scLog('[sc-click] ⚠ Go Live clicked but START SHOW still visible — show may not have started, check manually');
        logger.warn('SC Go Live clicked but START SHOW still present');
      }
    }

    restoreScView();
  } else {
    logger.info('Stream started', { platforms: activeDests.map(d => d.name) });
  }

  return { ok: true };
});

ipcMain.handle('desktop:go-offline', async () => {
  logger.info('Go offline: stopping');

  // ── Stripchat stop (soft fail — OBS stop always runs) ────────────────
  const hasStripchat = streamDestinations.some(d => d.name.toLowerCase() === 'stripchat');
  if (hasStripchat) {
    const scUrl = scView?.webContents.getURL() || '';
    logger.info('Go offline: clicking End Broadcasting on Stripchat', { scUrl });
    // Stripchat's stop button is labelled "End Broadcasting" (not "Stop Show").
    // Match that first, keep "stop show" as a fallback for any layout variant.
    const sr = await clickStripchatButton(/end\s*broadcast(ing)?|stop\s*show/i, 15000).catch(e => ({ ok: false, error: e.message }));
    if (sr.ok) {
      logger.info('Go offline: Stripchat End Broadcasting clicked');
    } else {
      logger.warn('Go offline: End Broadcasting not clicked', { error: sr.error, scUrl });
    }
  }

  // ── OBS ──────────────────────────────────────────────────────────────
  streamGuard.setWantLive(false);
  if (!obsClient) { logger.warn('Go offline: OBS not connected'); return { ok: false, stage: 'obs', error: friendlyStreamError('Not connected') }; }
  try {
    await obsClient.call('StopStream');
    logger.info('Go offline: OBS stream stopped');
    return { ok: true };
  } catch (err) {
    logger.error('Go offline: OBS stop failed', { error: err.message });
    return { ok: false, stage: 'obs', error: friendlyStreamError(err) };
  }
});

ipcMain.handle('desktop:toggle-broadcast-view', () => {
  if (!scView) return { visible: false };
  scViewVisible = !scViewVisible;
  if (scViewVisible && mainWindow) {
    const [w, h] = mainWindow.getContentSize();
    const top = TITLEBAR_H + SC_BAR_H;
    scView.setBounds({ x: 0, y: top, width: w, height: h - top });
  }
  scView.setVisible(scViewVisible);
  // Mutually exclusive: hide CB when SC becomes visible
  if (scViewVisible && cbViewVisible) {
    cbViewVisible = false;
    cbView?.setVisible(false);
  }
  const url = scViewVisible ? scView.webContents.getURL() : '';
  return { visible: scViewVisible, url, cbHidden: scViewVisible && !cbViewVisible };
});

ipcMain.handle('desktop:sc-navigate', (_e, { url }) => {
  if (!scView || !url) return;
  const full = url.startsWith('http') ? url : 'https://' + url;
  scView.webContents.loadURL(full);
});

ipcMain.handle('desktop:sc-go-back', () => {
  if (scView?.webContents.canGoBack()) scView.webContents.goBack();
});

ipcMain.handle('desktop:sc-go-forward', () => {
  if (scView?.webContents.canGoForward()) scView.webContents.goForward();
});

ipcMain.handle('desktop:toggle-cb-view', () => {
  if (!cbView) return { visible: false };
  cbViewVisible = !cbViewVisible;
  if (cbViewVisible && mainWindow) {
    const [w, h] = mainWindow.getContentSize();
    const top = TITLEBAR_H + SC_BAR_H;
    cbView.setBounds({ x: 0, y: top, width: w, height: h - top });
  }
  cbView.setVisible(cbViewVisible);
  // Mutually exclusive: hide SC when CB becomes visible
  if (cbViewVisible && scViewVisible) {
    scViewVisible = false;
    scView?.setVisible(false);
  }
  const url = cbViewVisible ? cbView.webContents.getURL() : '';
  return { visible: cbViewVisible, url, scHidden: cbViewVisible && !scViewVisible };
});

ipcMain.handle('desktop:cb-navigate', (_e, { url }) => {
  if (!cbView || !url) return;
  const full = url.startsWith('http') ? url : 'https://' + url;
  cbView.webContents.loadURL(full);
});

ipcMain.handle('desktop:cb-go-back', () => {
  if (cbView?.webContents.canGoBack()) cbView.webContents.goBack();
});

ipcMain.handle('desktop:cb-go-forward', () => {
  if (cbView?.webContents.canGoForward()) cbView.webContents.goForward();
});

function handleScWsFrame(raw) {
  scLog('PAGE: ' + raw.slice(0, 200));
  if (!raw.startsWith('42')) return;
  try {
    const parsed = JSON.parse(raw.slice(2));
    if (!Array.isArray(parsed)) return;
    const [event, data] = parsed;
    if (!data) return;

    const user = data?.user?.username || data?.from?.username || data?.username
      || data?.message?.user?.username || 'anon';

    switch (event) {
      case 'message':
      case 'chatMessage':
      case 'broadcast:user:message':
      case 'chat:message':
      case 'userMessage': {
        const text = data?.text || data?.message?.text || data?.message || data?.body || '';
        mainWindow?.webContents.send('desktop:chat-message', { type: 'chat', platform: 'stripchat', user, msg: text });
        break;
      }
      case 'tip':
      case 'tokenTip':
      case 'broadcast:tip': {
        const amount = data?.amount || data?.tokens || data?.tip?.amount || data?.tokensAmount || '?';
        mainWindow?.webContents.send('desktop:chat-message', { type: 'tip', platform: 'stripchat', user, msg: `tipped ${amount} tokens` });
        noteTip('stripchat', user, amount);
        break;
      }
      case 'follow':
      case 'fanclub':
      case 'fanclubJoin':
      case 'broadcast:follow':
        mainWindow?.webContents.send('desktop:chat-message', { type: 'follow', platform: 'stripchat', user, msg: 'followed' });
        break;
      default:
        mainWindow?.webContents.send('desktop:chat-message', {
          type: 'system', platform: 'stripchat', user: '',
          msg: `[SC:${event}] ${JSON.stringify(data).slice(0, 120)}`,
        });
    }
  } catch {}
}

ipcMain.handle('desktop:get-destinations', () => ({
  destinations: streamDestinations,
  disabledIds:  [...disabledDestIds],
}));

ipcMain.handle('desktop:toggle-destination', (_e, { id }) => {
  const idStr = String(id);
  const wasDisabled = disabledDestIds.has(idStr);
  if (wasDisabled) { disabledDestIds.delete(idStr); } else { disabledDestIds.add(idStr); }
  const dest = streamDestinations.find(d => String(d.id) === idStr);
  logger.info('Destination toggled', { id: idStr, name: dest?.name || '?', enabled: wasDisabled });
  return { disabledIds: [...disabledDestIds] };
});

ipcMain.handle('desktop:add-destination', async (_e, { name, rtmpUrl, streamKey, username }) => {
  const trimName = (name      || '').trim();
  const trimUrl  = (rtmpUrl   || '').trim();
  const trimKey  = (streamKey || '').trim();

  // Client-side validation (server enforces the same rules)
  if (!trimName) return { ok: false, error: 'Name is required.' };
  if (trimName.length > 255) return { ok: false, error: 'Name must be 255 characters or fewer.' };
  if (!/^rtmps?:\/\//i.test(trimUrl)) return { ok: false, error: 'RTMP URL must start with rtmp:// or rtmps://' };

  const r = await cloudAddDestination(storedToken, { name: trimName, rtmpUrl: trimUrl, streamKey: trimKey });
  if (!r.ok) return r;

  const cloudDest = r.destination; // {id, name, rtmpUrl, streamKey} — use server's id

  const ext = loadDestExtProps();
  if (!ext.props) ext.props = {};
  ext.props[String(cloudDest.id)] = { username: (username || '').trim(), eventsToken: '' };
  saveDestExtProps(ext);

  const merged = { ...cloudDest, username: (username || '').trim(), eventsToken: '' };
  streamDestinations.push(merged);
  streamPlatforms = streamDestinations.map(d => d.name);
  saveDestCache(streamDestinations);

  const wsPassword = obsMan.getOrCreateWsPassword();
  try { obsMan.initObsConfig({ destinations: streamDestinations, wsPort: OBS_WS_PORT, wsPassword }); } catch {}
  applyStreamService().catch(() => {});
  return { ok: true, destination: merged };
});

ipcMain.handle('desktop:remove-destination', async (_e, { id }) => {
  // Null-id is the server's read-only default row — cannot delete
  if (id === null || id === 'null' || id == null) {
    return { ok: false, error: 'Cannot remove the default destination.' };
  }

  const r = await cloudDeleteDestination(storedToken, id);
  // 404 = already gone on server — remove locally anyway
  if (!r.ok && r.status !== 404) return r;

  const ext = loadDestExtProps();
  if (ext.props) delete ext.props[String(id)];
  saveDestExtProps(ext);

  streamDestinations = streamDestinations.filter(d => String(d.id) !== String(id));
  streamPlatforms    = streamDestinations.map(d => d.name);
  saveDestCache(streamDestinations);

  const wsPassword = obsMan.getOrCreateWsPassword();
  try { obsMan.initObsConfig({ destinations: streamDestinations, wsPort: OBS_WS_PORT, wsPassword }); } catch {}
  applyStreamService().catch(() => {});
  return { ok: true };
});

ipcMain.handle('desktop:toggle-mute', async () => {
  if (!obsClient) return { ok: false, muted: false, error: friendlyStreamError('Not connected') };
  try {
    if (!cachedMicName) {
      const specials = await obsClient.call('GetSpecialInputs');
      cachedMicName  = specials.mic1 || specials.mic2 || 'Mic/Aux';
    }
    const { inputMuted } = await obsClient.call('ToggleInputMute', { inputName: cachedMicName });
    logger.info('Mic mute changed', { muted: inputMuted, source: 'user' });
    return { ok: true, muted: inputMuted };
  } catch (err) {
    logger.error('Mic mute toggle failed', { error: err.message });
    return { ok: false, error: err.message, muted: false };
  }
});

ipcMain.handle('desktop:set-events-token', (_e, { id, token }) => {
  const dest = streamDestinations.find(d => String(d.id) === String(id));
  if (!dest) return { ok: false, error: 'Not found' };
  dest.eventsToken = token || '';

  const ext = loadDestExtProps();
  if (!ext.props) ext.props = {};
  const key = String(id);
  if (!ext.props[key]) ext.props[key] = { username: dest.username || '' };
  ext.props[key].eventsToken = token || '';
  saveDestExtProps(ext);

  saveDestCache(streamDestinations);
  stopEventsPolling();
  stopViewerCountPolling();
  if (token) { startEventsPolling(); startViewerCountPolling(); }
  return { ok: true };
});

ipcMain.handle('desktop:set-username', (_e, { id, username }) => {
  const dest = streamDestinations.find(d => String(d.id) === String(id));
  if (!dest) return { ok: false, error: 'Not found' };
  dest.username = (username || '').trim();

  const ext = loadDestExtProps();
  if (!ext.props) ext.props = {};
  const key = String(id);
  if (!ext.props[key]) ext.props[key] = { eventsToken: dest.eventsToken || '' };
  ext.props[key].username = dest.username;
  saveDestExtProps(ext);
  saveDestCache(streamDestinations);
  return { ok: true };
});

// ── Remote logs ───────────────────────────────────────────────────────────────
ipcMain.handle('desktop:get-remote-logs', async (_e, params) => {
  return logger.getLogs(params || {});
});

// Live program monitor: returns a JPEG screenshot (data URL) of OBS's current
// program scene so the renderer can show what's being streamed while the
// physical camera is owned by OBS. Small + compressed to stay light at a few fps.
ipcMain.handle('desktop:get-program-frame', async () => {
  if (!obsClient) return { ok: false };
  try {
    const { currentProgramSceneName } = await obsClient.call('GetCurrentProgramScene');
    const res = await obsClient.call('GetSourceScreenshot', {
      sourceName:              currentProgramSceneName,
      imageFormat:             'jpg',
      imageWidth:              480,
      imageCompressionQuality: 45,
    });
    return { ok: true, dataUrl: res.imageData };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Tip goal
ipcMain.handle('desktop:goal-get', () => getTipGoal().getView());
ipcMain.handle('desktop:goal-set', (_e, c) => { getTipGoal().configure(c); saveGoalConfig(); return getTipGoal().getView(); });
ipcMain.handle('desktop:goal-reset', () => { getTipGoal().reset(); return getTipGoal().getView(); });

// Tip menu
ipcMain.handle('desktop:tipmenu-get', () => loadTipMenu());
ipcMain.handle('desktop:tipmenu-set', async (_e, c) => {
  tipMenuCfg = { text: String(c?.text || '').slice(0, 800), enabled: !!c?.enabled };
  try { fs.writeFileSync(tipMenuPath(), JSON.stringify(tipMenuCfg), 'utf8'); } catch {}
  await ensureTipMenuSource();
  return tipMenuCfg;
});

// Promo text overlay (top-left of stream)
ipcMain.handle('desktop:get-overlay', () => loadOverlayConfig());
ipcMain.handle('desktop:set-overlay', async (_e, cfg) => {
  saveOverlayConfig(cfg);
  await ensureOverlaySource();
  await ensureGoalSource();
  await ensureTipMenuSource();
  return { ok: true, ...overlayConfig };
});

// ── Admin logs (all users) ────────────────────────────────────────────────────
function getAdminCreds() {
  // 1. Environment variables (set before launching the app)
  if (process.env.DASHBOARD_USER && process.env.DASHBOARD_PASS) {
    return { username: process.env.DASHBOARD_USER, password: process.env.DASHBOARD_PASS };
  }
  // 2. Local config file in userData — never committed to git
  try {
    const cfgPath = path.join(app.getPath('userData'), 'admin-config.json');
    return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {}
  // 3. Built-in fallback from the gitignored secrets file so the Admin overview
  // can fetch all-user logs on any machine with no setup.
  if (_secrets.DASHBOARD_USER && _secrets.DASHBOARD_PASS) {
    return { username: _secrets.DASHBOARD_USER, password: _secrets.DASHBOARD_PASS };
  }
  return null;
}

async function ensureAdminSession() {
  if (adminSessionCookie) return true;
  const creds = getAdminCreds();
  if (!creds) return false;
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(creds),
    signal:  AbortSignal.timeout(10000),
  });
  if (!res.ok) return false;
  adminSessionCookie = res.headers.get('set-cookie');
  return true;
}

// Fetch one page of admin desktop-logs. Returns { ok, logs, nextBefore, error }.
async function fetchAdminLogsPage(params = {}) {
  try {
    if (!(await ensureAdminSession())) {
      return { ok: false, error: 'Admin credentials not configured.' };
    }
    const qs = new URLSearchParams();
    qs.set('limit', String(params.limit || 200));
    if (params.before)   qs.set('before',   String(params.before));
    if (params.username) qs.set('username',  params.username);
    if (params.level)    qs.set('level',     params.level);

    const r = await fetch(`${API_BASE}/api/admin/desktop-logs?${qs}`, {
      headers: { 'Cookie': adminSessionCookie },
      signal:  AbortSignal.timeout(15000),
    });
    if (r.status === 401) { adminSessionCookie = null; return { ok: false, error: 'Session expired — try again' }; }
    if (!r.ok) return { ok: false, error: `Server error ${r.status}` };
    const data = await r.json();
    return { ok: true, logs: data.logs || [], nextBefore: data.nextBefore };
  } catch (err) {
    adminSessionCookie = null;
    return { ok: false, error: err.message };
  }
}

ipcMain.handle('desktop:get-admin-logs', async (_e, params = {}) => fetchAdminLogsPage(params));

// Admin overview: pulls several pages of logs and derives a live picture of who
// is using the app — total accounts, who is broadcasting right now, app-version
// spread, and a recent activity feed. Derived entirely from desktop-logs since
// the server exposes no dedicated users/live endpoints.
ipcMain.handle('desktop:get-admin-overview', async () => {
  // Pull up to ~5 pages (newest first) for a useful window without hammering the API.
  let all = [];
  let before;
  for (let i = 0; i < 5; i++) {
    const page = await fetchAdminLogsPage({ limit: 200, before });
    if (!page.ok) {
      if (i === 0) return { ok: false, error: page.error };
      break;
    }
    all = all.concat(page.logs);
    if (!page.nextBefore || page.logs.length === 0) break;
    before = page.nextBefore;
  }

  const tsOf = l => new Date(l.serverTs || l.createdAt || l.clientTs || 0).getTime();
  all.sort((a, b) => tsOf(a) - tsOf(b)); // oldest → newest

  const now      = Date.now();
  const LIVE_WIN = 12 * 60 * 1000; // consider a "live" flag stale after 12 min of silence
  const ACT_WIN  = 15 * 60 * 1000; // "active session" = any log in the last 15 min
  const users = new Map(); // username → state

  const userOf = name => {
    if (!users.has(name)) {
      users.set(name, { username: name, userId: null, version: null, lastTs: 0, live: false, liveSince: 0, lastSession: null });
    }
    return users.get(name);
  };

  for (const l of all) {
    const name = l.username || `user#${l.userId ?? '?'}`;
    const u = userOf(name);
    const t = tsOf(l);
    u.userId      = l.userId ?? u.userId;
    if (l.appVersion) u.version = l.appVersion;
    if (l.sessionId)  u.lastSession = l.sessionId;
    if (t > u.lastTs) u.lastTs = t;

    const msg = (l.message || '');
    const ctx = l.context || {};
    // Live transitions
    if (/OBS stream started/i.test(msg) || /SC auto-click succeeded/i.test(msg) ||
        (/OBS stream state changed/i.test(msg) && ctx.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED')) {
      u.live = true; u.liveSince = t;
    }
    if (/OBS stream stopped/i.test(msg) || /Go offline/i.test(msg) || /App closing/i.test(msg) ||
        (/OBS stream state changed/i.test(msg) && ctx.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED')) {
      u.live = false;
    }
    if (/App started/i.test(msg)) { u.live = false; } // fresh launch = not live yet
  }

  const list = [...users.values()];
  const liveNow = list
    .filter(u => u.live && (now - u.lastTs) < LIVE_WIN)
    .map(u => ({ username: u.username, version: u.version, sinceMs: u.liveSince, lastTs: u.lastTs }))
    .sort((a, b) => a.sinceMs - b.sinceMs);
  const activeSessions = list.filter(u => (now - u.lastTs) < ACT_WIN).length;

  const versions = {};
  for (const u of list) if (u.version) versions[u.version] = (versions[u.version] || 0) + 1;

  // Recent notable events feed (newest first)
  const notable = all.filter(l => {
    const m = l.message || '';
    return /App started|OBS stream started|Go offline|OBS stream stopped|SC auto-click|username auto-detected/i.test(m)
        || l.level === 'error' || l.level === 'warn';
  }).slice(-60).reverse().map(l => ({
    ts: l.serverTs || l.clientTs || l.createdAt, username: l.username || '?',
    level: l.level, message: l.message, version: l.appVersion,
  }));

  return {
    ok: true,
    generatedAt: now,
    totalAccounts: list.length,
    liveCount: liveNow.length,
    activeSessions,
    liveNow,
    versions,
    accounts: list.map(u => ({
      username: u.username, version: u.version, lastTs: u.lastTs, live: liveNow.some(x => x.username === u.username),
    })).sort((a, b) => b.lastTs - a.lastTs),
    events: notable,
    logCount: all.length,
  };
});

// Per-account drill-down: recent logs filtered to one model, plus derived
// sessions / platforms / live state and a timeline. Read-only, works today.
ipcMain.handle('desktop:get-account-detail', async (_e, { username }) => {
  if (!username) return { ok: false, error: 'No username' };
  let all = [];
  let before;
  for (let i = 0; i < 4; i++) {
    const page = await fetchAdminLogsPage({ limit: 200, username, before });
    if (!page.ok) { if (i === 0) return { ok: false, error: page.error }; break; }
    all = all.concat(page.logs);
    if (!page.nextBefore || page.logs.length === 0) break;
    before = page.nextBefore;
  }
  const tsOf = l => new Date(l.serverTs || l.createdAt || l.clientTs || 0).getTime();
  all.sort((a, b) => tsOf(a) - tsOf(b));

  const sessions = new Set();
  const platforms = new Set();
  let version = null, userId = null, live = false, liveSince = 0, lastTs = 0, goLiveCount = 0;
  for (const l of all) {
    if (l.sessionId)      sessions.add(l.sessionId);
    if (l.appVersion)     version = l.appVersion;
    if (l.userId != null) userId = l.userId;
    const t = tsOf(l); if (t > lastTs) lastTs = t;
    const ctx = l.context || {};
    const msg = l.message || '';
    if (Array.isArray(ctx.platforms)) {
      ctx.platforms.forEach(p => { const n = typeof p === 'string' ? p : p?.name; if (n) platforms.add(n); });
    }
    if (/OBS stream started/i.test(msg)) { live = true; liveSince = t; goLiveCount++; }
    if (/OBS stream stopped|Go offline|App closing/i.test(msg)) live = false;
    if (/App started/i.test(msg)) live = false;
  }
  const now = Date.now();
  const timeline = all.slice(-100).reverse().map(l => ({
    ts: l.serverTs || l.clientTs || l.createdAt, level: l.level, message: l.message,
    context: l.context, version: l.appVersion,
  }));
  return {
    ok: true, username, userId, version,
    live: live && (now - lastTs) < 12 * 60 * 1000,
    liveSince, lastTs, sessionCount: sessions.size,
    platforms: [...platforms], goLiveCount, logCount: all.length, timeline,
  };
});

// Admin "Open as" — logs the app in AS a model by asking the backend to mint a
// desktop token for them. Requires a server endpoint that does not exist yet;
// returns { notAvailable:true } until it's deployed, so the UI can explain it.
ipcMain.handle('desktop:impersonate', async (_e, { userId, username }) => {
  try {
    if (!(await ensureAdminSession())) return { ok: false, error: 'Admin session unavailable.' };
    const res = await fetch(`${API_BASE}/api/admin/impersonate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': adminSessionCookie },
      body:    JSON.stringify({ userId, username }),
      signal:  AbortSignal.timeout(12000),
    });
    if (res.status === 404 || res.status === 405) {
      return { ok: false, notAvailable: true, error: 'Server has no /api/admin/impersonate endpoint yet — add it to enable Open-as.' };
    }
    if (!res.ok) return { ok: false, error: `Server error ${res.status}` };
    let data = {};
    try { data = await res.json(); } catch {}
    const token = data.token || data.desktopToken;
    if (!token) return { ok: false, error: 'Server did not return a token.' };
    logger.info('Admin impersonation', { username, userId });
    await bootstrapModelSession(token, username || `user#${userId}`);
    return { ok: true, username: username || `user#${userId}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Admin "Create account" — creates a real model account on the backend so it
// can log in / be impersonated like any other. Requires a server endpoint.
ipcMain.handle('desktop:admin-create-account', async (_e, { username, password }) => {
  try {
    const u = (username || '').trim();
    if (!u || !password) return { ok: false, error: 'Username and password are required.' };
    if (!(await ensureAdminSession())) return { ok: false, error: 'Admin session unavailable.' };
    const res = await fetch(`${API_BASE}/api/admin/create-account`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': adminSessionCookie },
      body:    JSON.stringify({ username: u, password }),
      signal:  AbortSignal.timeout(12000),
    });
    if (res.status === 404 || res.status === 405) {
      return { ok: false, notAvailable: true, error: 'Server has no /api/admin/create-account endpoint yet.' };
    }
    if (res.status === 409) return { ok: false, error: 'That username is already taken.' };
    if (!res.ok) {
      let e = ''; try { e = (await res.json()).error || ''; } catch {}
      return { ok: false, error: e || `Server error ${res.status}` };
    }
    let data = {}; try { data = await res.json(); } catch {}
    logger.info('Admin created account', { username: u, userId: data.userId });
    return { ok: true, username: u, userId: data.userId };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Read an account's real cloud destinations (platforms / rtmp / stream keys) for
// the admin detail view. Uses an impersonation token to read with the model's
// own auth, but does NOT switch the running session (no OBS/dashboard change).
ipcMain.handle('desktop:get-account-destinations', async (_e, { userId, username }) => {
  try {
    if (!(await ensureAdminSession())) return { ok: false, error: 'Admin session unavailable.' };
    const imp = await fetch(`${API_BASE}/api/admin/impersonate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': adminSessionCookie },
      body:    JSON.stringify({ userId, username }),
      signal:  AbortSignal.timeout(12000),
    });
    if (imp.status === 404 || imp.status === 405) return { ok: false, notAvailable: true };
    if (!imp.ok) return { ok: false, error: `impersonate ${imp.status}` };
    let token; try { const d = await imp.json(); token = d.token || d.desktopToken; } catch {}
    if (!token) return { ok: false, error: 'No token returned.' };
    // Read destinations with the model's own token (no global session side-effects).
    const { status, data } = await apiFetch('GET', '/api/desktop/destinations', null, token);
    if (status !== 200) return { ok: false, error: `destinations ${status}` };
    return { ok: true, destinations: data.destinations || [] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Debug info ────────────────────────────────────────────────────────────────
ipcMain.handle('desktop:get-debug-info', async () => {
  const obsDir    = obsMan.getObsDir();
  const configDir = path.join(obsDir, 'config', 'obs-studio');

  let obsLog = '(no log found)';
  try {
    const logDir  = path.join(configDir, 'logs');
    const entries = fs.readdirSync(logDir)
      .map(f => ({ f, mt: fs.statSync(path.join(logDir, f)).mtimeMs }))
      .sort((a, b) => b.mt - a.mt);
    if (entries.length) {
      const raw   = fs.readFileSync(path.join(logDir, entries[0].f), 'utf8');
      const lines = raw.split('\n');
      obsLog = `[${entries[0].f}] (${lines.length} lines)\n` + raw;
    }
  } catch (err) { obsLog = `Log read error: ${err.message}`; }

  let serviceJson = '(not found)';
  try {
    serviceJson = fs.readFileSync(
      path.join(configDir, 'basic', 'profiles', 'TMT', 'service.json'), 'utf8');
  } catch {}

  let obsProcs = '(unknown)';
  try {
    obsProcs = execSync(
      'tasklist /FI "IMAGENAME eq obs64.exe" /NH /FO CSV',
      { encoding: 'utf8', timeout: 3000 }
    ).trim() || '(none)';
  } catch {}

  let destCacheFile = '(not found)';
  try { destCacheFile = fs.readFileSync(destCachePath(), 'utf8'); } catch {}

  let destExtFile = '(not found)';
  try { destExtFile = fs.readFileSync(destExtPath(), 'utf8'); } catch {}

  let activeProfile = '(not connected)';
  let streamService = '(not connected)';
  if (obsClient) {
    try { const p = await obsClient.call('GetProfileList'); activeProfile = p.currentProfileName; } catch {}
    try { const s = await obsClient.call('GetStreamServiceSettings'); streamService = JSON.stringify(s, null, 2); } catch {}
  }

  return {
    ts:                  new Date().toISOString(),
    obsWsPort:           OBS_WS_PORT,
    obsWsConnected:      !!obsClient,
    activeProfile,
    streamService,
    streamDestinations,
    destinationsOnDisk:  destCacheFile,
    destExtFile,
    obsProcesses:        obsProcs,
    obsDir,
    userData:            app.getPath('userData'),
    serviceJson,
    obsLog,
    scWsLog:             scWsLog.join('\n'),
    scViewUrl:           scView ? scView.webContents.getURL() : '(no view)',
    chatReaderUrl:       chatManager?.getView('stripchat')?.webContents.getURL() ?? '(no view)',
  };
});

// ── Open URL in default browser ───────────────────────────────────────────────
ipcMain.handle('desktop:open-external', (_e, { url }) => {
  shell.openExternal(url);
});

// ── Broadcast view (Stripchat broadcast centre — model-facing) ───────────────
function createBroadcastView() {
  scView = new WebContentsView({
    webPreferences: {
      partition:            'persist:stripchat',
      backgroundThrottling: false,
      contextIsolation:     true,
      nodeIntegration:      false,
    },
  });
  mainWindow.contentView.addChildView(scView);
  scView.setVisible(false);

  // ── Chat observer + popup auto-dismisser — injected on each page load ──────────
  const scPlatform = chatConfig.platforms.find(p => p.id === 'stripchat');

  // Auto-dismiss Stripchat warning popups (e.g. "B-Frames cause lagging").
  // Runs every 2 s; only clicks OK when the dialog mentions B-Frames or similar.
  const scPopupDismisser = `(function(){
  if (window.__tmtPopupDismisser) return;
  window.__tmtPopupDismisser = true;
  setInterval(function() {
    var sel = '[role="dialog"],[class*="modal" i],[class*="popup" i],[class*="overlay" i],[class*="alert" i]';
    var dialogs = Array.from(document.querySelectorAll(sel));
    for (var i = 0; i < dialogs.length; i++) {
      var txt = dialogs[i].textContent || '';
      if (/b.?frame/i.test(txt) || /lagging/i.test(txt) || /bad.*audio/i.test(txt)) {
        var btn = Array.from(dialogs[i].querySelectorAll('button')).find(function(b){
          return /^ok$/i.test((b.innerText||b.textContent||'').trim());
        });
        if (btn) { btn.click(); break; }
      }
    }
  }, 2000);
})();`;

  scChatScript = scPlatform
    ? `if (!window.__tmtChatInjected) { window.__tmtChatInjected = true; ${ChatManager.makeInjection(scPlatform.selectors || {}, 'stripchat')} } ${scPopupDismisser}`
    : scPopupDismisser;

  scView.webContents.on('console-message', (_e, _level, msg) => {
    if (msg.startsWith('__CHAT_LOG__')) { scLog('[sc-chat] ' + msg.slice(12)); return; }
    if (!msg.startsWith('__CHAT__')) return;
    lastScChatEventMs = Date.now(); // alive-check for auto-fixer
    try {
      const event = JSON.parse(msg.slice(8));
      chatManager?.emitEvent(event);
    } catch {}
  });

  // Reset readiness only on real full-page navigations, not SPA in-page routing.
  // Stripchat is a React SPA — did-start-navigation fires on every route change but
  // did-finish-load only fires once, so scViewReady would stay false forever if we
  // reset on every navigation.
  scView.webContents.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      scViewReady = false;
      scView.webContents.executeJavaScript('window.__tmtChatInjected = false;', true).catch(() => {});
      if (_url && _url.includes('stripchat.com')) sendStartupStatus('broadcast', 'loading', 'Loading broadcast page…');
    }
  });

  // Mark ready when the page finishes loading; inject chat observer; save cookies.
  scView.webContents.on('did-finish-load', () => {
    scViewReady = true;
    const url = scView.webContents.getURL();
    const onSc = url.includes('stripchat.com') && !url.includes('/login') && !url.includes('/signin');
    if (onSc) sendStartupStatus('broadcast', 'done', 'Broadcast page ready');
    if (scChatScript) {
      if (onSc) sendStartupStatus('chat', 'loading', 'Setting up chat…');
      scView.webContents.executeJavaScript(scChatScript, true)
        .then(() => {
          scLog('[sc-chat] observer injected into broadcast view');
          if (onSc) sendStartupStatus('chat', 'done', 'Chat ready');
        })
        .catch(e => {
          scLog('[sc-chat] inject error: ' + e.message);
          if (onSc) sendStartupStatus('chat', 'error', 'Chat inject failed');
        });
    } else if (onSc) {
      sendStartupStatus('chat', 'skip', '');
    }
    if (url.includes('stripchat.com') && !url.includes('/login') && !url.includes('/signin') && storedToken) {
      cookieSync.saveCookies(storedToken, 'stripchat', 'persist:stripchat')
        .then(r => scLog(`[cookie-sync] save → ${r.ok ? 'OK' : ('FAIL ' + (r.reason || ''))}`))
        .catch(e => scLog('[cookie-sync] save error: ' + e.message));
    }
  });

  // Forward URL changes to the renderer URL bar; detect post-login and redirect to room.
  let lastScUrl = getScRoomUrl() || 'https://stripchat.com/start-broadcasting';
  const sendUrl = (_e, url) => {
    try { mainWindow?.webContents.send('sc-url-changed', url); } catch {}
    // SPA routing: page is interactive after in-page navigation completes.
    if (url.includes('stripchat.com')) {
      scViewReady = true;
      sendStartupStatus('broadcast', 'done', 'Broadcast page ready');
    }
    logger.info('SC view navigated', { url });
    const wasLogin = lastScUrl.includes('/login') || lastScUrl.includes('/signin');
    // Auto-detect the model's own username: /start-broadcasting always redirects
    // a logged-in model to their own room (/<username>), so capturing the slug
    // on that transition is reliable and means no per-machine config is needed.
    if (lastScUrl.includes('/start-broadcasting')) {
      const detected = extractScUsername(url);
      if (detected) persistScUsername(detected);
    }
    lastScUrl = url;
    // After a manual Stripchat login, auto-navigate to the model's broadcast centre.
    if (wasLogin && url.includes('stripchat.com') && !url.includes('/login') && !url.includes('/signin')) {
      const roomUrl = getScRoomUrl();
      if (roomUrl && !url.startsWith(roomUrl)) {
        scLog('[sc-view] Stripchat login detected → navigating to broadcast centre');
        logger.info('SC login detected — redirecting to broadcast centre', { from: url, to: roomUrl });
        setTimeout(() => { try { scView?.webContents.loadURL(roomUrl); } catch {} }, 500);
      }
    }
  };
  scView.webContents.on('did-navigate',         sendUrl);
  scView.webContents.on('did-navigate-in-page', sendUrl);

  // Recover if the renderer crashes
  scView.webContents.on('render-process-gone', (_e, details) => {
    scLog(`[sc-view] renderer gone (${details?.reason || 'unknown'}) — reloading in 3s`);
    logger.warn('SC broadcast view crashed', { reason: details?.reason });
    setTimeout(() => {
      try { scView?.webContents.loadURL(getScRoomUrl() || 'https://stripchat.com/start-broadcasting'); } catch {}
    }, 3000);
  });

  // Returning users (auto-login at startup): destinations are already loaded, so
  // getScRoomUrl() returns the room URL and we skip the login page entirely.
  // New users (no saved token): getScRoomUrl() returns null → load login page.
  scView.webContents.loadURL(getScRoomUrl() || 'https://stripchat.com/start-broadcasting');

  function updateBounds() {
    if (!mainWindow || !scView) return;
    const [w, h] = mainWindow.getContentSize();
    const top = TITLEBAR_H + SC_BAR_H;
    scView.setBounds({ x: 0, y: top, width: w, height: h - top });
  }
  updateBounds();
  mainWindow.on('resize', updateBounds);
}

// ── Chaturbate panel view ────────────────────────────────────────────────────
function createCbView() {
  cbView = new WebContentsView({
    webPreferences: {
      partition:            'persist:chaturbate',
      backgroundThrottling: false,
      contextIsolation:     true,
      nodeIntegration:      false,
    },
  });
  mainWindow.contentView.addChildView(cbView);
  cbView.setVisible(false);

  const sendCbUrl = (_e, url) => {
    try { mainWindow?.webContents.send('cb-url-changed', url); } catch {}
  };
  cbView.webContents.on('did-navigate',         sendCbUrl);
  cbView.webContents.on('did-navigate-in-page', sendCbUrl);

  cbView.webContents.on('did-finish-load', () => {
    const url = cbView.webContents.getURL();
    if (url.includes('chaturbate.com') && !url.includes('/auth/') && storedToken) {
      cookieSync.saveCookies(storedToken, 'chaturbate', 'persist:chaturbate')
        .then(r => scLog(`[cookie-sync] cb save → ${r.ok ? 'OK' : ('FAIL ' + (r.reason || ''))}`))
        .catch(e => scLog('[cookie-sync] cb save error: ' + e.message));
    }
  });

  cbView.webContents.on('render-process-gone', (_e, details) => {
    logger.warn('CB broadcast view crashed', { reason: details?.reason });
    setTimeout(() => {
      try { cbView?.webContents.loadURL(getCbRoomUrl() || 'https://chaturbate.com/'); } catch {}
    }, 3000);
  });

  cbView.webContents.loadURL(getCbRoomUrl() || 'https://chaturbate.com/');

  function updateCbBounds() {
    if (!mainWindow || !cbView) return;
    const [w, h] = mainWindow.getContentSize();
    const top = TITLEBAR_H + SC_BAR_H;
    cbView.setBounds({ x: 0, y: top, width: w, height: h - top });
  }
  updateCbBounds();
  mainWindow.on('resize', updateCbBounds);
}

async function clickStripchatButton(pattern, timeoutMs = 15000, opts = {}) {
  const chatView = chatManager?.getView('stripchat');
  const viewsToTry = [];
  // scView first — it has correct bounds so sendInputEvent coordinates are valid.
  // chatView is 1×1 px and needs a temporary resize before native events work.
  if (scView)   viewsToTry.push({ view: scView,   label: 'broadcast-view' });
  if (chatView) viewsToTry.push({ view: chatView, label: 'chat-reader' });

  if (viewsToTry.length === 0) {
    const err = 'No SC views available';
    scLog(`[sc-click] FAIL — ${err}`);
    logger.error('SC button click failed', { reason: err });
    return { ok: false, error: err };
  }

  const urls = viewsToTry.map(v => `${v.label}:${v.view.webContents.getURL()}`).join(', ');
  scLog(`[sc-click] looking for ${pattern} — views: ${urls}`);
  logger.info('SC button click attempt', { pattern: pattern.toString(), views: urls });

  // Find button/checkbox, invoke its React onClick fiber directly (bypasses isTrusted),
  // then also fire a native OS click as belt-and-suspenders.
  // Returns JSON: { method, text, x, y } or null if button not found.
  const isCheckbox = !!opts.isCheckbox;
  const clickScript = `(function(){
  var re = ${pattern.toString()};
  var isCheckbox = ${isCheckbox};
  // For checkboxes: find by nearby label text. For buttons: find by button text.
  var el;
  if (isCheckbox) {
    // Find a checkbox whose label/sibling text matches the pattern.
    var labels = Array.from(document.querySelectorAll('label, [class*="checkbox"], [class*="Checkbox"]'));
    var lbl = labels.find(function(l){ return re.test((l.innerText || l.textContent || '').trim()); });
    if (lbl) {
      el = lbl.querySelector('input[type="checkbox"]') || lbl;
    } else {
      // Try finding input[type=checkbox] near matching text
      var allCbs = Array.from(document.querySelectorAll('input[type="checkbox"]'));
      el = allCbs.find(function(cb){
        var p = cb.closest('label') || cb.parentElement;
        return p && re.test((p.innerText || p.textContent || '').trim());
      }) || allCbs[allCbs.length - 1]; // last checkbox in the modal as fallback
    }
  } else {
    el = Array.from(document.querySelectorAll('button,[role="button"]'))
      .find(function(b){ return re.test((b.innerText || b.textContent || '').trim()); });
  }
  if (!el) return null;

  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  var text = (el.innerText || el.textContent || '').trim().slice(0, 60) || el.type || 'element';
  var r  = el.getBoundingClientRect();
  var cx = Math.round(r.left + r.width  / 2);
  var cy = Math.round(r.top  + r.height / 2);

  // Method 1: walk the React fiber to call onChange/onClick directly — isTrusted irrelevant.
  try {
    var fk = Object.keys(el).find(function(k){
      return k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance');
    });
    if (fk) {
      var f = el[fk];
      for (var depth = 0; f && depth < 6; depth++, f = f.return) {
        var p = f.memoizedProps || f.pendingProps;
        var handler = p && (p.onChange || p.onClick);
        if (typeof handler === 'function') {
          handler({
            preventDefault: function(){}, stopPropagation: function(){},
            stopImmediatePropagation: function(){}, nativeEvent: {},
            target: el, currentTarget: el,
            type: isCheckbox ? 'change' : 'click', bubbles: true, checked: true,
          });
          return JSON.stringify({ method: 'fiber', text: text, x: cx, y: cy });
        }
      }
    }
  } catch(e) {}

  // Method 2: native DOM click.
  try { el.click(); } catch(e) {}
  return JSON.stringify({ method: 'native', text: text, x: cx, y: cy });
})()`;

  // true = button is GONE (show went live)
  const checkGoneScript = `(function(){
  var re = ${pattern.toString()};
  return !Array.from(document.querySelectorAll('button,[role="button"]'))
    .find(function(el){ return re.test((el.innerText || el.textContent || '').trim()); });
})()`;

  const diagScript = `(function(){
  return Array.from(document.querySelectorAll('button,[role="button"]'))
    .map(function(b){ return (b.innerText||b.textContent||'').trim().slice(0,40); })
    .filter(Boolean).join(' | ');
})()`;

  // Phase 1 — find and click.
  let clickedView = null;
  let clickedLabel = null;
  const deadline = Date.now() + timeoutMs;

  outer: while (Date.now() < deadline) {
    for (const { view, label } of viewsToTry) {
      try {
        const raw = await view.webContents.mainFrame.executeJavaScript(clickScript, true);
        if (!raw) { await new Promise(r => setTimeout(r, 500)); continue; }
        const info = JSON.parse(raw);

        // Also fire a real OS-level mouse event as belt-and-suspenders.
        try {
          const wc     = view.webContents;
          const bounds = view.getBounds();
          const needsResize = bounds.width < info.x + 10 || bounds.height < info.y + 10;
          if (needsResize) view.setBounds({ x: 0, y: 0, width: info.x + 200, height: info.y + 200 });
          wc.focus();
          wc.sendInputEvent({ type: 'mouseMove', x: info.x, y: info.y });
          await new Promise(r => setTimeout(r, 40));
          wc.sendInputEvent({ type: 'mouseDown', x: info.x, y: info.y, button: 'left', clickCount: 1 });
          await new Promise(r => setTimeout(r, 40));
          wc.sendInputEvent({ type: 'mouseUp',   x: info.x, y: info.y, button: 'left', clickCount: 1 });
          if (needsResize) view.setBounds(bounds);
        } catch {}

        scLog(`[sc-click] ${info.method} click "${info.text}" at (${info.x},${info.y}) on ${label} — verifying in 3s…`);
        logger.info('SC click sent', { method: info.method, buttonText: info.text, x: info.x, y: info.y, view: label });
        clickedView  = view;
        clickedLabel = label;
        break outer;
      } catch (e) {
        scLog(`[sc-click] ${label} error: ${e.message?.slice(0, 80)}`);
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }

  if (!clickedView) {
    const diagParts = [];
    for (const { view, label } of viewsToTry) {
      try {
        const btns = await view.webContents.mainFrame.executeJavaScript(diagScript, true);
        diagParts.push(`${label}(${view.webContents.getURL().split('/').pop()}): ${btns || 'none'}`);
      } catch { diagParts.push(`${label}: diagnostic failed`); }
    }
    const buttonsFound = diagParts.join(' || ');
    const reason = `timeout after ${timeoutMs}ms — ${buttonsFound}`;
    scLog(`[sc-click] FAIL — ${reason}`);
    logger.error('SC button click timed out', { pattern: pattern.toString(), buttonsFound });
    return { ok: false, error: reason };
  }

  // Phase 2 — verify: if the button disappeared the show is live.
  // Skip verification for intermediate steps (checkbox, modal) — only verify the final click.
  if (opts.skipVerify) return { ok: true };

  await new Promise(r => setTimeout(r, 3000));
  try {
    const gone = await clickedView.webContents.mainFrame.executeJavaScript(checkGoneScript, true);
    if (gone) {
      scLog(`[sc-click] ✓ VERIFIED — button gone, show is LIVE (${clickedLabel})`);
      logger.info('SC show confirmed live', { view: clickedLabel });
      return { ok: true };
    }
    const reason = 'click sent but "Start Show" still present — show did not start';
    scLog(`[sc-click] FAIL — ${reason}`);
    logger.warn('SC native click did not start show', { view: clickedLabel });
    return { ok: false, error: reason };
  } catch {
    scLog('[sc-click] could not verify button state — assuming live');
    logger.warn('SC click verification failed (frame error)', { view: clickedLabel });
    return { ok: true };
  }
}

// ── Update check ──────────────────────────────────────────────────────────────
function semverGt(a, b) {
  const pa = String(a).replace(/[^0-9.]/g, '').split('.').map(Number);
  const pb = String(b).replace(/[^0-9.]/g, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

function checkForUpdates(silent = false) {
  const platform     = process.platform === 'win32' ? 'windows'
                     : process.platform === 'darwin' ? 'macos'
                     : 'linux';
  const localVersion = app.getVersion();
  const url          = `${API_BASE}/api/desktop/version?platform=${platform}`;

  const req = https.get(url, (res) => {
    let body = '';
    res.on('data', chunk => { body += chunk; });
    res.on('end', () => {
      try {
        const { version: serverVersion } = JSON.parse(body);
        if (!serverVersion) return;

        if (semverGt(serverVersion, localVersion)) {
          dialog.showMessageBox(mainWindow, {
            type:      'info',
            title:     'Update Available',
            message:   `TMT Native ${serverVersion} is available`,
            detail:    `You're on v${localVersion}. Download the latest version from the TMT Agency dashboard.`,
            buttons:   ['Download Now', 'Later'],
            defaultId: 0,
          }).then(({ response }) => {
            if (response === 0) shell.openExternal(`${API_BASE}/download-app`);
          }).catch(() => {});
        } else if (!silent) {
          dialog.showMessageBox(mainWindow, {
            type:    'info',
            title:   'Up to Date',
            message: `TMT Native v${localVersion} is the latest version.`,
            buttons: ['OK'],
          }).catch(() => {});
        }
      } catch { /* ignore malformed response */ }
    });
  });

  req.on('error', (err) => {
    if (!silent) {
      dialog.showMessageBox(mainWindow, {
        type:    'warning',
        title:   'Update Check Failed',
        message: 'Could not connect to the update server.',
        detail:  err.message,
        buttons: ['OK'],
      }).catch(() => {});
    }
  });

  req.setTimeout(8000, () => { req.destroy(); });
}

ipcMain.handle('desktop:check-for-updates', () => checkForUpdates(false));
ipcMain.handle('desktop:get-app-version',   () => app.getVersion());

ipcMain.handle('desktop:sc-login-status', async () => {
  if (!scView) return { loggedIn: false };
  try {
    // If Stripchat redirected to a login/signin page the user is not logged in.
    const url = scView.webContents.getURL();
    return { loggedIn: url.includes('stripchat.com') &&
                       !url.includes('/login') &&
                       !url.includes('/signin') };
  } catch {
    return { loggedIn: false };
  }
});

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:           1280,
    height:          800,
    minWidth:        900,
    minHeight:       600,
    frame:           false,
    backgroundColor: '#000000',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.maximize();
  mainWindow.on('closed', () => { mainWindow = null; });
  // Re-sync mute state once the renderer DOM is ready — fixes the race where
  // connectObs() fires before createWindow() and mainWindow is still null.
  mainWindow.webContents.on('did-finish-load', async () => {
    if (!obsClient || !cachedMicName) return;
    try {
      const { inputMuted } = await obsClient.call('GetInputMute', { inputName: cachedMicName });
      mainWindow?.webContents.send('desktop:mute-state', { muted: inputMuted });
    } catch {}
  });

  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12')
      mainWindow.webContents.openDevTools();
    if (input.key === 'F11' && scView)
      scView.webContents.openDevTools();
  });
  createBroadcastView();
  createCbView();

  // ── DOM-based chat reader (Stripchat public room + BongaCams) ──────────────
  chatManager = new ChatManager({
    mainWindow,
    onEvent: (event) => {
      scLog(`[${event.platform}] ${event.username}: ${(event.text || '').slice(0, 80)}`);
      handleBongaDomEvent(event);
      mainWindow?.webContents.send('desktop:chat-message', {
        type:     event.type || 'chat',
        platform: event.platform,
        user:     event.username || '',
        msg:      event.text    || '',
      });
    },
    onLog: (msg) => scLog('[chat] ' + msg),
  });
  chatManager.start(chatConfig);
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return permission === 'media';
  });

  ensureFirewallRule();
  logger.info('App started', { appVersion: logger.appVersion, platform: logger.platform, sessionId: logger.sessionId });
  const token = loadToken();
  if (token) {
    logger.start(token, API_BASE);
    const ext = loadDestExtProps();
    try {
      const cloudDests = await cloudLoadDestinations(token);
      if (cloudDests !== null) {
        streamDestinations = mergeWithExt(cloudDests, ext);
        saveDestCache(streamDestinations);
      } else {
        // 401/403 handled inside cloudLoadDestinations — token cleared if 401
        streamDestinations = [];
      }
    } catch {
      // Offline — fall back to local cache
      streamDestinations = loadDestCache();
    }

    // Only launch OBS if the token is still valid after the cloud check
    if (storedToken) {
      streamPlatforms = streamDestinations.map(d => d.name);
      const wsPassword = obsMan.getOrCreateWsPassword();
      try { obsMan.initObsConfig({ destinations: streamDestinations, wsPort: OBS_WS_PORT, wsPassword }); } catch {}
      let obsLaunched = obsMan.isObsRunning();
      if (!obsLaunched) {
        try { obsMan.spawnObs(); obsLaunched = true; }
        catch (err) { console.error('[OBS spawn on resume]', err.message); }
      }
      if (obsLaunched) connectObs(wsPassword);
      startStatusPolling(storedToken);
      startAutoFixer();
    }
  }

  // Restore platform sessions from cloud before views are created so the
  // embedded pages load already authenticated on the first navigation.
  if (storedToken) {
    const [rSc, rCb] = await Promise.all([
      cookieSync.restoreCookies(storedToken, 'stripchat',  'persist:stripchat').catch(() => ({ ok: false, reason: 'exception' })),
      cookieSync.restoreCookies(storedToken, 'chaturbate', 'persist:chaturbate').catch(() => ({ ok: false, reason: 'exception' })),
    ]);
    scLog(`[cookie-sync] restore@startup SC → ${rSc.ok ? `OK (${rSc.injected} cookies)` : ('FAIL ' + (rSc.reason || ''))}`);
    scLog(`[cookie-sync] restore@startup CB → ${rCb.ok ? `OK (${rCb.injected} cookies)` : ('FAIL ' + (rCb.reason || ''))}`);
    if (rSc.ok) logger.info('Cookie sync restored', { platform: 'stripchat',  injected: rSc.injected, timing: 'startup' });
    else        logger.warn('Cookie sync failed',   { platform: 'stripchat',  reason: rSc.reason,     timing: 'startup' });
    if (rCb.ok) logger.info('Cookie sync restored', { platform: 'chaturbate', injected: rCb.injected, timing: 'startup' });
    else        logger.warn('Cookie sync failed',   { platform: 'chaturbate', reason: rCb.reason,     timing: 'startup' });
  }

  createWindow();
  try { if (getToyMan().getSettings().autoConnect) getToyMan().connect(); } catch {}
  // Silent update check: run 5 s after launch so it doesn't race with startup
  setTimeout(() => checkForUpdates(true), 5000);
  app.on('activate', () => { if (!mainWindow) createWindow(); });
});

app.on('window-all-closed', () => {
  stopStatusPolling();
  stopEventsPolling();
  stopViewerCountPolling();
  stopStripchatChat();
  stopAutoFixer();
  obsMan.killObs();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  logger.info('App closing');
  logger.stop();
  stopStatusPolling();
  stopEventsPolling();
  stopViewerCountPolling();
  stopStripchatChat();
  stopAutoFixer();
  chatManager?.stop();
  try { toyMan?.shutdown(); } catch {}
  obsMan.killObs();
});
