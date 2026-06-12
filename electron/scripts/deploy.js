'use strict';
const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const ROOT       = path.join(__dirname, '..');
const UNPACKED   = path.join(ROOT, 'dist', 'win-unpacked');
const DESKTOP    = path.join(os.homedir(), 'Desktop');
const APP_FOLDER = path.join(DESKTOP, 'TMT Native');
const APP_EXE    = path.join(APP_FOLDER, 'TMT Native.exe');
const SHORTCUT   = path.join(DESKTOP, 'TMT Native.lnk');

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

// ── 3. Kill any running instance ─────────────────────────────────────────────
try {
  execSync(
    'powershell -Command "Get-Process | Where-Object { $_.Name -like \'*TMT*\' -or $_.Name -like \'*electron*\' } | Stop-Process -Force -ErrorAction SilentlyContinue"',
    { stdio: 'ignore' }
  );
} catch {}
execSync('powershell -Command "Start-Sleep -Milliseconds 800"', { stdio: 'ignore' });

// ── 4. Sync win-unpacked → Desktop/TMT Native/ ───────────────────────────────
console.log(`Deploying to ${APP_FOLDER} …`);
// robocopy exit code 1 = "files copied, no errors" — not a real error
try {
  execSync(
    `robocopy "${UNPACKED}" "${APP_FOLDER}" /MIR /NFL /NDL /NJH /NJS /nc /ns /np`,
    { stdio: 'ignore' }
  );
} catch (e) {
  if (e.status > 7) { console.error('robocopy failed:', e.message); process.exit(1); }
}

// ── 5. Create / refresh Desktop shortcut ─────────────────────────────────────
const lnkTarget = APP_EXE.replace(/\\/g, '\\\\');
const lnkDir    = APP_FOLDER.replace(/\\/g, '\\\\');
const lnkPath   = SHORTCUT.replace(/\\/g, '\\\\');
execSync(
  `powershell -Command "$ws=$([Runtime.InteropServices.Marshal]::GetActiveObject('WScript.Shell') 2>$null); $ws=New-Object -ComObject WScript.Shell; $sc=$ws.CreateShortcut('${lnkPath}'); $sc.TargetPath='${lnkTarget}'; $sc.WorkingDirectory='${lnkDir}'; $sc.WindowStyle=1; $sc.Save()"`,
  { stdio: 'ignore' }
);

const folderSize = (() => {
  let total = 0;
  const walk = dir => {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      try { if (fs.statSync(full).isDirectory()) walk(full); else total += fs.statSync(full).size; } catch {}
    }
  };
  walk(APP_FOLDER);
  return (total / 1024 / 1024).toFixed(0);
})();

// ── 6. Add Windows Firewall rule for obs64 ────────────────────────────────────
const obsExeInDeploy = path.join(APP_FOLDER, 'resources', 'obs', 'bin', '64bit', 'obs64.exe');
try {
  const ruleName  = 'TMT Native - Streaming Engine';
  const existing  = execSync(
    `netsh advfirewall firewall show rule name="${ruleName}"`,
    { stdio: 'pipe', timeout: 5000 }
  ).toString();
  if (!existing.toLowerCase().includes('rule name')) {
    execSync(
      `netsh advfirewall firewall add rule name="${ruleName}" dir=in action=allow program="${obsExeInDeploy}" enable=yes`,
      { stdio: 'ignore', timeout: 5000 }
    );
    console.log('✓  Firewall rule added  (TMT Native - Streaming Engine)');
  } else {
    console.log('✓  Firewall rule already present');
  }
} catch {
  console.log('⚠  Firewall rule skipped (run deploy as admin to add it)');
}

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`✓  Desktop/TMT Native/   (${folderSize} MB)`);
console.log(`✓  Desktop/TMT Native.lnk  (shortcut)`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
