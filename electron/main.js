'use strict';
const { app, BrowserWindow, ipcMain, safeStorage, session, WebContentsView, shell, dialog } = require('electron');
const path       = require('path');
const fs         = require('fs');
const https      = require('https');
const { execSync } = require('child_process');
const obsMan     = require('./obs-manager');

// ── Config ────────────────────────────────────────────────────────────────────
const API_BASE           = process.env.API_BASE || 'https://admin.agencytmt.com';
const OBS_WS_PORT        = Number(process.env.OBS_WS_PORT) || 4455;
const STATUS_INTERVAL_MS = 3000;

// ── State ─────────────────────────────────────────────────────────────────────
let mainWindow         = null;
let obsClient          = null;
let statusInterval     = null;
let storedToken        = null;
let streamPlatforms    = [];
let streamDestinations = [];
let lastTotalBytes     = 0;
let lastPollTime       = Date.now();
let scView             = null;
let scViewVisible      = true;
const TITLEBAR_H       = 30;
let disabledDestIds    = new Set(); // ids of destinations turned off by the user

function getActiveDestinations() {
  if (disabledDestIds.size === 0) return streamDestinations;
  return streamDestinations.filter(d => !disabledDestIds.has(String(d.id)));
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
  const res  = await fetch(`${API_BASE}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
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
let eventsActive          = false;
let eventsAbortController = null;
let viewerPollInterval    = null;

async function startEventsPolling() {
  if (eventsActive) return;
  const dest = streamDestinations.find(
    d => d.eventsToken && d.username && d.name.toLowerCase() === 'chaturbate'
  );
  if (!dest) return;

  eventsActive = true;
  console.log('[events] starting for', dest.username);
  mainWindow?.webContents.send('desktop:chat-status', buildChatStatus());
  let url = `https://eventsapi.chaturbate.com/events/${encodeURIComponent(dest.username)}/${encodeURIComponent(dest.eventsToken)}/?timeout=20`;

  while (eventsActive && storedToken) {
    try {
      eventsAbortController = new AbortController();
      const res = await fetch(url, {
        signal:  eventsAbortController.signal,
        headers: { Accept: 'application/json' },
      });
      if (res.status === 401 || res.status === 403) { eventsActive = false; break; }
      if (!res.ok) { await new Promise(r => setTimeout(r, 5000)); continue; }
      const data = await res.json();
      for (const ev of (data.events || [])) handleChaturbateEvent(ev);
      url = data.next_url || url;
    } catch (err) {
      if (err.name !== 'AbortError') await new Promise(r => setTimeout(r, 3000));
    }
  }
  eventsActive = false;
}

function handleChaturbateEvent(ev) {
  console.log('[chaturbate-event] method=%s object=%s', ev.method, JSON.stringify(ev.object).slice(0, 300));
  switch (ev.method) {
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
  eventsActive = false;
  eventsAbortController?.abort();
  eventsAbortController = null;
}

async function startViewerCountPolling() {
  if (viewerPollInterval) clearInterval(viewerPollInterval);

  const cbDest = streamDestinations.find(d => d.username && d.name.toLowerCase() === 'chaturbate');
  const scDest = streamDestinations.find(d => d.username && d.name.toLowerCase() === 'stripchat');
  if (!cbDest && !scDest) return;

  const poll = async () => {
    try {
      if (cbDest) {
        const res  = await fetch(
          `https://chaturbate.com/api/public/affiliates/onlinerooms/?wm=&format=json&username=${encodeURIComponent(cbDest.username)}`
        );
        if (res.ok) {
          const data = await res.json();
          const room = (data.results || []).find(r => r.username === cbDest.username);
          if (room?.num_users !== undefined)
            mainWindow?.webContents.send('desktop:viewer-count', room.num_users);
        }
      } else if (scDest) {
        const res = await fetch(
          `https://stripchat.com/api/front/v2/models/username/${encodeURIComponent(scDest.username.toLowerCase())}`,
          { headers: { Accept: 'application/json' } }
        );
        if (res.ok) {
          const data = await res.json();
          const viewers = data?.model?.viewersCount ?? data?.model?.viewers ?? null;
          if (viewers !== null)
            mainWindow?.webContents.send('desktop:viewer-count', viewers);
        }
      }
    } catch {}
  };
  poll();
  viewerPollInterval = setInterval(poll, 30000);
}

function stopViewerCountPolling() {
  if (viewerPollInterval) { clearInterval(viewerPollInterval); viewerPollInterval = null; }
}

// ── Stripchat chat WebSocket (socket.io 4.x protocol) ────────────────────────
let stripchatWs       = null;
let stripchatPingTimer = null;
let stripchatRetryTimer = null;

async function startStripchatChat() {
  const dest = streamDestinations.find(d => d.username && d.name.toLowerCase() === 'stripchat');
  if (!dest?.username) return;
  if (stripchatWs) return;
  if (stripchatRetryTimer) { clearTimeout(stripchatRetryTimer); stripchatRetryTimer = null; }

  // Fetch model info to get their numeric room ID
  let modelId = null;
  try {
    const res = await fetch(
      `https://stripchat.com/api/front/v2/models/username/${encodeURIComponent(dest.username.toLowerCase())}`,
      { headers: { Accept: 'application/json' } }
    );
    if (res.ok) {
      const data = await res.json();
      modelId = data?.model?.id ?? null;
      console.log('[stripchat-chat] modelId lookup:', modelId, 'keys:', Object.keys(data || {}).join(','));
    } else {
      console.warn('[stripchat-chat] modelId fetch failed:', res.status);
    }
  } catch (e) {
    console.warn('[stripchat-chat] modelId fetch error:', e.message);
  }

  try {
    const WS = require('ws');
    stripchatWs = new WS('wss://chatws.stripchat.global/socket.io/?EIO=4&transport=websocket', {
      headers: { Origin: 'https://stripchat.com' },
    });

    stripchatWs.on('open', () => {
      console.log('[stripchat-chat] connected for', dest.username, 'modelId=', modelId);
    });

    stripchatWs.on('message', raw => {
      const msg = raw.toString();
      // Log every frame so we can see the real event names in the debug panel
      if (msg.length < 300) console.log('[stripchat-ws]', msg);
      else console.log('[stripchat-ws]', msg.slice(0, 300), '…');

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
        console.log('[stripchat-chat] joined room for', dest.username, 'id=', modelId);
        mainWindow?.webContents.send('desktop:chat-status', buildChatStatus());
        return;
      }

      if (!msg.startsWith('42')) return;
      try {
        const parsed = JSON.parse(msg.slice(2));
        if (!Array.isArray(parsed)) return;
        const [event, data] = parsed;
        console.log('[stripchat-chat] event=%s data=%s', event, JSON.stringify(data).slice(0, 200));
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
            break;
          }
          case 'follow':
          case 'fanclub':
          case 'fanclubJoin':
          case 'broadcast:follow':
            mainWindow?.webContents.send('desktop:chat-message', { type: 'follow', platform: 'stripchat', user, msg: 'followed' });
            break;
          default:
            // All events already logged above — no extra log needed
        }
      } catch {}
    });

    stripchatWs.on('close', () => {
      console.log('[stripchat-chat] disconnected');
      stripchatWs = null;
      if (stripchatPingTimer) { clearInterval(stripchatPingTimer); stripchatPingTimer = null; }
      if (storedToken) stripchatRetryTimer = setTimeout(() => startStripchatChat(), 6000);
    });

    stripchatWs.on('error', err => {
      console.warn('[stripchat-chat] error:', err.message);
      stripchatWs?.terminate();
      stripchatWs = null;
    });
  } catch (err) {
    console.error('[stripchat-chat] failed:', err.message);
  }
}

