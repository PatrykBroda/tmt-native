// Chaturbate Events API long-poll loop with bounded exponential backoff and
// plain-English status notices. Pure/injectable so it can be unit tested.
function createEventsPoller({ fetchFn, onEvent, notify, sleep, baseUrl, isAllowed = () => true, maxDelay = 60000 }) {
  let active = false;
  let ctl = null;
  let down = false;       // we've told the model the connection is down
  let failures = 0;

  const delayFor = n => Math.min(maxDelay, 3000 * 2 ** Math.max(0, n - 1));

  function markUp() {
    if (down) notify('Chaturbate chat & tips reconnected.');
    down = false; failures = 0;
  }
  function markDown(why) {
    failures++;
    // Only warn once the second consecutive failure, so a single blip stays quiet.
    if (failures >= 2 && !down) {
      down = true;
      notify(`Lost connection to Chaturbate chat/tips (${why}). Retrying automatically — your stream is not affected.`);
    }
  }

  async function run() {
    if (active) return;
    active = true;
    let url = baseUrl;
    while (active && isAllowed()) {
      try {
        ctl = new AbortController();
        const res = await fetchFn(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
        if (res.status === 401 || res.status === 403) {
          notify('Chaturbate rejected your Events API token, so chat and tips are off. Open Settings and paste a fresh token.');
          break;
        }
        if (!res.ok) { markDown(`HTTP ${res.status}`); await sleep(delayFor(failures)); continue; }
        const data = await res.json();
        markUp();
        for (const ev of (data.events || [])) {
          try { onEvent(ev); } catch {}          // one bad event must not drop the rest
        }
        url = data.next_url || url;
      } catch (err) {
        if (err.name === 'AbortError') { if (!active) break; continue; }
        markDown(err.message || 'network error');
        await sleep(delayFor(failures));
      }
    }
    active = false;
  }
  function stop() { active = false; ctl?.abort(); ctl = null; down = false; failures = 0; }
  return { run, stop, isActive: () => active, delayFor };
}
module.exports = { createEventsPoller };
