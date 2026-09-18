#!/bin/bash
# Tost Sırası — Client Mode başlatma script'i (panel PC'de çalışır).
#
# Bu artık kendi backend'i olan bir kiosk DEĞİL — panel PC'nin kendisi kart
# okuyucuyu (CH340) burada okur ve uzak backend'e (TOST_BACKEND_URL) bildirir.
# Backend artık PANELDE DEĞİL, geliştiricinin kendi bilgisayarında çalışır.
#
# TOST_BACKEND_URL'i BURADA hardcode ETMEYİN — yanındaki client-mode.env
# dosyasından okunur (deploy sırasında tek satır değiştirilir).
set -u
cd "$(dirname "$0")"

if [ -f "./client-mode.env" ]; then
  # shellcheck disable=SC1091
  source "./client-mode.env"
fi

if [ -z "${TOST_BACKEND_URL:-}" ]; then
  echo "HATA: TOST_BACKEND_URL ayarlanmamış (client-mode.env dosyasını kontrol edin)." >&2
  echo "Uygulama yine de açılacak ama 'Backend adresi ayarlanmamış' uyarı ekranını gösterecek." >&2
fi
export TOST_BACKEND_URL

APPIMAGE="./TostKioskClient-2.1.8.AppImage"
chmod +x "$APPIMAGE" 2>/dev/null

# AppImage varsayılan olarak FUSE ile kendini bağlar; panelde libfuse2 kurulu
# değilse (yaygın, minimal Ubuntu kurulumlarında sık) bu başarısız olur.
# --appimage-extract-and-run FUSE'a hiç ihtiyaç duymadan geçici bir dizine
# açıp oradan çalıştırır — ekstra paket kurulumu gerektirmez.
#
# --ozone-platform=wayland: panel Wayland-yerel çalışıyor (GNOME/Mutter).
# Electron'un pencere katmanı (Ozone) bu bayrak olmadan $DISPLAY (X11)
# arıyor ve "Missing X server" hatasıyla sessizce çöküyor.
exec "$APPIMAGE" --appimage-extract-and-run --no-sandbox \
  --ozone-platform=wayland --enable-features=UseOzonePlatform
