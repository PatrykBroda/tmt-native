'use strict';
const WS    = require('ws');
const https = require('https');
const username = process.argv[2] || 'juicyxi';

function startWs(modelId) {
  console.log('\nConnecting WS with modelId=' + modelId);
  const ws = new WS('wss://chatws.stripchat.global/socket.io/?EIO=4&transport=websocket', {
    headers: { Origin: 'https://stripchat.com', 'User-Agent': 'Mozilla/5.0' },
  });

  ws.on('open', () => console.log('WS open'));
  ws.on('error', e => console.log('WS error:', e.message));
  ws.on('close', () => { console.log('WS closed'); process.exit(0); });

  ws.on('message', raw => {
    const msg = raw.toString();
    console.log('RECV:', msg.slice(0, 600));

    if (msg.startsWith('0')) {
      ws.send('40');
      console.log('SENT: 40');
      return;
    }
    if (msg === '2') { ws.send('3'); return; }

    if (msg.startsWith('40')) {
      const payload = modelId
        ? JSON.stringify(['join', { roomId: String(modelId), viewerUsername: '' }])
        : JSON.stringify(['join', { username: username.toLowerCase(), viewerUsername: '' }]);
      ws.send('42' + payload);
      console.log('SENT: join', payload);
      console.log('\nWaiting 20s for chat messages...');
      setTimeout(() => { ws.terminate(); }, 20000);
      return;
    }
  });
}

console.log('Fetching modelId for', username);
const req = https.get({
  hostname: 'stripchat.com',
  path:     '/api/front/v2/models/username/' + encodeURIComponent(username),
  headers:  { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
}, res => {
  let body = '';
  res.on('data', c => { body += c; });
  res.on('end', () => {
    console.log('HTTP', res.statusCode);
    try {
      const data   = JSON.parse(body);
      const modelId = data?.model?.id ?? null;
      console.log('modelId:', modelId, '  topKeys:', Object.keys(data).join(', '));
      startWs(modelId);
    } catch (e) {
      console.log('Parse error:', e.message, '\nBody:', body.slice(0, 300));
      startWs(null);
    }
  });
});
req.on('error', e => { console.log('HTTP error:', e.message); startWs(null); });
req.setTimeout(5000, () => { console.log('HTTP timeout'); req.destroy(); startWs(null); });
