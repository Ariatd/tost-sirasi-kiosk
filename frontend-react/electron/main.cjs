// Tost Sırası — Electron ana süreç (CLIENT MODE).
//
// Bu makine artık backend'e bağlı değil — panel PC'nin KENDİSİ kart
// okuyucuyu (CH340, 9600 8N1) doğrudan burada, serialport ile okur,
// çerçeveyi ayrıştırır (bkz. serial-parser.cjs — backend/server.py'nin
// eski parse_frames()'iyle birebir) ve sonucu uzak backende
// (TOST_BACKEND_URL, ör. http://192.168.x.x:8080) POST /api/card-scan
// ile bildirir. Arayüzün geri kalanı (basamak/önizleme/bloke/kayıt)
// AYNI React build'i — sadece API adresi artık localhost değil.
//
// Okuyucu bulunamazsa (SerialPort.list() boşsa / CH340 yoksa) normal
// akışa hiç izin verilmez — tam ekran bir uyarı ekranı gösterilir.
//
// NOT — webSecurity: false: aynı önceki sürümdeki gerekçe: backend'e
// CORS başlığı eklemeden (dokunmama ilkesi) file:// kökünden farklı bir
// HTTP köküne fetch/SSE atmanın pratik yolu bu.
"use strict";

const { app, BrowserWindow, ipcMain, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const https = require("https");
const { exec } = require("child_process");
const { SerialPort } = require("serialport");
const { parseFrames, em4100Core } = require("./serial-parser.cjs");

// Tek instance kilidi: uygulama zaten calisirken ikondan/menuden tekrar
// acilmaya calisilirsa (ozellikle kucultulmusken) YENI bir pencere/surec
// ACILMASIN - ikinci surec hemen kendini kapatip mevcut pencereyi one
// getirsin. Bu, en basta (BrowserWindow'dan ONCE) alinmali.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
}

let win;
const ICON_PATH = path.join(__dirname, "..", "dist", "icon.png");
const appIcon = nativeImage.createFromPath(ICON_PATH);
// ONEMLI: burada Turkce/bosluklu bir isim ("Tost Sırası") KULLANMAYIN.
// Bu deger Electron'un Linux'ta ayarladigi X11 WM_CLASS'a karisir; .deb'in
// ürettigi masaustu girdisindeki StartupWMClass (asagida package.json'da
// "tost-kiosk-client" olarak ayarli) ile BIREBIR ayni olmali. Uyusmazsa
// GNOME calisan pencereyi kurulu .desktop girdisiyle eslestiremiyor ve
// ham X11 ozelliklerine (bozuk WM_NAME kodlamasi + bos _NET_WM_ICON) geri
// dusuyor - panelde gorulen "jenerik ikon + bozuk baslik" tam olarak bu.
app.setName("tost-kiosk-client");

// ---------------------------------------------------------------------
// Backend adresi — HARDCODED DEĞİL. Sırasıyla:
//   1) TOST_BACKEND_URL ortam değişkeni (systemd Environment= / elle export;
//      run.sh eski AppImage dağıtımından kalma, .deb ile artık KULLANILMIYOR)
//   2) ~/.config/tost-kiosk-client/config.env dosyası (TOST_BACKEND_URL=…)
//      — .deb kurulumundan menüden açılışta bu kullanılır. Dosya yoksa
//      İLK açılışta varsayılan değerle OLUŞTURULUR, böylece kurulumu
//      yapan kişi kendi ağına göre tek satırı değiştirebilir.
//   3) Varsayılan: bu kurulumu yapan geliştiricinin kendi ağı
//      (10.42.0.1) — BAŞKA BİR AĞDA ÇALIŞMAZ, config.env ile değiştirin.
// ---------------------------------------------------------------------
const DEFAULT_BACKEND_URL = "http://10.42.0.1:8080";
const CONFIG_DIR = path.join(os.homedir(), ".config", "tost-kiosk-client");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.env");

function resolveBackendUrl() {
  if (process.env.TOST_BACKEND_URL && process.env.TOST_BACKEND_URL.trim()) {
    return process.env.TOST_BACKEND_URL.trim();
  }
  try {
    const content = fs.readFileSync(CONFIG_FILE, "utf8");
    const m = content.match(/^\s*TOST_BACKEND_URL\s*=\s*(.+?)\s*$/m);
    if (m && m[1]) return m[1].trim();
  } catch (_) {
    // dosya yok -> ilk calistirma, varsayilanla olustur
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(
        CONFIG_FILE,
        "# Tost Sırası Client — backend adresi\n" +
          "# Bu değer SADECE kurulumu yapan kişinin kendi ağında (varsayılan:\n" +
          "# geliştiricinin ev ağı) çalışır. Kendi backend'inizi ayağa kaldırıp\n" +
          "# buraya kendi IP'nizi yazın, sonra uygulamayı yeniden başlatın.\n" +
          `TOST_BACKEND_URL=${DEFAULT_BACKEND_URL}\n`
      );
    } catch (e) {
      console.error("[client-mode] config.env olusturulamadi:", e.message);
    }
  }
  return DEFAULT_BACKEND_URL;
}

