'use strict';
const { app }  = require('electron');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const { spawn, execSync } = require('child_process');
const crypto   = require('crypto');

// Per-platform OBS encoding specs.
// These are applied to basic.ini whenever a destination from that platform is primary.
const PLATFORM_PRESETS = {
  stripchat: {
    vBitrate:    4500,   // up to 6 Mbps allowed; 4500 gives headroom
    aBitrate:    128,    // Stripchat spec: 128 kbps
    outputCX:    1280,
    outputCY:    720,
    fpsNum:      30,
    // Stripchat: tune=zerolatency (x264), B-frames=0 (hardware), profile=main
    x264Opts:    'tune=zerolatency profile=main',
    bFrames:     0,
    profile:     'main',
    // NVENC: 'll' (low latency) disables lookahead — required for bf=0.
    // With hq/default tuning, NVENC lookahead forces a minimum of 2 B-frames
    // regardless of the NVENCBFrames=0 setting, causing Stripchat "BAD" audio.
    nvencTuning: 'll',
    nvencPreset: 'p5',
    nvencMultipass: 'disabled',
  },
  chaturbate: {
    vBitrate:    3500,
    aBitrate:    192,
    outputCX:    1280,
    outputCY:    720,
    fpsNum:      30,
    x264Opts:    '',
    bFrames:     2,
    profile:     'high',
    nvencTuning: 'hq',
    nvencPreset: 'p5',
    nvencMultipass: 'qres',
  },
};

const DEFAULT_PRESET = {
  vBitrate:  3500,
  aBitrate:  192,
  outputCX:  1280,
  outputCY:  720,
  fpsNum:    30,
  x264Opts:  '',
  bFrames:   2,
  profile:   'high',
  nvencTuning:    'hq',
  nvencPreset:    'p5',
  nvencMultipass: 'qres',
};

function detectStreamEncoder() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-WmiObject Win32_VideoController | Select-Object -ExpandProperty Name"',
      { encoding: 'utf8', timeout: 4000 }
    ).toLowerCase();
    // Prefer discrete GPUs — check NVIDIA first so hybrid laptops (NVIDIA+AMD) pick NVENC.
    if (out.includes('nvidia'))                        return 'obs_nvenc_h264_tex';
    if (out.includes('amd') || out.includes('radeon')) return 'h264_texture_amf';
    if (out.includes('intel'))                         return 'obs_qsv11_v2';
  } catch {}
  return 'obs_x264'; // CPU fallback — consistent with switch cases below
}

// ── Paths ─────────────────────────────────────────────────────────────────────
function getObsDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'obs')
    : path.join(__dirname, 'obs');
}

function getObsBin(obsDir) {
  switch (process.platform) {
    case 'win32':  return path.join(obsDir, 'bin', '64bit', 'obs64.exe');
    case 'darwin': return path.join(obsDir, 'OBS.app', 'Contents', 'MacOS', 'obs');
    default:       return path.join(obsDir, 'bin', '64bit', 'obs');
  }
}

// Portable OBS stores config next to the executable root
function getObsConfigDir(obsDir) {
  return path.join(obsDir, 'config', 'obs-studio');
}

// ── WebSocket password (auto-generated, persisted in userData) ────────────────
function getOrCreateWsPassword() {
  const passFile = path.join(app.getPath('userData'), 'obs-ws.key');
  try {
    return fs.readFileSync(passFile, 'utf8').trim();
  } catch {
    const pass = crypto.randomBytes(20).toString('hex');
    fs.writeFileSync(passFile, pass, 'utf8');
    return pass;
  }
}

// ── Config writers ─────────────────────────────────────────────────────────────

function writeGlobalIni(configDir, wsPort, wsPassword) {
  // [BasicWindow] settings keep OBS from ever showing a visible window.
  // SysTrayWhenStarted=true + SysTrayMinimizeToTray=true = starts straight to tray.
  // OBS 32.x uses fully-qualified theme IDs and reads Theme from [Appearance], not [General].
  // DEFAULT_THEME in OBS 32 source is "com.obsproject.Yami.Original".
  const ini = `[General]
LicenseAccepted=true
FirstRun=false
EnableAutoUpdates=false
AutoConfigWizardWasRun=true
Pre-Configured=true

[Appearance]
Theme=com.obsproject.Yami.Original

[Basic]
Profile=TMT
ProfileDir=TMT
SceneCollection=TMT
SceneCollectionFile=TMT

[BasicWindow]
SystemTrayEnabled=true
SysTrayWhenStarted=true
SysTrayMinimizeToTray=true
OpenStatsOnStartup=false

[OBSWebServer]
ServerEnabled=true
ServerPort=${wsPort}
AuthRequired=true
ServerPassword=${wsPassword}
Alerts=false
`;
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'global.ini'), ini);
}

