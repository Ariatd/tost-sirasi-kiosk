// Tost Sırası — Electron ana süreç.
// React build'ini (dist/index.html) çerçevesiz tam ekran gösterir; pywebview
// sürümüyle aynı görsel sonuç (fullscreen + frameless). Backend'e (server.py,
// http://10.42.0.74:8080) doğrudan fetch/EventSource ile bağlanılır.
//
// NOT — webSecurity: false: renderer file:// kökeninden backend'in farklı
// (http://10.42.0.74:8080) köküne fetch/SSE atıyor. server.py'ye CORS başlığı
// EKLEMEDEN (backend'e dokunmama ilkesi) bunun tek pratik yolu budur. Uygulama
// yalnızca kendi paketlenmiş arayüzünü yükler, dışarıdan içerik/gezinme kabul
// etmez — kapalı bir kiosk için kabul edilebilir bir ödün.
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('path');

let win;
// build-resources/icon.png ile ayni dosyanin bir kopyasi (public/icon.png ->
// dist/icon.png); paketlenmis uygulamada calisma anindaki pencere ikonu
// icin build-resources'a degil, dist icindeki bu kopyaya bakiyoruz.
const ICON_PATH = path.join(__dirname, '..', 'dist', 'icon.png');
// nativeImage.createFromPath asar-paketli yoldan dogrudan okur; BrowserWindow'a
// ham dosya yolu yerine hazir NativeImage vermek + olusturduktan sonra
// win.setIcon() ile tekrar uygulamak, Linux'ta (X11/_NET_WM_ICON) bazi pencere
// yoneticilerinde constructor'daki icon: seceneginin tek basina islememesi
// bilinen bir Electron/Linux sorunu - iki yontemi birlikte kullanmak cozuyor.
const appIcon = nativeImage.createFromPath(ICON_PATH);
app.setName('Tost Sırası');

function createWindow() {
  win = new BrowserWindow({
    fullscreen: true,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#17110D',
    icon: appIcon, // pencere/görev çubuğu ikonu — launcher ikonuyla (electron-builder) aynı dosya
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });
  win.setIcon(appIcon); // bkz. yukarıdaki not
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  win.on('closed', () => {
    win = null;
  });
}

ipcMain.handle('tost:minimize', () => win?.minimize());
ipcMain.handle('tost:toggleFullscreen', () => win?.setFullScreen(!win.isFullScreen()));
ipcMain.handle('tost:quit', () => app.quit());

app.whenReady().then(createWindow);

app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
