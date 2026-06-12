'use strict';

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(`${name}-screen`).classList.add('active');
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Titlebar close ────────────────────────────────────────────────────────────
$('close-btn').addEventListener('click', () => window.close());

// ── OBS status ───────────────────────────────────────────────────────────────
let obsConnected = false;
let isStreaming  = false;

window.api.onObsStatus(({ connected, status, error }) => {
  obsConnected = connected;
  const dot   = $('obs-dot');
  const label = $('obs-label');

  if (connected) {
    dot.className      = 'obs-dot connected';
    label.textContent  = 'OBS ✓';
    $('go-live-btn').disabled    = false;
    $('live-status').textContent = isStreaming ? 'Live' : 'Ready';
  } else if (error && !status) {
    dot.className      = 'obs-dot error';
    label.textContent  = 'OBS ✗';
    $('go-live-btn').disabled    = true;
    $('live-status').textContent = error;
  } else {
    dot.className      = 'obs-dot booting';
    label.textContent  = 'OBS';
    $('go-live-btn').disabled    = true;
    $('live-status').textContent = status || 'Starting OBS…';
  }
});

// ── Status polling ────────────────────────────────────────────────────────────
window.api.onStatusUpdate(({ live, bitrate, droppedFrames, cpuUsage }) => {
  isStreaming = live;
  $('stat-bitrate').textContent = live ? bitrate.toLocaleString() : '—';
  $('stat-dropped').textContent = live ? droppedFrames            : '—';
  $('stat-cpu').textContent     = typeof cpuUsage === 'number' ? cpuUsage : '—';

  const btn = $('go-live-btn');
  if (live) {
    btn.textContent = 'STOP';
    btn.classList.add('live');
    $('live-status').textContent = 'Live';
  } else {
    btn.textContent = 'GO LIVE';
    btn.classList.remove('live');
    if (obsConnected) $('live-status').textContent = 'Ready';
  }
});

// ── Stream error ──────────────────────────────────────────────────────────────
window.api.onStreamError(msg => {
  isStreaming = false;
  $('live-status').textContent = msg || 'Streaming failed';
  $('go-live-btn').textContent = 'GO LIVE';
  $('go-live-btn').classList.remove('live');
  $('go-live-btn').disabled    = !obsConnected;
});

// ── Go Live / Stop ────────────────────────────────────────────────────────────
// ── Stripchat manual-start modal ─────────────────────────────────────────────
let _scManualUrl = '';

function showScManualModal(url) {
  _scManualUrl = url || '';
  $('sc-manual-overlay').classList.add('active');
}
function hideScManualModal() {
  $('sc-manual-overlay').classList.remove('active');
}

$('sc-modal-close').addEventListener('click',   hideScManualModal);
$('sc-modal-dismiss').addEventListener('click', hideScManualModal);
$('sc-modal-overlay').addEventListener('click', e => {
  if (e.target === $('sc-manual-overlay')) hideScManualModal();
});
$('sc-modal-open').addEventListener('click', () => {
  if (_scManualUrl) window.api.openExternal(_scManualUrl);
  hideScManualModal();
});

// ── Go Live / Stop ────────────────────────────────────────────────────────────
$('go-live-btn').addEventListener('click', async () => {
  const btn = $('go-live-btn');
  btn.disabled = true;
  const result = isStreaming
    ? await window.api.goOffline()
    : await window.api.goLive();
  if (!result.ok) {
    const prefix = result.stage === 'stripchat' ? '[Stripchat] ' : '';
    $('live-status').textContent = prefix + (result.error || 'Failed');
  } else if (result.stripchatManual) {
    $('live-status').textContent = 'Live — start SC manually';
    showScManualModal(result.scUrl);
  }
  btn.disabled = !obsConnected;
});

$('broadcast-btn').addEventListener('click', () => window.api.toggleBroadcastView());

// ── Camera preview ────────────────────────────────────────────────────────────
let cameraStream = null;

async function initCamera() {
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    const vid = $('camera-preview');
    vid.srcObject = cameraStream;
    $('camera-placeholder').style.display = 'none';
  } catch {
    $('camera-placeholder').style.display = 'flex';
  }
}

function stopCamera() {
  cameraStream?.getTracks().forEach(t => t.stop());
  cameraStream = null;
  const vid = $('camera-preview');
  vid.srcObject = null;
  $('camera-placeholder').style.display = 'flex';
}

// ── Platform sidebar (live destination toggles) ───────────────────────────────
const PLATFORM_META = {
  chaturbate: { label: 'Chaturbate', abbr: 'CB' },
  stripchat:  { label: 'Stripchat',  abbr: 'SC' },
};

