'use strict';
// node scripts/test-obs-respawn.js — respawn limiter + exit-handler wiring (no Electron/OBS needed)
const assert = require('assert');
const m = require('../obs-manager');
const lim = m.createRespawnLimiter(2, 1000);
assert.strictEqual(lim(0), true);
assert.strictEqual(lim(10), true);
assert.strictEqual(lim(20), false, 'third restart inside window is refused');
assert.strictEqual(lim(1500), true, 'budget refreshes after the window');
assert.strictEqual(typeof m.onUnexpectedExit, 'function');
console.log('  ✓ obs respawn limiter\n  Passed: 1 Failed: 0');
