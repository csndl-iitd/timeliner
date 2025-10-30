const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  startOAuth: () => ipcRenderer.invoke('start-oauth'),
  pollToken: (data) => ipcRenderer.invoke('poll-token', data),
  submitPAT: (pat) => ipcRenderer.invoke('submit-pat', pat),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  saveToken: (token) => ipcRenderer.invoke('save-token', token),
  onAuthSuccess: (callback) => ipcRenderer.on('auth-success', (_e, token) => callback(token)),
  logout: () => ipcRenderer.invoke('logout'),
});