const BACKEND_URL = resolveBackendUrl().replace(/\/+$/, "");
const CH340_VENDOR_ID = "1a86"; // QinHeng Electronics

let serialPort = null;
let serialBuf = Buffer.alloc(0);
let lastCardId = null;
let lastCardTs = 0;
const CLIENT_DEBOUNCE_MS = 1500; // sunucu zaten debounce ediyor (2.5s); bu sadece ag trafigini azaltir

// ---------------------------------------------------------------------
// Backend'e bildirim
// ---------------------------------------------------------------------
function postCardScan(cardId, rawHex) {
  if (!BACKEND_URL) return;
  const data = JSON.stringify({ card_id: cardId, raw_hex: rawHex });
  let url;
  try {
    url = new URL(BACKEND_URL + "/api/card-scan");
  } catch (e) {
    console.error("[client-mode] gecersiz TOST_BACKEND_URL:", BACKEND_URL);
    return;
  }
  const req = http.request(
    {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      timeout: 5000,
    },
    (res) => {
      res.resume();
      if (res.statusCode >= 400) console.error("[client-mode] backend hata dondu:", res.statusCode);
    }
  );
  req.on("timeout", () => req.destroy(new Error("zaman asimi")));
  req.on("error", (e) => console.error("[client-mode] backend istegi basarisiz:", e.message));
  req.write(data);
  req.end();
}

// ---------------------------------------------------------------------
// Kart okuyucu (CH340) bul ve dinlemeye başla
// ---------------------------------------------------------------------
async function findReaderPort() {
  const ports = await SerialPort.list();
  return (
    ports.find((p) => (p.vendorId || "").toLowerCase() === CH340_VENDOR_ID) ||
    ports.find((p) => /ch340|qinheng/i.test(p.manufacturer || "")) ||
    null
  );
}

function closeReaderIfOpen() {
  if (serialPort) {
    try {
      if (serialPort.isOpen) serialPort.close();
    } catch (_) {
      /* yoksay */
    }
  }
  serialPort = null;
  serialBuf = Buffer.alloc(0);
}

function openReader(portInfo) {
  serialPort = new SerialPort({
    path: portInfo.path,
    baudRate: 9600,
    dataBits: 8,
    parity: "none",
    stopBits: 1,
  });
  serialBuf = Buffer.alloc(0);

  serialPort.on("data", (chunk) => {
    serialBuf = Buffer.concat([serialBuf, chunk]);
    const { frames, rest } = parseFrames(serialBuf);
    serialBuf = rest;
    for (const { payload, frame } of frames) {
      const cardId = payload.toString("hex").toUpperCase();
      const rawHex = frame.toString("hex").toUpperCase();
      const now = Date.now();
      if (cardId === lastCardId && now - lastCardTs < CLIENT_DEBOUNCE_MS) {
        lastCardTs = now;
        continue;
      }
      lastCardId = cardId;
      lastCardTs = now;
      console.log("[client-mode] kart okundu:", cardId, "em4100", em4100Core(payload));
      postCardScan(cardId, rawHex);
    }
  });
  serialPort.on("error", (e) => console.error("[client-mode] seri port hatasi:", e.message));
  serialPort.on("close", () => console.warn("[client-mode] seri port kapandi"));
  console.log(
    "[client-mode] okuyucu acildi:",
    portInfo.path,
    portInfo.vendorId || "",
    portInfo.manufacturer || ""
  );
}

// ---------------------------------------------------------------------
// Ekranlar
// ---------------------------------------------------------------------
function loadNoReaderScreen(query) {
  win.loadFile(path.join(__dirname, "no-reader.html"), { search: query || "" });
}

function loadKioskApp() {
  win.loadFile(path.join(__dirname, "..", "dist", "index.html"), {
    search: "api=" + encodeURIComponent(BACKEND_URL),
  });
}

async function tryStartReaderThenApp() {
  const portInfo = await findReaderPort();
  if (!portInfo) return false;
  closeReaderIfOpen();
  openReader(portInfo);
  loadKioskApp();
  return true;
}

function createWindow() {
  win = new BrowserWindow({
    // ASCII baslik: Electron'un Linux/X11'de kullandigi eski WM_NAME
    // (STRING, Latin-1) ozelligi Turkce karakterleri ("ı" vb.) yanlis
    // kodluyor (panelde "Tost SÄ±rasÄ±" gibi gorunuyordu). index.html/
    // no-reader.html'in <title> etiketleri sayfa yuklenince bu degeri
    // ezdigi icin page-title-updated'i asagida engelliyoruz.
    title: "Tost Sirasi - Client",
    fullscreen: true,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: "#17110D",
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });
  win.on("page-title-updated", (event) => {
    event.preventDefault();
  });
  win.setIcon(appIcon);
  win.setMenuBarVisibility(false);
  win.on("closed", () => {
    win = null;
    closeReaderIfOpen();
  });
}

