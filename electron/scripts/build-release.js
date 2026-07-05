'use strict';
// node scripts/build-release.js
// Produces the upload-ready NSIS installer: dist/TMT-Streaming-Setup-<version>.exe
const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const { syncUnpackedToDesktop } = require('./_sync-desktop');

const ROOT     = path.join(__dirname, '..');
const DIST     = path.join(ROOT, 'dist');
const pkg      = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const isMac    = process.argv.includes('--mac') || process.platform === 'darwin';
const platform = isMac ? 'macOS DMG' : 'Windows NSIS installer';
const flag     = isMac ? '--mac'      : '--win';

console.log(`\n━━━  TMT Native — release build  (v${pkg.version} · ${platform})  ━━━\n`);

// Kill any running instances (Windows only, to avoid file-lock errors)
if (process.platform === 'win32') {
  try {
    execSync(
      'powershell -Command "Get-Process | Where-Object { $_.Name -like \'*TMT*\' -or $_.Name -like \'*electron*\' } | Stop-Process -Force -ErrorAction SilentlyContinue"',
      { stdio: 'ignore' }
    );
  } catch {}
  execSync('powershell -Command "Start-Sleep -Seconds 2"', { stdio: 'ignore' });
}

// Build
console.log(`Building ${platform}…\n`);
try {
  execSync(`npx electron-builder ${flag} --publish never`, {
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

// Find the output file
const ext      = isMac ? 'dmg' : 'exe';
const outName  = `TMT-Streaming-Setup-${pkg.version}.${ext}`;
const outPath  = path.join(DIST, outName);

if (!fs.existsSync(outPath)) {
  console.error(`\n✗  Expected output not found: ${outPath}`);
  console.log('Files in dist/:');
  try { fs.readdirSync(DIST).forEach(f => console.log('  ', f)); } catch {}
  process.exit(1);
}

const sizeMb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(0);

// Copy latest installer to Desktop (Windows only), removing stale versioned copies.
if (process.platform === 'win32') {
  const desktopDir = path.join(require('os').homedir(), 'Desktop');
  const destPath   = path.join(desktopDir, 'TMT Native.exe');
  try {
    // Remove any old versioned installer files left on the Desktop
    fs.readdirSync(desktopDir)
      .filter(f => /^TMT[- ]Streaming[- ]Setup.*\.exe$/i.test(f) || /^TMT Native \d/.test(f))
      .forEach(f => { try { fs.rmSync(path.join(desktopDir, f)); } catch {} });
    fs.copyFileSync(outPath, destPath);
    console.log(`   Desktop:   ${destPath}  ✓`);
  } catch (e) {
    console.warn(`   Desktop copy failed: ${e.message}`);
  }

  // Also refresh the running app folder (Desktop/TMT Native/) from the same
  // build, so the installed/running app is never stale vs the installer.
  syncUnpackedToDesktop(path.join(DIST, 'win-unpacked'));
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`✓  Output:    ${outPath}`);
console.log(`   Size:      ${sizeMb} MB`);
console.log(`   Version:   ${pkg.version}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
