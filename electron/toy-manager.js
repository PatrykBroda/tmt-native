'use strict';
// Tip-activated toy control.
//   • ToyManager      — settings, unified tip queue, playback, status
//   • IntifaceBackend — Buttplug v3 JSON protocol over ws (Intiface Central)
//   • LovenseBackend  — Lovense Remote "Game Mode" local HTTP(S) API
// No Electron imports: runs (and is unit-tested) under plain Node.
// Nothing here may throw into the caller — a toy failure must never hurt the stream.
const EventEmitter = require('events');
const http  = require('http');
const https = require('https');
const WS    = require('ws');

const DEFAULT_LEVELS = [
  { min: 1,   max: 9,    intensity: 0.25, seconds: 3  },
  { min: 10,  max: 49,   intensity: 0.5,  seconds: 6  },
  { min: 50,  max: 99,   intensity: 0.75, seconds: 10 },
  { min: 100, max: null, intensity: 1,    seconds: 15 },   // max:null = no upper bound
];

const DEFAULT_SETTINGS = {
  enabled:      true,
  backend:      'intiface',               // 'intiface' | 'lovense'
  intifaceUrl:  'ws://127.0.0.1:12345',
  lovenseHost:  '127.0.0.1',
  lovensePort:  20010,
  lovenseHttps: false,                    // https → <ip-dashed>.lovense.club:<port> (Lovense wildcard cert)
  autoConnect:  false,
  maxQueue:     10,
  bongaTipParsing: false,                 // heuristic chat-text tip detection (spoofable — opt-in)
  levels:       DEFAULT_LEVELS,
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function sanitizeLevels(levels) {
  if (!Array.isArray(levels)) return DEFAULT_LEVELS.map(l => ({ ...l }));
  const out = [];
  for (const l of levels.slice(0, 20)) {
    const min = Math.floor(Number(l?.min));
    if (!Number.isFinite(min) || min < 1) continue;
    const maxRaw = l.max === null || l.max === '' || l.max === undefined ? null : Math.floor(Number(l.max));
    const max = maxRaw !== null && Number.isFinite(maxRaw) && maxRaw >= min ? maxRaw : null;
    const intensity = clamp(Number(l.intensity) || 0, 0, 1);
    const seconds   = clamp(Number(l.seconds) || 0, 0.1, 120);
    if (intensity <= 0) continue;
    out.push({ min, max, intensity, seconds });
  }
  out.sort((a, b) => a.min - b.min);
  return out;
}

function sanitizeSettings(s) {
  const d = DEFAULT_SETTINGS;
  s = s && typeof s === 'object' ? s : {};
  const str = (v, def) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : def);
  return {
    enabled:     s.enabled !== false,
    backend:     s.backend === 'lovense' ? 'lovense' : 'intiface',
    intifaceUrl: str(s.intifaceUrl, d.intifaceUrl),
    lovenseHost: str(s.lovenseHost, d.lovenseHost),
    lovensePort: clamp(Math.floor(Number(s.lovensePort)) || d.lovensePort, 1, 65535),
    lovenseHttps: !!s.lovenseHttps,
    autoConnect: !!s.autoConnect,
    maxQueue:    clamp(Math.floor(Number(s.maxQueue)) || d.maxQueue, 1, 100),
    bongaTipParsing: !!s.bongaTipParsing,
    levels:      Array.isArray(s.levels) ? sanitizeLevels(s.levels) : sanitizeLevels(d.levels),
  };
}

// tokens → level (or null when below the lowest range / no match)
function levelForTokens(levels, tokens) {
  const t = Number(tokens);
  if (!Number.isFinite(t) || t < 1) return null;
  let hit = null;
  for (const l of levels) if (t >= l.min && (l.max === null || t <= l.max)) hit = l;   // later (higher) range wins on overlap
  return hit;
}

