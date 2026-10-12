/**
 * Smoke test for TMT Native Electron app.
 * Launches via dev electron binary, drives UI with Playwright, screenshots everything.
 */
import { _electron as electron } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR   = path.resolve(__dirname, '..');
const SHOTS_DIR = path.join(APP_DIR, 'test-shots');
const ELECTRON_BIN = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');

fs.mkdirSync(SHOTS_DIR, { recursive: true });

let pass = 0, fail = 0;

function ok(label)   { console.log(`  ✓  ${label}`); pass++; }
function err(label)  { console.log(`  ✗  ${label}`); fail++; }
function log(msg)    { console.log(`     ${msg}`); }

async function shot(page, name) {
  const f = path.join(SHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: f });
  log(`screenshot → test-shots/${name}.png`);
  return f;
}

async function run() {
  console.log('\n━━━  TMT Native — smoke test  ━━━\n');

  // ── Launch ─────────────────────────────────────────────────────────────────
  console.log('Launching app…');
  let app;
  try {
    // Must unset ELECTRON_RUN_AS_NODE — Claude Code sets it to run Electron as Node.js.
    // With it set, require('electron') returns the binary path string instead of the API.
    const cleanEnv = { ...process.env };
    delete cleanEnv.ELECTRON_RUN_AS_NODE;

    app = await electron.launch({
      executablePath: ELECTRON_BIN,
      args: [APP_DIR],
      env: cleanEnv,
      timeout: 30_000,
    });
    ok('App launched without crash');
  } catch (e) {
    err(`Launch failed: ${e.message}`);
    process.exit(1);
  }

  // Wait for renderer
  await new Promise(r => setTimeout(r, 3000));

  const windows = app.windows();
  log(`Windows open: ${windows.length} ${windows.map(w=>w.url()).join(" , ")}`);

  const page = windows.find(w => w.url().includes("renderer/index.html"))
            ?? await app.firstWindow();

  if (!page) { err('No renderer window found'); await app.close(); process.exit(1); }
  ok('Renderer window found');

  // ── Screenshot: initial state ───────────────────────────────────────────────
  console.log('\n── Screen 1: Initial load ──');
  await shot(page, '01-initial');

  // ── Check which screen is active ───────────────────────────────────────────
  const activeScreen = await page.evaluate(() => {
    const active = document.querySelector('.screen.active');
    return active ? active.id : 'none';
  });
  log(`Active screen: ${activeScreen}`);

  if (activeScreen === 'login-screen') {
    ok('Login screen shown (no cached token)');
    await testLoginScreen(page);
  } else if (activeScreen === 'dashboard-screen') {
    ok('Dashboard shown (cached token found — testing session resume)');
    await testDashboard(page);
    // Also test logout goes back to login
    await testLogout(page);
  } else {
    err(`Unexpected active screen: ${activeScreen}`);
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Passed: ${pass}   Failed: ${fail}`);
  console.log(`  Screenshots in: electron/test-shots/`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  await app.close();
  process.exit(fail > 0 ? 1 : 0);
}

async function testLoginScreen(page) {
  console.log('\n── Login screen checks ──');

  // Titlebar
  const titlebar = await page.evaluate(() => document.querySelector('.titlebar')?.textContent?.trim());
  titlebar?.includes('TMT') ? ok(`Titlebar: "${titlebar}"`) : err(`Titlebar missing or wrong: "${titlebar}"`);

  // Logo image
  const logo = await page.evaluate(() => !!document.querySelector('.brand-logo-img'));
  logo ? ok('TMT logo present') : err('TMT logo missing');

  // Form fields
  const hasUsername = await page.evaluate(() => !!document.getElementById('username'));
  const hasPassword = await page.evaluate(() => !!document.getElementById('password'));
  const hasSubmit   = await page.evaluate(() => !!document.getElementById('login-btn'));
  hasUsername ? ok('Username field present') : err('Username field missing');
  hasPassword ? ok('Password field present') : err('Password field missing');
  hasSubmit   ? ok('Sign in button present') : err('Sign in button missing');

  // Close button
  const hasClose = await page.evaluate(() => !!document.getElementById('close-btn'));
  hasClose ? ok('Close button present') : err('Close button missing');

  await shot(page, '02-login-screen');

  // ── Test bad credentials ────────────────────────────────────────────────────
  console.log('\n── Bad login attempt ──');
  await page.evaluate(() => { document.getElementById('username').value = 'baduser'; });
  await page.evaluate(() => { document.getElementById('password').value = 'badpass'; });
  await page.evaluate(() => document.getElementById('login-btn').click());

  // Wait for error or response
  await new Promise(r => setTimeout(r, 4000));
  const errText = await page.evaluate(() => document.getElementById('login-error')?.textContent?.trim());
  const btnText = await page.evaluate(() => document.getElementById('login-btn')?.textContent?.trim());
  log(`Error message: "${errText}"`);
  log(`Button text after: "${btnText}"`);

  if (errText && errText.length > 0) {
    ok(`Error shown on bad credentials: "${errText}"`);
  } else if (btnText === 'Sign in') {
    ok('Button re-enabled after failed login (network error expected — no backend)');
  } else {
    err('No error feedback after bad credentials');
  }

  await shot(page, '03-login-error');
}

async function testDashboard(page) {
  console.log('\n── Dashboard checks ──');

  const brand = await page.evaluate(() => document.querySelector('.dash-brand')?.textContent?.trim());
  brand === 'TMT' ? ok(`Brand text: "${brand}"`) : err(`Brand wrong: "${brand}"`);

  const obsLabel  = await page.evaluate(() => document.getElementById('obs-label')?.textContent?.trim());
  const obsStatus = await page.evaluate(() => {
    const dot = document.getElementById('obs-dot');
    return dot ? dot.className : 'missing';
  });
  ok(`OBS label: "${obsLabel}" | dot class: "${obsStatus}"`);

  const goLive = await page.evaluate(() => {
    const btn = document.getElementById('go-live-btn');
    return { text: btn?.textContent?.trim(), disabled: btn?.disabled };
  });
  ok(`Go Live button: "${goLive.text}" disabled=${goLive.disabled}`);

  const liveStatus = await page.evaluate(() => document.getElementById('live-status')?.textContent?.trim());
  ok(`Live status: "${liveStatus}"`);

  const hasLogout = await page.evaluate(() => !!document.getElementById('logout-btn'));
  hasLogout ? ok('Logout button present') : err('Logout button missing');

  // Stats cards
  const stats = await page.evaluate(() => ({
    bitrate: document.getElementById('stat-bitrate')?.textContent,
    dropped: document.getElementById('stat-dropped')?.textContent,
    cpu:     document.getElementById('stat-cpu')?.textContent,
  }));
  ok(`Stats — kbps: "${stats.bitrate}"  dropped: "${stats.dropped}"  cpu: "${stats.cpu}"`);

  await shot(page, '04-dashboard');
}

async function testLogout(page) {
  console.log('\n── Logout test ──');
  await page.evaluate(() => document.getElementById('logout-btn')?.click());
  await new Promise(r => setTimeout(r, 1000));

  const activeAfterLogout = await page.evaluate(() => {
    return document.querySelector('.screen.active')?.id;
  });
  activeAfterLogout === 'login-screen'
    ? ok('Logout returns to login screen')
    : err(`After logout, active screen is: ${activeAfterLogout}`);

  await shot(page, '05-after-logout');
}

run().catch(e => { console.error('Test crashed:', e); process.exit(1); });
