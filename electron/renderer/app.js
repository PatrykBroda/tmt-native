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
  stopProgramPreview();
  setCameraPlaceholder('&#9679;&nbsp; NO CAMERA');
  initCamera();
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
$('sc-manual-overlay').addEventListener('click', e => {
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
  let result;
  try {
  if (isStreaming) {
    result = await window.api.goOffline();
    stopProgramPreview();
    setCameraPlaceholder('&#9679;&nbsp; NO CAMERA');
    initCamera();                       // restore the live in-app preview once offline
  } else {
    // Release the webcam so OBS can capture it. Windows only lets one app own a
    // DirectShow camera — our preview was blocking OBS, producing a black stream
    // with working audio. Free it, give Windows a moment, then go live, then show
    // OBS's program output as the in-app monitor.
    stopCamera();
    setCameraPlaceholder('&#9679;&nbsp; Starting stream…');
    await new Promise(r => setTimeout(r, 1500));
    result = await window.api.goLive();
    if (result.ok) startProgramPreview();
    else { setCameraPlaceholder('&#9679;&nbsp; NO CAMERA'); initCamera(); }
  }
  } catch (err) {
    // IPC itself failed — never leave the button stuck disabled with no explanation
    console.error('[go-live]', err);
    result = { ok: false, error: 'Something went wrong talking to the app. Please try again.' };
    setCameraPlaceholder('&#9679;&nbsp; NO CAMERA'); initCamera();
  }
  if (!result.ok) {
    const prefix = result.stage === 'stripchat' ? '[Stripchat] ' : '';
    $('live-status').textContent = prefix + (result.error || 'Failed');
  } else if (result.stripchatManual) {
    $('live-status').textContent = 'Live — open SC panel to start show';
    if (result.openPanel) window.api.toggleBroadcastView();
  }
  btn.disabled = !obsConnected;
});

function setScBarVisible(visible, url) {
  const bar = document.getElementById('sc-url-bar');
  if (!bar) return;
  bar.classList.toggle('visible', visible);
  if (url) $('sc-url-input').value = url;
}

function setCbBarVisible(visible, url) {
  const bar = document.getElementById('cb-url-bar');
  if (!bar) return;
  bar.classList.toggle('visible', visible);
  if (url) $('cb-url-input').value = url;
}

window.api.onScUrlChanged(url => { $('sc-url-input').value = url; });
window.api.onCbUrlChanged(url => { $('cb-url-input').value = url; });

$('sc-url-input').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  let url = e.target.value.trim();
  if (url && !url.startsWith('http')) url = 'https://' + url;
  if (url) window.api.scNavigate(url);
});
$('sc-go-btn').addEventListener('click', () => {
  let url = $('sc-url-input').value.trim();
  if (url && !url.startsWith('http')) url = 'https://' + url;
  if (url) window.api.scNavigate(url);
});
$('sc-back-btn').addEventListener('click', () => window.api.scGoBack());
$('sc-fwd-btn').addEventListener('click', () => window.api.scGoForward());

$('cb-url-input').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  let url = e.target.value.trim();
  if (url && !url.startsWith('http')) url = 'https://' + url;
  if (url) window.api.cbNavigate(url);
});
$('cb-go-btn').addEventListener('click', () => {
  let url = $('cb-url-input').value.trim();
  if (url && !url.startsWith('http')) url = 'https://' + url;
  if (url) window.api.cbNavigate(url);
});
$('cb-back-btn').addEventListener('click', () => window.api.cbGoBack());
$('cb-fwd-btn').addEventListener('click', () => window.api.cbGoForward());

$('broadcast-btn').addEventListener('click', async () => {
  const res = await window.api.toggleBroadcastView();
  setScBarVisible(res.visible, res.url);
  // If SC is now visible, CB was hidden by main process — update CB bar
  if (res.visible) setCbBarVisible(false);
  $('broadcast-btn').classList.toggle('active', res.visible);
  $('cb-btn').classList.toggle('active', false);
});

$('cb-btn').addEventListener('click', async () => {
  const res = await window.api.toggleCbView();
  setCbBarVisible(res.visible, res.url);
  // If CB is now visible, SC was hidden by main process — update SC bar
  if (res.visible) setScBarVisible(false);
  $('cb-btn').classList.toggle('active', res.visible);
  $('broadcast-btn').classList.toggle('active', false);
});

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

function setCameraPlaceholder(text) {
  const span = $('camera-placeholder')?.querySelector('span');
  if (span) span.innerHTML = text;
}

// Live program monitor: while broadcasting, the physical webcam is owned by OBS,
// so instead of re-opening it (Windows blocks that) we poll OBS for a screenshot
// of its program output and show that — the model sees exactly what viewers see.
let programPreviewTimer = null;
let programPreviewOn    = false;