// BongaCams has no events API we can reach; best-effort text heuristic for DOM-scraped rows.
// Matches e.g. "tipped 50 tokens", "sent you 25 tk", "tip: 100 tokens". Verified against nothing live.
function parseTipText(text) {
  const m = /\b(?:tipped|tips?|sent(?:\s+you)?)\D{0,12}?(\d{1,6})\s*(?:tokens?|tk|tks|coins?)\b/i.exec(String(text || ''));
  return m ? Number(m[1]) : null;
}

// ── Intiface / Buttplug v3 ────────────────────────────────────────────────────
class IntifaceBackend extends EventEmitter {
  constructor(url, log) {
    super();
    this.url = url; this.log = log;
    this.ws = null; this.id = 1; this.devices = new Map(); this.pingTimer = null; this.ready = false;
  }
  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => { if (settled) return; settled = true; clearTimeout(to); err ? reject(err) : resolve(); };
      const to = setTimeout(() => { done(new Error('Intiface handshake timed out')); this.close(); }, 6000);
      let ws;
      try { ws = new WS(this.url, { handshakeTimeout: 5000 }); } catch (e) { return done(e); }
      this.ws = ws;
      ws.on('open', () => this._send({ RequestServerInfo: { ClientName: 'TMT Native', MessageVersion: 3 } }));
      ws.on('message', raw => {
        let msgs; try { msgs = JSON.parse(raw.toString()); } catch { return; }
        for (const m of (Array.isArray(msgs) ? msgs : [msgs])) this._onMsg(m, done);
      });
      ws.on('error', e => { done(e); });
      ws.on('close', () => {
        clearInterval(this.pingTimer);
        const was = this.ready; this.ready = false; this.devices.clear();
        done(new Error('Intiface connection closed'));
        if (was) this.emit('closed');
      });
    });
  }
  _send(obj) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    const key = Object.keys(obj)[0];
    obj[key].Id = obj[key].Id || this.id++;
    try { this.ws.send(JSON.stringify([obj])); return true; } catch { return false; }
  }
  _onMsg(m, done) {
    const key = Object.keys(m)[0], v = m[key];
    switch (key) {
      case 'ServerInfo': {
        this.ready = true;
        const ping = Number(v.MaxPingTime) || 0;
        if (ping > 0) this.pingTimer = setInterval(() => this._send({ Ping: {} }), Math.max(250, Math.floor(ping / 2)));
        this._send({ RequestDeviceList: {} });
        this._send({ StartScanning: {} });
        done();
        break;
      }
      case 'DeviceList':
        this.devices.clear();
        for (const d of (v.Devices || [])) this._addDevice(d);
        this.emit('devices');
        break;
      case 'DeviceAdded':   this._addDevice(v); this.emit('devices'); break;
      case 'DeviceRemoved': this.devices.delete(v.DeviceIndex); this.emit('devices'); break;
      case 'Error':
        this.log('warn', 'Intiface error message', { code: v.ErrorCode, msg: v.ErrorMessage });
        if (!this.ready) done(new Error('Intiface: ' + (v.ErrorMessage || 'handshake error')));
        break;
    }
  }
  _addDevice(d) {
    const msgs = d.DeviceMessages || {};
    let cmd = null, count = 0;
    if (Array.isArray(msgs.ScalarCmd)) {
      const vib = msgs.ScalarCmd.map((a, i) => ({ a, i })).filter(x => /vibrate/i.test(x.a.ActuatorType || ''));
      if (vib.length) { cmd = { type: 'scalar', idx: vib.map(x => x.i) }; count = vib.length; }
    }
    if (!cmd && msgs.VibrateCmd) {
      count = msgs.VibrateCmd.FeatureCount || 1;
      cmd = { type: 'vibrate', idx: Array.from({ length: count }, (_, i) => i) };
    }
    this.devices.set(d.DeviceIndex, { id: d.DeviceIndex, name: d.DeviceName, canVibrate: !!cmd, cmd });
  }
  listDevices() {
    return [...this.devices.values()].map(d => ({ id: String(d.id), name: d.name, canVibrate: d.canVibrate }));
  }
  vibrate(level) {
    let n = 0;
    for (const d of this.devices.values()) {
      if (!d.cmd) continue;
      const ok = d.cmd.type === 'scalar'
        ? this._send({ ScalarCmd: { DeviceIndex: d.id, Scalars: d.cmd.idx.map(i => ({ Index: i, Scalar: level, ActuatorType: 'Vibrate' })) } })
        : this._send({ VibrateCmd: { DeviceIndex: d.id, Speeds: d.cmd.idx.map(i => ({ Index: i, Speed: level })) } });
      if (ok) n++;
    }
    return n;
  }
  stop() { this._send({ StopAllDevices: {} }); }
  close() {
    clearInterval(this.pingTimer);
    try { this.ws?.removeAllListeners('close'); this.ws?.close(); } catch {}
    this.ws = null; this.ready = false; this.devices.clear();
  }
  isAlive() { return !!this.ws && this.ws.readyState === 1 && this.ready; }
}

