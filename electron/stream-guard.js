// Keeps a live stream alive: remembers that the model WANTS to be live and
// restarts the OBS stream if it drops (network blip, platform kick, OBS crash).
// Pure logic — all side effects are injected so it can be unit tested.
function createStreamGuard({ start, notify, log = () => {}, maxAttempts = 6, baseDelayMs = 3000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let wantLive = false;
  let attempts = 0;
  let timer = null;

  function cancel() { if (timer) { clearTimer(timer); timer = null; } }

  function schedule(reason) {
    if (!wantLive || timer) return;
    if (attempts >= maxAttempts) {
      notify('Your stream could not reconnect. Please press Go Live again.');
      log('gave up resuming stream', { reason });
      wantLive = false;
      return;
    }
    const delay = Math.min(baseDelayMs * 2 ** attempts, 30000);
    attempts++;
    notify(`Connection lost — reconnecting your stream (try ${attempts} of ${maxAttempts})…`);
    timer = setTimer(async () => {
      timer = null;
      if (!wantLive) return;
      try { await start(); log('stream resumed', { attempt: attempts }); }
      catch (e) { log('resume failed', { error: e.message }); schedule('start-failed'); }
    }, delay);
  }

  return {
    setWantLive(v) { wantLive = !!v; attempts = 0; if (!wantLive) cancel(); },
    isWantLive: () => wantLive,
    // OBS reported the stream is no longer running / errored
    onStreamStopped(reason) { schedule(reason || 'stopped'); },
    // OBS reported the stream is running again
    onStreamStarted() { if (timer) cancel(); if (wantLive) { attempts = 0; } },
    // WebSocket to OBS (re)established, e.g. after OBS crash + respawn
    onObsReconnected() { if (wantLive) { cancel(); attempts = 0; schedule('obs-reconnected'); } },
  };
}
module.exports = { createStreamGuard };
