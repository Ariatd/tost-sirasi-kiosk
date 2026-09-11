#!/usr/bin/env python3
"""
Tost Sırası — native masaüstü kiosk penceresi.

Mevcut backend'in (server.py, http://127.0.0.1:8080) sunduğu arayüzü
(aynı HTML/CSS/JS, hiç değişmeden) çerçevesiz tam ekran bir WebKitGTK
penceresinde gösterir. Tarayıcı yok, adres çubuğu yok, sekme yok.

Çerçevesiz olduğu için pencere kontrolleri JS köprüsü ile:
  window.pywebview.api.minimize()          — küçült
  window.pywebview.api.toggle_fullscreen() — tam ekran aç/kapa
  window.pywebview.api.quit()              — uygulamayı kapat
Frontend (app.js) bu API'yi "test" panelindeki butonlara ve
F11 / Ctrl+Shift+M / Ctrl+Shift+Q kısayollarına bağlar.

pywebview + bağımlılıkları ~/tost-kiosk/libs/vendor/ altında (pip'siz).
"""
import os
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "libs", "vendor"))

URL = os.environ.get("KIOSK_URL", "http://127.0.0.1:8080/")
HEALTH = URL.rstrip("/") + "/api/health"


def wait_backend(timeout=180):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(HEALTH, timeout=2):
                return True
        except Exception:
            time.sleep(1)
    return False


class Api:
    """app.js'ten window.pywebview.api.* ile çağrılır."""

    def __init__(self):
        self.window = None

    def minimize(self):
        if self.window:
            self.window.minimize()

    def toggle_fullscreen(self):
        if self.window:
            self.window.toggle_fullscreen()

    def quit(self):
        if self.window:
            self.window.destroy()


def main():
    ok = wait_backend()
    print(f"[kiosk_app] backend {'hazır' if ok else 'YANIT YOK — yine de açılıyor'}: {URL}",
          flush=True)

    import webview

    api = Api()
    api.window = webview.create_window(
        "Tost Sırası",
        URL,
        fullscreen=True,
        frameless=True,
        background_color="#17110D",
        confirm_close=False,
        js_api=api,
    )
    webview.start(gui="gtk")


if __name__ == "__main__":
    main()