function stopStripchatChat() {
  if (stripchatRetryTimer) { clearTimeout(stripchatRetryTimer); stripchatRetryTimer = null; }
  if (stripchatPingTimer)  { clearInterval(stripchatPingTimer); stripchatPingTimer = null; }
  stripchatWs?.terminate();
  stripchatWs = null;
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

async function connectObs(wsPassword) {
  if (obsClient) return;
  const OBS = await getOBSClass();
  obsClient = new OBS();

  obsClient.on('ConnectionClosed', () => {
    obsClient = null;
    mainWindow?.webContents.send('desktop:obs-status', { connected: false });
    if (storedToken) setTimeout(() => connectObs(wsPassword), 3000);
  });

  obsClient.on('StreamStateChanged', ({ outputActive, outputState }) => {
    if (!outputActive && outputState === 'OBS_WEBSOCKET_OUTPUT_ERROR') {
      mainWindow?.webContents.send('desktop:stream-error', 'Stream failed — check your network or stream settings.');
    }
  });

  try {
    await obsClient.connect(`ws://127.0.0.1:${OBS_WS_PORT}`, wsPassword);
    console.log('[OBS ws] connected');

    try { await obsClient.call('SetCurrentProfile', { profileName: 'TMT' }); } catch {}
    try { await obsClient.call('SetCurrentSceneCollection', { sceneCollectionName: 'TMT' }); } catch {}
    await applyStreamService();
    startViewerCountPolling();
    startEventsPolling();
    startStripchatChat();

    try {
      const specials       = await obsClient.call('GetSpecialInputs');
      const micName        = specials.mic1 || specials.mic2 || 'Mic/Aux';
      const { inputMuted } = await obsClient.call('GetInputMute', { inputName: micName });
      mainWindow?.webContents.send('desktop:mute-state', { muted: inputMuted });
    } catch {}

    mainWindow?.webContents.send('desktop:obs-status', { connected: true });
  } catch (err) {
    obsClient = null;
    mainWindow?.webContents.send('desktop:obs-status', { connected: false, status: 'Starting OBS…' });
    if (storedToken) setTimeout(() => connectObs(wsPassword), 3000);
  }
}

// ── Status polling ────────────────────────────────────────────────────────────
function startStatusPolling(token) {
  if (statusInterval) return;
  statusInterval = setInterval(async () => {
    if (!obsClient || !token) return;
    try {
      const [stream, stats] = await Promise.all([
        obsClient.call('GetStreamStatus'),
        obsClient.call('GetStats'),
      ]);

      const now         = Date.now();
      const deltaBytes  = Math.max(0, stream.outputTotalBytes - lastTotalBytes);
      const deltaSec    = (now - lastPollTime) / 1000;
      const bitrateKbps = deltaSec > 0 ? Math.round((deltaBytes * 8) / deltaSec / 1000) : 0;
      lastTotalBytes = stream.outputTotalBytes;
      lastPollTime   = now;

      const payload = {
        live:          stream.outputActive,
        platforms:     streamPlatforms,
        bitrate:       bitrateKbps,
        droppedFrames: stream.outputDroppedFrames,
        cpuUsage:      Math.round(stats.cpuUsage),
      };

      mainWindow?.webContents.send('desktop:status-update', payload);
      apiFetch('POST', '/api/desktop/status', payload, token).catch(() => {});
    } catch (err) {
      console.debug('[poll]', err.message);
    }
  }, STATUS_INTERVAL_MS);
}

function stopStatusPolling() {
  clearInterval(statusInterval);
  statusInterval = null;
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('desktop:login', async (_e, { username, password }) => {
  try {
    const auth = await apiFetch('POST', '/api/desktop/auth/login', { username, password });
    if (auth.status === 403) return { ok: false, error: auth.data.error || 'Account is inactive or is not a model account.' };
    if (auth.status !== 200) return { ok: false, error: auth.data.error || 'Login failed' };
    const token = auth.data.token;
    saveToken(token);

    // Load cloud destinations, migrate legacy local data if needed
    let cloudDests = null;
    try {
      cloudDests = await cloudLoadDestinations(token);
    } catch (err) {
      console.warn('[login] cloud fetch failed, using local cache:', err.message);
    }

    const ext = loadDestExtProps();

    if (cloudDests !== null) {
      await migrateLocalToCloud(token, cloudDests, ext);
      // Reload after migration (newly uploaded rows now have cloud ids)
      try { cloudDests = await cloudLoadDestinations(token); } catch {}
      streamDestinations = mergeWithExt(cloudDests ?? [], ext);
      saveDestCache(streamDestinations);
    } else {
      streamDestinations = loadDestCache();
    }

    streamPlatforms = streamDestinations.map(d => d.name);

    const wsPassword = obsMan.getOrCreateWsPassword();
    obsMan.initObsConfig({ destinations: streamDestinations, wsPort: OBS_WS_PORT, wsPassword });

    let obsLaunched = obsMan.isObsRunning();
    if (!obsLaunched) {
      try {
        obsMan.spawnObs();
        obsLaunched = true;
      } catch (err) {
        console.error('[OBS spawn]', err.message);
        mainWindow?.webContents.send('desktop:obs-status', {
          connected: false,
          error: 'OBS not found. Extract the OBS portable ZIP into electron/obs/ then rebuild.',
        });
      }
    }

    if (obsLaunched) connectObs(wsPassword);
    startStatusPolling(token);

    return { ok: true };
  } catch (err) {
    console.error('[desktop:login]', err);
    return { ok: false, error: 'Network error — are you online?' };
  }
});

ipcMain.handle('desktop:get-token', () => storedToken || loadToken());

ipcMain.handle('desktop:logout', () => {
  clearToken();
  stopStatusPolling();
  stopEventsPolling();
  stopViewerCountPolling();
  stopStripchatChat();
  try { obsClient?.disconnect(); } catch {}
  obsClient = null;
  obsMan.killObs();
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
    lastTotalBytes = 0;
    lastPollTime   = Date.now();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('desktop:stop-stream', async () => {
  if (!obsClient) return { ok: false, error: 'OBS not connected' };
  try {
    await obsClient.call('StopStream');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('desktop:go-live', async () => {
  // ── OBS ──────────────────────────────────────────────────────────────
  if (!obsClient) return { ok: false, stage: 'obs', error: 'OBS not connected' };
  const activeDests = getActiveDestinations();
  if (activeDests.length === 0)
    return { ok: false, stage: 'obs', error: 'All platforms are disabled' };

  // Rewrite obs-multi-rtmp.json with only active destinations, then reload
  // the OBS profile so the plugin picks up the new config before stream start.
  try {
    const configDir = obsMan.getObsConfigDir(obsMan.getObsDir());
    obsMan.writeMultiRtmpConfig(configDir, activeDests);
    // Profile reload: switch away then back so obs-multi-rtmp re-reads its JSON
    await obsClient.call('SetCurrentProfile', { profileName: 'Untitled' }).catch(() => {});
    await obsClient.call('SetCurrentProfile', { profileName: 'TMT' });
    // Re-apply primary stream service after profile reload
    const primary = activeDests[0];
    await obsClient.call('SetStreamServiceSettings', {
      streamServiceType: 'rtmp_custom',
      streamServiceSettings: { server: primary.rtmpUrl, key: primary.streamKey, use_auth: false },
    });
  } catch (err) {
    console.warn('[go-live] config reload failed:', err.message);
  }

  try {
    await obsClient.call('StartStream');
    lastTotalBytes = 0;
    lastPollTime   = Date.now();
  } catch (err) {
    return { ok: false, stage: 'obs', error: err.message };
  }

  // ── Stripchat click (only when Stripchat is an active destination) ────
  const scDest = activeDests.find(d => d.name.toLowerCase() === 'stripchat');
  if (scDest) {
    const r = await clickStripchatButton(/start\s*show/i, 15000);
    if (!r.ok) {
      // Don't open the browser automatically — return the URL so the renderer
      // can show an explanation modal with a button the user consciously clicks.
      const scUrl = scDest.username
        ? `https://stripchat.com/${scDest.username}`
        : 'https://stripchat.com/broadcast';
      return { ok: true, stripchatManual: true, scUrl };
    }
  }

  return { ok: true };
});

ipcMain.handle('desktop:go-offline', async () => {
  // ── Stripchat stop (soft fail — OBS stop always runs) ────────────────
  const hasStripchat = streamDestinations.some(
    d => d.name.toLowerCase() === 'stripchat'
  );
  if (hasStripchat) {
    await clickStripchatButton(/stop\s*show/i, 15000).catch(() => {});
  }

  // ── OBS ──────────────────────────────────────────────────────────────
  if (!obsClient) return { ok: false, stage: 'obs', error: 'OBS not connected' };
  try {
    await obsClient.call('StopStream');
    return { ok: true };
  } catch (err) {
    return { ok: false, stage: 'obs', error: err.message };
  }
});

ipcMain.handle('desktop:toggle-broadcast-view', () => {
  if (!scView) return { visible: false };
  scViewVisible = !scViewVisible;
  scView.setVisible(scViewVisible);
  return { visible: scViewVisible };
});

ipcMain.handle('desktop:get-destinations', () => ({
  destinations: streamDestinations,
  disabledIds:  [...disabledDestIds],
}));

ipcMain.handle('desktop:toggle-destination', (_e, { id }) => {
  const idStr = String(id);
  if (disabledDestIds.has(idStr)) {
    disabledDestIds.delete(idStr);
  } else {
    disabledDestIds.add(idStr);
  }
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
  if (!obsClient) return { ok: false, muted: false, error: 'OBS not connected' };
  try {
    const specials = await obsClient.call('GetSpecialInputs');
    const micName  = specials.mic1 || specials.mic2 || 'Mic/Aux';
    console.log('[mute] mic input name:', micName);
    const { inputMuted } = await obsClient.call('ToggleInputMute', { inputName: micName });
    return { ok: true, muted: inputMuted };
  } catch (err) {
    console.error('[mute] error:', err.message);
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
  };
});

// ── Open URL in default browser ───────────────────────────────────────────────
ipcMain.handle('desktop:open-external', (_e, { url }) => {
  shell.openExternal(url);
});

// ── Broadcast view (Stripchat) ────────────────────────────────────────────────
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
  scView.webContents.loadURL('https://stripchat.com/broadcast');

  function updateBounds() {
    if (!mainWindow || !scView) return;
    const [w, h] = mainWindow.getSize();
    scView.setBounds({ x: 0, y: TITLEBAR_H, width: w, height: h - TITLEBAR_H });
  }
  mainWindow.on('resize', updateBounds);
  mainWindow.once('maximize', updateBounds);
}

async function clickStripchatButton(pattern, timeoutMs = 15000) {
  if (!scView) return { ok: false, error: 'broadcast view not initialized' };
  const wc = scView.webContents;
  const script = `(function(){
  const re = ${pattern.toString()};
  const btn = Array.from(document.querySelectorAll('button,[role="button"]'))
    .find(el => re.test((el.innerText || el.textContent || '').trim()));
  if (!btn) return false;
  btn.click();
  /* Fallback if React synthetic-event gating blocks .click() — uncomment if needed:
  ['pointerdown','mouseup','click'].forEach(t =>
    btn.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window})));
  */
  return true;
})()`;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of wc.mainFrame.framesInSubtree) {
      try {
        if (await frame.executeJavaScript(script, true)) return { ok: true };
      } catch { /* cross-origin frame — skip */ }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return { ok: false, error: `timeout: button not found within ${timeoutMs}ms` };
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
  createBroadcastView();
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return permission === 'media';
  });

  ensureFirewallRule();
  const token = loadToken();
  if (token) {
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
    }
  }

  createWindow();
  // Silent update check: run 5 s after launch so it doesn't race with startup
  setTimeout(() => checkForUpdates(true), 5000);
  app.on('activate', () => { if (!mainWindow) createWindow(); });
});

app.on('window-all-closed', () => {
  stopStatusPolling();
  stopEventsPolling();
  stopViewerCountPolling();
  stopStripchatChat();
  obsMan.killObs();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopStatusPolling();
  stopEventsPolling();
  stopViewerCountPolling();
  stopStripchatChat();
  obsMan.killObs();
});