function writeProfileIni(configDir, primaryPlatform) {
  const profileDir = path.join(configDir, 'basic', 'profiles', 'TMT');
  fs.mkdirSync(profileDir, { recursive: true });

  const preset  = PLATFORM_PRESETS[primaryPlatform?.toLowerCase()] || DEFAULT_PRESET;
  const encoder = detectStreamEncoder();

  // Simple Output mode uses short aliases; advanced IDs are silently ignored and fall back to x264.
  const simpleEncoder = {
    'obs_nvenc_h264_tex': 'nvenc',
    'h264_texture_amf':   'amd',
    'obs_qsv11_v2':       'qsv_h264',
    'obs_x264':           'x264',
  }[encoder] || 'x264';

  console.log('[obs-manager] platform=%s encoder=%s simple=%s bitrate=%s', primaryPlatform || 'default', encoder, simpleEncoder, preset.vBitrate);

  // Build encoder-specific extras — each GPU brand has its own ini keys.
  // Keys not recognised by OBS in simple mode are silently ignored (safe to include).
  let encoderExtras = '';
  switch (encoder) {
    case 'obs_nvenc_h264_tex':                        // NVIDIA NVENC
      // NVENCTuning=ll (low latency) disables lookahead so bf=0 is respected.
      // With hq tuning, NVENC SDK forces bf>=2 when lookahead is on.
      encoderExtras =
        `NVENCPreset2=${preset.nvencPreset || 'p5'}\n` +
        `NVENCTuning=${preset.nvencTuning || 'hq'}\n` +
        `NVENCMultipass=${preset.nvencMultipass || 'qres'}\n` +
        `NVENCBFrames=${preset.bFrames}\n` +
        `NVENCProfile=${preset.profile}\n`;
      break;
    case 'h264_texture_amf':                          // AMD AMF
      encoderExtras =
        `AMFBFrames=${preset.bFrames}\n` +
        `AMFProfile=${preset.profile}\n`;
      break;
    case 'obs_qsv11_v2':                              // Intel QSV (B-frames off by default)
      encoderExtras = `QSVProfile=${preset.profile}\n`;
      break;
    case 'obs_x264':                                  // CPU x264 fallback
      if (preset.x264Opts) encoderExtras = `x264Settings=${preset.x264Opts}\n`;
      break;
  }

  const ini = `[General]
Name=TMT
AutoConfigWizardWasRun=true
FirstRun=false

[Video]
BaseCX=1920
BaseCY=1080
OutputCX=${preset.outputCX}
OutputCY=${preset.outputCY}
FPSType=0
FPSCommon=${preset.fpsNum}
FPSNum=${preset.fpsNum}
FPSDen=1
ScaleType=lanczos
ColorFormat=NV12
ColorSpace=sRGB
ColorRange=Partial

[Output]
Mode=Simple

[SimpleOutput]
VBitrate=${preset.vBitrate}
ABitrate=${preset.aBitrate}
StreamEncoder=${simpleEncoder}
${encoderExtras}RecFormat=mkv
UseAdvanced=false

[Audio]
SampleRate=48000
ChannelSetup=Stereo
DesktopAudioDevice1=default
DesktopAudioDevice2=disabled
AuxAudioDevice1=default
AuxAudioDevice2=disabled
AuxAudioDevice3=disabled
AuxAudioDevice4=disabled

[Stream]
BindIP=default
EnableMultitrackVideo=false
`;
  fs.writeFileSync(path.join(profileDir, 'basic.ini'), ini);
}

