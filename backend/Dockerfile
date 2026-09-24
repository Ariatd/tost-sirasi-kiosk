# Tost Sırası backend — staging/deneme ortamı imajı.
#
# Backend zaten stdlib-only (bkz. server.py) olduğu için imaj çok basit:
# sadece resmi Python imajı + kaynak kod. Production'da (systemd --user
# servisi) bu imaj KULLANILMIYOR — bu yalnızca izole, tek komutla ayağa
# kalkan bir staging/deneme kopyası içindir (bkz. README "Staging").
#
# ÖNEMLİ: build context REPO KÖKÜ olmalı (backend/ değil), çünkü hem
# backend/ hem de frontend-react/dist/ kopyalanıyor:
#   docker build -f backend/Dockerfile -t tost-kiosk-backend-staging .
FROM python:3.12-slim

WORKDIR /app
COPY backend/server.py .
COPY backend/static/ static/
# Mobil takip sayfası (frontend-react/dist), server.py'nin REACT_DIST_DIR
# hesabıyla aynı göreli konuma (backend'in bir üst dizinindeki kardeş
# klasör) yerleştirilir: /app/../frontend-react/dist = /frontend-react/dist.
COPY frontend-react/dist/ /frontend-react/dist/

ENV KIOSK_HOST=0.0.0.0
ENV KIOSK_PORT=8080
ENV KIOSK_DB=/data/kiosk.db

VOLUME ["/data"]
EXPOSE 8080

CMD ["python3", "-u", "server.py"]
