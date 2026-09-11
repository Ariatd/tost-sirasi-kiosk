#!/usr/bin/env python3
"""
Tost Sirasi Kiosk — backend.

Sadece Python standart kutuphanesi + pyserial kullanir (Flask/pip GEREKMEZ).

- http.server.ThreadingHTTPServer ile:
    * statik dosyalar (static/)
    * JSON API (/api/...)
    * Server-Sent Events (/events) — kart okuma ve durum degisiklikleri anlik
- Arka planda bir thread seri porttan (CH340, 9600 8N1) kart okur.
  Cerceve ayrıştırma mantigi ~/nfc/nfc_reader.py ile BIREBIR aynidir:
      AA | LEN(2, big-endian) | PAYLOAD(LEN bayt) | XOR(LEN+PAYLOAD) | BB
- Veritabani: SQLite (kiosk.db) — users (kalici), tickets, card_reads.

Is kurallari reference.jsx ile ayni; basamak/onizleme/bloke hesabi
cogunlukla frontend'de yapilir, server sadece siparis olustururken dogrular.
"""
import json
import os
import queue
import secrets
import signal
import sqlite3
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

try:
    import serial  # pyserial
except ImportError:
    serial = None

# --------------------------------------------------------------------------
# Ayarlar
# --------------------------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(HERE, "static")
DB_PATH = os.environ.get("KIOSK_DB", os.path.join(HERE, "kiosk.db"))
HOST = os.environ.get("KIOSK_HOST", "127.0.0.1")
PORT = int(os.environ.get("KIOSK_PORT", "8080"))

SERIAL_PORT = os.environ.get(
    "KIOSK_SERIAL", "/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0"
)
SERIAL_PORT_FALLBACKS = ["/dev/ttyUSB1", "/dev/ttyUSB2", "/dev/ttyUSB0"]
SERIAL_BAUD = 9600

SLOT_MINUTES = 5
SLOT_MS = SLOT_MINUTES * 60 * 1000

# Yonetim (admin) API icin sabit token. Sirasiyla: ortam degiskeni,
# ~/tost-kiosk/admin_token dosyasi, yoksa uret ve dosyaya yaz.
_TOKEN_FILE = os.path.join(HERE, "admin_token")


def _load_admin_token() -> str:
    tok = os.environ.get("KIOSK_ADMIN_TOKEN", "").strip()
    if tok:
        return tok
    try:
        with open(_TOKEN_FILE) as f:
            tok = f.read().strip()
        if tok:
            return tok
    except FileNotFoundError:
        pass
    tok = secrets.token_urlsafe(24)
    with open(_TOKEN_FILE, "w") as f:
        f.write(tok + "\n")
    try:
        os.chmod(_TOKEN_FILE, 0o600)
    except OSError:
        pass
    return tok


ADMIN_TOKEN = _load_admin_token()

SCAN_DEBOUNCE_S = 2.5          # ayni kart bu sure icinde tek "okuma" sayilir
TICKET_STALE_MS = 30 * 60 * 1000  # acilista bu kadar eski bekleyen biletler otomatik kapatilir

FRAME_START = 0xAA
FRAME_END = 0xBB

# --------------------------------------------------------------------------
# Global durum
# --------------------------------------------------------------------------
_time_offset_ms = 0            # sadece "test" panelindeki zaman ilerletme icin
_offset_lock = threading.Lock()

_clients_lock = threading.Lock()
_clients = set()              # aktif SSE kuyruklari (queue.Queue)

_db_lock = threading.RLock()  # sqlite baglantisini tek thread'den kullan
_conn = None

_running = True
_last_scan_id = None
_last_scan_ts = 0.0


def now_ms() -> int:
    with _offset_lock:
        off = _time_offset_ms
    return int(time.time() * 1000) + off


def log(msg: str) -> None:
    print(f"{datetime.now():%Y-%m-%d %H:%M:%S}  {msg}", flush=True)


