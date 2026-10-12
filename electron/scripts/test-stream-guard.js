const assert = require('assert');
const { createStreamGuard } = require('../stream-guard');
function mk(opts = {}) {
  const timers = []; const msgs = []; let starts = 0; let failStart = opts.fail || 0;
  const g = createStreamGuard({
    start: async () => { starts++; if (failStart-- > 0) throw new Error('x'); },
    notify: m => msgs.push(m),
    maxAttempts: 3,
    setTimer: (fn, d) => { const t = { fn, d }; timers.push(t); return t; },
    clearTimer: t => { t.dead = true; },
  });
  const run = async () => { const t = timers.filter(x => !x.dead && !x.ran).shift(); if (t) { t.ran = true; await t.fn(); } };
  return { g, timers, msgs, run, starts: () => starts };
}
(async () => {
  let c = mk();
  c.g.onStreamStopped(); assert.equal(c.timers.length, 0, 'not live → no restart');
  c.g.setWantLive(true); c.g.onStreamStopped(); c.g.onStreamStopped();
  assert.equal(c.timers.length, 1, 'no stacked timers');
  await c.run(); assert.equal(c.starts(), 1);
  c.g.setWantLive(false); c.g.onStreamStopped(); assert.equal(c.timers.length, 1, 'user stop → no restart');
  c = mk({ fail: 5 }); c.g.setWantLive(true); c.g.onObsReconnected();
  for (let i = 0; i < 5; i++) await c.run();
  assert.equal(c.starts(), 3, 'bounded attempts');
  assert(/press Go Live again/.test(c.msgs.at(-1)));
  assert.equal(c.g.isWantLive(), false);
  assert.deepEqual(c.timers.map(t => t.d), [3000, 6000, 12000]);
  console.log('stream-guard OK');
})().catch(e => { console.error(e); process.exit(1); });
