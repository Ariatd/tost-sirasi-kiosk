# Tost Sırası Kiosk

RFID/NFC kartla çalışan bir tost sırası yönetim sistemi: müşteri kartını okutur,
tostunun ne zaman hazır olacağını seçer; panel ekranı sırayı gösterir; bir de
biletleri/kayıtları yönetebileceğiniz ayrı bir masaüstü aracı vardır.

Panel donanımı: temassız kart okuyucu (CH340 USB-seri, 125 kHz EM4100) takılı
bir Ubuntu 24.04 mini PC (panelpc). Backend ve kiosk arayüzü o makinede
sürekli çalışır; bu depo hem o kaynak kodu hem de kendi bilgisayarınızda
derlenip panele **dağıtılan** React/Electron sürümünü bir arada tutar.

## Mimari

```
┌──────────────┐   9600 8N1 seri    ┌────────────────────────────┐
│ NFC okuyucu  │ ─────────────────▶ │ backend/server.py            │
│ (CH340,      │  AA|len|veri|xor|  │ Python stdlib: http.server   │
│  EM4100)     │  BB çerçevesi      │ + SQLite + Server-Sent Events│
└──────────────┘                    └──────────────┬────────────┘
                                                     │ HTTP + SSE
                        ┌────────────────────────────┼───────────────────┐
                        │                            │                   │
               ┌────────▼────────┐         ┌─────────▼────────┐  ┌───────▼───────┐
               │ backend/static   │         │ frontend-react     │  │ admin-tool     │
               │ (vanilla JS,     │         │ React → Electron/   │  │ tost-admin.py  │
               │  pywebview'de     │         │ AppImage — panelde  │  │ (Tkinter, kendi│
               │  çalıştı, artık   │         │ CANLI sürüm         │  │  bilgisayardan)│
               │  arşiv/yedek)     │         │                      │  │                │
               └──────────────────┘         └──────────────────────┘  └────────────────┘
```

Panelde şu an **iki** systemd `--user` servisi vardır:

- `tost-kiosk.service` — backend, her zaman çalışır, hiç değişmedi.
- `tost-kiosk-electron.service` — React/Electron kiosk penceresi (**canlı sürüm**).
- `tost-kiosk-app.service` — eski pywebview penceresi (**devre dışı**, dosyalar
  duruyor, geri dönüş gerekirse `systemctl --user enable --now` yeterli).

## Depo yapısı

```
backend/          panelde çalışan gerçek kaynak (server.py, static/, deploy/)
frontend-react/   React kaynağı + Electron paketleme (Vite, electron-builder)
admin-tool/       tost-admin.py — Tkinter yönetim uygulaması (kendi bilgisayarınızda)
docs/             ekran görüntüleri / notlar (opsiyonel)
```

