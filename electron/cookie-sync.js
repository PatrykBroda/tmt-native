'use strict';
const { session } = require('electron');

const BASE = 'https://admin.agencytmt.com/api/desktop';

async function apiCall(method, path, token, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    return await fetch(`${BASE}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
  } finally {
    clearTimeout(timer);
  }
}

// Export every cookie from the Electron session and PUT to the API.
async function saveCookies(token, platform, partitionName) {
  if (!token || !platform) return { ok: false };
  try {
    const cookies = await session.fromPartition(partitionName).cookies.get({});
    if (cookies.length === 0) return { ok: false, reason: 'no-cookies' };
    const res = await apiCall('PUT', `/cookies/${platform}`, token, { cookies, ttlDays: 30 });
    return { ok: res.ok };
  } catch (e) {
    console.error('[cookie-sync] save:', e.message);
    return { ok: false };
  }
}

// Fetch cookies from the API and inject them into the Electron session.
// Returns { ok, reason } — callers handle 'not-found' and 'rotated' specially.
async function restoreCookies(token, platform, partitionName) {
  if (!token || !platform) return { ok: false };
  try {
    const res = await apiCall('GET', `/cookies/${platform}`, token);
    if (res.status === 404) return { ok: false, reason: 'not-found' };
    if (res.status === 409) return { ok: false, reason: 'rotated' };
    if (!res.ok)            return { ok: false, reason: `http-${res.status}` };

    const data    = await res.json();
    const cookies = Array.isArray(data.cookies) ? data.cookies : null;
    if (!cookies || cookies.length === 0) return { ok: false, reason: 'empty' };

    const s = session.fromPartition(partitionName);
    let injected = 0;
    for (const c of cookies) {
      try {
        const domain = (c.domain || '').replace(/^\./, '');
        await s.cookies.set({
          url:            `https://${domain}${c.path || '/'}`,
          name:           c.name,
          value:          c.value,
          domain:         c.domain,
          path:           c.path          || '/',
          secure:         c.secure        ?? false,
          httpOnly:       c.httpOnly      ?? false,
          expirationDate: c.expirationDate ?? c.expires,
          sameSite:       c.sameSite      ?? 'no_restriction',
        });
        injected++;
      } catch {} // skip cookies that fail (e.g. malformed domain)
    }
    return { ok: injected > 0, injected };
  } catch (e) {
    console.error('[cookie-sync] restore:', e.message);
    return { ok: false };
  }
}

// DELETE all saved sessions from the API — call on logout.
async function deleteAllCookies(token) {
  if (!token) return { ok: false };
  try {
    const res = await apiCall('DELETE', '/cookies', token);
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

module.exports = { saveCookies, restoreCookies, deleteAllCookies };