function startProgramPreview() {
  if (programPreviewOn) return;
  programPreviewOn = true;
  $('camera-placeholder').style.display = 'none';
  $('camera-preview').style.display     = 'none';
  $('program-preview').style.display    = 'block';
  $('program-live-badge').style.display = 'block';
  const img = $('program-preview');
  const tick = async () => {
    if (!programPreviewOn) return;
    try {
      const r = await window.api.getProgramFrame();
      if (programPreviewOn && r?.ok && r.dataUrl) img.src = r.dataUrl;
    } catch {}
    if (programPreviewOn) programPreviewTimer = setTimeout(tick, 350);
  };
  tick();
}

function stopProgramPreview() {
  programPreviewOn = false;
  if (programPreviewTimer) { clearTimeout(programPreviewTimer); programPreviewTimer = null; }
  const img = $('program-preview');
  img.style.display = 'none';
  img.src = '';
  $('program-live-badge').style.display = 'none';
  $('camera-preview').style.display     = 'block';
}

// ── Promo overlay bar (dashboard) — deliberately dead-simple for models ────────
let promoEnabled   = false;
let promoSaveTimer = null;

async function loadPromoBar() {
  try {
    const cfg = await window.api.getOverlay();
    if ($('promo-input')) $('promo-input').value = cfg?.text || '';
    promoEnabled = !!cfg?.enabled;
    updatePromoToggle();
  } catch {}
}

function updatePromoToggle() {
  const btn = $('promo-toggle');
  if (!btn) return;
  btn.classList.toggle('on', promoEnabled);
  $('promo-toggle-label').textContent = promoEnabled ? 'ON' : 'OFF';
  btn.title = promoEnabled
    ? 'Showing on your stream — click to hide'
    : 'Hidden — click to show it on your stream';
}

function savePromo() {
  window.api.setOverlay({ text: $('promo-input').value.trim(), enabled: promoEnabled })
    .then(() => {
      const s = $('promo-saved');
      if (s) { s.classList.add('show'); setTimeout(() => s.classList.remove('show'), 1300); }
    })
    .catch(() => {});
}

if ($('promo-input')) {
  // Auto-save shortly after they stop typing — no Save button to forget.
  $('promo-input').addEventListener('input', () => {
    clearTimeout(promoSaveTimer);
    promoSaveTimer = setTimeout(savePromo, 700);
  });
  $('promo-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { clearTimeout(promoSaveTimer); savePromo(); e.target.blur(); }
  });
  $('promo-toggle').addEventListener('click', () => {
    promoEnabled = !promoEnabled;
    updatePromoToggle();
    savePromo();
  });
  loadPromoBar();
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

// ── Startup progress bar ──────────────────────────────────────────────────────
const SS_ICONS = { pending: '·', loading: '⟳', done: '✓', error: '✕', skip: '—' };

function showStartupBar() {
  const bar = $('startup-bar');
  if (!bar) return;
  // Reset all steps to pending
  ['obs', 'session', 'broadcast', 'chat'].forEach(s => {
    const icon = document.querySelector(`#ss-${s} .ss-icon`);
    if (icon) { icon.textContent = '·'; icon.dataset.status = 'pending'; }
  });
  bar.classList.remove('fading');
  bar.classList.add('active');
}

function hideStartupBar() {
  const bar = $('startup-bar');
  if (!bar) return;
  bar.classList.remove('active', 'fading');
}

function setStartupStep(step, status) {
  const el = document.getElementById('ss-' + step);
  if (!el) return;
  const icon = el.querySelector('.ss-icon');
  if (!icon) return;
  icon.textContent    = SS_ICONS[status] ?? '·';
  icon.dataset.status = status;
  // Auto-dismiss once all steps are resolved
  const allDone = ['obs', 'session', 'broadcast', 'chat'].every(s => {
    const st = document.getElementById('ss-' + s)?.querySelector('.ss-icon')?.dataset?.status;
    return st === 'done' || st === 'error' || st === 'skip';
  });
  const bar = $('startup-bar');
  if (allDone && bar?.classList.contains('active') && !bar.classList.contains('fading')) {
    setTimeout(() => {
      bar.classList.add('fading');
      setTimeout(() => bar.classList.remove('active', 'fading'), 500);
    }, 2500);
  }
}

window.api.onStartupStatus(({ step, status }) => setStartupStep(step, status));

