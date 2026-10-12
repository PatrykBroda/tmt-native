// Launches the real app, injects tips through the real CB/SC handlers, checks the goal bar + screenshot.
//   node scripts/test-goal-e2e.mjs [shotsDir]
import { _electron as electron } from 'playwright-core';
import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
import { fileURLToPath } from 'url';
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const SHOTS = process.argv[2] || path.join(APP_DIR, 'test-shots'); fs.mkdirSync(SHOTS, { recursive: true });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-menu-'));
const env = { ...process.env, TMT_TEST_HOOKS: '1', TMT_ALLOW_MULTI: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: BIN, args: [APP_DIR, `--user-data-dir=${userData}`], env, timeout: 30000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(2500);
const page = app.windows().find(w => w.url().includes('renderer/index.html')) ?? await app.firstWindow();
let fail = 0;
const check = async (n, fn) => { try { await fn(); console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n    ' + e.message); } };
await page.evaluate(() => showScreen('dashboard'));
await page.click('#extras-toggle');   // Extras are collapsed by default (round 12)
await page.fill('#tipmenu-input', '25 = blow a kiss; 50 = twirl; 100 = flash');
await sleep(1500);
await page.click('#tipmenu-toggle'); await sleep(500);
await check('saved + persisted via IPC', async () => {
  const c = await page.evaluate(() => window.api.tipMenuGet());
  assert.strictEqual(c.enabled, true); assert.match(c.text, /100 = flash/);
  assert.strictEqual(await page.textContent('#tipmenu-toggle-label'), 'ON');
});
await page.screenshot({ path: path.join(SHOTS, 'round6-tipmenu.png') });
await app.close();
console.log(fail ? 'FAILED' : 'tipmenu e2e OK'); process.exit(fail ? 1 : 0);