function renderPlatformSidebar(destinations, disabledIds = []) {
  const sidebar = $('platform-sidebar');
  if (!sidebar) return;
  sidebar.innerHTML = destinations.map(d => {
    const key     = d.name.toLowerCase();
    const meta    = PLATFORM_META[key] || { label: d.name, abbr: d.name.slice(0, 2).toUpperCase() };
    const enabled = !disabledIds.includes(String(d.id));
    return `<button class="plat-toggle${enabled ? '' : ' plat-off'}"
                    data-dest-id="${d.id}"
                    title="${meta.label}: ${enabled ? 'Live — click to disable' : 'Disabled — click to enable'}">
              <span class="plat-icon plat-icon-${key}">${meta.abbr}</span>
              <span class="plat-name">${meta.label}</span>
              <span class="plat-dot${enabled ? '' : ' plat-dot-off'}"></span>
            </button>`;
  }).join('');
}

$('platform-sidebar').addEventListener('click', async e => {
  const btn = e.target.closest('.plat-toggle');
  if (!btn) return;
  const id = btn.dataset.destId;
  btn.disabled = true;
  const { disabledIds } = await window.api.toggleDestination(id);
  // Re-render with updated state
  const { destinations } = await window.api.getDestinations();
  renderPlatformSidebar(destinations, disabledIds);
  // Disable GO LIVE if all platforms off
  const allOff = destinations.every(d => disabledIds.includes(String(d.id)));
  if (allOff) {
    $('go-live-btn').disabled = true;
    $('live-status').textContent = 'Enable at least one platform';
  } else if (obsConnected && !isStreaming) {
    $('go-live-btn').disabled = false;
    $('live-status').textContent = 'Ready';
  }
  btn.disabled = false;
});

// ── Chat status (clears/updates the empty-state message) ─────────────────────
function applyChatStatus({ stripchat, chaturbate }) {
  const chatEmpty = $('chat-empty');
  if (!chatEmpty) return; // already removed by a real message

  if (stripchat?.active || chaturbate?.active) {
    // At least one platform has chat connected — clear the placeholder
    chatEmpty.remove();
    // Inject a subtle "waiting" notice so the box isn't just blank
    const box = $('chat-messages');
    const notice = document.createElement('div');
    notice.id        = 'chat-waiting';
    notice.className = 'chat-empty';
    notice.textContent = 'Chat connected — waiting for messages…';
    box.insertBefore(notice, box.firstChild);
  } else if (chaturbate?.username && !chaturbate?.hasToken) {
    chatEmpty.textContent = 'Add your Chaturbate Events API token in Settings to see live chat.';
  } else {
    chatEmpty.textContent = 'Add a streaming platform in Settings to see live chat.';
  }
}

window.api.onChatStatus(applyChatStatus);

async function refreshChatStatus() {
  try {
    const status = await window.api.getChatStatus();
    applyChatStatus(status);
  } catch {}
}

// ── Live chat ─────────────────────────────────────────────────────────────────
const PLATFORM_LABELS = { chaturbate: 'CB', stripchat: 'SC' };

window.api.onChatMessage(({ type, user, msg, platform }) => {
  // Remove both the empty placeholder and the "waiting" notice on first real message
  $('chat-empty')?.remove();
  $('chat-waiting')?.remove();

  const box   = $('chat-messages');
  const el    = document.createElement('div');
  el.className = 'chat-msg';

  const badge = platform && PLATFORM_LABELS[platform]
    ? `<span class="chat-platform-badge chat-platform-${platform}">${PLATFORM_LABELS[platform]}</span>`
    : '';

  if (type === 'tip') {
    el.innerHTML =
      badge +
      `<span class="chat-user chat-tip">&#9733; ${escHtml(user)}</span>` +
      `<span class="chat-text">${escHtml(msg)}</span>`;
  } else if (type === 'follow') {
    el.innerHTML =
      badge +
      `<span class="chat-user chat-follow">&#9829; ${escHtml(user)}</span>` +
      `<span class="chat-text">followed</span>`;
  } else if (type === 'system') {
    el.innerHTML = badge + `<span class="chat-system">${escHtml(msg)}</span>`;
  } else {
    el.innerHTML =
      badge +
      `<span class="chat-user">${escHtml(user)}:</span>` +
      `<span class="chat-text">${escHtml(msg)}</span>`;
  }

  box.appendChild(el);
  while (box.children.length > 200) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
});

// ── Viewer count ──────────────────────────────────────────────────────────────
window.api.onViewerCount(n => {
  $('viewer-count').textContent = Number(n).toLocaleString();
});

