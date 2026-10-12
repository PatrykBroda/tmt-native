// Turns raw OBS / network error text into something a non-technical model can act on.
// Full detail still goes to the log; only the on-screen message is rewritten.

function friendlyStreamError(err) {
  const raw = String((err && err.message) || err || '').trim();
  const code = err && err.code;
  if (/not connected|socket not identified|connection closed|websocket.*(closed|not open)|ECONNREFUSED/i.test(raw) && !/internet/i.test(raw))
    return 'The streaming engine (OBS) is not ready yet. Wait a few seconds and press Go Live again — if it keeps happening, close and reopen TMT Native.';
  if (/already active|already streaming|code 500.*active/i.test(raw))
    return 'You are already live. Press Go Offline first if you want to restart.';
  if (/not active|not streaming/i.test(raw))
    return 'You are not live right now.';
  if (/timed? ?out|ETIMEDOUT|AbortError/i.test(raw) || code === 'ETIMEDOUT')
    return 'That took too long. Check your internet connection and try again.';
  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|network/i.test(raw) || ['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH'].includes(code))
    return 'No internet connection. Check your Wi-Fi or cable, then try again.';
  if (/camera|video capture|device/i.test(raw))
    return 'Your camera could not be started. Make sure no other app is using it, then try again.';
  if (/output.*(error|fail)|failed to connect|invalid.*(key|url)|stream key/i.test(raw))
    return 'A platform refused the connection. Check that your stream keys are correct, then try again.';
  if (!raw) return 'Something went wrong. Please try again.';
  return `Something went wrong (${raw.slice(0, 120)}). Please try again — if it keeps happening, tell support.`;
}

module.exports = { friendlyStreamError };