function writeSceneCollection(configDir) {
  const scenesDir = path.join(configDir, 'basic', 'scenes');
  fs.mkdirSync(scenesDir, { recursive: true });

  // Minimal valid scene collection — one blank scene.
  // Sources (camera, screen capture) are added by the model directly in OBS if needed,
  // but the stream destinations are driven entirely by obs-multi-rtmp.
  const collection = {
    current_program_scene: 'Scene',
    current_scene: 'Scene',
    groups: [],
    modules: {},
    name: 'TMT',
    quick_transitions: [],
    saved_projectors: [],
    scaled_items: [],
    scene_order: [{ name: 'Scene' }],
    sources: [
      {
        deinterlace_field_order: 0,
        deinterlace_mode: 0,
        enabled: true,
        flags: 0,
        hotkeys: {},
        id: 'scene',
        mixers: 0,
        monitoring_type: 0,
        muted: false,
        name: 'Scene',
        prev_ver: null,
        private_settings: {},
        'push-to-mute-delay': 0,
        'push-to-mute': false,
        'push-to-talk-delay': 0,
        'push-to-talk': false,
        settings: { custom_size: false, id_counter: 0, items: [] },
        sync: 0,
        versioned_id: 'scene',
        volume: 1.0,
      },
    ],
    transition_duration: 300,
    transitions: [
      { id: 'fade_transition', name: 'Fade', settings: { duration: 300 } },
    ],
    version: 1,
  };

  fs.writeFileSync(
    path.join(scenesDir, 'TMT.json'),
    JSON.stringify(collection, null, 2)
  );
}

// Streaming architecture:
//  - First destination → OBS built-in RTMP output (service.json). StartStream starts it.
//  - Remaining destinations → obs-multi-rtmp, sync-start/stop so they follow the main output.
// This avoids double-streaming to the first platform and keeps one clean start/stop signal.
function writeMultiRtmpConfig(configDir, destinations) {
  const profileDir = path.join(configDir, 'basic', 'profiles', 'TMT');
  fs.mkdirSync(profileDir, { recursive: true });

  // service.json: first dest (real key) OR dummy localhost when no destinations.
  // This file must always exist to prevent OBS from showing the Auto-Config Wizard.
  const primary = destinations[0];
  fs.writeFileSync(
    path.join(profileDir, 'service.json'),
    JSON.stringify({
      settings: {
        bwtest: false,
        key:    primary ? primary.streamKey : 'configured',
        server: primary ? primary.rtmpUrl   : 'rtmp://127.0.0.1/live',
      },
      type: 'rtmp_custom',
    }, null, 2)
  );

  // obs-multi-rtmp: only destinations 2+ (first is already handled by service.json)
  const targets = destinations.slice(1).map(dest => ({
    id:              crypto.randomUUID(),
    name:            dest.name,
    protocol:        'RTMP',
    'service-param': { server: dest.rtmpUrl, key: dest.streamKey },
    'output-param':  {},
    'sync-start':    true,
    'sync-stop':     true,
  }));

  fs.writeFileSync(
    path.join(profileDir, 'obs-multi-rtmp.json'),
    JSON.stringify({ targets, video_configs: [], audio_configs: [] }, null, 2)
  );
}

function writeObsWebSocketConfig(configDir, wsPort, wsPassword) {
  // obs-websocket 5.x reads its config from plugin_config/obs-websocket/config.json,
  // NOT from global.ini [OBSWebServer]. Write the JSON config directly.
  const wsConfigDir = path.join(configDir, 'plugin_config', 'obs-websocket');
  fs.mkdirSync(wsConfigDir, { recursive: true });
  fs.writeFileSync(
    path.join(wsConfigDir, 'config.json'),
    JSON.stringify({
      alerts_enabled:  false,
      auth_required:   true,
      first_load:      false,
      server_enabled:  true,
      server_password: wsPassword,
      server_port:     wsPort,
    }, null, 2)
  );
}

// Clear crash-sentinel files so OBS never shows "Crash Detected" on startup.
// OBS 30+ creates a run_<uuid> file in .sentinel/ when it starts and removes it
// on clean exit. Force-killing OBS leaves these files, triggering the dialog.
// --disable-shutdown-check does not suppress this newer sentinel mechanism.
function clearObsSentinel(configDir) {
  const sentinelDir = path.join(configDir, '.sentinel');
  try {
    if (!fs.existsSync(sentinelDir)) return;
    for (const f of fs.readdirSync(sentinelDir)) {
      try { fs.unlinkSync(path.join(sentinelDir, f)); } catch {}
    }
    console.log('[obs-manager] sentinel cleared');
  } catch (err) {
    console.warn('[obs-manager] sentinel clear failed:', err.message);
  }
}

