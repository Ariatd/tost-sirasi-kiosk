#!/bin/bash
# Tost Sırası — Client Mode OTA güncelleme betiği.
#
# electron/main.cjs'teki "tost:applyUpdate" IPC handler'ı bunu
# `sudo /usr/local/bin/kiosk-update.sh <deb-url>` olarak çağırır (Ayarlar
# ekranındaki "Güncelle" butonu → GitHub Release'den .deb indirir, kurar,
# kiosk servisini yeniden başlatır).
#
# Kurulum (bu makinede / panelde, bir kere):
#   sudo cp deploy/kiosk-update.sh /usr/local/bin/kiosk-update.sh
#   sudo chmod +x /usr/local/bin/kiosk-update.sh
#   sudo cp deploy/kiosk-update.sudoers /etc/sudoers.d/kiosk-update
#   sudo chmod 440 /etc/sudoers.d/kiosk-update
#   sudo visudo -c
set -euo pipefail

URL="${1:?Kullanım: kiosk-update.sh <deb-url>}"
TMPDEB="$(mktemp --suffix=.deb)"
trap 'rm -f "$TMPDEB"' EXIT

echo "[kiosk-update] İndiriliyor: $URL"
wget -q -O "$TMPDEB" "$URL"

echo "[kiosk-update] Kuruluyor..."
apt-get install -y --reinstall "$TMPDEB"

# Bu betik root olarak (sudo ile) çalışıyor; kiosk'u çalıştıran gerçek
# kullanıcının systemd --user oturumuna erişip servisi yeniden başlatmak
# için o oturumun DBUS/XDG değişkenlerini elle vermek gerekiyor.
REAL_USER="${SUDO_USER:-$(logname 2>/dev/null || true)}"
if [ -n "$REAL_USER" ]; then
  REAL_UID="$(id -u "$REAL_USER")"
  echo "[kiosk-update] $REAL_USER için kiosk servisi yeniden başlatılıyor..."
  sudo -u "$REAL_USER" \
    XDG_RUNTIME_DIR="/run/user/$REAL_UID" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$REAL_UID/bus" \
    systemctl --user restart tost-kiosk-electron.service || true
fi

echo "[kiosk-update] Tamamlandı."
