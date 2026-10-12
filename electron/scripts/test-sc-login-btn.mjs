// Checklist "Log in to Stripchat" button opens the SC panel directly (and doesn't toggle it closed on 2nd click).
import { _electron as electron } from 'playwright-core';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { fileURLToPath } from 'url';
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-scl-'));
const env = { ...process.env, TMT_TEST_HOOKS: '1', TMT_ALLOW_MULTI: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: BIN, args: [APP_DIR, `--user-data-dir=${userData}`], env, timeout: 30000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(2500);
const page = app.windows().find(w => w.url().includes('renderer/index.html')) ?? await app.firstWindow();
await page.evaluate(() => {
  showScreen('dashboard');
  Object.assign(setup, { studio: true, camera: 'ok', mic: 'ok', scLoggedIn: false, destinations: [{ id: 1, name: 'Stripchat' }] });
  renderSetup();
});
const click = async () => { await page.click('#setup-action'); await sleep(500); return page.evaluate(() => document.getElementById('broadcast-btn').classList.contains('active')); };
const a = await click(), b = await click();
const settingsOpen = await page.evaluate(() => document.getElementById('settings-screen').classList.contains('active'));
await app.close();
console.log({ afterFirst: a, afterSecond: b, settingsOpen });
if (!a || !b || settingsOpen) { console.error('FAIL'); process.exit(1); }
console.log('PASS');
