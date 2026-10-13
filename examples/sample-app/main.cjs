const { app, ipcMain, BrowserWindow } = require('electron');
const { loadNotes } = require('./notes.cjs');
app.whenReady().then(() => {
  const window = new BrowserWindow({ webPreferences: { preload: './preload.cjs', contextIsolation: true } });
  window.loadFile('index.html');
});
ipcMain.handle('notes:list', () => loadNotes());
