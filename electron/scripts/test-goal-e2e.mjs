// Launches the real app, injects tips through the real CB/SC handlers, checks the goal bar + screenshot.
//   node scripts/test-goal-e2e.mjs [shotsDir]
import { _electron as electron } from 'playwright-core';
import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
import { fileURLToPath } from 'url';
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const SHOTS = process.argv[2] || path.join(APP_DIR, 'test-shots'); fs.mkdirSync(SHOTS, { recursive: true });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-goal-'));
const env = { ...process.env, TMT_TEST_HOOKS: '1', TMT_ALLOW_MULTI: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: BIN, args: [APP_DIR, `--user-data-dir=${userData}`], env, timeout: 30000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(2500);
const page = app.windows().find(w => w.url().includes('renderer/index.html')) ?? await app.firstWindow();
let fail = 0;
const check = async (n, fn) => { try { await fn(); console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n    ' + e.message); } };
await page.evaluate(() => showScreen('dashboard'));
await page.evaluate(() => window.api.goalSet({ title: 'Lingerie off', target: 500, enabled: true }));
await sleep(300);
const cb = (user, tokens) => page.evaluate(([u, t]) => window.api.testInject('chaturbate', { method: 'tip', object: { tip: { tokens: t }, user: { username: u } } }), [user, tokens]);
await cb('bigspender', 150); await cb('alice', 40); await cb('alice', 25);
await sleep(500);
await check('total/top tipper reach UI', async () => {
  assert.strictEqual(await page.textContent('#goal-text'), '215 / 500  👑 bigspender (150)');
  assert.strictEqual(await page.evaluate(() => window.api.goalGet().then(v => v.percent)), 43);
});
await page.screenshot({ path: path.join(SHOTS, 'round5-goal.png') });
await cb('bigspender', 400); await sleep(400);
await check('goal reached state', async () => assert.match(await page.textContent('#goal-text'), /GOAL REACHED/));
await page.screenshot({ path: path.join(SHOTS, 'round5-goal-reached.png') });
await check('reset', async () => { await page.evaluate(() => window.api.goalReset().then(renderGoal)); assert.strictEqual(await page.textContent('#goal-text'), '0 / 500'); });
await app.close();
console.log(fail ? 'FAILED' : 'goal e2e OK'); process.exit(fail ? 1 : 0);
