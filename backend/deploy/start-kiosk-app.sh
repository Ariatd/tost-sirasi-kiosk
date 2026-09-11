#!/bin/bash
# Tost Sırası — native kiosk penceresini başlatır (pywebview + WebKitGTK).
set -u

# WebKitGTK 2.44+ bazı sürücülerde DMABUF renderer ile boş/siyah çiziyor;
# kapatmak en yaygın çözüm.
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export GDK_BACKEND=wayland,x11
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

# grafik oturum ortamını systemd --user'a taşı (bazı kurulumlarda gerekli)
systemctl --user import-environment WAYLAND_DISPLAY DISPLAY XAUTHORITY 2>/dev/null || true

cd "$HOME/tost-kiosk"
exec /usr/bin/python3 "$HOME/tost-kiosk/kiosk_app.py"
