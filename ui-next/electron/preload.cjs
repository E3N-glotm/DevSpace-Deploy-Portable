'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name, ...args) => ipcRenderer.invoke('ds:' + name, ...args);
function listen(channel, handler) {
  if (typeof handler !== 'function') throw new TypeError('callback required');
  const listener = (_event, value) => handler(value);
  ipcRenderer.on('ds:' + channel, listener);
  return () => ipcRenderer.removeListener('ds:' + channel, listener);
}
contextBridge.exposeInMainWorld('devspace', Object.freeze({
  initialize: () => invoke('initialize'),
  getConfig: () => invoke('getConfig'),
  getStatus: () => invoke('getStatus'),
  save: settings => invoke('save', settings),
  deploy: provider => invoke('deploy', provider),
  copySecret: kind => invoke('copySecret', kind),
  copyValue: value => invoke('copyValue', value),
  pickPlugin: () => invoke('pickPlugin'),
  pickExport: name => invoke('pickExport', name),
  admin: (action,payload,confirmed=false) => invoke('admin', action, payload, confirmed),
  copyUrl: kind => invoke('copyUrl', kind),
  chooseFolder: () => invoke('chooseFolder'),
  runAction: action => invoke('runAction', action),
  onStatus: handler => listen('status', handler),
  onProgress: handler => listen('progress', handler),
  onCloseRequest: handler => listen('requestCloseChoice', handler),
  chooseClose: (choice, remember=false) => invoke('chooseClose', choice, remember),
  getClosePreference: () => invoke('getClosePreference'),
  setClosePreference: choice => invoke('setClosePreference', choice),
  resetClosePreference: () => invoke('resetClosePreference'),
}));