`backend/` panelin **kopyasıdır** — git ile burada versiyonlanır, ama panele
gönderim hâlâ elle (rsync/scp) yapılır; bkz. [Deploy](#deploy).

## Neden bu kararlar

- **SQLite, NoSQL değil.** Veri küçük ve tamamen ilişkisel (biletler, kullanıcılar,
  ham kart okumaları) — ayrı bir veritabanı sunucusu kurmanın hiçbir faydası yok.
- **Python stdlib, Flask değil.** Panel PC'nin paket erişimi kısıtlı; `pip` bile
  yoktu. `http.server.ThreadingHTTPServer` + `sqlite3` + Server-Sent Events ile
  hiçbir üçüncü parti bağımlılık olmadan (pyserial hariç, o zaten kuruluydu) aynı
  işi görüyoruz.
- **Electron + React, panelde Node hiç yokken bile.** Panelde `node`/`npm`
  kurulamıyor (bağımlılık çakışmaları, kısıtlı erişim). Çözüm: React'i ve
  Electron paketini **bu depodan, kendi bilgisayarınızda, Docker içinde** (pinlenmiş
  Node 20 imajı) derleyip; panele yalnızca **derlenmiş, bağımsız çalışan
  AppImage**'ı göndermek. Panelde Node'a hiç ihtiyaç yok.
- **Aynı gerçek backend, iki frontend.** `backend/static` (vanilla JS) ve
  `frontend-react` **aynı** `server.py`'nin API'sini (`/api/*`) ve olay akışını
  (`/events` SSE) tüketir — backend hiçbir zaman iki kere yazılmadı.

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

Panelde artık yalnızca eski (arşiv) `tost-kiosk.service` durdurulmuş/devre
dışı duruyor — dosyalar duruyor, geri dönüş gerekirse
`sudo systemctl enable --now tost-kiosk.service`.

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

### Frontend (React) — Electron/AppImage derleme (Node kurmadan, Docker ile)

```bash
cd frontend-react
docker run --rm -v $PWD:/app -w /app node:20-bookworm-slim npm run build
docker run --rm -v $PWD:/app -w /app \
  -v ~/.docker-cache/electron:/root/.cache/electron \
  -v ~/.docker-cache/electron-builder:/root/.cache/electron-builder \
  node:20-bookworm-slim bash -c '
    apt-get update -qq && apt-get install -y -qq ca-certificates >/dev/null
    update-ca-certificates >/dev/null
    npx electron-builder --linux AppImage --x64'
```

Çıktı: `frontend-react/release/Tost Sirasi-1.0.0.AppImage` (~104 MB, panel ve
kendi makineniz aynı x86_64 mimaride).

> `ca-certificates` adımı gerekli — imajda yoksa Electron/AppImage indirmeleri
> `x509: certificate signed by unknown authority` hatasıyla başarısız olur.

### Client Mode masaüstü paketi (.deb)

AppImage'ın yanına, standart Ubuntu/Debian kurulumu için `.deb` hedefi de
eklendi — kurulunca uygulama menüsüne kendiliğinden (elle `.desktop` dosyası
yazmadan) girer, kendi ikonuyla görünür.

```bash
cd frontend-react
docker run --rm -v $PWD:/app -w /app node:20-bookworm-slim npm run build
docker run --rm -v $PWD:/app -w /app \
  -v ~/.docker-cache/electron:/root/.cache/electron \
  -v ~/.docker-cache/electron-builder:/root/.cache/electron-builder \
  node:20-bookworm-slim bash -c '
    apt-get update -qq && apt-get install -y -qq ca-certificates >/dev/null
    update-ca-certificates >/dev/null
    npx electron-builder --linux AppImage deb --x64'
```

Kurulum (bu makinede ya da panelde):

```bash
sudo apt install ./release/"Tost Sırası - Client_2.0.0_amd64.deb"
```

Uygulama menüsünden "Tost Sırası - Client" ile açılır; masaüstüne kısayol
istenirse menüdeki simge normal Ubuntu davranışıyla sürüklenip bırakılabilir
— ekstra script gerekmez.

**⚠️ Varsayılan backend adresi ağınıza özeldir.** Paket
`TOST_BACKEND_URL=http://10.42.0.1:8080` varsayılanıyla gelir — bu yalnızca
bu depoyu hazırlayan geliştiricinin **kendi ev ağında** çalışır. Uygulama ilk
açılışta `~/.config/tost-kiosk-client/config.env` dosyasını (yoksa) bu
varsayılanla oluşturur; **kendi backend'inizi ayakta tutup** bu dosyadaki
`TOST_BACKEND_URL` satırını kendi IP'nize göre değiştirip uygulamayı yeniden
başlatmanız gerekir. Ortam değişkeni (`TOST_BACKEND_URL=... `, örn. bir
systemd `Environment=` satırı) varsa config.env'den önce o kullanılır.

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

## Deploy (panele gönderim)

Değişiklik yaptıktan sonra panele göndermek için:

```bash
# backend değiştiyse:
rsync -az backend/server.py botek@10.42.0.74:~/tost-kiosk/server.py
rsync -az backend/static/   botek@10.42.0.74:~/tost-kiosk/static/
ssh botek@10.42.0.74 'systemctl restart tost-kiosk.service'   # server.py değiştiyse
# static/ (app.js/admin.html/styles.css) değiştiyse backend'i yeniden başlatmaya
# gerek yok, ama Electron/pywebview penceresi sayfayı SADECE açılışta yükler:
ssh botek@10.42.0.74 'systemctl --user restart tost-kiosk-electron.service'

# frontend-react değiştiyse: önce yukarıdaki Docker adımlarıyla AppImage'ı
# yeniden derleyin, sonra:
rsync -az "frontend-react/release/Tost Sirasi-1.0.0.AppImage" \
  botek@10.42.0.74:~/tost-kiosk-electron/
ssh botek@10.42.0.74 'chmod +x "~/tost-kiosk-electron/Tost Sirasi-1.0.0.AppImage" && \
  systemctl --user restart tost-kiosk-electron.service'
```

Panel PC'ye SSH şifreyle bağlanılıyor (anahtar tabanlı erişim kurulu değil);
uzun komut dizilerinde her seferinde şifre girmemek için bir `ControlMaster`
soketi açık tutmak pratik oluyor:

```bash
ssh -o ControlMaster=yes -o ControlPath=/tmp/nfc-cm.sock -o ControlPersist=8h botek@10.42.0.74
# başka bir terminalde:
rsync -az -e "ssh -o ControlPath=/tmp/nfc-cm.sock" ...
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
- **`--no-sandbox`** — Electron'un Chromium sandbox'ı panelde setuid-root
  yapılandırmasını gerektiriyor olabilir, doğrulanmadı; `--no-sandbox` ile
  çalıştığı bilinen/test edilen durum. Kapalı bir kiosk için kabul edilebilir.
