// Real Electron: tips -> app quits -> relaunch with same profile -> goal total must survive.
//   node scripts/test-goal-restart-e2e.mjs [shotsDir]
import { _electron as electron } from 'playwright-core';
import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
import { fileURLToPath } from 'url';
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const SHOTS = process.argv[2] || path.join(APP_DIR, 'test-shots'); fs.mkdirSync(SHOTS, { recursive: true });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-goalr-'));
const env = { ...process.env, TMT_TEST_HOOKS: '1', TMT_ALLOW_MULTI: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function launch() {
  const app = await electron.launch({ executablePath: BIN, args: [APP_DIR, `--user-data-dir=${userData}`], env, timeout: 30000 });
  await sleep(2500);
  const page = app.windows().find(w => w.url().includes('renderer/index.html')) ?? await app.firstWindow();
  await page.evaluate(() => showScreen('dashboard'));
  return { app, page };
}
let { app, page } = await launch();
await page.evaluate(() => window.api.goalSet({ title: 'Show goal', target: 500, enabled: true }));
for (const [u, t] of [['bigspender', 150], ['alice', 40]])
  await page.evaluate(([u, t]) => window.api.testInject('chaturbate', { method: 'tip', object: { tip: { tokens: t }, user: { username: u } } }), [u, t]);
await sleep(1200); // debounce flush
await app.close();
({ app, page } = await launch());
await page.evaluate(() => renderGoal && window.api.goalGet().then(renderGoal));
await sleep(300);
const v = await page.evaluate(() => window.api.goalGet());
assert.strictEqual(v.total, 190); assert.strictEqual(v.top.user, 'bigspender');
assert.strictEqual(await page.textContent('#goal-text'), '190 / 500  👑 bigspender (150)');
await page.screenshot({ path: path.join(SHOTS, 'round10-goal-after-restart.png') });
await page.evaluate(() => window.api.goalReset());
await sleep(900); await app.close();
({ app, page } = await launch());
assert.strictEqual((await page.evaluate(() => window.api.goalGet())).total, 0, 'reset persists');
await app.close();
console.log('goal restart e2e OK');
