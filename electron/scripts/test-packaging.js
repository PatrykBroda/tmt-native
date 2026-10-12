// Every local module main.js requires must be listed in package.json build.files,
// otherwise the installed app crashes on launch.
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..');
const files = require(path.join(root, 'package.json')).build.files;
const missing = [];
for (const f of ['main.js', 'obs-manager.js', 'chat-manager.js', 'toy-manager.js', 'stream-guard.js', 'events-poller.js', 'obs-text-source.js']) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  for (const m of src.matchAll(/require\('\.\/([\w-]+)(?:\.js)?'\)/g)) {
    if (m[1] === 'secrets') continue;
    if (!files.includes(m[1] + '.js')) missing.push(`${f} -> ${m[1]}.js`);
  }
}
assert.deepStrictEqual([...new Set(missing)], [], 'not packaged: ' + missing.join(', '));
console.log('packaging OK');
