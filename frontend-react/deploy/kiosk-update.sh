#!/bin/bash
# Tost Sırası — Client Mode OTA güncelleme betiği.
#
# electron/main.cjs'teki "tost:applyUpdate" IPC handler'ı bunu çağırır:
# main.cjs artık .deb'i KENDİSİ indirir (ilerleme yüzdesini Ayarlar
# ekranına canlı yayınlamak için), bu betiğe sadece YEREL dosya yolunu
# verir. Elle/manuel kullanım için doğrudan bir URL de verilebilir —
# o zaman indirmeyi bu betik yapar (eski davranış, geriye dönük uyumlu).
#
# Kurulum (bu makinede / panelde, bir kere):
#   sudo cp deploy/kiosk-update.sh /usr/local/bin/kiosk-update.sh
#   sudo chmod +x /usr/local/bin/kiosk-update.sh
#   sudo cp deploy/kiosk-update.sudoers /etc/sudoers.d/kiosk-update
#   sudo chmod 440 /etc/sudoers.d/kiosk-update
#   sudo visudo -c
set -euo pipefail

SRC="${1:?Kullanım: kiosk-update.sh <yerel .deb yolu | deb-url>}"

if [[ "$SRC" == /* ]] && [ -f "$SRC" ]; then
  # Zaten indirilmiş yerel dosya (main.cjs'in normal kullanım şekli).
  DEB="$SRC"
  CLEANUP=0
else
  # URL — kendimiz indiriyoruz (manuel/CLI kullanım).
  DEB="$(mktemp --suffix=.deb)"
  CLEANUP=1
  echo "[kiosk-update] İndiriliyor: $SRC"
  wget -q -O "$DEB" "$SRC"
fi
[ "$CLEANUP" = 1 ] && trap 'rm -f "$DEB"' EXIT

echo "[kiosk-update] Kuruluyor: $DEB"
apt-get install -y --reinstall "$DEB"

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