// ── Lovense Remote Game Mode (local HTTP API) ─────────────────────────────────
class LovenseBackend extends EventEmitter {
  constructor(s, log) {
    super();
    this.s = s; this.log = log; this.toys = []; this.alive = false; this.poll = null;
  }
  _target() {
    const { lovenseHost: host, lovensePort: port, lovenseHttps: tls } = this.s;
    if (!tls) return { mod: http, host, port };
    // Lovense's wildcard cert covers *.lovense.club only → dash the IP
    const h = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host.replace(/\./g, '-') + '.lovense.club' : host;
    return { mod: https, host: h, port };
  }
  _post(body) {
    const { mod, host, port } = this._target();
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = mod.request({
        host, port, path: '/command', method: 'POST', timeout: 4000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-platform': 'TMT Native' },
      }, res => {
        let buf = ''; res.on('data', c => buf += c);
        res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { reject(new Error('Lovense: bad response')); } });
      });
      req.on('timeout', () => req.destroy(new Error('Lovense: request timed out')));
      req.on('error', reject);
      req.end(data);
    });
  }
  async _refresh() {
    const r = await this._post({ command: 'GetToys' });
    // "data.toys" may be an object (documented) or a JSON string (older app builds)
    let toys = r?.data?.toys;
    if (typeof toys === 'string') { try { toys = JSON.parse(toys); } catch { toys = {}; } }
    this.toys = Object.values(toys || {}).map(t => ({
      id: String(t.id), name: t.nickName || t.name || 'Lovense toy',
      canVibrate: !t.fullFunctionNames || t.fullFunctionNames.includes('Vibrate'),
      connected: String(t.status) === '1',
    })).filter(t => t.connected);
    this.alive = true;
  }
  async connect() {
    await this._refresh();
    this.poll = setInterval(async () => {
      try { const before = this.toys.length; await this._refresh(); if (before !== this.toys.length) this.emit('devices'); }
      catch (e) { if (this.alive) { this.alive = false; this.emit('closed'); } }
    }, 5000);
  }
  listDevices() { return this.toys.map(({ id, name, canVibrate }) => ({ id, name, canVibrate })); }
  vibrate(level, seconds) {
    const action = 'Vibrate:' + Math.round(clamp(level, 0, 1) * 20);
    this._post({ command: 'Function', action, timeSec: Math.max(1, Math.ceil(seconds)), toy: '', stopPrevious: 1, apiVer: 1 })
      .catch(e => this.log('warn', 'Lovense vibrate failed', { error: e.message }));
    return this.toys.length;
  }
  stop() {
    this._post({ command: 'Function', action: 'Stop', timeSec: 0, toy: '', apiVer: 1 })
      .catch(e => this.log('warn', 'Lovense stop failed', { error: e.message }));
  }
  close() { clearInterval(this.poll); this.poll = null; this.alive = false; this.toys = []; }
  isAlive() { return this.alive; }
}

