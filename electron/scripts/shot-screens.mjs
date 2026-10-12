// Dev helper: screenshot login/settings/admin/toys-open at min window width; list clipped elements.
//   node scripts/shot-screens.mjs <shotsDir> <round>
import { _electron as electron } from 'playwright-core';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { fileURLToPath } from 'url';
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const SHOTS = process.argv[2]; const R = process.argv[3] || 'x'; fs.mkdirSync(SHOTS, { recursive: true });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-scr-'));
const env = { ...process.env, TMT_TEST_HOOKS: '1', TMT_ALLOW_MULTI: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: BIN, args: [APP_DIR, `--user-data-dir=${userData}`], env, timeout: 30000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(2500);
const page = app.windows().find(w => w.url().includes('renderer/index.html')) ?? await app.firstWindow();
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 600));
await sleep(600);
const scan = () => page.evaluate(() => [...document.querySelectorAll('.screen.active *')].filter(e => e.offsetParent && e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible' && e.clientWidth > 0).map(e => (e.id || e.className || e.tagName) + ' ' + e.scrollWidth + '>' + e.clientWidth + ' "' + (e.textContent || '').slice(0, 40) + '"'));
for (const name of ['login', 'settings', 'admin', 'dashboard']) {
  await page.evaluate(n => showScreen(n), name);
  if (name === 'dashboard') await page.evaluate(() => { const b = document.getElementById('extras'); if (!b.classList.contains('open')) document.getElementById('extras-toggle').click(); document.getElementById('toy-panel').classList.add('open'); document.getElementById('extras').scrollTop = 99999; });
  await sleep(500);
  await page.screenshot({ path: path.join(SHOTS, `${R}-screen-${name}-900.png`) });
  console.log(name, 'clipped:', await scan());
}
await app.close();