// ── Public: write everything OBS needs before launch ─────────────────────────
function initObsConfig({ destinations, wsPort, wsPassword }) {
  const obsDir          = getObsDir();
  const configDir       = getObsConfigDir(obsDir);
  const primaryPlatform = destinations[0]?.name || '';

  clearObsSentinel(configDir);
  writeGlobalIni(configDir, wsPort, wsPassword);
  writeObsWebSocketConfig(configDir, wsPort, wsPassword);
  writeProfileIni(configDir, primaryPlatform);
  writeSceneCollection(configDir);
  writeMultiRtmpConfig(configDir, destinations);

  // Pre-start the window hider now (before OBS spawns) so PowerShell has time
  // to compile Add-Type while OBS is still booting. Uses process-name lookup
  // so no PID is needed yet.
  startObsWindowHider();

  console.log('[obs-manager] config written →', configDir);
}

// ── Process management ────────────────────────────────────────────────────────
let obsProcess    = null;
let obsHiderProc  = null;
let obsDialogProc = null;  // fast VBScript companion — zero compile time

// Known OBS dialog titles to kill immediately.
const OBS_DIALOG_TITLES = [
  'Auto-Configuration Wizard',
  'OBS Studio Crash Detected',
  'Failed to start streaming',
  'Starting the output failed',
  'Unable to initialize video',
  'Failed to start recording',
  'Encoding Overloaded!',
  'Output is reconnecting',
  'Restart',
];

// Starts two hidden processes:
//
//  1. VBScript dialog-killer (zero startup delay, no compilation).
//     Uses WScript.Shell AppActivate + SendKeys ESC so known OBS dialogs
//     are dismissed within 200ms, even before the C# hider is compiled.
//
//  2. PowerShell C# hider (full window suppressor).
//     Caches the compiled DLL in %TEMP% so Add-Type compile only happens
//     ONCE (first run ~500ms), subsequent runs load the DLL instantly.
//     Also calls FindWindowW by title for belt-and-suspenders coverage.
function startObsWindowHider() {
  // Kill any previous instances
  for (const p of [obsHiderProc, obsDialogProc]) {
    if (p) { try { p.kill(); } catch {} }
  }
  obsHiderProc  = null;
  obsDialogProc = null;

  // ── 1. Fast VBScript companion ─────────────────────────────────────────────
  const titlesVbs = OBS_DIALOG_TITLES.map(t => `"${t}"`).join(',');
  const vbsContent =
`Dim oShell : Set oShell = CreateObject("WScript.Shell")
Dim titles : titles = Array(${titlesVbs})
Do While True
  WScript.Sleep 200
  Dim i
  For i = 0 To UBound(titles)
    If oShell.AppActivate(titles(i)) Then
      WScript.Sleep 30
      oShell.SendKeys("{ESC}")
    End If
  Next
Loop`;

  const vbsPath = path.join(os.tmpdir(), 'obs-dialog-killer.vbs');
  try {
    fs.writeFileSync(vbsPath, vbsContent, 'utf8');
    obsDialogProc = spawn('wscript', ['/nologo', vbsPath], {
      stdio: 'ignore', detached: true, windowsHide: true,
    });
    obsDialogProc.unref();
    obsDialogProc.on('exit', () => { obsDialogProc = null; });
    console.log('[obs-manager] VBScript dialog killer started');
  } catch (err) {
    console.warn('[obs-manager] VBScript dialog killer failed:', err.message);
  }

  // ── 2. PowerShell C# hider with DLL caching ────────────────────────────────
  const dllPath  = path.join(os.tmpdir(), 'TMTOBSHider.dll').replace(/\\/g, '\\\\');
  const titles   = OBS_DIALOG_TITLES.map(t => `'${t}'`).join(',');

  const scriptContent =
`$ErrorActionPreference='SilentlyContinue'
$dll='${dllPath}'
$src=@"
using System;using System.Runtime.InteropServices;
public class OBSHider{
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc e,IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h,uint cmd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint msg,IntPtr wp,IntPtr lp);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string c,string t);
  public delegate bool EnumWindowsProc(IntPtr h,IntPtr p);
  public static void HideAll(int pid){
    EnumWindows(delegate(IntPtr h,IntPtr p){
      uint w=0;GetWindowThreadProcessId(h,out w);
      if((int)w==pid){
        ShowWindow(h,0);
        if(GetWindow(h,4u)!=IntPtr.Zero)
          PostMessage(h,0x0010u,IntPtr.Zero,IntPtr.Zero);
      }
      return true;
    },IntPtr.Zero);
  }
}
"@
if(Test-Path $dll){
  try{Add-Type -Path $dll -EA Stop}catch{
    Remove-Item $dll -Force -EA SilentlyContinue
    Add-Type -TypeDefinition $src -OutputAssembly $dll -Language CSharp -EA SilentlyContinue
    Add-Type -Path $dll -EA SilentlyContinue
  }
}else{
  Add-Type -TypeDefinition $src -OutputAssembly $dll -Language CSharp -EA SilentlyContinue
  Add-Type -Path $dll -EA SilentlyContinue
}
$knownTitles=@(${titles})
while($true){
  Start-Sleep -Milliseconds 150
  foreach($t in $knownTitles){
    $h=[OBSHider]::FindWindowW($null,$t)
    if($h -ne [IntPtr]::Zero){[OBSHider]::PostMessage($h,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)}
  }
  $procs=Get-Process obs64 -EA SilentlyContinue
  if(-not $procs){continue}
  foreach($p in $procs){try{[OBSHider]::HideAll($p.Id)}catch{}}
}`;

  const scriptPath = path.join(os.tmpdir(), 'obs-hider.ps1');
  try {
    fs.writeFileSync(scriptPath, scriptContent, 'utf8');
    obsHiderProc = spawn('powershell', [
      '-NonInteractive', '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-File', scriptPath,
    ], { stdio: 'ignore', detached: true, windowsHide: true });
    obsHiderProc.unref();
    obsHiderProc.on('exit', () => { obsHiderProc = null; });
    console.log('[obs-manager] window hider started');
  } catch (err) {
    console.warn('[obs-manager] window hider failed to start:', err.message);
  }
}