// ── ToyManager ────────────────────────────────────────────────────────────────
class ToyManager extends EventEmitter {
  constructor({ logger, settings } = {}) {
    super();
    this.logger   = logger || { info() {}, warn() {}, error() {}, debug() {} };
    this.settings = sanitizeSettings(settings);
    this.state    = 'disconnected';   // disconnected | connecting | connected
    this.error    = '';
    this.backend  = null;
    this.queue    = [];               // [{platform,user,tokens,intensity,seconds,at}]
    this.playing  = null;
    this.playTimer = null;
    this.reconnectTimer = null;
    this.wantConnected  = false;      // user intent — drives auto-reconnect
    this.backoff = 2000;
    this.dropped = 0;
  }

  _log(level, msg, ctx) {
    try { this.logger[level]?.('[toys] ' + msg, ctx); } catch {}
  }

  // ── settings ────────────────────────────────────────────────────────────────
  getSettings() { return this.settings; }
  setSettings(s) {
    const prev = this.settings;
    this.settings = sanitizeSettings({ ...prev, ...s });
    this._log('info', 'settings updated', { backend: this.settings.backend, levels: this.settings.levels.length, maxQueue: this.settings.maxQueue });
    // trim queue if the cap shrank
    while (this.queue.length > this.settings.maxQueue) this.queue.pop();
    this._emitStatus();
    return this.settings;
  }

  // ── connection ──────────────────────────────────────────────────────────────
  async connect() {
    this.wantConnected = true;
    clearTimeout(this.reconnectTimer);
    return this._connectOnce();
  }

  async _connectOnce() {
    this._teardownBackend();
    this.state = 'connecting'; this.error = ''; this._emitStatus();
    const s = this.settings;
    const log = (l, m, c) => this._log(l, m, c);
    const b = s.backend === 'lovense' ? new LovenseBackend(s, log) : new IntifaceBackend(s.intifaceUrl, log);
    this.backend = b;
    b.on('devices', () => { this._emitStatus(); });
    b.on('closed', () => this._onBackendLost(b));
    try {
      await b.connect();
      if (this.backend !== b) { b.close(); return this.getStatus(); }   // superseded while connecting
      this.state = 'connected'; this.backoff = 2000;
      this._log('info', 'connected', { backend: s.backend, devices: b.listDevices().length });
    } catch (e) {
      if (this.backend !== b) return this.getStatus();
      b.close(); this.backend = null;
      this.state = 'disconnected'; this.error = e.message;
      this._log('warn', 'connect failed', { backend: s.backend, error: e.message });
      this._scheduleReconnect();
    }
    this._emitStatus();
    return this.getStatus();
  }