// ── Mic mute ─────────────────────────────────────────────────────────────────
let micMuted = false;

function setMuteUI(muted) {
  micMuted = muted;
  const btn = $('mute-btn');
  $('mute-label').textContent = muted ? 'MUTED' : 'MIC';
  $('mute-icon').textContent  = muted ? '✕' : '●';
  btn.classList.toggle('control-off', muted);
}

window.api.onMuteState(({ muted }) => setMuteUI(muted));

$('mute-btn').addEventListener('click', async () => {
  const btn = $('mute-btn');
  btn.disabled = true;
  const result = await window.api.toggleMute();
  btn.disabled = false;
  if (result.ok) {
    setMuteUI(result.muted);
  } else {
    // Flash the button red briefly so the user knows something went wrong
    btn.classList.add('control-off');
    setTimeout(() => { if (!micMuted) btn.classList.remove('control-off'); }, 600);
  }
});

// ── Camera toggle ─────────────────────────────────────────────────────────────
let camOff = false;

function setCamUI(off) {
  camOff = off;
  $('cam-label').textContent = off ? 'OFF' : 'CAM';
  $('cam-icon').textContent  = off ? '✕' : '●';
  $('cam-btn').classList.toggle('control-off', off);
}

$('cam-btn').addEventListener('click', () => {
  if (camOff) {
    initCamera().then(() => setCamUI(false));
  } else {
    stopCamera();
    setCamUI(true);
  }
});

// Keyboard shortcuts: M = mute, V = video
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'm' || e.key === 'M') $('mute-btn').click();
  if (e.key === 'v' || e.key === 'V') $('cam-btn').click();
});

// ── Auth error (session expired or account deactivated) ───────────────────────
window.api.onAuthError(({ code, message }) => {
  if (code === 401) {
    stopCamera();
    isStreaming  = false;
    obsConnected = false;
    $('go-live-btn').disabled    = true;
    $('go-live-btn').textContent = 'GO LIVE';
    $('go-live-btn').classList.remove('live');
    $('obs-dot').className       = 'obs-dot';
    $('obs-label').textContent   = 'OBS';
    showScreen('login');
    $('login-error').textContent = message || 'Session expired — please sign in again.';
  } else if (code === 403) {
    $('live-status').textContent = message || 'Account access denied.';
  }
});

// ── Login ─────────────────────────────────────────────────────────────────────
$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const username = $('username').value.trim();
  const password = $('password').value;
  const btn      = $('login-btn');
  const errEl    = $('login-error');

  if (!username || !password) { errEl.textContent = 'Username and password are required.'; return; }

  btn.disabled      = true;
  btn.textContent   = 'Signing in…';
  errEl.textContent = '';

  const result = await window.api.login(username, password);

  if (result.ok) {
    showScreen('dashboard');
    $('live-status').textContent = 'Connecting to OBS…';
    initCamera();
    refreshChatStatus();
    const { destinations, disabledIds } = await window.api.getDestinations();
    renderPlatformSidebar(destinations, disabledIds);
  } else {
    errEl.textContent = result.error || 'Login failed.';
    btn.disabled    = false;
    btn.textContent = 'Sign in';
  }
});

// ── Settings ──────────────────────────────────────────────────────────────────
const PLATFORMS = [
  {
    id:             'chaturbate',
    label:          'Chaturbate',
    rtmpUrl:        'rtmp://global.live.mmcdn.com/live-origin',
    keyHint:        'chaturbate.com → Broadcast Yourself → External Software',
    hasUsername:    true,
    hasEventsToken: true,
    eventsHint:     'chaturbate.com → Broadcast Yourself → External Software → Events API Token',
  },
  {
    id:             'stripchat',
    label:          'Stripchat',
    rtmpUrl:        'rtmp://live.doppiocdn.com/ext',
    keyHint:        'stripchat.com → Go Live → External Software → Stream key (Token)',
    usernameHint:   'Your Stripchat model username',
    hasUsername:    true,
    hasEventsToken: false,
  },
];

