'use strict';
// Fake toy servers for testing without hardware:
//   • Buttplug v3 websocket server (what Intiface Central exposes) with one fake "Lovense Lush 3"
//   • Lovense Remote Game Mode HTTP API (POST /command) with one fake "Lush"
// Every received command is appended (with timestamp) to the log file as JSON lines.
//
//   node scripts/fake-intiface.js [--ws 12345] [--lovense 20010] [--log fake-toy.log]
// or require('./fake-intiface').start({ wsPort, lovensePort, logFile }) from a test.
const http = require('http');
const fs   = require('fs');
const { WebSocketServer } = require('ws');

function start({ wsPort = 12345, lovensePort = 20010, logFile = null, quiet = false } = {}) {
  const entries = [];
  const log = (src, cmd, data) => {
    const e = { t: Date.now(), src, cmd, ...data };
    entries.push(e);
    const line = JSON.stringify(e);
    if (!quiet) console.log(new Date(e.t).toISOString().slice(11, 23), src, cmd, JSON.stringify(data));
    if (logFile) try { fs.appendFileSync(logFile, line + '\n'); } catch {}
  };

  const DEVICE = {
    DeviceName: 'Lovense Lush 3', DeviceIndex: 0, DeviceMessageTimingGap: 100,
    DeviceMessages: {
      ScalarCmd: [{ StepCount: 20, FeatureDescriptor: 'Vibrate', ActuatorType: 'Vibrate' }],
      StopDeviceCmd: {},
    },
  };

  // ── Buttplug v3 ──
  const wss = new WebSocketServer({ port: wsPort });
  wss.on('connection', ws => {
    log('intiface', 'client-connected', {});
    const reply = (key, Id, body = {}) => ws.send(JSON.stringify([{ [key]: { Id, ...body } }]));
    ws.on('message', raw => {
      let msgs; try { msgs = JSON.parse(raw.toString()); } catch { return; }
      for (const m of msgs) {
        const key = Object.keys(m)[0], v = m[key], Id = v.Id;
        switch (key) {
          case 'RequestServerInfo':
            log('intiface', key, { client: v.ClientName, version: v.MessageVersion });
            reply('ServerInfo', Id, { ServerName: 'fake-intiface', MessageVersion: 3, MaxPingTime: 0 });
            break;
          case 'RequestDeviceList':
            log('intiface', key, {});
            reply('DeviceList', Id, { Devices: [] });
            break;
          case 'StartScanning':
            log('intiface', key, {});
            reply('Ok', Id);
            setTimeout(() => { try { ws.send(JSON.stringify([{ DeviceAdded: { Id: 0, ...DEVICE } }])); } catch {} }, 250);
            break;
          case 'ScalarCmd':
            log('intiface', key, { device: v.DeviceIndex, scalars: v.Scalars });
            reply('Ok', Id); break;
          case 'VibrateCmd':
            log('intiface', key, { device: v.DeviceIndex, speeds: v.Speeds });
            reply('Ok', Id); break;
          case 'StopDeviceCmd':
          case 'StopAllDevices':
            log('intiface', key, { device: v.DeviceIndex });
            reply('Ok', Id); break;
          case 'Ping': reply('Ok', Id); break;
          default:
            log('intiface', key + '(unhandled)', {});
            reply('Error', Id, { ErrorCode: 3, ErrorMessage: 'unsupported in fake server' });
        }
      }
    });
    ws.on('close', () => log('intiface', 'client-disconnected', {}));
  });

  // ── Lovense Remote Game Mode ──
  const srv = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/command') { res.writeHead(404); return res.end(); }
    let buf = ''; req.on('data', c => buf += c);
    req.on('end', () => {
      let b = {}; try { b = JSON.parse(buf); } catch {}
      res.setHeader('Content-Type', 'application/json');
      if (b.command === 'GetToys') {
        log('lovense', 'GetToys', {});
        return res.end(JSON.stringify({ code: 200, type: 'OK', data: { toys: { d1: {
          id: 'd1', name: 'lush', nickName: 'Lush 3', status: '1', battery: 80, version: '', shortFunctionNames: ['v'], fullFunctionNames: ['Vibrate'] } } } }));
      }
      log('lovense', b.command || '?', { action: b.action, timeSec: b.timeSec, toy: b.toy, apiVer: b.apiVer, stopPrevious: b.stopPrevious });
      res.end(JSON.stringify({ code: 200, type: 'ok' }));
    });
  });
  srv.listen(lovensePort, '127.0.0.1');

  return {
    entries,
    close: () => new Promise(r => { for (const c of wss.clients) c.terminate(); wss.close(); srv.close(() => r()); }),
  };
}

module.exports = { start };

if (require.main === module) {
  const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
  const wsPort = Number(arg('ws', 12345)), lovensePort = Number(arg('lovense', 20010));
  start({ wsPort, lovensePort, logFile: arg('log', null) });
  console.log(`fake Intiface ws://127.0.0.1:${wsPort}  |  fake Lovense http://127.0.0.1:${lovensePort}/command`);
}