  _onBackendLost(b) {
    if (this.backend !== b) return;
    this._log('warn', 'connection lost', { backend: this.settings.backend });
    b.close(); this.backend = null;
    this._clearPlayback();
    this.state = 'disconnected'; this.error = 'Connection lost';
    this._emitStatus();
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (!this.wantConnected) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => { if (this.wantConnected) this._connectOnce(); }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 15000);
  }

  _teardownBackend() {
    if (this.backend) { try { this.backend.close(); } catch {} this.backend = null; }
  }

  disconnect() {
    this.wantConnected = false;
    clearTimeout(this.reconnectTimer);
    this.stopAll('disconnect');
    this._teardownBackend();
    this.state = 'disconnected'; this.error = '';
    this._log('info', 'disconnected by user');
    this._emitStatus();
    return this.getStatus();
  }

  // ── tips → queue ────────────────────────────────────────────────────────────
  // Single entry point for tips from every platform.
  enqueueTip({ platform, user, tokens }) {
    try {
      const s = this.settings;
      if (!s.enabled) return { queued: false, reason: 'disabled' };
      const level = levelForTokens(s.levels, tokens);
      if (!level) { this._log('debug', 'tip below any level', { platform, tokens }); return { queued: false, reason: 'no-level' }; }
      if (this.state !== 'connected') {
        this._log('info', 'tip ignored — toy not connected', { platform, user, tokens });
        return { queued: false, reason: 'not-connected' };
      }
      if (this.queue.length >= s.maxQueue) {
        this.dropped++;
        this._log('warn', 'tip dropped — queue full', { platform, user, tokens, maxQueue: s.maxQueue });
        this._emitStatus();
        return { queued: false, reason: 'queue-full' };
      }
      this.queue.push({ platform, user: user || 'anon', tokens: Number(tokens), intensity: level.intensity, seconds: level.seconds, at: Date.now() });
      this._log('info', 'tip queued', { platform, user, tokens, intensity: level.intensity, seconds: level.seconds, queued: this.queue.length });
      this._emitStatus();
      this._pump();
      return { queued: true };
    } catch (e) {
      this._log('error', 'enqueueTip threw', { error: e.message });
      return { queued: false, reason: 'error' };
    }
  }

  // Manual test (bypasses tip mapping, still queues so tests don't overlap)
  testVibrate(intensity, seconds) {
    if (this.state !== 'connected') return { queued: false, reason: 'not-connected' };
    if (this.queue.length >= this.settings.maxQueue) return { queued: false, reason: 'queue-full' };
    this.queue.push({ platform: 'test', user: 'test', tokens: 0, intensity: clamp(Number(intensity) || 0, 0, 1), seconds: clamp(Number(seconds) || 1, 0.1, 120), at: Date.now() });
    this._emitStatus();
    this._pump();
    return { queued: true };
  }

  _pump() {
    if (this.playing || !this.queue.length || this.state !== 'connected' || !this.backend) return;
    const item = this.queue.shift();
    this.playing = { ...item, startedAt: Date.now() };
    let n = 0;
    try { n = this.backend.vibrate(item.intensity, item.seconds); }
    catch (e) { this._log('error', 'vibrate threw', { error: e.message }); }
    this._log('info', 'play', { platform: item.platform, user: item.user, tokens: item.tokens, intensity: item.intensity, seconds: item.seconds, devices: n, queued: this.queue.length });
    this._emitStatus();
    this.playTimer = setTimeout(() => {
      this.playTimer = null; this.playing = null;
      try { this.backend?.stop(); } catch {}
      this._emitStatus();
      this._pump();
    }, item.seconds * 1000);
  }

  _clearPlayback() {
    clearTimeout(this.playTimer); this.playTimer = null;
    this.playing = null; this.queue = [];
  }

  // Emergency stop: drop queue, kill current vibration.
  stopAll(reason = 'user') {
    const had = this.queue.length + (this.playing ? 1 : 0);
    this._clearPlayback();
    try { this.backend?.stop(); } catch {}
    this._log('info', 'STOP', { reason, cleared: had });
    this._emitStatus();
    return { cleared: had };
  }

  // ── status ──────────────────────────────────────────────────────────────────
  getStatus() {
    const devices = this.backend ? this.backend.listDevices() : [];
    return {
      state: this.state,
      backend: this.settings.backend,
      error: this.error,
      devices,
      queued: this.queue.length,
      dropped: this.dropped,
      playing: this.playing && {
        platform: this.playing.platform, user: this.playing.user, tokens: this.playing.tokens,
        intensity: this.playing.intensity, seconds: this.playing.seconds,
        remaining: Math.max(0, this.playing.seconds - (Date.now() - this.playing.startedAt) / 1000),
      },
      next: this.queue.slice(0, 5).map(q => ({ platform: q.platform, user: q.user, tokens: q.tokens })),
    };
  }
  _emitStatus() { try { this.emit('status', this.getStatus()); } catch {} }

  shutdown() { this.wantConnected = false; clearTimeout(this.reconnectTimer); this.stopAll('shutdown'); this._teardownBackend(); }
}

module.exports = { ToyManager, DEFAULT_SETTINGS, DEFAULT_LEVELS, sanitizeSettings, levelForTokens, parseTipText };
