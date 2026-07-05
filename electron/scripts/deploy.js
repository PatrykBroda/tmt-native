'use strict';
const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const { syncUnpackedToDesktop } = require('./_sync-desktop');

const ROOT       = path.join(__dirname, '..');
const UNPACKED   = path.join(ROOT, 'dist', 'win-unpacked');

console.log('\n━━━  TMT Native — build & deploy  ━━━\n');

// ── 1. Install deps if missing ────────────────────────────────────────────────
if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
  console.log('Installing dependencies…');
  execSync('npm install', { cwd: ROOT, stdio: 'inherit' });
}

// ── 2. Build (dir target — fastest, produces win-unpacked/) ──────────────────
console.log('Building…\n');
try {
  // --config.win.target=dir overrides the NSIS release target for fast local deploys
  execSync('npx electron-builder --win --publish never --config.win.target=dir', {
    cwd:   ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      WIN_CSC_LINK: '',
    },
  });
} catch {
  console.error('\n✗  Build failed — see output above.');
  process.exit(1);
}

if (!fs.existsSync(UNPACKED)) {
  console.error('\n✗  win-unpacked not found after build.');
  process.exit(1);
}

// ── 3. Sync win-unpacked → Desktop/TMT Native/ (kill, mirror, shortcut, fw) ───
syncUnpackedToDesktop(UNPACKED);

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`✓  Deployed to Desktop/TMT Native/`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
