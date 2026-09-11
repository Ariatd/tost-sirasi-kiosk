#!/bin/bash
# Tost Sırası — React/Electron sürümü, ELLE başlatma script'i.
#
# Bu, panelin mevcut çalışan pywebview kiosk'una (tost-kiosk-app.service)
# DOKUNMAZ. İkisi aynı anda fiziksel ekranı paylaşamaz; bu sürümü test
# etmeden önce mevcut olanı geçici durdur:
#
#   systemctl --user stop tost-kiosk-app.service
#   ~/tost-kiosk-electron/run.sh
#   (test bitince: Ctrl+C veya "Uygulamayı kapat" ile çık, sonra)
#   systemctl --user start tost-kiosk-app.service
#
# Aynı gerçek backend'e (http://10.42.0.74:8080, ~/tost-kiosk/server.py)
# bağlanır — backend değişmedi, bu sadece farklı bir görüntüleme katmanı.
set -u
cd "$(dirname "$0")"
chmod +x "./Tost Sirasi-1.0.0.AppImage" 2>/dev/null

# AppImage varsayılan olarak FUSE ile kendini bağlar; panelde libfuse2 kurulu
# değilse (yaygın, minimal Ubuntu kurulumlarında sık) bu başarısız olur.
# --appimage-extract-and-run FUSE'a hiç ihtiyaç duymadan geçici bir dizine
# açıp oradan çalıştırır — ekstra paket kurulumu gerektirmez.
#
# --ozone-platform=wayland: panel Wayland-yerel çalışıyor (GNOME/Mutter).
# Electron'un pencere katmanı (Ozone) bu bayrak olmadan $DISPLAY (X11)
# arıyor ve "Missing X server" hatasıyla sessizce çöküyor — pywebview
# (GTK-native) bu sorunu yaşamıyordu, Electron/Chromium ayrı bir katman.
exec "./Tost Sirasi-1.0.0.AppImage" --appimage-extract-and-run --no-sandbox \
  --ozone-platform=wayland --enable-features=UseOzonePlatform
