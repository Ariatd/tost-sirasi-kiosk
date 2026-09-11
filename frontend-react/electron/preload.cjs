// contextIsolation açık: sayfaya yalnızca bu üç fonksiyonu güvenli şekilde
// açığa çıkarıyoruz (Node/ipcRenderer'ın tamamına erişim yok).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tostNative', {
  minimize: () => ipcRenderer.invoke('tost:minimize'),
  toggleFullscreen: () => ipcRenderer.invoke('tost:toggleFullscreen'),
  quit: () => ipcRenderer.invoke('tost:quit'),
});

window.dispatchEvent(new Event('tostnativeready'));
