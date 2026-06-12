'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  login:              (username, password) => ipcRenderer.invoke('desktop:login',              { username, password }),
  getToken:           ()                   => ipcRenderer.invoke('desktop:get-token'),
  logout:             ()                   => ipcRenderer.invoke('desktop:logout'),
  startStream:        ()                   => ipcRenderer.invoke('desktop:start-stream'),
  stopStream:         ()                   => ipcRenderer.invoke('desktop:stop-stream'),
  getDestinations:    ()                   => ipcRenderer.invoke('desktop:get-destinations'),
  addDestination:     (d)                  => ipcRenderer.invoke('desktop:add-destination',    d),
  removeDestination:  (id)                 => ipcRenderer.invoke('desktop:remove-destination', { id }),

  getDebugInfo:    ()           => ipcRenderer.invoke('desktop:get-debug-info'),
  getChatStatus:   ()           => ipcRenderer.invoke('desktop:get-chat-status'),
  setEventsToken:  (id, token) => ipcRenderer.invoke('desktop:set-events-token', { id, token }),
  toggleMute:          ()           => ipcRenderer.invoke('desktop:toggle-mute'),
  goLive:              ()           => ipcRenderer.invoke('desktop:go-live'),
  goOffline:           ()           => ipcRenderer.invoke('desktop:go-offline'),
  toggleBroadcastView: ()           => ipcRenderer.invoke('desktop:toggle-broadcast-view'),
  toggleDestination:   (id)         => ipcRenderer.invoke('desktop:toggle-destination',    { id }),
  openExternal:        (url)        => ipcRenderer.invoke('desktop:open-external',          { url }),
  checkForUpdates:     ()           => ipcRenderer.invoke('desktop:check-for-updates'),
  getAppVersion:       ()           => ipcRenderer.invoke('desktop:get-app-version'),

  onStatusUpdate: (cb) => ipcRenderer.on('desktop:status-update',  (_e, data) => cb(data)),
  onObsStatus:    (cb) => ipcRenderer.on('desktop:obs-status',      (_e, data) => cb(data)),
  onStreamError:  (cb) => ipcRenderer.on('desktop:stream-error',    (_e, msg)  => cb(msg)),
  onChatMessage:  (cb) => ipcRenderer.on('desktop:chat-message',    (_e, msg)  => cb(msg)),
  onViewerCount:  (cb) => ipcRenderer.on('desktop:viewer-count',    (_e, n)    => cb(n)),
  onMuteState:    (cb) => ipcRenderer.on('desktop:mute-state',      (_e, d)    => cb(d)),
  onAuthError:    (cb) => ipcRenderer.on('desktop:auth-error',      (_e, d)    => cb(d)),
  onChatStatus:   (cb) => ipcRenderer.on('desktop:chat-status',     (_e, d)    => cb(d)),
});
