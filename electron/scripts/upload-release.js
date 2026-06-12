'use strict';
// node scripts/upload-release.js
// Logs in, uploads the current-version installer, verifies the publish.
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const ROOT     = path.join(__dirname, '..');
const pkg      = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION  = pkg.version;
const PLATFORM = process.argv.includes('--platform')
  ? process.argv[process.argv.indexOf('--platform') + 1]
  : (process.platform === 'darwin' ? 'macos' : 'windows');
const EXT      = PLATFORM === 'macos' ? 'dmg' : 'exe';
const FILE     = path.join(ROOT, 'dist', `TMT-Streaming-Setup-${VERSION}.${EXT}`);
const HOST     = 'admin.agencytmt.com';

// ── helpers ────────────────────────────────────────────────────────────────────
function jsonRequest(method, urlPath, body, cookie) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const headers = { 'Content-Type': 'application/json' };
    if (payload) headers['Content-Length'] = payload.length;
    if (cookie)  headers['Cookie']         = cookie;

    const req = https.request({ hostname: HOST, path: urlPath, method, headers }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end',  () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

function uploadMultipart(urlPath, cookie, fields, filePath) {
  return new Promise((resolve, reject) => {
    const CRLF     = '\r\n';
    const boundary = 'TMTBoundary' + Date.now().toString(16);

    // Text fields
    let prelude = '';
    for (const [name, value] of Object.entries(fields)) {
      prelude += `--${boundary}${CRLF}`;
      prelude += `Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}`;
      prelude += `${value}${CRLF}`;
    }
    // File field header
    const filename = path.basename(filePath);
    prelude += `--${boundary}${CRLF}`;
    prelude += `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}`;
    prelude += `Content-Type: application/octet-stream${CRLF}${CRLF}`;

    const epilogue    = `${CRLF}--${boundary}--${CRLF}`;
    const preludeBuf  = Buffer.from(prelude,   'utf8');
    const epilogueBuf = Buffer.from(epilogue,  'utf8');
    const fileSize    = fs.statSync(filePath).size;
    const totalSize   = preludeBuf.length + fileSize + epilogueBuf.length;

    const req = https.request({
      hostname: HOST,
      path:     urlPath,
      method:   'POST',
      headers:  {
        'Cookie':         cookie,
        'Content-Type':   `multipart/form-data; boundary=${boundary}`,
        'Content-Length': totalSize,
      },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end',  () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', reject);
    req.setTimeout(600000, () => req.destroy(new Error('Upload timed out after 10 min')));

    req.write(preludeBuf);

    const stream = fs.createReadStream(filePath);
    let uploaded = 0;
    stream.on('data', chunk => {
      req.write(chunk);
      uploaded += chunk.length;
      const pct = ((uploaded / fileSize) * 100).toFixed(1);
      process.stdout.write(`\r  Uploading… ${pct}%  (${(uploaded / 1024 / 1024).toFixed(0)} / ${(fileSize / 1024 / 1024).toFixed(0)} MB)`);
    });
    stream.on('end',   () => { req.write(epilogueBuf); req.end(); });
    stream.on('error', reject);
  });
}

// ── main ───────────────────────────────────────────────────────────────────────
(async () => {
  if (!fs.existsSync(FILE)) {
    console.error(`\n✗  Installer not found: ${FILE}`);
    console.error('   Run "node scripts/build-release.js" first.');
    process.exit(1);
  }
  const sizeMb = (fs.statSync(FILE).size / 1024 / 1024).toFixed(0);
  console.log(`\n━━━  TMT Native — upload v${VERSION}  ━━━\n`);
  console.log(`  File:    ${path.basename(FILE)}  (${sizeMb} MB)`);

  // Step 1 — login
  console.log('\n[1/3] Logging in…');
  const adminUser = process.env.DASHBOARD_USER;
  const adminPass = process.env.DASHBOARD_PASS;
  if (!adminUser || !adminPass) {
    console.error('✗  Set DASHBOARD_USER and DASHBOARD_PASS environment variables before uploading.');
    process.exit(1);
  }
  const loginRes = await jsonRequest('POST', '/api/auth/login', { username: adminUser, password: adminPass });
  if (loginRes.status !== 200) {
    console.error(`\n✗  Login failed (HTTP ${loginRes.status}): ${loginRes.body}`);
    process.exit(1);
  }
  const rawCookies = loginRes.headers['set-cookie'] || [];
  const cookie     = rawCookies.map(c => c.split(';')[0]).join('; ');
  if (!cookie) { console.error('\n✗  No session cookie received.'); process.exit(1); }
  console.log('     ✓  Session established');

  // Step 2 — upload
  console.log('\n[2/3] Uploading installer…');
  const uploadRes = await uploadMultipart('/api/app-builds', cookie, {
    platform: PLATFORM,
    version:  VERSION,
    notes:    `Auto-published — TMT Native v${VERSION}`,
  }, FILE);
  console.log(''); // newline after progress
  if (uploadRes.status !== 201) {
    console.error(`\n✗  Upload failed (HTTP ${uploadRes.status}): ${uploadRes.body}`);
    process.exit(1);
  }
  const build = JSON.parse(uploadRes.body).build;
  console.log(`     ✓  Build published — id=${build.id}  active=${build.isActive}`);

  // Step 3 — verify
  console.log('\n[3/3] Verifying public endpoint…');
  const verifyRes = await jsonRequest('GET', '/api/desktop/version?platform=windows');
  const live      = JSON.parse(verifyRes.body);
  console.log(`     ✓  /api/desktop/version returns: ${JSON.stringify(live)}`);

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`✓  v${VERSION} is live on ${HOST}`);
  console.log(`   Download page: https://${HOST}/download-app`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
})().catch(err => { console.error('\n✗  Unexpected error:', err.message); process.exit(1); });
