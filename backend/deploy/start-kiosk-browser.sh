#!/bin/bash
# Tost Kiosk — tam ekran tarayici baslatici (GNOME autostart tarafindan cagrilir).
set -u
URL="http://127.0.0.1:8080/"
# snap Firefox sadece kendi yazilabilir alanina erisebilir:
PROFILE="$HOME/snap/firefox/common/.mozilla/firefox/kiosk"
LOG="$HOME/tost-kiosk/kiosk-browser.log"

echo "$(date) baslatiliyor" >> "$LOG"

# 1) Backend ayaga kalkana kadar bekle (curl varsa curl, yoksa python3)
for i in $(seq 1 90); do
  if command -v curl >/dev/null 2>&1; then
    curl -sf -o /dev/null "http://127.0.0.1:8080/api/health" && break
  else
    python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=2)" 2>/dev/null && break
  fi
  sleep 1
done

# 2) Kiosk profili — guncelleme/oturum-kurtarma uyarilarini kapat
mkdir -p "$PROFILE"
cat > "$PROFILE/user.js" <<'EOF'
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.aboutConfig.showWarning", false);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("app.update.auto", false);
user_pref("app.update.enabled", false);
user_pref("browser.tabs.warnOnClose", false);
user_pref("browser.warnOnQuit", false);
user_pref("full-screen-api.warning.timeout", 0);
user_pref("dom.disable_beforeunload", true);
user_pref("signon.rememberSignons", false);
EOF

# 3) Ekran koruyucu / kararma kapali kalsin (Wayland/GNOME)
gsettings set org.gnome.desktop.screensaver lock-enabled false 2>/dev/null || true
gsettings set org.gnome.desktop.session idle-delay 0 2>/dev/null || true
gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing' 2>/dev/null || true

# 4) Tam ekran kiosk (Wayland yerel)
export MOZ_ENABLE_WAYLAND=1
exec firefox --kiosk --profile "$PROFILE" --new-window "$URL" >> "$LOG" 2>&1
