// Dev helper: screenshot the dashboard setup checklist in the "Stripchat not logged in" state.
//   node scripts/shot-checklist.mjs <outfile.png>
import { _electron as electron } from 'playwright-core';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { fileURLToPath } from 'url';
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-chk-'));
const env = { ...process.env, TMT_TEST_HOOKS: '1', TMT_ALLOW_MULTI: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: BIN, args: [APP_DIR, `--user-data-dir=${userData}`], env, timeout: 30000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(2500);
const page = app.windows().find(w => w.url().includes('renderer/index.html')) ?? await app.firstWindow();
const out = await page.evaluate(() => {
  showScreen('dashboard');
  Object.assign(setup, { studio: true, camera: 'ok', mic: 'ok', scLoggedIn: false,
    destinations: [{ id: 1, name: 'Stripchat' }, { id: 2, name: 'Chaturbate', eventsToken: 'x' }] });
  renderSetup();
  const h1 = document.getElementById('setup-headline').textContent;
  setup.scLoggedIn = null; renderSetup();
  return { notLoggedIn: h1, unknown: document.getElementById('setup-headline').textContent };
});
console.log(out);
await page.evaluate(() => { setup.scLoggedIn = false; renderSetup(); });
await sleep(300);
await page.screenshot({ path: process.argv[2] });
await app.close();
