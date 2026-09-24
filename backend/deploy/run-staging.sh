#!/bin/bash
# Tost Sırası — tek komutla izole bir STAGING backend'i ayağa kaldırır.
#
# Production'daki gerçek backend'e (port 8080, tost-kiosk-backend.service)
# HİÇ dokunmaz: ayrı port, ayrı Docker volume (dolayısıyla ayrı SQLite
# dosyası, ayrı admin token). Yeni bir sürümü panele göndermeden önce
# burada deneyin.
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo kökü

STAGING_PORT="${STAGING_PORT:-8081}"
KIOSK_ADMIN_TOKEN="${KIOSK_ADMIN_TOKEN:-staging-token}"
IMAGE_NAME="tost-kiosk-backend-staging"
CONTAINER_NAME="tost-kiosk-staging"
VOLUME_NAME="tost-kiosk-staging-data"

if [ ! -d "frontend-react/dist" ]; then
  echo "HATA: frontend-react/dist yok. Önce derleyin:" >&2
  echo "  cd frontend-react && npm run build" >&2
  exit 1
fi

echo "[staging] imaj derleniyor..."
docker build -f backend/Dockerfile -t "$IMAGE_NAME" .

docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

echo "[staging] konteyner başlatılıyor (host:${STAGING_PORT} -> container:8080)..."
docker run -d \
  --name "$CONTAINER_NAME" \
  -p "${STAGING_PORT}:8080" \
  -v "${VOLUME_NAME}:/data" \
  -e KIOSK_ADMIN_TOKEN="${KIOSK_ADMIN_TOKEN}" \
  "$IMAGE_NAME" >/dev/null

echo "[staging] hazır:        http://localhost:${STAGING_PORT}"
echo "[staging] admin token:  ${KIOSK_ADMIN_TOKEN}"
echo "[staging] veri (kalıcı, production'dan bağımsız): docker volume '${VOLUME_NAME}'"
echo "[staging] loglar:       docker logs -f ${CONTAINER_NAME}"
echo "[staging] durdurmak:    docker rm -f ${CONTAINER_NAME}"