function renderPlatforms(destinations) {
  // Detect if the model has any of their own destinations (id !== null)
  const hasOwnDests = destinations.some(d => d.id !== null);

  const noticeBanner = !hasOwnDests && destinations.length > 0
    ? `<div class="platform-notice">
         Streaming to the agency default destination. Add your own stream key to use your personal channel.
       </div>`
    : '';

  const cards = PLATFORMS.map(p => {
    const existing  = destinations.find(d => d.name.toLowerCase() === p.id);
    const isDefault = existing && existing.id === null;

    if (existing) {
      const sub = existing.username
        ? `<span class="platform-sub">@${existing.username}</span>` : '';

      const eventsSection = p.hasEventsToken ? `
        <div class="platform-events">
          <label style="font-size:9px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);">
            Live Chat Token
          </label>
          <div class="key-wrap" style="margin-top:6px;">
            <input type="password" id="evtok-${p.id}"
                   value="${escHtml(existing.eventsToken || '')}"
                   placeholder="${p.eventsHint || 'Events API token'}"
                   autocomplete="off" />
            <button class="btn btn-icon key-toggle" data-target="evtok-${p.id}" type="button">&#128065;</button>
          </div>
          <button class="btn btn-ghost platform-evtsave-btn"
                  data-id="${existing.id}" data-platform="${p.id}"
                  style="width:100%;margin-top:8px;">
            ${existing.eventsToken ? 'Update Token' : 'Connect Chat'}
          </button>
        </div>` : '';

      // Default (null-id) rows are read-only — show badge, no Remove button
      const actionRow = isDefault
        ? `<span class="platform-badge-default" style="display:block;padding:0 16px 14px;">Agency default</span>`
        : `<button class="btn platform-remove-btn" data-id="${existing.id}">Remove</button>`;

      return `
        <div class="platform-card is-connected" data-platform="${p.id}">
          <div class="platform-row">
            <div>
              <span class="platform-name">${p.label}</span>
              ${sub}
            </div>
            <span class="platform-badge">&#10003;&nbsp;Connected</span>
          </div>
          ${eventsSection}
          ${actionRow}
        </div>`;
    }

    const usernameField = p.hasUsername ? `
      <div class="field">
        <label for="uname-${p.id}">Username</label>
        <input type="text" id="uname-${p.id}"
               placeholder="Your ${p.label} username" autocomplete="off" />
      </div>` : '';

    return `
      <div class="platform-card" data-platform="${p.id}">
        <div class="platform-row">
          <span class="platform-name">${p.label}</span>
        </div>
        <div class="platform-form">
          ${usernameField}
          <div class="field">
            <label for="key-${p.id}">Stream Key</label>
            <div class="key-wrap">
              <input type="password" id="key-${p.id}"
                     placeholder="Paste your stream key" autocomplete="off" />
              <button class="btn btn-icon key-toggle"
                      data-target="key-${p.id}" type="button">&#128065;</button>
            </div>
            <span class="key-hint">Find it at: ${p.keyHint}</span>
          </div>
          <p class="error-msg platform-err" id="err-${p.id}"></p>
          <button class="btn btn-primary platform-add-btn"
                  data-platform="${p.id}"
                  data-rtmp="${p.rtmpUrl}"
                  data-label="${p.label}">Add ${p.label}</button>
        </div>
      </div>`;
  }).join('');

  $('platform-list').innerHTML = noticeBanner + cards;
}

$('settings-btn').addEventListener('click', async () => {
  const [{ destinations }, version] = await Promise.all([
    window.api.getDestinations(),
    window.api.getAppVersion(),
  ]);
  renderPlatforms(destinations);
  $('settings-version').textContent = `v${version}`;
  showScreen('settings');
});

$('check-updates-btn').addEventListener('click', () => window.api.checkForUpdates());

$('settings-back-btn').addEventListener('click', () => { showScreen('dashboard'); refreshChatStatus(); });

$('platform-list').addEventListener('click', async e => {
  // Show / hide key
  const toggle = e.target.closest('.key-toggle');
  if (toggle) {
    const inp = document.getElementById(toggle.dataset.target);
    if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
    return;
  }

  // Save events token
  const evtSave = e.target.closest('.platform-evtsave-btn');
  if (evtSave) {
    const platformId = evtSave.dataset.platform;
    const token      = document.getElementById(`evtok-${platformId}`)?.value.trim() || '';
    evtSave.disabled = true;
    const result = await window.api.setEventsToken(evtSave.dataset.id, token);
    evtSave.disabled = false;
    if (result.ok) {
      evtSave.textContent = token ? 'Update Token' : 'Connect Chat';
    }
    return;
  }

  // Remove destination
  const removeBtn = e.target.closest('.platform-remove-btn');
  if (removeBtn) {
    removeBtn.disabled = true;
    const result = await window.api.removeDestination(Number(removeBtn.dataset.id));
    if (!result.ok) { removeBtn.disabled = false; return; }
    const { destinations } = await window.api.getDestinations();
    renderPlatforms(destinations);
    return;
  }

  // Add destination
  const addBtn = e.target.closest('.platform-add-btn');
  if (addBtn) {
    const platformId  = addBtn.dataset.platform;
    const platform    = PLATFORMS.find(p => p.id === platformId);
    const errEl       = document.getElementById(`err-${platformId}`);
    const keyInput    = document.getElementById(`key-${platformId}`);
    const unameInput  = document.getElementById(`uname-${platformId}`);
    const streamKey   = keyInput?.value.trim();
    const username    = unameInput?.value.trim() || '';
    errEl.textContent = '';

    if (platform?.hasUsername && !username) { errEl.textContent = 'Username is required.'; return; }
    if (!streamKey) { errEl.textContent = 'Stream key is required.'; return; }

    addBtn.disabled = true;
    const result = await window.api.addDestination({
      name: addBtn.dataset.label, rtmpUrl: addBtn.dataset.rtmp, streamKey, username,
    });
    addBtn.disabled = false;
    if (!result.ok) { errEl.textContent = result.error || 'Failed to add.'; return; }
    const { destinations } = await window.api.getDestinations();
    renderPlatforms(destinations);
  }
});

