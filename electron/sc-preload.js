'use strict';
const { ipcRenderer } = require('electron');

// Announce that the preload is running — visible in debug panel's SC_WS_LOG
ipcRenderer.send('sc:ws-frame', 'PRELOAD_READY url=' + location.href);

// Proxy WebSocket before any page script runs.
// Intercepts the authenticated connection Stripchat already creates.
const OrigWS = window.WebSocket;
window.WebSocket = new Proxy(OrigWS, {
  construct(Target, args) {
    const ws = Reflect.construct(Target, args);
    const url = typeof args[0] === 'string' ? args[0] : String(args[0]);
    // Log every WS creation so we can see the URL in debug panel
    ipcRenderer.send('sc:ws-frame', 'WS_NEW url=' + url.slice(0, 200));
    if (url.includes('chatws.stripchat')) {
      ws.addEventListener('message', e => {
        if (typeof e.data === 'string')
          ipcRenderer.send('sc:ws-frame', e.data.slice(0, 2000));
      });
    }
    return ws;
  },
});
