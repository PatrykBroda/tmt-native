'use strict';
// Shared helper: mirror a freshly-built win-unpacked/ into the running app folder
// on the Desktop (Desktop/TMT Native/), refresh the shortcut, and ensure the OBS
// firewall rule exists. Used by BOTH deploy.js (fast dir build) and
// build-release.js (NSIS build) so the running app never drifts behind the
// installer/dashboard version.
const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

function syncUnpackedToDesktop(unpackedDir) {
  if (process.platform !== 'win32') return;
  if (!fs.existsSync(unpackedDir)) {
    console.warn(`   Desktop folder sync skipped — not found: ${unpackedDir}`);
    return;
  }

  const DESKTOP    = path.join(os.homedir(), 'Desktop');
  const APP_FOLDER = path.join(DESKTOP, 'TMT Native');
  const APP_EXE    = path.join(APP_FOLDER, 'TMT Native.exe');
  const SHORTCUT   = path.join(DESKTOP, 'TMT Native.lnk');

  // Kill any running instance so robocopy isn't blocked by file locks.
  try {
    execSync(
      'powershell -Command "Get-Process | Where-Object { $_.Name -like \'*TMT*\' -or $_.Name -like \'*electron*\' } | Stop-Process -Force -ErrorAction SilentlyContinue"',
      { stdio: 'ignore' }
    );
  } catch {}
  execSync('powershell -Command "Start-Sleep -Milliseconds 800"', { stdio: 'ignore' });

  // Mirror unpacked → running app folder. robocopy exit code ≤7 = success.
  console.log(`   Syncing running app → ${APP_FOLDER} …`);
  try {
    execSync(
      `robocopy "${unpackedDir}" "${APP_FOLDER}" /MIR /NFL /NDL /NJH /NJS /nc /ns /np`,
      { stdio: 'ignore' }
    );
  } catch (e) {
    if (e.status > 7) { console.error('   robocopy failed:', e.message); return; }
  }

  // Refresh the Desktop shortcut.
  try {
    const lnkTarget = APP_EXE.replace(/\\/g, '\\\\');
    const lnkDir    = APP_FOLDER.replace(/\\/g, '\\\\');
    const lnkPath   = SHORTCUT.replace(/\\/g, '\\\\');
    execSync(
      `powershell -Command "$ws=New-Object -ComObject WScript.Shell; $sc=$ws.CreateShortcut('${lnkPath}'); $sc.TargetPath='${lnkTarget}'; $sc.WorkingDirectory='${lnkDir}'; $sc.WindowStyle=1; $sc.Save()"`,
      { stdio: 'ignore' }
    );
  } catch {}

  // Ensure the OBS firewall rule points at the deployed obs64.exe (best-effort).
  try {
    const obsExe   = path.join(APP_FOLDER, 'resources', 'obs', 'bin', '64bit', 'obs64.exe');
    const ruleName = 'TMT Native - Streaming Engine';
    const existing = execSync(`netsh advfirewall firewall show rule name="${ruleName}"`, { stdio: 'pipe', timeout: 5000 }).toString();
    if (!existing.toLowerCase().includes('rule name')) {
      execSync(
        `netsh advfirewall firewall add rule name="${ruleName}" dir=in action=allow program="${obsExe}" enable=yes`,
        { stdio: 'ignore', timeout: 5000 }
      );
    }
  } catch { /* needs admin — skip silently */ }

  console.log(`   Running app:  ${APP_FOLDER}  ✓`);
}

module.exports = { syncUnpackedToDesktop };
