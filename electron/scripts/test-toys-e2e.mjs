/**
 * End-to-end toy test: launches the real Electron app against the fake Intiface / Lovense servers,
 * injects synthetic tips through the app's real CB / SC / BongaCams handlers, asserts from the
 * fake-server log, and takes screenshots.
 *   node scripts/test-toys-e2e.mjs [shotsDir]
 */
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const fake = require('./fake-intiface.js');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const BIN = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const SHOTS = process.argv[2] || path.join(APP_DIR, 'test-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-toys-'));
const logFile = path.join(SHOTS, 'fake-toy-commands.log');
fs.rmSync(logFile, { force: true });

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launch() {
  const env = { ...process.env, TMT_TEST_HOOKS: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: BIN, args: [APP_DIR, `--user-data-dir=${userData}`], env, timeout: 30000 });
  await sleep(2500);
  const page = app.windows().find(w => w.url().includes('renderer/index.html')) ?? await app.firstWindow();
  return { app, page };
}
const shot = async (page, name) => { await page.screenshot({ path: path.join(SHOTS, name + '.png') }); console.log('     shot ' + name + '.png'); };
const state = page => page.evaluate(() => window.api.toysGet().then(r => r.status));
const waitFor = async (page, pred, ms = 8000) => { for (let t = 0; t < ms; t += 200) { const s = await state(page); if (pred(s)) return s; await sleep(200); } throw new Error('timeout waiting for state: ' + JSON.stringify(await state(page))); };

const srv = fake.start({ wsPort: 12345, lovensePort: 20010, logFile, quiet: true });
const E = () => srv.entries;

console.log('\n━━━ TMT Native — toys E2E ━━━\n');
let { app, page } = await launch();

await check('app starts; login screen renders (no regression)', async () => {
  assert.strictEqual(await page.evaluate(() => document.querySelector('.screen.active')?.id), 'login-screen');
  assert.ok(await page.evaluate(() => !!document.querySelector('.brand-logo-img') && !!document.getElementById('login-btn')));
  await shot(page, '01-login-screen');
});

// There is no TMT backend here, so we can't log in; reveal the dashboard directly (renderer-only).
await page.evaluate(() => { showScreen('dashboard'); });
await page.evaluate(() => window.api.toysSetSettings({
  bongaTipParsing: true, maxQueue: 6,
  levels: [{ min: 1, max: 9, intensity: 0.25, seconds: 2 }, { min: 10, max: 49, intensity: 0.5, seconds: 2 }, { min: 50, max: null, intensity: 1, seconds: 2 }],
}));
await page.evaluate(() => { setTimeout(() => location.reload(), 10); });   // re-init the renderer with saved settings
await sleep(1500);
await page.evaluate(() => { showScreen('dashboard'); });
await page.click('#toy-expand');
await sleep(300);
await shot(page, '02-toys-disconnected');

await check('default Intiface URL is ws://127.0.0.1:12345 and Connect works via UI', async () => {
  assert.strictEqual(await page.inputValue('#toy-intiface-url'), 'ws://127.0.0.1:12345');
  await page.click('#toy-connect');
  const s = await waitFor(page, s => s.state === 'connected' && s.devices.length === 1);
  assert.strictEqual(s.devices[0].name, 'Lovense Lush 3');
  assert.ok(E().some(e => e.cmd === 'RequestServerInfo' && e.client === 'TMT Native'));
  assert.ok(E().some(e => e.cmd === 'StartScanning'));
  assert.match(await page.textContent('#toy-status'), /Connected · 1 toy/);
  await shot(page, '03-toys-connected');
});

await check('synthetic tips from CB, SC, BongaCams play in order with mapped intensity', async () => {
  const mark = E().length;
  await page.evaluate(async () => {
    const w = window.api;
    await w.testInject('chaturbate', { method: 'tip', object: { tip: { tokens: 5 }, user: { username: 'cb_fan' } } });             // 0.25
    await w.testInject('stripchat', '42["tip",{"amount":20,"user":{"username":"sc_fan"}}]');                                        // 0.5
    await w.testInject('bongacams', { platform: 'bongacams', type: 'chat', username: 'bc_fan', text: 'bc_fan tipped 60 tokens' }); // 1.0
    await w.testInject('chaturbate', { method: 'tip', object: { tip: { tokens: 12 }, user: { username: 'cb_fan2' } } });            // 0.5
    await w.testInject('chaturbate', { method: 'tip', object: { tip: { tokens: 0 }, user: { username: 'cheap' } } });              // ignored
  });
  await sleep(700);
  const mid = await state(page);
  assert.ok(mid.playing && mid.queued === 3, 'expected 1 playing + 3 queued, got ' + JSON.stringify(mid));
  await shot(page, '04-toys-queue-playing');
  await sleep(8000);
  const cmds = E().slice(mark).filter(e => e.cmd === 'ScalarCmd');
  assert.deepStrictEqual(cmds.map(c => c.scalars[0].Scalar), [0.25, 0.5, 1, 0.5]);
  for (let i = 1; i < cmds.length; i++) assert.ok(cmds[i].t - cmds[i - 1].t >= 1900, 'duration gap ' + (cmds[i].t - cmds[i - 1].t));
  const stops = E().slice(mark).filter(e => e.cmd === 'StopAllDevices');
  assert.ok(stops.length >= 4);
  console.log('     command timeline (ms from first): ' + cmds.map(c => `${c.scalars[0].Scalar}@${c.t - cmds[0].t}`).join('  '));
});

