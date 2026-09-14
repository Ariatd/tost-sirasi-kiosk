// contextIsolation açık: sayfaya yalnızca bu fonksiyonları güvenli şekilde
// açığa çıkarıyoruz (Node/ipcRenderer'ın tamamına erişim yok).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tostNative', {
  minimize: () => ipcRenderer.invoke('tost:minimize'),
  toggleFullscreen: () => ipcRenderer.invoke('tost:toggleFullscreen'),
  quit: () => ipcRenderer.invoke('tost:quit'),
  // no-reader.html "Tekrar Dene" butonu: okuyucuyu yeniden tara, bulunursa
  // main process gercek uygulamayi kendisi yukler (true doner).
  retryReaderScan: () => ipcRenderer.invoke('tost:retryReaderScan'),
});

window.dispatchEvent(new Event('tostnativeready'));
