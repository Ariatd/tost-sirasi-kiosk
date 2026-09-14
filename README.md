# Tost Sırası Kiosk

RFID/NFC kartla çalışan bir tost sırası yönetim sistemi: müşteri kartını okutur,
tostunun ne zaman hazır olacağını seçer; panel ekranı sırayı gösterir; bir de
biletleri/kayıtları yönetebileceğiniz ayrı bir masaüstü aracı vardır.

Panel donanımı: temassız kart okuyucu (CH340 USB-seri, 125 kHz EM4100) takılı
bir Ubuntu 24.04 mini PC (panelpc). **Mimari iki makineye bölünmüş
durumda:** sipariş mantığı + veritabanı geliştiricinin kendi bilgisayarında
çalışır, panel PC yalnızca "Client Mode" (kart okuyucu + uzak backend
istemcisi) çalıştırır. Bu depo her iki tarafın da kaynak kodunu bir arada
tutar; panele dağıtım artık GitHub Release üzerinden yayınlanan bir `.deb`
paketiyle yapılır.

## Mimari

```
              (geliştiricinin kendi bilgisayarı)             (panel PC — panelpc)
        ┌───────────────────────────────────┐        ┌─────────────────────────────┐
        │ backend/server.py                 │        │ Client Mode (Electron)      │
        │ Python stdlib: http.server        │◀──────▶│ .deb ile kurulu             │
        │ + SQLite + Server-Sent Events     │  HTTP  │ (tost-kiosk-client)         │
        │ systemd --user servisi:           │  + SSE │ systemd --user servisi:     │
        │ tost-kiosk-backend.service        │  (LAN) │ tost-kiosk-electron.service │
        │ 0.0.0.0:8080                      │        │                             │
        └───────────────┬───────────────────┘        │  ┌───────────────────────┐  │
                         │                            │  │ CH340 seri okuyucu    │  │
                         │ admin API (X-Admin-Token)  │  │ (125 kHz EM4100)      │  │
                         │                            │  └───────────┬───────────┘  │
                ┌────────▼────────┐                   │   POST /api/card-scan ─────┼──▶ (yukarıya)
                │ admin-tool       │                   └─────────────────────────────┘
                │ tost-admin.py    │
                │ (Tkinter, kendi  │
                │  bilgisayarınızdan) │
                └──────────────────┘
```

Panelde tek bir systemd `--user` servisi vardır:

