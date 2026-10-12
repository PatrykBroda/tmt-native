const assert = require('assert');
const { createEventsPoller } = require('../events-poller');
(async () => {
  const msgs = [], evs = [], sleeps = [];
  let step = 0, p;
  const script = [
    () => { throw new Error('ENOTFOUND'); },
    () => { throw new Error('ENOTFOUND'); },
    () => ({ ok: false, status: 500 }),
    () => ({ ok: true, status: 200, json: async () => ({ events: [{ n: 1 }, { n: 2, bad: true }, { n: 3 }], next_url: 'NEXT' }) }),
    () => ({ ok: false, status: 401 }),
  ];
  const urls = [];
  p = createEventsPoller({
    baseUrl: 'BASE', notify: m => msgs.push(m), sleep: async d => { sleeps.push(d); },
    onEvent: e => { if (e.bad) throw new Error('boom'); evs.push(e.n); },
    fetchFn: async (u) => { urls.push(u); return script[step++](); },
  });
  await p.run();
  assert.deepEqual(sleeps, [3000, 6000, 12000], 'backoff grows');
  assert.equal(msgs.filter(m => /Lost connection/.test(m)).length, 1, 'down notice once, after 2nd failure');
  assert(msgs.some(m => /reconnected/.test(m)), 'reconnect notice');
  assert.deepEqual(evs, [1, 3], 'bad event does not drop others');
  assert.equal(urls.at(-1), 'NEXT', 'follows next_url');
  assert(/token/.test(msgs.at(-1)), 'auth failure explained');
  assert.equal(p.isActive(), false, 'stops on auth failure');
  assert.equal(p.delayFor(99), 60000, 'capped');
  console.log('events-poller OK');
})().catch(e => { console.error(e); process.exit(1); });