// ── Auth error (session expired or account deactivated) ───────────────────────
window.api.onAuthError(({ code, message }) => {
  if (code === 401) {
    stopProgramPreview();
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

  let result;
  try {
    result = await window.api.login(username, password);
  } catch (err) {
    errEl.textContent = 'App error: ' + err.message;
    btn.disabled    = false;
    btn.textContent = 'Sign in';
    return;
  }

  if (result.ok && result.admin) {
    btn.disabled = false;
    btn.textContent = 'Sign in';
    $('username').value = '';
    $('password').value = '';
    enterAdminMode();
  } else if (result.ok) {
    showScreen('dashboard');
    showStartupBar();
    $('live-status').textContent = 'Connecting to OBS…';
    initCamera();
    refreshChatStatus();
    const { destinations, disabledIds } = await window.api.getDestinations();
    renderPlatformSidebar(destinations, disabledIds);
  } else {
    errEl.textContent = result.error || 'Login failed.';
    btn.disabled    = false;
    btn.textContent = 'Sign in';
    const form = $('login-form');
    form.classList.remove('shake');
    void form.offsetWidth; // force reflow so animation restarts
    form.classList.add('shake');
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

      // Show username field when platform needs one but it's missing (e.g. Stripchat without username)
      const missingUsername = p.hasUsername && !existing.username ? `
        <div class="platform-missing-username">
          <span class="missing-uname-label">⚠ Username needed for auto-start</span>
          <div class="field" style="margin-top:6px;">
            <input type="text" id="uname-edit-${p.id}"
                   placeholder="${escHtml(p.usernameHint || 'Your username')}" autocomplete="off" />
            <button class="btn btn-ghost platform-uname-save-btn"
                    data-id="${existing.id}" data-platform="${p.id}"
                    style="width:100%;margin-top:6px;">Save Username</button>
          </div>
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
          ${missingUsername}
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

// ── Stripchat connection status ───────────────────────────────────────────────
async function refreshScStatus() {
  const { loggedIn } = await window.api.scLoginStatus();
  const dot    = $('sc-conn-dot');
  const status = $('sc-conn-status');
  const card   = $('sc-connection-card');
  if (loggedIn) {
    dot.className       = 'connection-dot connected';
    status.textContent  = 'Connected';
    card.classList.add('is-connected');
  } else {
    dot.className       = 'connection-dot';
    status.textContent  = 'Not connected — open panel to log in';
    card.classList.remove('is-connected');
  }
}

$('sc-open-btn').addEventListener('click', async () => {
  const res = await window.api.toggleBroadcastView();
  setScBarVisible(res.visible, res.url);
  setTimeout(refreshScStatus, 2500);
});

$('settings-btn').addEventListener('click', async () => {
  const [{ destinations }, version] = await Promise.all([
    window.api.getDestinations(),
    window.api.getAppVersion(),
  ]);
  renderPlatforms(destinations);
  $('settings-version').textContent = `v${version}`;
  refreshScStatus();
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

  // Save username for platforms that need it (e.g. Stripchat)
  const unameSave = e.target.closest('.platform-uname-save-btn');
  if (unameSave) {
    const platformId = unameSave.dataset.platform;
    const username   = document.getElementById(`uname-edit-${platformId}`)?.value.trim() || '';
    if (!username) return;
    unameSave.disabled = true;
    const result = await window.api.setUsername(unameSave.dataset.id, username);
    unameSave.disabled = false;
    if (result.ok) {
      const { destinations } = await window.api.getDestinations();
      renderPlatforms(destinations);
    }
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
  stopProgramPreview();
  stopCamera();
  hideStartupBar();
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

// ── Admin overview ────────────────────────────────────────────────────────────
let adminInterval = null;

function enterAdminMode() {
  showScreen('admin');
  refreshAdminOverview();
  clearInterval(adminInterval);
  adminInterval = setInterval(refreshAdminOverview, 10000);
}

function exitAdminMode() {
  clearInterval(adminInterval);
  adminInterval = null;
  showScreen('login');
}

function agoText(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60)   return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

async function refreshAdminOverview() {
  let data;
  try { data = await window.api.getAdminOverview(); }
  catch (e) { $('admin-updated').textContent = 'error: ' + e.message; return; }
  if (!data || !data.ok) { $('admin-updated').textContent = 'error: ' + (data?.error || 'failed'); return; }

  $('admin-updated').textContent  = 'Updated ' + new Date(data.generatedAt).toLocaleTimeString();
  $('admin-live').textContent     = data.liveCount;
  $('admin-active').textContent   = data.activeSessions;
  $('admin-accounts').textContent = data.totalAccounts;
  $('admin-versions').textContent = Object.keys(data.versions || {}).length;

  // Live now
  $('admin-live-list').innerHTML = data.liveNow.length
    ? data.liveNow.map(u => `
        <div class="admin-row">
          <span class="admin-dot admin-dot-live"></span>
          <span class="admin-name">${escHtml(u.username)}</span>
          <span class="admin-meta">live ${agoText(u.sinceMs)}</span>
          <span class="admin-ver">v${escHtml(u.version || '?')}</span>
        </div>`).join('')
    : '<div class="admin-empty">No one is live right now.</div>';

  // Accounts (clickable → detail). Merge in admin-created accounts that don't
  // have any logs yet, so they show up immediately after creation.
  const known = new Set(data.accounts.map(a => a.username.toLowerCase()));
  const extra = adminCreatedAccounts
    .filter(u => !known.has(u.toLowerCase()))
    .map(u => ({ username: u, version: null, lastTs: 0, live: false, justCreated: true }));
  const accounts = [...extra, ...data.accounts];
  $('admin-accounts-list').innerHTML = accounts.length
    ? accounts.map(u => `
        <div class="admin-row admin-row-click" data-user="${escHtml(u.username)}">
          <span class="admin-dot${u.live ? ' admin-dot-live' : ''}"></span>
          <span class="admin-name">${escHtml(u.username)}</span>
          ${u.justCreated ? '<span class="admin-new-tag">NEW</span>' : ''}
          <span class="admin-meta">${u.justCreated ? 'just created' : agoText(u.lastTs)}</span>
          <span class="admin-ver">v${escHtml(u.version || '?')}</span>
        </div>`).join('')
    : '<div class="admin-empty">No accounts seen yet.</div>';
  // Live-now rows are also clickable
  $('admin-live-list').querySelectorAll('.admin-row').forEach((row, i) => {
    const u = data.liveNow[i]; if (u) { row.classList.add('admin-row-click'); row.dataset.user = u.username; }
  });

  // Versions summary into the title tooltip
  const verStr = Object.entries(data.versions || {}).map(([v, n]) => `v${v}: ${n}`).join('  ·  ');
  $('admin-versions').title = verStr;

  // Events feed
  $('admin-events').innerHTML = data.events.length
    ? data.events.map(e => `
        <div class="admin-event admin-event-${e.level}">
          <span class="admin-event-ts">${(e.ts || '').slice(11, 19)}</span>
          <span class="admin-event-user">${escHtml(e.username)}</span>
          <span class="admin-event-msg">${escHtml(e.message)}</span>
        </div>`).join('')
    : '<div class="admin-empty">No recent activity.</div>';
}

$('admin-refresh-btn').addEventListener('click', refreshAdminOverview);
$('admin-logout-btn').addEventListener('click', exitAdminMode);

// ── Create account (from login screen + admin panel) ──────────────────────────
const adminCreatedAccounts = [];
let createAccountContext = 'login';   // 'login' (self sign-up) or 'admin'

function openCreateAccount(context) {
  createAccountContext = context;
  $('ac-title').textContent = context === 'admin' ? 'New account' : 'Create account';
  $('ac-username').value = '';
  $('ac-password').value = '';
  $('ac-msg').textContent = '';
  $('ac-msg').style.color = '';
  $('ac-create').disabled = false;
  $('ac-create').textContent = 'Create account';
  $('admin-create-overlay').classList.add('active');
  $('ac-username').focus();
}

$('login-create-btn').addEventListener('click', () => openCreateAccount('login'));
$('admin-new-btn').addEventListener('click', () => openCreateAccount('admin'));
$('ac-close').addEventListener('click', () => $('admin-create-overlay').classList.remove('active'));
$('admin-create-overlay').addEventListener('click', e => {
  if (e.target === $('admin-create-overlay')) $('admin-create-overlay').classList.remove('active');
});
$('ac-password').addEventListener('keydown', e => { if (e.key === 'Enter') submitCreateAccount(); });
$('ac-create').addEventListener('click', submitCreateAccount);

async function submitCreateAccount() {
  const username = $('ac-username').value.trim();
  const password = $('ac-password').value;
  const msg = $('ac-msg');
  msg.style.color = '';
  if (!username || !password) { msg.textContent = 'Username and password are required.'; return; }
  const btn = $('ac-create');
  btn.disabled = true; btn.textContent = 'Creating…'; msg.textContent = '';
  let r;
  try { r = await window.api.adminCreateAccount(username, password); }
  catch (e) { r = { ok: false, error: e.message }; }

  if (!r.ok) {
    btn.disabled = false; btn.textContent = 'Create account';
    msg.textContent = r.notAvailable
      ? '⚠ Account creation isn\'t available right now (backend route missing).'
      : '✕ ' + (r.error || 'Could not create account.');
    return;
  }

  if (createAccountContext === 'admin') {
    if (!adminCreatedAccounts.includes(username)) adminCreatedAccounts.unshift(username);
    $('admin-create-overlay').classList.remove('active');
    refreshAdminOverview();
    return;
  }

  // Login-screen self sign-up → log the new account straight in.
  msg.style.color = 'var(--green)';
  msg.textContent = '✓ Account created — signing you in…';
  let login;
  try { login = await window.api.login(username, password); }
  catch (e) { login = { ok: false, error: e.message }; }
  if (login.ok && !login.admin) {
    $('admin-create-overlay').classList.remove('active');
    showScreen('dashboard');
    showStartupBar();
    $('live-status').textContent = 'Connecting to OBS…';
    initCamera();
    refreshChatStatus();
    const { destinations, disabledIds } = await window.api.getDestinations();
    renderPlatformSidebar(destinations, disabledIds);
  } else {
    // Created but auto-login failed — let them sign in manually.
    $('admin-create-overlay').classList.remove('active');
    $('username').value = username;
    $('password').value = '';
    $('login-error').textContent = 'Account created — please sign in.';
  }
}

// ── Account detail drawer ─────────────────────────────────────────────────────
let adCurrentUser = null;

document.addEventListener('click', e => {
  const row = e.target.closest('.admin-row-click');
  if (row && row.dataset.user) openAccountDetail(row.dataset.user);
});

async function openAccountDetail(username) {
  adCurrentUser = username;
  $('admin-detail-overlay').classList.add('active');
  $('ad-name').textContent = username;
  $('ad-sub').textContent = '';
  $('ad-msg').textContent = '';
  $('ad-stats').innerHTML = '';
  $('ad-timeline').innerHTML = '<div class="admin-empty">Loading…</div>';
  $('ad-open-as').disabled = false;
  $('ad-open-as').textContent = 'Open as model';

  let d;
  try { d = await window.api.getAccountDetail(username); }
  catch (e) { $('ad-timeline').innerHTML = `<div class="admin-empty">Error: ${escHtml(e.message)}</div>`; return; }
  if (!d || !d.ok) { $('ad-timeline').innerHTML = `<div class="admin-empty">Error: ${escHtml(d?.error || 'failed')}</div>`; return; }

  $('ad-sub').innerHTML = d.live ? '<span class="admin-dot admin-dot-live"></span> live now' : 'offline';
  $('ad-stats').innerHTML = [
    ['Live', d.live ? 'Yes' : 'No'],
    ['Last seen', agoText(d.lastTs)],
    ['Sessions', d.sessionCount],
    ['Go-lives', d.goLiveCount],
    ['Platforms', (d.platforms || []).join(', ') || '—'],
    ['Version', 'v' + (d.version || '?')],
    ['User ID', d.userId ?? '—'],
  ].map(([k, v]) => `<div class="ad-stat"><div class="ad-stat-k">${k}</div><div class="ad-stat-v">${escHtml(String(v))}</div></div>`).join('');

  $('ad-timeline').innerHTML = d.timeline.length
    ? d.timeline.map(e => `
        <div class="admin-event admin-event-${e.level}">
          <span class="admin-event-ts">${(e.ts || '').slice(5, 19).replace('T', ' ')}</span>
          <span class="admin-event-msg">${escHtml(e.message)}${e.context ? ' <span class="ad-ctx">' + escHtml(JSON.stringify(e.context)) + '</span>' : ''}</span>
        </div>`).join('')
    : '<div class="admin-empty">No activity recorded.</div>';

  // Real account config: pull this account's cloud destinations (platforms + keys).
  loadAccountDestinations(d.userId, username);
}

function maskKey(k) {
  if (!k) return '—';
  const s = String(k);
  if (s.length <= 10) return s;
  return s.slice(0, 6) + '…' + s.slice(-4);
}

async function loadAccountDestinations(userId, username) {
  const box = $('ad-destinations');
  box.innerHTML = '<div class="admin-empty">Loading platforms…</div>';
  let r;
  try { r = await window.api.getAccountDestinations(userId, username); }
  catch (e) { r = { ok: false, error: e.message }; }
  if (!r.ok) {
    box.innerHTML = `<div class="admin-empty">${r.notAvailable ? 'Platform info unavailable (impersonation route missing).' : 'Couldn\'t load platforms: ' + escHtml(r.error || '')}</div>`;
    return;
  }
  if (!r.destinations.length) {
    box.innerHTML = '<div class="admin-empty">No platforms configured on this account yet.</div>';
    return;
  }
  box.innerHTML = r.destinations.map(dst => {
    const key = dst.name.toLowerCase();
    const meta = PLATFORM_META[key] || { abbr: (dst.name || '?').slice(0, 2).toUpperCase() };
    return `
      <div class="ad-dest">
        <span class="plat-icon plat-icon-${key}">${meta.abbr}</span>
        <div class="ad-dest-info">
          <div class="ad-dest-name">${escHtml(dst.name)}</div>
          <div class="ad-dest-row"><span class="ad-dest-k">RTMP</span><span class="ad-dest-v">${escHtml(dst.rtmpUrl || '—')}</span></div>
          <div class="ad-dest-row"><span class="ad-dest-k">Key</span><span class="ad-dest-v ad-dest-key" title="${escHtml(dst.streamKey || '')}">${escHtml(maskKey(dst.streamKey))}</span></div>
        </div>
        <span class="ad-dest-status ${dst.streamKey ? 'ok' : 'off'}">${dst.streamKey ? 'configured' : 'no key'}</span>
      </div>`;
  }).join('');
}

$('ad-close').addEventListener('click', () => $('admin-detail-overlay').classList.remove('active'));
$('admin-detail-overlay').addEventListener('click', e => {
  if (e.target === $('admin-detail-overlay')) $('admin-detail-overlay').classList.remove('active');
});

$('ad-open-as').addEventListener('click', async () => {
  if (!adCurrentUser) return;
  const btn = $('ad-open-as');
  btn.disabled = true;
  btn.textContent = 'Opening…';
  $('ad-msg').textContent = '';
  let r;
  try { r = await window.api.impersonate(null, adCurrentUser); }
  catch (e) { r = { ok: false, error: e.message }; }
  if (r.ok) {
    // Logged in as the model — leave admin mode and show their dashboard.
    clearInterval(adminInterval); adminInterval = null;
    $('admin-detail-overlay').classList.remove('active');
    showScreen('dashboard');
    showStartupBar();
    $('live-status').textContent = 'Connecting to OBS…';
    initCamera();
    refreshChatStatus();
    const { destinations, disabledIds } = await window.api.getDestinations();
    renderPlatformSidebar(destinations, disabledIds);
  } else {
    btn.disabled = false;
    btn.textContent = 'Open as model';
    $('ad-msg').textContent = r.notAvailable
      ? '⚠ Open-as needs a backend endpoint (/api/admin/impersonate) that isn\'t deployed yet. Everything else here works.'
      : '✕ ' + (r.error || 'Could not open this account.');
  }
});

// ── Debug panel ───────────────────────────────────────────────────────────────
let debugOpen     = false;
let debugInterval = null;

async function refreshDebug() {
  try {
    const [info, remote] = await Promise.all([
      window.api.getDebugInfo(),
      window.api.getRemoteLogs({ limit: 50 }).catch(() => null),
    ]);

    let remoteLogs = '(not available — not logged in or no logs yet)';
    if (remote && Array.isArray(remote.logs)) {
      remoteLogs = remote.logs.length === 0
        ? '(no remote logs found)'
        : remote.logs.map(l =>
            `${(l.clientTs || l.createdAt || '').slice(0, 19)}  [${l.level.toUpperCase()}]  ${l.message}` +
            (l.context ? `\n  ${JSON.stringify(l.context)}` : '')
          ).join('\n');
    }

    const lines = [
      `TIME       ${info.ts}`,
      `USER DATA  ${info.userData}`,
      `OBS DIR    ${info.obsDir}`,
      `WS PORT    ${info.obsWsPort}  connected=${info.obsWsConnected}`,
      `PROFILE    ${info.activeProfile}`,
      `SC VIEW    ${info.scViewUrl}`,
      `CHAT VIEW  ${info.chatReaderUrl}`,
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
      '',
      '── STRIPCHAT WS FRAMES (last 80) ─────────────────────────',
      info.scWsLog || '(none yet)',
      '',
      '── REMOTE LOGS (last 50) ─────────────────────────────────',
      remoteLogs,
    ];
    $('debug-pre').textContent = lines.join('\n');
  } catch (err) {
    $('debug-pre').textContent = `Error: ${err.message}`;
  }
}

function openDebug() {
  debugOpen = true;
  $('debug-overlay').style.display = 'flex';
  setDebugTab(debugTab);
}

function closeDebug() {
  debugOpen = false;
  $('debug-overlay').style.display = 'none';
  clearInterval(debugInterval);
  debugInterval = null;
}

// ── Debug panel tab state ─────────────────────────────────────────────────────
let debugTab = 'local'; // 'local' | 'allusers'

function setDebugTab(tab) {
  debugTab = tab;
  $('debug-tab-local').style.opacity    = tab === 'local'    ? '1' : '0.4';
  $('debug-tab-allusers').style.opacity = tab === 'allusers' ? '1' : '0.4';
  clearInterval(debugInterval);
  if (debugOpen) {
    $('debug-pre').textContent = 'Loading…';
    if (tab === 'local') {
      refreshDebug();
      debugInterval = setInterval(refreshDebug, 2000);
    } else {
      refreshAdminLogs();
      debugInterval = setInterval(refreshAdminLogs, 5000);
    }
  }
}

async function refreshAdminLogs() {
  try {
    const result = await window.api.getAdminLogs({ limit: 200 });
    if (!result.ok) { $('debug-pre').textContent = `Error: ${result.error}`; return; }
    const lines = result.logs.map(l => {
      const ts  = (l.clientTs || l.createdAt || '').slice(0, 19);
      const who = `[${(l.username || 'unknown').padEnd(12)}]`;
      const ver = `v${l.appVersion || '?'}`;
      const lvl = `[${l.level.toUpperCase()}]`;
      const msg = l.message;
      const ctx = l.context ? `\n    ${JSON.stringify(l.context)}` : '';
      return `${ts}  ${who}  ${ver}  ${lvl}  ${msg}${ctx}`;
    });
    $('debug-pre').textContent = lines.length
      ? `── ALL USERS LOGS (${lines.length}) ──\n\n` + lines.join('\n')
      : '(no logs found)';
  } catch (err) {
    $('debug-pre').textContent = `Error: ${err.message}`;
  }
}

$('debug-tab-local').addEventListener('click',    () => setDebugTab('local'));
$('debug-tab-allusers').addEventListener('click', () => setDebugTab('allusers'));

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
    showStartupBar();
    $('live-status').textContent = 'Connecting to OBS…';
    initCamera();
    refreshChatStatus();
    const { destinations, disabledIds } = await window.api.getDestinations();
    renderPlatformSidebar(destinations, disabledIds);
  }
})();

// ── Toys panel (tip-activated Lovense / Intiface) ─────────────────────────────
const toyUI = { settings: null, status: null, saveTimer: null, tick: null, t0: 0 };

function toyPlatformTag(p) { return ({ chaturbate: 'CB', stripchat: 'SC', bongacams: 'BC', test: 'test' })[p] || p; }

function toyNowText(st, remaining) {
  const p = st.playing;
  return `▶ ${toyPlatformTag(p.platform)} ${p.user}${p.tokens ? ' ' + p.tokens + 'tk' : ''} · ${Math.round(p.intensity * 100)}% · ${Math.ceil(remaining)}s left` +
    (st.queued ? ` · ${st.queued} queued` : '');
}

function renderToyStatus(st) {
  toyUI.status = st;
  $('toy-dot').className = 'toy-dot ' + (st.state === 'connected' ? 'connected' : st.state === 'connecting' ? 'connecting' : '');
  const n = st.devices.length;
  $('toy-status').textContent =
    st.state === 'connected'  ? (n ? `Connected · ${n} toy${n === 1 ? '' : 's'}` : 'Connected · no toys yet')
    : st.state === 'connecting' ? 'Connecting…'
    : (st.error ? 'Disconnected — ' + st.error : 'Not connected');
  $('toy-connect').textContent = st.state === 'disconnected' ? 'Connect' : 'Disconnect';
  const dev = $('toy-devices');
  dev.classList.toggle('has', n > 0);
  dev.textContent = n ? st.devices.map(d => d.name + (d.canVibrate ? '' : ' (no vibrate)')).join(' · ')
    : (st.state === 'connected' ? 'Connected, but no toys found — switch the toy on / pair it in Intiface.' : 'No toys connected.');
  const now = $('toy-now');
  clearInterval(toyUI.tick);
  if (st.playing) {
    now.classList.add('active');
    now.textContent = toyNowText(st, st.playing.remaining);
    toyUI.t0 = Date.now();
    toyUI.tick = setInterval(() => {   // keep the countdown moving between status pushes
      const left = Math.max(0, st.playing.remaining - (Date.now() - toyUI.t0) / 1000);
      now.textContent = toyNowText(st, left);
    }, 500);
  } else {
    now.classList.remove('active');
    now.textContent = st.queued ? `${st.queued} queued` : 'Idle';
  }
}

function renderToyLevels() {
  const box = $('toy-levels'); box.innerHTML = '';
  (toyUI.settings.levels || []).forEach((l, i) => {
    const row = document.createElement('div'); row.className = 'toy-level';
    row.innerHTML =
      `<input type="text" class="toy-num" data-k="min" value="${l.min}" /> to ` +
      `<input type="text" class="toy-num" data-k="max" value="${l.max ?? ''}" placeholder="∞" /> tokens → ` +
      `<input type="text" class="toy-num" data-k="intensity" value="${Math.round(l.intensity * 100)}" />% for ` +
      `<input type="text" class="toy-num" data-k="seconds" value="${l.seconds}" />s ` +
      `<button class="toy-level-x" data-i="${i}" title="Remove">&times;</button>`;
    box.appendChild(row);
  });
}

function collectToySettings() {
  const s = toyUI.settings;
  s.backend = $('toy-backend').value;
  s.intifaceUrl = $('toy-intiface-url').value.trim() || s.intifaceUrl;
  s.lovenseHost = $('toy-lovense-host').value.trim() || s.lovenseHost;
  s.lovensePort = Number($('toy-lovense-port').value) || s.lovensePort;
  s.enabled = $('toy-enabled').checked;
  s.autoConnect = $('toy-auto').checked;
  s.bongaTipParsing = $('toy-bonga').checked;
  s.maxQueue = Number($('toy-maxq').value) || s.maxQueue;
  s.levels = [...$('toy-levels').children].map(row => {
    const v = k => row.querySelector(`[data-k="${k}"]`).value.trim();
    return { min: Number(v('min')), max: v('max') === '' ? null : Number(v('max')),
             intensity: (Number(v('intensity')) || 0) / 100, seconds: Number(v('seconds')) };
  });
  return s;
}

function saveToys() {
  clearTimeout(toyUI.saveTimer);
  toyUI.saveTimer = setTimeout(async () => {
    try {
      toyUI.settings = await window.api.toysSetSettings(collectToySettings());
      $('toy-panel').classList.toggle('lovense', toyUI.settings.backend === 'lovense');
      const s = $('toy-saved'); s.classList.add('show'); setTimeout(() => s.classList.remove('show'), 1300);
    } catch {}
  }, 500);
}

async function initToys() {
  if (!$('toy-panel')) return;
  const { settings, status } = await window.api.toysGet();
  toyUI.settings = settings;
  $('toy-backend').value = settings.backend;
  $('toy-intiface-url').value = settings.intifaceUrl;
  $('toy-lovense-host').value = settings.lovenseHost;
  $('toy-lovense-port').value = settings.lovensePort;
  $('toy-enabled').checked = settings.enabled;
  $('toy-auto').checked = settings.autoConnect;
  $('toy-bonga').checked = settings.bongaTipParsing;
  $('toy-maxq').value = settings.maxQueue;
  $('toy-panel').classList.toggle('lovense', settings.backend === 'lovense');
  renderToyLevels();
  renderToyStatus(status);
  window.api.onToyStatus(renderToyStatus);

  $('toy-expand').addEventListener('click', () => $('toy-panel').classList.toggle('open'));
  $('toy-stop').addEventListener('click', () => window.api.toysStop());
  $('toy-connect').addEventListener('click', async () => {
    if (toyUI.status.state === 'disconnected') {
      clearTimeout(toyUI.saveTimer);
      toyUI.settings = await window.api.toysSetSettings(collectToySettings());
      window.api.toysConnect();
    } else window.api.toysDisconnect();
  });
  document.querySelectorAll('.toy-test').forEach(b =>
    b.addEventListener('click', () => window.api.toysTest(Number(b.dataset.i), Number(b.dataset.s))));
  ['toy-backend', 'toy-intiface-url', 'toy-lovense-host', 'toy-lovense-port', 'toy-enabled', 'toy-auto', 'toy-bonga', 'toy-maxq']
    .forEach(id => $(id).addEventListener('change', saveToys));
  $('toy-levels').addEventListener('change', saveToys);
  $('toy-levels').addEventListener('click', e => {
    const x = e.target.closest('.toy-level-x'); if (!x) return;
    toyUI.settings.levels = collectToySettings().levels.filter((_, i) => i !== Number(x.dataset.i));
    renderToyLevels(); saveToys();
  });
  $('toy-add-level').addEventListener('click', () => {
    const lv = collectToySettings().levels; const last = lv[lv.length - 1];
    if (last && last.max === null) last.max = last.min + 99;
    lv.push({ min: last ? (last.max + 1) : 1, max: null, intensity: 1, seconds: 10 });
    toyUI.settings.levels = lv; renderToyLevels(); saveToys();
  });
  $('toy-reset-levels').addEventListener('click', () => {
    toyUI.settings.levels = [
      { min: 1, max: 9, intensity: 0.25, seconds: 3 }, { min: 10, max: 49, intensity: 0.5, seconds: 6 },
      { min: 50, max: 99, intensity: 0.75, seconds: 10 }, { min: 100, max: null, intensity: 1, seconds: 15 }];
    renderToyLevels(); saveToys();
  });
}
initToys();
