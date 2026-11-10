const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('orbit', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  voice: { base: () => ipcRenderer.invoke('voice:base') },
  on: () => {},
});
contextBridge.exposeInMainWorld('done', (r) => ipcRenderer.send('result', r));
