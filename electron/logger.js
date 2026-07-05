'use strict';
const { randomUUID } = require('crypto');
const pkg = require('./package.json');

const SESSION_ID  = randomUUID();
const APP_VERSION = pkg.version;
const PLATFORM    = process.platform === 'win32' ? 'windows'
                  : process.platform === 'darwin' ? 'macos' : 'linux';

const FLUSH_INTERVAL_MS = 8000;
const FLUSH_THRESHOLD   = 50;   // flush early when queue hits this
const MAX_BATCH         = 100;  // API hard limit
const MAX_MSG_LEN       = 8000;
const MAX_CTX_LEN       = 16384;
const VALID_LEVELS      = new Set(['debug', 'info', 'warn', 'error']);

let _token     = null;
let _base      = 'https://admin.agencytmt.com';
let _queue     = [];
let _timer     = null;
let _backoffMs = 0;
let _failedAt  = 0;
let _flushing  = false;

// ── public ─────────────────────────────────────────────────────────────────────

function setToken(token) { _token = token; }
function clearToken()    { _token = null; }
function setBase(base)   { _base = base; }

function push(level, message, context) {
  if (!message || typeof message !== 'string') return;
  if (!VALID_LEVELS.has(level)) level = 'info';

  const entry = {
    level,
    message:  message.slice(0, MAX_MSG_LEN),
    clientTs: new Date().toISOString(),
  };

  if (context != null) {
    try {
      const s = JSON.stringify(context);
      if (s.length <= MAX_CTX_LEN) entry.context = context;
    } catch {}
  }

  _queue.push(entry);
  if (_queue.length >= FLUSH_THRESHOLD) flush().catch(() => {});
}

async function flush() {
  if (!_token || _queue.length === 0 || _flushing) return;

  // Respect backoff after failures
  if (_backoffMs > 0 && Date.now() - _failedAt < _backoffMs) return;

  _flushing = true;
  const batch = _queue.splice(0, MAX_BATCH);

  try {
    const res = await fetch(`${_base}/api/desktop/logs`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${_token}`,
      },
      body: JSON.stringify({
        appVersion: APP_VERSION,
        sessionId:  SESSION_ID,
        platform:   PLATFORM,
        logs:       batch,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 429 || res.status >= 500) {
      _queue.unshift(...batch);
      _backoffMs = Math.min((_backoffMs || 5000) * 2, 120000);
      _failedAt  = Date.now();
    } else {
      _backoffMs = 0;
    }
  } catch {
    _queue.unshift(...batch);
    _backoffMs = Math.min((_backoffMs || 5000) * 2, 120000);
    _failedAt  = Date.now();
  } finally {
    _flushing = false;
  }
}

function start(token, base) {
  if (token) _token = token;
  if (base)  _base  = base;
  if (_timer) return;
  _timer = setInterval(() => flush().catch(() => {}), FLUSH_INTERVAL_MS);
}

function stop() {
  clearInterval(_timer);
  _timer = null;
  flush().catch(() => {});
}

async function getLogs(params = {}) {
  if (!_token) return null;
  const qs = new URLSearchParams();
  if (params.level)  qs.set('level',  params.level);
  if (params.since)  qs.set('since',  params.since);
  if (params.until)  qs.set('until',  params.until);
  if (params.limit)  qs.set('limit',  String(params.limit));
  if (params.before) qs.set('before', String(params.before));
  try {
    const res = await fetch(`${_base}/api/desktop/logs?${qs}`, {
      headers: { 'Authorization': `Bearer ${_token}` },
      signal:  AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// ── exports ────────────────────────────────────────────────────────────────────

const logger = {
  debug: (msg, ctx) => push('debug', msg, ctx),
  info:  (msg, ctx) => push('info',  msg, ctx),
  warn:  (msg, ctx) => push('warn',  msg, ctx),
  error: (msg, ctx) => push('error', msg, ctx),
  setToken,
  clearToken,
  setBase,
  start,
  stop,
  flush,
  getLogs,
  get sessionId()  { return SESSION_ID; },
  get appVersion() { return APP_VERSION; },
  get platform()   { return PLATFORM; },
};

module.exports = logger;
