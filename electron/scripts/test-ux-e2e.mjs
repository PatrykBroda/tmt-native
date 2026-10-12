// Real Electron: checklist next-step text, ending a live show needs confirmation, extras collapsed by default.
//   node scripts/test-ux-e2e.mjs
import { _electron as electron } from 'playwright-core';
import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
import { fileURLToPath } from 'url';
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-uxe-'));
const env = { ...process.env, TMT_TEST_HOOKS: '1', TMT_ALLOW_MULTI: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: BIN, args: [APP_DIR, `--user-data-dir=${userData}`], env, timeout: 30000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(2500);
const page = app.windows().find(w => w.url().includes('renderer/index.html')) ?? await app.firstWindow();
const send = (ch, d) => app.evaluate(({ BrowserWindow }, [c, x]) => BrowserWindow.getAllWindows()[0].webContents.send(c, x), [ch, d]);
let fail = 0;
const check = async (n, fn) => { try { await fn(); console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n    ' + e.message); } };
const text = id => page.textContent('#' + id);
await page.evaluate(() => { showScreen('dashboard'); setup.destinations = []; setup.studio = true; setup.camera = 'ok'; setup.mic = 'ok'; renderSetup(); });
await check('no site connected -> step 1 is connect a site', async () => {
  assert.match(await text('setup-headline'), /connect the site/i);
  assert.ok(await page.isVisible('#setup-action'));
});
await page.evaluate(() => { setup.destinations = [{ id: 5, name: 'Chaturbate', username: 'm', eventsToken: '' }]; renderSetup(); });
await check('chaturbate without tips token -> link tips', async () => assert.match(await text('setup-headline'), /link Chaturbate/i));
await page.evaluate(() => { setup.destinations[0].eventsToken = 'tok'; setup.camera = 'bad'; renderSetup(); });
await check('camera missing -> plain camera message', async () => assert.match(await text('setup-headline'), /camera/i));
await page.evaluate(() => { setup.camera = 'ok'; renderSetup(); });
await check('everything ready -> press GO LIVE', async () => assert.match(await text('setup-headline'), /all set/i));
await check('extras collapsed by default', async () => assert.ok(!(await page.isVisible('#promo-input'))));
await page.click('#extras-toggle');
await check('extras open on click', async () => assert.ok(await page.isVisible('#promo-input')));
await page.click('#extras-toggle');

await send('desktop:obs-status', { connected: true });
await send('desktop:status-update', { live: true, bitrate: 4000, droppedFrames: 0, cpuUsage: 5 });
await sleep(300);
await check('live -> button says END SHOW, checklist hidden', async () => {
  assert.strictEqual((await text('go-live-btn')).trim(), 'END SHOW');
  assert.ok(!(await page.isVisible('#setup-card')));
});
await page.click('#go-live-btn');
await check('clicking END SHOW asks first', async () => assert.ok(await page.isVisible('#confirm-overlay .sc-modal')));
await page.click('#confirm-no');
await sleep(200);
await check('Keep streaming leaves show running', async () => {
  assert.ok(!(await page.isVisible('#confirm-overlay .sc-modal')));
  assert.strictEqual((await text('go-live-btn')).trim(), 'END SHOW');
  assert.ok(!(await page.isDisabled('#go-live-btn')));
});
await page.click('#go-live-btn'); await page.keyboard.press('Escape'); await sleep(200);
await check('Esc also keeps streaming', async () => assert.ok(!(await page.isVisible('#confirm-overlay .sc-modal'))));
await page.click('#logout-btn');
await check('log out while live asks first', async () => {
  assert.ok(await page.isVisible('#confirm-overlay .sc-modal'));
  assert.ok(await page.isVisible('#dashboard-screen'));
});
await page.click('#confirm-no');
await page.evaluate(() => window.api.testWantLive(true));
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
await sleep(500);
await check('closing the window while live is blocked and asks first', async () => {
  assert.ok(!page.isClosed());
  assert.ok(await page.isVisible('#confirm-overlay .sc-modal'));
  assert.match(await text('confirm-title'), /close the app/i);
});
await page.click('#confirm-no');
await page.evaluate(() => window.api.testWantLive(false));
await app.close();
console.log(fail ? 'FAILED' : 'ux e2e OK'); process.exit(fail ? 1 : 0);