# --------------------------------------------------------------------------
# Veritabani
# --------------------------------------------------------------------------
def db_init():
    global _conn
    _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    _conn.row_factory = sqlite3.Row
    _conn.execute("PRAGMA journal_mode=WAL")
    _conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            card_id     TEXT PRIMARY KEY,
            first_name  TEXT NOT NULL,
            last_name   TEXT NOT NULL,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tickets (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            card_id        TEXT NOT NULL,
            code           TEXT NOT NULL,
            scheduled_time INTEGER NOT NULL,          -- epoch ms
            picked_up      INTEGER NOT NULL DEFAULT 0,
            created_at     TEXT NOT NULL,
            picked_up_at   TEXT
        );
        CREATE INDEX IF NOT EXISTS ix_tickets_active ON tickets(picked_up, scheduled_time);
        CREATE TABLE IF NOT EXISTS card_reads (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            ts       TEXT NOT NULL,
            tarih    TEXT NOT NULL,
            saat     TEXT NOT NULL,
            card_id  TEXT NOT NULL,
            em4100   TEXT,
            raw_hex  TEXT NOT NULL
        );
        """
    )
    _conn.commit()
    # Acilista: cok eski bekleyen biletleri kapat (panel kapali kalmis olabilir)
    cutoff = now_ms() - TICKET_STALE_MS
    with _db_lock:
        cur = _conn.execute(
            "UPDATE tickets SET picked_up=1, picked_up_at=? "
            "WHERE picked_up=0 AND scheduled_time < ?",
            (datetime.now().isoformat(timespec="seconds"), cutoff),
        )
        _conn.commit()
        if cur.rowcount:
            log(f"acilista {cur.rowcount} eski bilet otomatik kapatildi")


def q(sql, args=()):
    with _db_lock:
        return _conn.execute(sql, args).fetchall()


def q1(sql, args=()):
    rows = q(sql, args)
    return rows[0] if rows else None


def execute(sql, args=()):
    with _db_lock:
        cur = _conn.execute(sql, args)
        _conn.commit()
        return cur


def active_tickets():
    rows = q(
        "SELECT id, card_id, code, scheduled_time, picked_up "
        "FROM tickets WHERE picked_up=0 ORDER BY scheduled_time ASC"
    )
    return [dict(r) for r in rows]


def get_user(card_id):
    r = q1("SELECT card_id, first_name, last_name FROM users WHERE card_id=?", (card_id,))
    return dict(r) if r else None


def state_payload():
    return {
        "type": "state",
        "now": now_ms(),
        "slot_ms": SLOT_MS,
        "tickets": active_tickets(),
    }


# --------------------------------------------------------------------------
# SSE yayini
# --------------------------------------------------------------------------
def broadcast(obj: dict):
    data = json.dumps(obj, ensure_ascii=False)
    with _clients_lock:
        dead = []
        for cq in _clients:
            try:
                cq.put_nowait(data)
            except queue.Full:
                dead.append(cq)
        for d in dead:
            _clients.discard(d)


def broadcast_state():
    broadcast(state_payload())


# --------------------------------------------------------------------------
# Kart kodu uretimi
# --------------------------------------------------------------------------
def em4100_core(payload: bytes) -> str:
    # reference: AA 00 09 [00 40 80] [5A 2D 62 6F 6B] [04]  -> cekirdek = bayt 3..8
    return payload[3:8].hex().upper() if len(payload) >= 8 else payload.hex().upper()


def make_code(card_id: str, em4100: str) -> str:
    """Kartin gercek kimliginin ondalik son 2 hanesi. Su an aktif bir bilette
    ayni kod varsa cakismayi onlemek icin 3, sonra 4 haneye cikar."""
    base_hex = em4100 or card_id
    try:
        n = int(base_hex, 16)
    except ValueError:
        n = abs(hash(base_hex))
    taken = {t["code"] for t in active_tickets()}
    for digits in (2, 3, 4, 6):
        code = str(n % (10 ** digits)).zfill(digits)
        if code not in taken:
            return code
    return str(n % 1000000).zfill(6)


# --------------------------------------------------------------------------
# Seri port okuma (parse mantigi nfc_reader.py ile birebir)
# --------------------------------------------------------------------------
def parse_frames(buf: bytearray):
    out = []
    while True:
        start = buf.find(FRAME_START)
        if start == -1:
            buf.clear()
            break
        if start > 0:
            del buf[:start]
        if len(buf) < 4:
            break
        length = (buf[1] << 8) | buf[2]
        total = 1 + 2 + length + 1 + 1
        if length <= 0 or length > 64:
            del buf[:1]
            continue
        if len(buf) < total:
            break
        frame = bytes(buf[:total])
        payload = frame[3:3 + length]
        chk = frame[3 + length]
        end = frame[4 + length]
        calc = 0
        for b in frame[1:3 + length]:
            calc ^= b
        if end == FRAME_END and chk == calc:
            out.append((payload, frame))
            del buf[:total]
        else:
            del buf[:1]
    return out


def emit_scan(card_id: str, em4100: str, raw_hex: str = ""):
    """Kart okuma olayini kaydet + SSE ile yayinla (debounce yok — cagiran halleder)."""
    dt = datetime.now()
    execute(
        "INSERT INTO card_reads (ts, tarih, saat, card_id, em4100, raw_hex) VALUES (?,?,?,?,?,?)",
        (dt.isoformat(timespec="seconds"), dt.strftime("%Y-%m-%d"),
         dt.strftime("%H:%M:%S"), card_id, em4100, raw_hex or card_id),
    )

    user = get_user(card_id)
    existing = q1(
        "SELECT id, code, scheduled_time FROM tickets WHERE card_id=? AND picked_up=0 "
        "ORDER BY scheduled_time ASC LIMIT 1",
        (card_id,),
    )
    evt = {
        "type": "scan",
        "now": now_ms(),
        "card_id": card_id,
        "em4100": em4100,
        "code_hint": make_code(card_id, em4100),
        "user": user,
        "active_ticket": dict(existing) if existing else None,
    }
    log(f"kart okundu: {card_id} (em4100 {em4100})"
        + (f" · kayitli: {user['first_name']}" if user else "")
        + (" · aktif bileti var" if existing else ""))
    broadcast(evt)


def record_scan(payload: bytes, frame: bytes):
    """Seri porttan gelen cerceve -> debounce -> emit_scan."""
    global _last_scan_id, _last_scan_ts
    card_id = payload.hex().upper()
    em4100 = em4100_core(payload)

    t = time.time()
    if card_id == _last_scan_id and (t - _last_scan_ts) < SCAN_DEBOUNCE_S:
        _last_scan_ts = t
        return
    _last_scan_id, _last_scan_ts = card_id, t
    emit_scan(card_id, em4100, frame.hex().upper())


def open_serial():
    ports = [SERIAL_PORT] + [p for p in SERIAL_PORT_FALLBACKS if p != SERIAL_PORT]
    for p in ports:
        if not os.path.exists(p):
            continue
        try:
            s = serial.Serial(p, SERIAL_BAUD, bytesize=serial.EIGHTBITS,
                              parity=serial.PARITY_NONE, stopbits=serial.STOPBITS_ONE,
                              timeout=0.2)
            s.reset_input_buffer()
            log(f"seri port acildi: {p}")
            return s
        except Exception as e:
            log(f"seri port acilamadi ({p}): {e}")
    return None


def serial_loop():
    if serial is None:
        log("UYARI: pyserial yok — kart okuma devre disi (arayuz yine calisir)")
        return
    ser = None
    while _running:
        if ser is None:
            ser = open_serial()
            if ser is None:
                time.sleep(3)
                continue
        buf = bytearray()
        try:
            while _running:
                chunk = ser.read(256)
                if chunk:
                    buf += chunk
                for payload, frame in parse_frames(buf):
                    record_scan(payload, frame)
        except Exception as e:
            log(f"seri port hatasi ({e}); yeniden baglanilacak")
            try:
                ser.close()
            except Exception:
                pass
            ser = None
            time.sleep(2)


# --------------------------------------------------------------------------
# Is mantigi — siparis dogrulama (frontend ile ayni kurallar)
# --------------------------------------------------------------------------
def validate_and_create_ticket(card_id, scheduled_time):
    scheduled_time = int(scheduled_time)
    n = now_ms()

    # 0) KAYIT ZORUNLU: kart users tablosunda kayitli degilse siparis yok
    if not get_user(card_id):
        return None, "Bu kart kayitli degil"

    # 1) zaten aktif bileti olan kart ikinci siparis veremez
    if q1("SELECT 1 FROM tickets WHERE card_id=? AND picked_up=0", (card_id,)):
        return None, "Zaten bir tostunuz var"

    # 2) gercek bir siparis asla 5 dk'dan az sonrasina olusturulamaz
    #    (istemci-server saat farki / ag gecikmesi icin ~20 sn tolerans)
    if scheduled_time - n < SLOT_MS - 20000:
        return None, "Secilen saat cok yakin"

    # 3) dolu bir basamakla cakisma (ayni 5-dk dilimi)
    pos = -(-(scheduled_time - n) // SLOT_MS)  # ceil
    for t in active_tickets():
        rem = t["scheduled_time"] - n
        if rem > 0 and -(-rem // SLOT_MS) == pos:
            return None, "Bu saat dolu"

    em = q1("SELECT em4100 FROM card_reads WHERE card_id=? ORDER BY id DESC LIMIT 1", (card_id,))
    em4100 = em["em4100"] if em else ""
    code = make_code(card_id, em4100)
    cur = execute(
        "INSERT INTO tickets (card_id, code, scheduled_time, created_at) VALUES (?,?,?,?)",
        (card_id, code, scheduled_time, datetime.now().isoformat(timespec="seconds")),
    )
    row = q1("SELECT id, card_id, code, scheduled_time, picked_up FROM tickets WHERE id=?",
             (cur.lastrowid,))
    return dict(row), None


def upsert_user(card_id, first_name, last_name):
    first_name = (first_name or "").strip()
    last_name = (last_name or "").strip()
    if not first_name or not last_name:
        return None, "Isim ve soyisim gerekli"
    ts = datetime.now().isoformat(timespec="seconds")
    execute(
        "INSERT INTO users (card_id, first_name, last_name, created_at, updated_at) "
        "VALUES (?,?,?,?,?) "
        "ON CONFLICT(card_id) DO UPDATE SET first_name=excluded.first_name, "
        "last_name=excluded.last_name, updated_at=excluded.updated_at",
        (card_id, first_name, last_name, ts, ts),
    )
    return get_user(card_id), None


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass  # sessiz

    # ---- yardimcilar ----
    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        try:
            n = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(n) if n else b""
            return json.loads(raw or b"{}")
        except Exception:
            return {}

    def _admin_ok(self):
        """X-Admin-Token dogru mu? Degilse 401 gonderip False doner."""
        given = self.headers.get("X-Admin-Token", "")
        if secrets.compare_digest(given, ADMIN_TOKEN):
            return True
        self._send_json({"ok": False, "error": "gecersiz veya eksik X-Admin-Token"}, 401)
        return False

    def _serve_static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        rel = path.lstrip("/")
        full = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
            self.send_error(404)
            return
        ext = os.path.splitext(full)[1].lower()
        ctype = CONTENT_TYPES.get(ext, "application/octet-stream")
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if ext in (".woff2", ".woff", ".ttf"):
            self.send_header("Cache-Control", "public, max-age=604800")
        else:
            self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    # ---- GET ----
    def do_GET(self):
        u = urlparse(self.path)
        p = u.path

        if p == "/events":
            return self._sse()

        if p == "/api/state":
            return self._send_json(state_payload())

        if p == "/api/user":
            qs = parse_qs(u.query)
            cid = (qs.get("card_id") or [""])[0]
            return self._send_json({"user": get_user(cid)})

        if p == "/api/health":
            return self._send_json({"ok": True, "now": now_ms()})

        # ---- yonetim (admin) API — X-Admin-Token gerekli ----
        if p == "/api/tickets":
            if not self._admin_ok():
                return
            return self._send_json({"tickets": [dict(r) for r in q(
                "SELECT id, card_id, code, scheduled_time, picked_up, created_at, picked_up_at "
                "FROM tickets ORDER BY scheduled_time DESC")]})

        if p == "/api/users":
            if not self._admin_ok():
                return
            return self._send_json({"users": [dict(r) for r in q(
                "SELECT card_id, first_name, last_name, created_at, updated_at "
                "FROM users ORDER BY created_at DESC")]})

        if p == "/api/card_reads":
            if not self._admin_ok():
                return
            return self._send_json({"card_reads": [dict(r) for r in q(
                "SELECT id, ts, card_id, em4100, raw_hex FROM card_reads "
                "ORDER BY id DESC LIMIT 300")]})

        if p == "/admin":
            self.path = "/admin.html"
            return self._serve_static("/admin.html")

        if p == "/api/admin/data":
            return self._send_json({
                "now": now_ms(),
                "users": [dict(r) for r in q(
                    "SELECT card_id, first_name, last_name, created_at, updated_at "
                    "FROM users ORDER BY created_at DESC")],
                "tickets": [dict(r) for r in q(
                    "SELECT id, card_id, code, scheduled_time, picked_up, created_at, picked_up_at "
                    "FROM tickets ORDER BY id DESC")],
                "card_reads": [dict(r) for r in q(
                    "SELECT id, ts, card_id, em4100, raw_hex FROM card_reads ORDER BY id DESC LIMIT 200")],
                "counts": {
                    "users": q1("SELECT COUNT(*) c FROM users")["c"],
                    "tickets": q1("SELECT COUNT(*) c FROM tickets")["c"],
                    "tickets_active": q1("SELECT COUNT(*) c FROM tickets WHERE picked_up=0")["c"],
                    "card_reads": q1("SELECT COUNT(*) c FROM card_reads")["c"],
                },
            })

        return self._serve_static(p)

    # ---- POST ----
    def do_POST(self):
        u = urlparse(self.path)
        p = u.path
        body = self._read_json()

        # /api/dev/* yalnizca panelin kendisinden (localhost) calisir
        if p.startswith("/api/dev/") and self.client_address[0] not in ("127.0.0.1", "::1"):
            return self._send_json({"ok": False, "error": "dev uc noktalari sadece localhost"}, 403)

        if p == "/api/order":
            ticket, err = validate_and_create_ticket(
                body.get("card_id", ""), body.get("scheduled_time", 0)
            )
            if err:
                return self._send_json({"ok": False, "error": err}, 409)
            broadcast_state()
            return self._send_json({"ok": True, "ticket": ticket})

        if p == "/api/register":
            user, err = upsert_user(
                body.get("card_id", ""), body.get("first_name", ""), body.get("last_name", "")
            )
            if err:
                return self._send_json({"ok": False, "error": err}, 400)
            return self._send_json({"ok": True, "user": user})

        if p == "/api/pickup":
            tid = body.get("ticket_id")
            execute(
                "UPDATE tickets SET picked_up=1, picked_up_at=? WHERE id=? AND picked_up=0",
                (datetime.now().isoformat(timespec="seconds"), tid),
            )
            broadcast_state()
            return self._send_json({"ok": True})

        if p == "/api/dev/scan":
            # donanimsiz test: sahte kart okuma olayi uret
            cid = (body.get("card_id") or "0040805A2D626F6B04").upper()
            em = (body.get("em4100") or (cid[6:16] if len(cid) >= 16 else cid)).upper()
            emit_scan(cid, em, cid)
            return self._send_json({"ok": True, "card_id": cid})

        if p == "/api/dev/advance":
            global _time_offset_ms
            with _offset_lock:
                _time_offset_ms += int(body.get("minutes", 0)) * 60 * 1000
            broadcast_state()
            return self._send_json({"ok": True, "offset_ms": _time_offset_ms})

        if p == "/api/dev/reset":
            with _offset_lock:
                _time_offset_ms = 0
            execute("DELETE FROM tickets")
            execute("DELETE FROM card_reads")
            broadcast_state()
            log("DEV: tum biletler ve okumalar silindi, zaman ofseti sifirlandi")
            return self._send_json({"ok": True})

        # ---- yonetim: tam sifirlama (token'li, agdan da cagrilabilir) ----
        if p == "/api/reset":
            if not self._admin_ok():
                return
            with _offset_lock:
                _time_offset_ms = 0
            execute("DELETE FROM tickets")
            execute("DELETE FROM card_reads")
            broadcast_state()
            log(f"ADMIN reset ({self.client_address[0]}): biletler + kart okumalari silindi "
                "(kayitli kullanicilar korundu)")
            return self._send_json({"ok": True})

        self.send_error(404)

    # ---- DELETE (yonetim) ----
    def do_DELETE(self):
        p = urlparse(self.path).path
        parts = [x for x in p.split("/") if x]  # ["api","tickets","<id>"]

        if len(parts) == 3 and parts[0] == "api" and parts[1] == "tickets":
            if not self._admin_ok():
                return
            try:
                tid = int(parts[2])
            except ValueError:
                return self._send_json({"ok": False, "error": "gecersiz id"}, 400)
            cur = execute("DELETE FROM tickets WHERE id=?", (tid,))
            broadcast_state()
            log(f"ADMIN ({self.client_address[0]}): bilet #{tid} silindi ({cur.rowcount} satir)")
            return self._send_json({"ok": True, "deleted": cur.rowcount})

        if len(parts) == 3 and parts[0] == "api" and parts[1] == "users":
            if not self._admin_ok():
                return
            from urllib.parse import unquote
            card_id = unquote(parts[2])
            cur = execute("DELETE FROM users WHERE card_id=?", (card_id,))
            log(f"ADMIN ({self.client_address[0]}): kullanici {card_id} silindi ({cur.rowcount} satir)")
            return self._send_json({"ok": True, "deleted": cur.rowcount})

        self.send_error(404)

    # ---- SSE ----
    def _sse(self):
        cq = queue.Queue(maxsize=64)
        with _clients_lock:
            _clients.add(cq)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            # ilk durum
            self.wfile.write(b": baglandi\n\n")
            self._sse_send(state_payload())
            last_ping = time.time()
            while _running:
                try:
                    data = cq.get(timeout=1.0)
                    self.wfile.write(f"data: {data}\n\n".encode("utf-8"))
                    self.wfile.flush()
                except queue.Empty:
                    pass
                if time.time() - last_ping > 15:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    last_ping = time.time()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with _clients_lock:
                _clients.discard(cq)

    def _sse_send(self, obj):
        self.wfile.write(f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode("utf-8"))
        self.wfile.flush()


def main():
    global _running

    def stop(*_):
        global _running
        _running = False
        log("kapatiliyor...")
        os._exit(0)

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    db_init()
    log(f"DB: {DB_PATH}")
    log(f"admin token: {ADMIN_TOKEN}  ({_TOKEN_FILE})")

    th = threading.Thread(target=serial_loop, name="serial", daemon=True)
    th.start()

    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    log(f"http://{HOST}:{PORT}  (statik: {STATIC_DIR})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
