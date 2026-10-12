// Dev helper: dashboard at small window sizes with goal reached; lists clipped/overflowing elements.
//   node scripts/shot-small.mjs <shotsDir> <round>
import { _electron as electron } from 'playwright-core';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { fileURLToPath } from 'url';
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const SHOTS = process.argv[2]; const R = process.argv[3] || 'x'; fs.mkdirSync(SHOTS, { recursive: true });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-small-'));
const env = { ...process.env, TMT_TEST_HOOKS: '1', TMT_ALLOW_MULTI: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: BIN, args: [APP_DIR, `--user-data-dir=${userData}`], env, timeout: 30000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(2500);
const page = app.windows().find(w => w.url().includes('renderer/index.html')) ?? await app.firstWindow();
await page.evaluate(() => showScreen('dashboard'));
await page.evaluate(() => window.api.goalSet({ title: 'Lingerie off', target: 500, enabled: true }));
await page.evaluate(() => window.api.tipmenuSet && window.api.tipmenuSet({ text: '25 = kiss; 50 = twirl', enabled: true }));
await page.evaluate(() => window.api.testInject('chaturbate', { method: 'tip', object: { tip: { tokens: 615 }, user: { username: 'bigspender' } } }));
for (const w of [900, 1024]) {
  await app.evaluate(({ BrowserWindow }, s) => { const b = BrowserWindow.getAllWindows()[0]; b.setSize(s, 760); }, w);
  await sleep(800);
  await page.screenshot({ path: path.join(SHOTS, `${R}-small-${w}.png`) });
  const bad = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.offsetParent && e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible' && e.clientWidth > 0).map(e => (e.id || e.className || e.tagName) + ' ' + e.scrollWidth + '>' + e.clientWidth + ' "' + (e.textContent || '').slice(0, 40) + '"'));
  console.log(w, 'clipped:', bad);
}
await app.close();
