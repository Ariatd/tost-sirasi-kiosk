// contextIsolation açık: sayfaya yalnızca bu fonksiyonları güvenli şekilde
// açığa çıkarıyoruz (Node/ipcRenderer'ın tamamına erişim yok).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tostNative', {
  minimize: () => ipcRenderer.invoke('tost:minimize'),
  toggleFullscreen: () => ipcRenderer.invoke('tost:toggleFullscreen'),
  quit: () => ipcRenderer.invoke('tost:quit'),
  retryReaderScan: () => ipcRenderer.invoke('tost:retryReaderScan'),
  applyUpdate: (downloadUrl, version) => ipcRenderer.invoke('tost:applyUpdate', downloadUrl, version),
  getVersion: () => ipcRenderer.invoke('tost:getVersion'),
  getUpdateState: () => ipcRenderer.invoke('tost:getUpdateState'),
  devAdvance: () => ipcRenderer.invoke('tost:devAdvance'),
  devReset: () => ipcRenderer.invoke('tost:devReset'),
  onUpdateProgress: (cb) => {
    const listener = (_event, state) => cb(state);
    ipcRenderer.on('tost:updateProgress', listener);
    return () => ipcRenderer.removeListener('tost:updateProgress', listener);
  },
});

window.dispatchEvent(new Event('tostnativeready'));