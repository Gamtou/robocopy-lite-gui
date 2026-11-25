'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('backup', {
  snapshot: () => ipcRenderer.invoke('snapshot'),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  configure: (id, form) => ipcRenderer.invoke('configure', id, form),
  start: id => ipcRenderer.invoke('start', id),
  pause: id => ipcRenderer.invoke('pause', id),
  cancelExternal: id => ipcRenderer.invoke('cancel-external', id),
  adoptExternal: (id, form) => ipcRenderer.invoke('adopt-external', id, form),
  remove: id => ipcRenderer.invoke('remove', id),
  preview: id => ipcRenderer.invoke('preview', id),
  resolveConflict: (id, key, keep) => ipcRenderer.invoke('resolve-conflict', id, key, keep),
  settings: value => ipcRenderer.invoke('settings', value),
  log: (id, runId) => ipcRenderer.invoke('log', id, runId),
  logsSnapshot: () => ipcRenderer.invoke('logs-snapshot'),
  diagnosticLog: id => ipcRenderer.invoke('diagnostic-log', id),
  diagnosticReport: id => ipcRenderer.invoke('diagnostic-report', id),
  openLogsFolder: () => ipcRenderer.invoke('open-logs-folder'),
});
