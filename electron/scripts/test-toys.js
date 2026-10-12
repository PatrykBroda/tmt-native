'use strict';
// Unit/integration test for toy-manager against the fake servers (plain Node, no Electron).
//   node scripts/test-toys.js
const assert = require('assert');
const { ToyManager, levelForTokens, DEFAULT_LEVELS, parseTipText, sanitizeSettings } = require('../toy-manager');
const fake = require('./fake-intiface');

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const WS_PORT = 23451, LV_PORT = 23452;

(async () => {
  // ── level mapping ──
  await t('tip → level mapping (default menu)', () => {
    const L = DEFAULT_LEVELS;
    assert.strictEqual(levelForTokens(L, 0), null);
    assert.strictEqual(levelForTokens(L, 1).seconds, 3);
    assert.strictEqual(levelForTokens(L, 9).intensity, 0.25);
    assert.strictEqual(levelForTokens(L, 10).seconds, 6);
    assert.strictEqual(levelForTokens(L, 49).intensity, 0.5);
    assert.strictEqual(levelForTokens(L, 50).seconds, 10);
    assert.strictEqual(levelForTokens(L, 99).intensity, 0.75);
    assert.strictEqual(levelForTokens(L, 100).seconds, 15);
    assert.strictEqual(levelForTokens(L, 99999).intensity, 1);
    assert.strictEqual(levelForTokens(L, '?'), null);
    assert.strictEqual(levelForTokens(L, '25').seconds, 6);   // string amounts from sites
  });
  await t('settings sanitizer rejects junk levels', () => {
    const s = sanitizeSettings({ levels: [{ min: 0, intensity: 1, seconds: 1 }, { min: 5, max: 2, intensity: 5, seconds: 9999 }, { min: 3, intensity: 0, seconds: 1 }], maxQueue: 9999 });
    assert.strictEqual(s.levels.length, 1);
    assert.strictEqual(s.levels[0].max, null); assert.strictEqual(s.levels[0].intensity, 1); assert.strictEqual(s.levels[0].seconds, 120);
    assert.strictEqual(s.maxQueue, 100);
  });
  await t('parseTipText heuristics', () => {
    assert.strictEqual(parseTipText('Bob tipped 50 tokens'), 50);
    assert.strictEqual(parseTipText('sent you 25 tk'), 25);
    assert.strictEqual(parseTipText('hello what are tokens'), null);
  });

  // ── queue / playback against fake Intiface ──
  const srv = fake.start({ wsPort: WS_PORT, lovensePort: LV_PORT, quiet: true });
  const quick = [{ min: 1, max: 9, intensity: 0.25, seconds: 0.3 }, { min: 10, max: 49, intensity: 0.5, seconds: 0.3 }, { min: 50, max: null, intensity: 1, seconds: 0.3 }];
  const mk = (extra = {}) => new ToyManager({ settings: { backend: 'intiface', intifaceUrl: `ws://127.0.0.1:${WS_PORT}`, levels: quick, maxQueue: 4, ...extra } });
  const cmds = (src, name) => srv.entries.filter(e => e.src === src && e.cmd === name);

  await t('tip while disconnected is ignored, never throws', () => {
    const m = mk();
    assert.deepStrictEqual(m.enqueueTip({ platform: 'chaturbate', user: 'a', tokens: 10 }), { queued: false, reason: 'not-connected' });
  });
  await t('connect to unreachable server → disconnected + error, no throw', async () => {
    const m = new ToyManager({ settings: { intifaceUrl: 'ws://127.0.0.1:1' } });
    const st = await m.connect();
    assert.strictEqual(st.state, 'disconnected'); assert.ok(st.error);
    m.shutdown();
  });

  const m = mk();
  await t('connects to fake Intiface and sees the fake Lush 3', async () => {
    const st = await m.connect();
    assert.strictEqual(st.state, 'connected');
    await sleep(500);
    const d = m.getStatus().devices;
    assert.strictEqual(d.length, 1); assert.strictEqual(d[0].name, 'Lovense Lush 3');
  });
  await t('cross-platform tips play strictly in arrival order with right intensity', async () => {
    const before = srv.entries.length;
    m.enqueueTip({ platform: 'chaturbate', user: 'u1', tokens: 5 });    // 0.25
    m.enqueueTip({ platform: 'stripchat',  user: 'u2', tokens: 20 });   // 0.5
    m.enqueueTip({ platform: 'bongacams',  user: 'u3', tokens: 75 });   // 1
    m.enqueueTip({ platform: 'chaturbate', user: 'u4', tokens: 12 });   // 0.5
    assert.strictEqual(m.getStatus().queued, 3);
    await sleep(1700);
    const sc = srv.entries.slice(before).filter(e => e.cmd === 'ScalarCmd').map(e => e.scalars[0].Scalar);
    assert.deepStrictEqual(sc, [0.25, 0.5, 1, 0.5]);
    const gaps = srv.entries.slice(before).filter(e => e.cmd === 'ScalarCmd').map(e => e.t);
    for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i] - gaps[i - 1] >= 280, 'gap ' + (gaps[i] - gaps[i - 1]));
    assert.ok(srv.entries.slice(before).some(e => e.cmd === 'StopAllDevices'));
    assert.strictEqual(m.getStatus().playing, null);
  });
  await t('max-queue cap drops overflow (1 playing + 4 queued, rest dropped)', async () => {
    const before = srv.entries.length;
    const res = []; for (let i = 0; i < 9; i++) res.push(m.enqueueTip({ platform: 'chaturbate', user: 'x' + i, tokens: 10 }).queued);
    assert.deepStrictEqual(res, [true, true, true, true, true, false, false, false, false]);
    assert.strictEqual(m.getStatus().queued, 4); assert.ok(m.getStatus().dropped >= 4);
    m.stopAll();
    await sleep(100);
    assert.strictEqual(srv.entries.slice(before).filter(e => e.cmd === 'ScalarCmd').length, 1);
  });
  await t('Stop clears queue + sends stop, nothing plays afterwards', async () => {
    m.enqueueTip({ platform: 'stripchat', user: 'a', tokens: 50 });
    m.enqueueTip({ platform: 'stripchat', user: 'b', tokens: 50 });
    await sleep(100);
    const before = srv.entries.length;
    const r = m.stopAll();
    assert.strictEqual(r.cleared, 2);
    await sleep(800);
    const after = srv.entries.slice(before).map(e => e.cmd);
    assert.deepStrictEqual(after, ['StopAllDevices']);
    assert.strictEqual(m.getStatus().queued, 0); assert.strictEqual(m.getStatus().playing, null);
  });
  await t('below-minimum tip is not queued', () => {
    assert.strictEqual(m.enqueueTip({ platform: 'chaturbate', user: 'a', tokens: 0 }).reason, 'no-level');
  });
  await t('auto-reconnect after server drops the connection', async () => {
    await srv.close();
    await sleep(300);
    assert.strictEqual(m.getStatus().state, 'disconnected');
    const srv2 = fake.start({ wsPort: WS_PORT, lovensePort: LV_PORT, quiet: true });
    for (let i = 0; i < 40 && m.getStatus().state !== 'connected'; i++) await sleep(250);
    assert.strictEqual(m.getStatus().state, 'connected');
    m.disconnect(); await srv2.close();
  });

  // ── Lovense backend ──
  const srv3 = fake.start({ wsPort: WS_PORT + 10, lovensePort: LV_PORT, quiet: true });
  await t('Lovense backend: GetToys, Vibrate level→0-20, Stop', async () => {
    const lv = new ToyManager({ settings: { backend: 'lovense', lovenseHost: '127.0.0.1', lovensePort: LV_PORT, levels: quick } });
    const st = await lv.connect();
    assert.strictEqual(st.state, 'connected'); assert.strictEqual(st.devices[0].name, 'Lush 3');
    lv.enqueueTip({ platform: 'stripchat', user: 'z', tokens: 20 });
    await sleep(500);
    const f = srv3.entries.filter(e => e.src === 'lovense' && e.cmd === 'Function');
    assert.strictEqual(f[0].action, 'Vibrate:10'); assert.strictEqual(f[0].timeSec, 1); assert.strictEqual(f[0].apiVer, 1);
    assert.strictEqual(f[1].action, 'Stop');
    lv.disconnect();
  });
  await srv3.close();

  console.log(`\n  Passed: ${pass}   Failed: ${fail}`);
  process.exit(fail ? 1 : 0);
})();