async function boot() {
  console.log("[client-mode] backend adresi:", BACKEND_URL, " (config:", CONFIG_FILE, ")");

  if (!BACKEND_URL) {
    createWindow();
    loadNoReaderScreen(
      "icon=" + encodeURIComponent("⚠️") +
      "&hideRetry=1" +
      "&title=" + encodeURIComponent("Backend adresi ayarlanmamış") +
      "&detail=" + encodeURIComponent(
        "TOST_BACKEND_URL ortam değişkeni ayarlanmadan Client Mode başlatılamaz. " +
        "~/.config/tost-kiosk-client/config.env dosyasındaki TOST_BACKEND_URL değerini kontrol edin."
      )
    );
    return;
  }

  createWindow();
  const started = await tryStartReaderThenApp();
  if (!started) loadNoReaderScreen("");
}

// ---------------------------------------------------------------------
// IPC (preload.cjs -> window.tostNative)
// ---------------------------------------------------------------------
ipcMain.handle("tost:minimize", () => win?.minimize());
ipcMain.handle("tost:toggleFullscreen", () => win?.setFullScreen(!win.isFullScreen()));
ipcMain.handle("tost:quit", () => app.quit());
ipcMain.handle("tost:retryReaderScan", () => tryStartReaderThenApp());
ipcMain.handle("tost:getVersion", () => app.getVersion());

// ---------------------------------------------------------------------
// OTA Güncelleme — gerçek bayt bazlı indirme ilerlemesi + kalıcı durum.
//
// updateState ana süreçte (React bileşenlerinin yaşam döngüsünden BAĞIMSIZ)
// tutuluyor: kullanıcı Ayarlar ekranından çıkıp başka bir ekrana geçse bile
// indirme arka planda devam ediyor; ekrana geri dönünce getUpdateState()
// ile kaldığı yerden (yüzde dahil) senkronize oluyor.
// ---------------------------------------------------------------------
let updateState = {
  phase: "idle", // idle | downloading | installing | done | error
  progress: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  error: null,
  version: null,
};

function setUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  win?.webContents.send("tost:updateProgress", updateState);
}

function downloadWithProgress(url, destPath, onProgress, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "tost-kiosk-client" } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          if (redirectsLeft <= 0 || !res.headers.location) {
            reject(new Error("Çok fazla yönlendirme"));
            return;
          }
          downloadWithProgress(res.headers.location, destPath, onProgress, redirectsLeft - 1).then(
            resolve,
            reject
          );
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`İndirme başarısız: HTTP ${res.statusCode}`));
          return;
        }
        const total = parseInt(res.headers["content-length"] || "0", 10);
        let downloaded = 0;
        const fileStream = fs.createWriteStream(destPath);
        res.on("data", (chunk) => {
          downloaded += chunk.length;
          onProgress(downloaded, total);
        });
        res.pipe(fileStream);
        fileStream.on("finish", () => fileStream.close(() => resolve()));
        fileStream.on("error", reject);
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

ipcMain.handle("tost:getUpdateState", () => updateState);

// GitHub'dan gelen downloadUrl'i indirir (ilerleme yayınlayarak), sonra
// kiosk-update.sh'a YEREL dosya yolunu vererek kurdurur (betik artık
// kendisi indirmiyor — main.cjs'in indirdiği dosyayı kuruyor).
ipcMain.handle("tost:applyUpdate", (event, downloadUrl, version) => {
  if (updateState.phase === "downloading" || updateState.phase === "installing") {
    return { ok: true, alreadyInProgress: true };
  }
  if (!downloadUrl) {
    return { ok: false, error: "İndirme bağlantısı (URL) eksik." };
  }

  const destPath = path.join(os.tmpdir(), "tost-kiosk-update.deb");
  setUpdateState({
    phase: "downloading",
    progress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    error: null,
    version: version || null,
  });

  (async () => {
    try {
      console.log("[OTA] İndiriliyor:", downloadUrl);
      await downloadWithProgress(downloadUrl, destPath, (downloaded, total) => {
        const progress = total > 0 ? Math.min(99, Math.round((downloaded / total) * 100)) : 0;
        setUpdateState({ progress, downloadedBytes: downloaded, totalBytes: total });
      });
      console.log("[OTA] İndirme tamam, kuruluyor:", destPath);
      setUpdateState({ phase: "installing", progress: 100 });
      await new Promise((resolve, reject) => {
        exec(`sudo /usr/local/bin/kiosk-update.sh "${destPath}"`, (error, stdout, stderr) => {
          if (error) reject(new Error(stderr || error.message));
          else resolve(stdout);
        });
      });
      console.log("[OTA] Kurulum tamam.");
      setUpdateState({ phase: "done", progress: 100 });
    } catch (e) {
      console.error("[OTA] Hata:", e.message);
      setUpdateState({ phase: "error", error: e.message });
    } finally {
      fs.unlink(destPath, () => {});
    }
  })();

  return { ok: true, started: true };
});

app.whenReady().then(boot);
app.on("window-all-closed", () => app.quit());
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) boot();
});