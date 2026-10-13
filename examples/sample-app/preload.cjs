const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('notes', { list: () => ipcRenderer.invoke('notes:list') });
