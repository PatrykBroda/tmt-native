// Launches the real app, injects tips through the real CB/SC handlers, checks the goal bar + screenshot.
//   node scripts/test-goal-e2e.mjs [shotsDir]
import { _electron as electron } from 'playwright-core';
import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
import { fileURLToPath } from 'url';
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const SHOTS = process.argv[2] || path.join(APP_DIR, 'test-shots'); fs.mkdirSync(SHOTS, { recursive: true });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-viewers-'));
const env = { ...process.env, TMT_TEST_HOOKS: '1', TMT_ALLOW_MULTI: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: BIN, args: [APP_DIR, `--user-data-dir=${userData}`], env, timeout: 30000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(2500);
const page = app.windows().find(w => w.url().includes('renderer/index.html')) ?? await app.firstWindow();
let fail = 0;
const check = async (n, fn) => { try { await fn(); console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n    ' + e.message); } };
await page.evaluate(() => showScreen('dashboard'));
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.webContents.send('desktop:viewer-count', { total: 17, platforms: { Chaturbate: 12, Stripchat: 5 } })));
await sleep(500);
await check('total + per-platform breakdown shown', async () => {
  assert.strictEqual(await page.textContent('#viewer-count'), '17');
  assert.match(await page.textContent('#viewer-breakdown'), /Chaturbate 12 · Stripchat 5/);
});
await page.screenshot({ path: path.join(SHOTS, 'round9-viewers.png') });
await app.close();
console.log(fail ? 'FAILED' : 'viewers e2e OK'); process.exit(fail ? 1 : 0);