- `tost-kiosk-electron.service` — Client Mode (Electron): CH340 okuyucuyu
  yerelde okur, `POST /api/card-scan` ile yukarıdaki backend'e bildirir,
  aynı React arayüzünü gösterir. `.deb` paketinin kurduğu
  `/usr/bin/tost-kiosk-client` ikilisini çalıştırır (bkz.
  [Client Mode masaüstü paketi](#client-mode-masaüstü-paketi-deb)).

Eski, tek-makinede-tam-yerel mimarinin kalıntıları (`backend/static` —
vanilla JS + pywebview, ve panelde kendi backend'ini çalıştıran eski
`tost-kiosk.service`/`tost-kiosk-app.service`) artık **kullanılmıyor**;
`backend/static` depoda arşiv olarak duruyor, paneldeki eski servisler
kaldırıldı.

## Depo yapısı

```
backend/          backend kaynağı — artık PANELDE DEĞİL, geliştiricinin
                   kendi bilgisayarında systemd --user servisi olarak çalışır
                   (server.py, static/ [arşiv], deploy/)
frontend-react/   Client Mode kaynağı: React + Electron (serialport),
                   Vite + electron-builder ile AppImage/.deb paketleme
admin-tool/       tost-admin.py — Tkinter yönetim uygulaması (kendi bilgisayarınızda)
docs/             ekran görüntüleri / notlar (opsiyonel)
```

## Neden bu kararlar

- **SQLite, NoSQL değil.** Veri küçük ve tamamen ilişkisel (biletler, kullanıcılar,
  ham kart okumaları) — ayrı bir veritabanı sunucusu kurmanın hiçbir faydası yok.
- **Python stdlib, Flask değil.** Başlangıçta panel PC'nin paket erişimi
  kısıtlıydı (pip bile yoktu); backend artık geliştiricinin kendi
  bilgisayarında çalışsa da aynı sıfır-bağımlılık yaklaşımı korundu —
  `http.server.ThreadingHTTPServer` + `sqlite3` + Server-Sent Events.
- **Backend geliştirici makinesinde, panelde yalnızca Client Mode.**
  Panelin kendi backend/DB'sini çalıştırmasına gerek yok; sipariş mantığı
  tek bir yerde (kendi bilgisayarınızda) çalışır, panel sadece kart okuyup
  HTTP ile bildirir. Bu, panelin donanım arızası/format gibi durumlarda
  veri kaybı riskini de ortadan kaldırır — biletler/kullanıcılar hiçbir
  zaman panelde tutulmaz.
- **Electron + React, panelde Node hiç yokken bile.** Panelde `node`/`npm`
  kurulamıyor (bağımlılık çakışmaları, kısıtlı erişim). Çözüm: React'i ve
  Electron paketini **bu depodan, kendi bilgisayarınızda, Docker içinde**
  (pinlenmiş Node 20 imajı) derleyip; panele yalnızca **derlenmiş,
  bağımsız çalışan `.deb`** paketini göndermek. Panelde Node'a hiç
  ihtiyaç yok.
- **Dağıtım GitHub Release üzerinden.** `.deb` dosyası panele elle
  (scp/rsync) taşınmak yerine bir GitHub Release'e asset olarak
  yükleniyor; panel (ya da başka herhangi bir Ubuntu 24.04 cihazı) tek
  başına `wget` + `apt install` ile indirip kurabiliyor — geliştiricinin
  dosya yoluna/makinesine bağımlı kalmadan.

## İş mantığı özeti

- Zaman **5 dakikalık basamaklara** bölünür. Boş basamaklar sabit etiket gösterir
  ("40 dk" gibi), gerçek zaman geçtikçe erimez.
- Dolu bir basamak, o biletin **gerçek kalan süresini** canlı gösterir.
- Dolu basamağın **bir öncesi**, aynı biletin hedef saatinden 5 dk çıkarılarak
  hesaplanan değeri canlı gösterir — ikisi birebir **senkron** iner (bkz.
  `frontend-react/src/logic.js` → `computeMaps` / `describePosition`, testli).
- Önizlemenin canlı değeri **5 dk'nın altına düşerse** basamak "Çok yakın"
  etiketiyle **bloke** olur — artık seçilemez; gerçek bir bilet asla 5 dk'dan az
  süreyle oluşturulamaz (hem arayüzde hem backend'de doğrulanır).
- "En yakın uygun saat" önerisi dolu ve bloke basamakları atlar.
- **Kart başına tek aktif bilet.** Aynı kart, elindeki tostu teslim almadan
  ikinci sipariş veremez — hem `App.jsx`/`app.js` hem `server.py` bunu kontrol eder.
- **Kayıt zorunlu.** Kayıtsız bir kartla "Sipariş Ver"e girilirse "Bu kart kayıtlı
  değil" ekranı çıkar.
- **Bilet kodu = kartın EM4100 kimliğinin ondalık son 2 hanesi.** Aktif bir
  bilette çakışma olursa sunucu kodu 3-4 haneye çıkarır (`server.py` →
  `make_code`). **Bilinen risk:** 2 haneli kodlar aynı anda çok sayıda aktif
  bilet olduğunda (≈%1 ihtimalle her yeni biletde) çakışabilir; çakışma anında
  otomatik uzatma bunu pratikte zararsız kılar, ama kalıcı çözüm istenirse
  varsayılanı 3 haneye çekirmek tek satırlık bir değişikliktir.

## Kurulum / çalıştırma

### Backend (artık PANELDE DEĞİL — geliştiricinin kendi bilgisayarında)

Mimari değişti: panel PC'de artık backend/DB yok, yalnızca "Client Mode"
(kart okuyucu + uzak backend istemcisi) çalışıyor. Backend, SQLite ve
kart-okuma iş mantığı geliştiricinin kendi makinesinde, `0.0.0.0:8080`
üzerinde dinliyor ki panel LAN'dan erişebilsin.

```bash
# kendi bilgisayarınızda:
python3 backend/server.py                       # elle test
systemctl --user status tost-kiosk-backend.service   # kalıcı servis (kurulum aşağıda)
```

Kalıcı servis kurmak için:

```bash
mkdir -p ~/.config/systemd/user
cp backend/deploy/tost-kiosk-backend.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now tost-kiosk-backend.service
```

Gereksinim: yalnızca Python 3.12 stdlib (pyserial bile gerekmiyor artık —
seri port okuma panelin Electron istemcisine taşındı). Ortam değişkenleri:
`KIOSK_HOST` (varsayılan `0.0.0.0`), `KIOSK_PORT`, `KIOSK_DB`,
`KIOSK_ADMIN_TOKEN` (bkz. `server.py` başı).

Panelde eski (tek-makine mimarisinden kalma) `tost-kiosk.service` tamamen
kaldırıldı; `tost-kiosk-app.service` (en eski, pywebview tabanlı sürüm)
dosyaları duruyor ama devre dışı. Panelde artık yalnızca
`tost-kiosk-electron.service` (Client Mode) çalışıyor.

### Frontend (React) — geliştirme

```bash
cd frontend-react
npm install     # ya da: docker run --rm -v $PWD:/app -w /app node:20-bookworm-slim npm install
npm run dev     # Vite dev sunucusu — backend'e VITE_API_BASE ile işaret edin
```

`src/api.js`'teki `API_BASE`, `VITE_API_BASE` build-zamanı değişkeniyle ya da
çalışma zamanında `?api=http://...` sorgu paramla değiştirilebilir; hiçbiri
yoksa `http://localhost:8080`'a düşer (tarayıcıda yerel geliştirme). Paketlenmiş
Electron uygulamasında bu adres `electron/main.cjs`'in çözdüğü
`TOST_BACKEND_URL`'den geliyor — bkz. aşağıdaki "Client Mode masaüstü paketi".

Electron/AppImage/`.deb` derleme ve panele kurulum için aşağıdaki
[Client Mode masaüstü paketi (.deb)](#client-mode-masaüstü-paketi-deb)
bölümüne bakın — Node kurmadan, Docker ile derlenir.

### Client Mode masaüstü paketi (.deb)

AppImage'ın yanına, standart Ubuntu/Debian kurulumu için `.deb` hedefi de
eklendi — kurulunca uygulama menüsüne kendiliğinden (elle `.desktop` dosyası
yazmadan) girer, kendi ikonuyla görünür.

#### Hazır paketi indirip kurmak (herhangi bir Ubuntu 24.04, x64 cihaz)

Kendi bilgisayarınızda derlemenize gerek yok — GitHub Release'den doğrudan
indirip kurabilirsiniz (panel PC dahil, SCP/dosya yoluna bağımlı kalmadan):

```bash
wget https://github.com/Ariatd/tost-sirasi-kiosk/releases/download/v2.0.4/tost-kiosk-client_2.0.4_amd64.deb
sudo apt install --reinstall ./tost-kiosk-client_2.0.4_amd64.deb
```

Kurulunca uygulama menüsünde **"Tost Sırası - Client"** olarak görünür;
masaüstüne kısayol istenirse menüdeki simge normal Ubuntu davranışıyla
sürüklenip bırakılabilir — ekstra script gerekmez. Diğer sürümler için
[Releases](https://github.com/Ariatd/tost-sirasi-kiosk/releases) sayfasına
bakın.

**⚠️ Varsayılan backend adresi ağınıza özeldir.** Paket
`TOST_BACKEND_URL=http://10.42.0.1:8080` varsayılanıyla gelir — bu yalnızca
bu depoyu hazırlayan geliştiricinin **kendi ev ağında** çalışır. Uygulama ilk
açılışta `~/.config/tost-kiosk-client/config.env` dosyasını (yoksa) bu
varsayılanla oluşturur; **kendi backend'inizi ayakta tutup** bu dosyadaki
`TOST_BACKEND_URL` satırını kendi IP'nize göre değiştirip uygulamayı yeniden
başlatmanız gerekir. Ortam değişkeni (`TOST_BACKEND_URL=... `, örn. bir
systemd `Environment=` satırı) varsa config.env'den önce o kullanılır.

Panelde zaten `tost-kiosk-electron.service` (bkz. aşağı) systemd `--user`
servisi olarak çalışıyorsa, `apt install --reinstall` sonrası yeni sürümü
devreye almak için:

```bash
systemctl --user restart tost-kiosk-electron.service
```

#### Panelde kalıcı/otomatik açılış (systemd)

Panel bir kiosk olduğu için oturum açılır açılmaz tam ekran başlamalı ve
kapatılırsa kendini toparlamalı. Bunun için `.deb`'in kurduğu ikiliyi bir
systemd `--user` servisiyle sarmalıyoruz:

```bash
mkdir -p ~/.config/systemd/user
cp frontend-react/deploy/tost-kiosk-electron.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now tost-kiosk-electron.service
```

Servis dosyası `/usr/bin/tost-kiosk-client`'ı (update-alternatives ile
`.deb`'in kurduğu gerçek ikiliye bağlı) `--disable-gpu
--disable-software-rasterizer` ile çalıştırır ve `NO_AT_BRIDGE=1` ortam
değişkenini ayarlar — panelde tespit edilen iki kararlılık sorununu
giderir (bkz. [Bilinen kısıtlar](#bilinen-kısıtlar)).

#### Kendi paketinizi derlemek

```bash
cd frontend-react
docker run --rm -v $PWD:/app -w /app node:20-bookworm-slim npm run build
docker run --rm -v $PWD:/app -w /app \
  -v ~/.docker-cache/electron:/root/.cache/electron \
  -v ~/.docker-cache/electron-builder:/root/.cache/electron-builder \
  node:20-bookworm-slim bash -c '
    apt-get update -qq && apt-get install -y -qq ca-certificates binutils fakeroot >/dev/null
    update-ca-certificates >/dev/null
    npx electron-builder --linux AppImage deb --x64'
```

`binutils`/`fakeroot` yalnızca `.deb` hedefi için gerekli (fpm aracı `ar`
komutunu kullanıyor). Çıktı `frontend-react/release/tost-kiosk-client_<sürüm>_amd64.deb`.
Kurulum aynı: `sudo apt install ./release/tost-kiosk-client_<sürüm>_amd64.deb`.

Bir GitHub Release olarak yayınlamak için:

```bash
gh release create v<sürüm> "frontend-react/release/tost-kiosk-client_<sürüm>_amd64.deb" \
  --title "Client Mode v<sürüm> (.deb)" --notes "..."
```

### Testler

```bash
cd frontend-react
npm test        # ya da Docker ile: docker run --rm -v $PWD:/app -w /app node:20-bookworm-slim npm test
```

`src/logic.test.js` (Vitest) — basamak/önizleme/senkron-azalma/bloke/en-yakın-
uygun-saat hesaplamalarını kapsar: boş kuyrukta en yakın slot her zaman 5 dk,
dolu+önizleme basamaklarının senkron azalması, basamağın zaman geçince kayması,
5 dk altına düşen önizlemenin bloke olması ve "en yakın uygun saat" önerisinin
bloke/dolu basamakları atlaması.

### Admin aracı (kendi bilgisayarınızda)

```bash
sudo apt install python3-tk    # yalnızca ilk sefer (bazı Ubuntu kurulumlarında
                                # ayrı paket; apt kırık görünüyorsa .deb'leri
                                # elle indirip `dpkg -i` ile kurun)
TOST_ADMIN_TOKEN=<panelden alınan token> python3 admin-tool/tost-admin.py
```

Token, panelde `~/tost-kiosk/admin_token` dosyasındadır (ilk açılışta rastgele
üretilir, `.gitignore`'da — depoya **girmez**). Araç biletleri, kayıtlı
kullanıcıları ve ham kart okumalarını 5 sn'de bir yeniler; silme/sıfırlama
`X-Admin-Token` başlığıyla korunan uçları kullanır.

## Deploy

Backend ve Client Mode artık **iki farklı makinede** çalıştığı için deploy
akışı da ikiye ayrılıyor.

### Backend değiştiyse (kendi bilgisayarınız)

Kod zaten yerelde çalıştığı için ağ üzerinden bir gönderim yok — sadece
servisi yeniden başlatmak yeterli:

```bash
systemctl --user restart tost-kiosk-backend.service
journalctl --user -u tost-kiosk-backend.service -f   # canlı log
```

### Client Mode (frontend-react) değiştiyse (panel PC)

1. `frontend-react/package.json`'da `version`'ı artırın (ör. `2.0.4` →
   `2.0.5`) ve `run.sh`'daki `APPIMAGE=` satırını buna göre güncelleyin.
2. [Kendi paketinizi derlemek](#kendi-paketinizi-derlemek) bölümündeki
   Docker komutlarıyla yeni `.deb`/AppImage'ı üretin.
3. Yeni sürümü bir GitHub Release'e asset olarak ekleyin:
   ```bash
   gh release create v<sürüm> "frontend-react/release/tost-kiosk-client_<sürüm>_amd64.deb" \
     --title "Client Mode v<sürüm> (.deb)" --notes "..."
   ```
4. Panelde (SSH ile ya da doğrudan panelin kendi terminalinden):
   ```bash
   wget https://github.com/Ariatd/tost-sirasi-kiosk/releases/download/v<sürüm>/tost-kiosk-client_<sürüm>_amd64.deb
   sudo apt install --reinstall ./tost-kiosk-client_<sürüm>_amd64.deb
   systemctl --user restart tost-kiosk-electron.service
   ```

Artık panele dosya **gönderilmiyor** (rsync/scp yok) — panel kendi
başına GitHub'dan indirip kuruyor. Panel PC'ye SSH şifreyle bağlanılıyor
(anahtar tabanlı erişim kurulu değil); tanılama/servis komutları için her
seferinde şifre girmemek amacıyla bir `ControlMaster` soketi açık tutmak
pratik oluyor:

```bash
ssh -o ControlMaster=yes -o ControlPath=/tmp/nfc-cm.sock -o ControlPersist=8h botek@10.42.0.74
# başka bir terminalde, aynı bağlantıyı paylaşarak:
ssh -o ControlPath=/tmp/nfc-cm.sock botek@10.42.0.74 'systemctl --user status tost-kiosk-electron.service'
```

## Bilinen kısıtlar

- **Gerçek `sudo reboot` testi henüz yapılmadı.** Panel daha önce bir reboot
  sonrası uzun süre siyah ekran vermişti (kök sebep tam netleştirilemedi);
  fiziksel müdahale imkânı olmadan tekrar aynı riski almamak için reboot testi
  ileri bir tarihe, panele fiziksel erişim olan bir ana ertelendi. Bunun yerine
  "hafif" bir test yapıldı: backend'in ana süreci öldürülüp otomatik toparlandığı,
  ardından Electron kiosk servisinin yeniden başlatılıp taze backend'e sorunsuz
  bağlandığı, pywebview servisinin **geri gelmediği** SSH üzerinden doğrulandı;
  ayrıca her iki servisin `graphical-session.target.wants/` sembolik bağları
  statik olarak kontrol edildi (gerçek boot'ta tetiklenecek mekanizmanın ta
  kendisi). Bu, gerçek bir soğuk açılışın yerini tam tutmaz.
- **Bilet kodu çakışması** — yukarıda "İş mantığı özeti"nde açıklandı.
- **Electron `webSecurity: false`** — backend'e CORS başlığı eklemeden (backend'e
  dokunmama ilkesi) `file://` kökünden farklı bir HTTP köküne fetch/SSE atmanın
  pratik yolu bu; uygulama yalnızca kendi paketlenmiş arayüzünü yükler, dışarıdan
  içerik kabul etmez.
- **Chromium sandbox — `.deb` kurulum yolu ASCII olmalı.** `.deb`'in kurduğu
  dizin (`/opt/<productName>`) boşluk/Türkçe karakter içerirse (ör. eski
  `Tost Sırası - Client`), Electron'un SUID `chrome-sandbox` yardımcı
  programı bunu doğrulayamayıp SIGTRAP ile çöküyor. Bu yüzden `productName`
  ASCII/boşluksuz (`TostKioskClient`) — kullanıcıya görünen isim
  (uygulama menüsü, taskbar) ayrıca `linux.desktop.Name` ile
  `"Tost Sırası - Client"` olarak ayarlanıyor.
- **Taskbar/WM_CLASS eşleşmesi.** Electron'un `app.setName()` ile ayarladığı
  değer, `.deb`'in ürettiği `.desktop` girdisindeki `StartupWMClass` ile
  **birebir aynı** olmalı (`tost-kiosk-client`) — aksi halde masaüstü ortamı
  çalışan pencereyi kurulu `.desktop` girdisiyle eşleştiremiyor ve
  Electron'un güvenilmez ham X11 özelliklerine (boş `_NET_WM_ICON`, eski
  Latin-1 `WM_NAME`) düşüyor; panelde bu, taskbar'da jenerik bir ikon ve
  bozuk kodlanmış bir başlık ("Tost SÄ±rasÄ±") olarak görünüyordu.
- **Panelde entegre GPU + GNOME erişilebilirlik köprüsü çakışması.**
  Panelin GPU/compositor'ünde tekrarlayan `GetVSyncParametersIfAvailable`
  uyarılarından sonra SIGTRAP ile çökme, ve GNOME oturumunun
  `GTK_MODULES=gail:atk-bridge` ayarıyla çakışan bir GLib-GObject hatası
  gözlendi — `tost-kiosk-electron.service` artık `--disable-gpu
  --disable-software-rasterizer` bayraklarıyla ve `NO_AT_BRIDGE=1` ortam
  değişkeniyle çalışıyor (panelde 8+ dakika kesintisiz çalışarak
  doğrulandı). Bu makinede (geliştirme) bu bayraklara gerek görülmedi.
- **Tek instance kilidi.** Electron uygulaması `app.requestSingleInstanceLock()`
  kullanıyor — ikondan tekrar açılmaya çalışılırsa yeni bir pencere/süreç
  açmak yerine mevcut pencereyi öne getirir.