await check('STOP button clears the queue and stops the toy', async () => {
  await page.evaluate(async () => { for (const t of [30, 30, 30, 30]) await window.api.testInject('chaturbate', { method: 'tip', object: { tip: { tokens: t }, user: { username: 'storm' } } }); });
  await sleep(500);
  assert.strictEqual((await state(page)).queued, 3);
  const mark = E().length;
  await page.click('#toy-stop');
  await sleep(2600);
  const after = E().slice(mark).map(e => e.cmd);
  assert.deepStrictEqual(after, ['StopAllDevices']);
  const s = await state(page); assert.strictEqual(s.queued, 0); assert.strictEqual(s.playing, null);
  assert.strictEqual(await page.textContent('#toy-now'), 'Idle');
});

await check('test buttons (Low/Med/High) drive the toy', async () => {
  const mark = E().length;
  await page.click('.toy-test[data-i="1"]');
  await sleep(500);
  assert.strictEqual(E().slice(mark).find(e => e.cmd === 'ScalarCmd').scalars[0].Scalar, 1);
  await page.click('#toy-stop');
});

await check('settings editor: add a level via UI, persisted to toys.json', async () => {
  await page.click('#toy-add-level');
  await sleep(1200);
  await shot(page, '05-toys-settings');
  const saved = JSON.parse(fs.readFileSync(path.join(userData, 'toys.json'), 'utf8'));
  assert.strictEqual(saved.levels.length, 4);
  assert.strictEqual(saved.maxQueue, 6);
});

// ── Lovense Remote backend through the UI ──
await check('Lovense Remote backend: connect, tip → Function Vibrate, Stop', async () => {
  await page.click('#toy-connect');                         // disconnect first
  await waitFor(page, s => s.state === 'disconnected');
  await page.selectOption('#toy-backend', 'lovense');
  await page.fill('#toy-lovense-host', '127.0.0.1');
  await page.fill('#toy-lovense-port', '20010');
  await page.dispatchEvent('#toy-lovense-port', 'change');
  await page.click('#toy-connect');
  const s = await waitFor(page, s => s.state === 'connected' && s.devices.length === 1);
  assert.strictEqual(s.backend, 'lovense');
  const mark = E().length;
  await page.evaluate(() => window.api.testInject('stripchat', '42["tip",{"amount":20,"user":{"username":"sc_fan"}}]'));
  await sleep(2600);
  const f = E().slice(mark).filter(e => e.src === 'lovense' && e.cmd === 'Function');
  assert.strictEqual(f[0].action, 'Vibrate:10'); assert.strictEqual(f[0].timeSec, 2);
  assert.strictEqual(f[1].action, 'Stop');
  await shot(page, '06-toys-lovense-backend');
});

await check('toy server failure never breaks the app (server killed mid-session)', async () => {
  await srv.close();
  await waitFor(page, s => s.state !== 'connected', 9000);   // Lovense backend notices on its 5 s poll
  await page.evaluate(() => window.api.testInject('chaturbate', { method: 'tip', object: { tip: { tokens: 50 }, user: { username: 'x' } } }));
  assert.ok(await page.evaluate(() => document.querySelector('.screen.active')?.id === 'dashboard-screen'));
  assert.notStrictEqual((await state(page)).state, 'connected');
  await shot(page, '07-toys-server-down');
});

await app.close();

await check('settings survive a restart (autoConnect off, levels kept)', async () => {
  ({ app, page } = await launch());
  const r = await page.evaluate(() => window.api.toysGet());
  assert.strictEqual(r.settings.backend, 'lovense');
  assert.strictEqual(r.settings.levels.length, 4);
  assert.strictEqual(r.status.state, 'disconnected');
  await app.close();
});

console.log(`\n  Passed: ${pass}   Failed: ${fail}\n  fake-server log: ${logFile}\n`);
process.exit(fail ? 1 : 0);