// ── Logout ────────────────────────────────────────────────────────────────────
$('logout-btn').addEventListener('click', async () => {
  stopCamera();
  await window.api.logout();
  isStreaming = false;
  obsConnected = false;
  $('go-live-btn').disabled    = true;
  $('go-live-btn').textContent = 'GO LIVE';
  $('go-live-btn').classList.remove('live');
  $('obs-dot').className       = 'obs-dot';
  $('obs-label').textContent   = 'OBS';
  $('username').value  = '';
  $('password').value  = '';
  $('login-error').textContent = '';
  showScreen('login');
});

// ── Debug panel ───────────────────────────────────────────────────────────────
let debugOpen     = false;
let debugInterval = null;

async function refreshDebug() {
  try {
    const info  = await window.api.getDebugInfo();
    const lines = [
      `TIME       ${info.ts}`,
      `USER DATA  ${info.userData}`,
      `OBS DIR    ${info.obsDir}`,
      `WS PORT    ${info.obsWsPort}  connected=${info.obsWsConnected}`,
      `PROFILE    ${info.activeProfile}`,
      '',
      '── STREAM SERVICE (live in OBS) ──────────────────────────',
      info.streamService,
      '',
      '── DESTINATIONS (memory) ─────────────────────────────────',
      JSON.stringify(info.streamDestinations, null, 2),
      '',
      '── DESTINATIONS CACHE (disk) ─────────────────────────────',
      info.destinationsOnDisk,
      '',
      '── DEST EXT PROPS (username/eventsToken) ─────────────────',
      info.destExtFile,
      '',
      '── OBS PROCESSES ─────────────────────────────────────────',
      info.obsProcesses,
      '',
      '── SERVICE.JSON ──────────────────────────────────────────',
      info.serviceJson,
      '',
      '── OBS LOG ───────────────────────────────────────────────',
      info.obsLog,
    ];
    $('debug-pre').textContent = lines.join('\n');
  } catch (err) {
    $('debug-pre').textContent = `Error: ${err.message}`;
  }
}

function openDebug() {
  debugOpen = true;
  $('debug-overlay').style.display = 'flex';
  refreshDebug();
  debugInterval = setInterval(refreshDebug, 2000);
}

function closeDebug() {
  debugOpen = false;
  $('debug-overlay').style.display = 'none';
  clearInterval(debugInterval);
  debugInterval = null;
}

$('debug-btn').addEventListener('click', () => debugOpen ? closeDebug() : openDebug());
$('debug-close-btn').addEventListener('click', closeDebug);
$('debug-overlay').addEventListener('click', e => { if (e.target === $('debug-overlay')) closeDebug(); });
$('debug-copy-btn').addEventListener('click', () => {
  navigator.clipboard.writeText($('debug-pre').textContent).catch(() => {});
  $('debug-copy-btn').textContent = 'Copied!';
  setTimeout(() => { $('debug-copy-btn').textContent = 'Copy'; }, 1500);
});

document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 'd') { e.preventDefault(); debugOpen ? closeDebug() : openDebug(); }
  if (e.key === 'Escape' && debugOpen) closeDebug();
});

// ── Init: resume session ──────────────────────────────────────────────────────
(async () => {
  const token = await window.api.getToken();
  if (token) {
    showScreen('dashboard');
    $('live-status').textContent = 'Connecting to OBS…';
    initCamera();
    refreshChatStatus();
    const { destinations, disabledIds } = await window.api.getDestinations();
    renderPlatformSidebar(destinations, disabledIds);
  }
})();
