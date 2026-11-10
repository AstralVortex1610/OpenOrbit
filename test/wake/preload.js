const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('orbit', { getWakeModel: () => ipcRenderer.invoke('wake:model') });