function spawnObs() {
  if (obsProcess && !obsProcess.killed) return;

  const obsDir = getObsDir();
  const obsBin = getObsBin(obsDir);

  if (!fs.existsSync(obsBin)) {
    throw new Error(
      `OBS binary not found at:\n  ${obsBin}\n\n` +
      `Extract the OBS Studio portable build into:\n  ${obsDir}\n\n` +
      `Then drop obs-multi-rtmp.dll into ${path.join(obsDir, 'obs-plugins', '64bit')}`
    );
  }

  // Kill any stale obs64.exe from previous runs before spawning.
  // A leftover OBS process holds the websocket port and causes the new instance
  // to fail to bind — Electron then connects to the stale process which has
  // wrong config, causing streaming to fail.
  try {
    const { execSync } = require('child_process');
    execSync('taskkill /F /IM obs64.exe /T', { stdio: 'ignore', timeout: 4000 });
    console.log('[obs-manager] killed stale obs64.exe');
  } catch {
    // No stale process — that's fine
  }

  const args = [
    '--portable',
    '--minimize-to-tray',
    '--disable-shutdown-check',
    '--disable-updater',
  ];

  console.log('[obs-manager] launching OBS…');

  obsProcess = spawn(obsBin, args, {
    cwd:      path.dirname(obsBin),
    stdio:   'ignore',
    detached: false,
  });

  obsProcess.on('error', err => console.error('[OBS spawn error]', err.message));
  obsProcess.on('exit', (code, sig) => {
    console.log(`[OBS] exited code=${code} sig=${sig}`);
    obsProcess = null;
  });
}

function killObs() {
  for (const p of [obsHiderProc, obsDialogProc]) {
    if (p) { try { p.kill(); } catch {} }
  }
  obsHiderProc  = null;
  obsDialogProc = null;
  if (obsProcess) {
    try { obsProcess.kill(); } catch {}
    obsProcess = null;
  }
  // Also force-kill any stale obs64 processes not tracked by obsProcess
  try {
    const { execSync } = require('child_process');
    execSync('taskkill /F /IM obs64.exe /T', { stdio: 'ignore', timeout: 3000 });
  } catch {}
}

function isObsRunning() {
  return !!obsProcess && !obsProcess.killed;
}

module.exports = {
  getObsDir,
  getObsBin,
  getObsConfigDir,
  getOrCreateWsPassword,
  initObsConfig,
  writeMultiRtmpConfig,
  spawnObs,
  killObs,
  isObsRunning,
};
