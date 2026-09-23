#!/usr/bin/env python3
"""
TostIQ Kiosk — Backend (SUNUCU MODU, KREDİ/KOTA, SİPARİŞ İPTAL & ÜRÜN DETAYLI PROFİL GEÇMİŞİ).
"""
import json
import os
import queue
import secrets
import signal
import sqlite3
import threading
import time
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from urllib.request import urlopen
from urllib.error import URLError

# --------------------------------------------------------------------------
# Ayarlar
# --------------------------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(HERE, "static")
REACT_DIST_DIR = os.path.normpath(os.path.join(HERE, "..", "frontend-react", "dist"))
DB_PATH = os.environ.get("KIOSK_DB", os.path.join(HERE, "kiosk.db"))
HOST = os.environ.get("KIOSK_HOST", "0.0.0.0")
PORT = int(os.environ.get("KIOSK_PORT", "8080"))

# cloudflared'in --metrics ile actigi yerel uc nokta — o an gecerli olan
# Quick Tunnel adresini programatik okumak icin (bkz. get_tunnel_url()).
# Adres sabit/hardcoded degil: her cloudflared yeniden baslatildiginda
# rastgele degisir, biz de her seferinde GUNCEL degeri okuyup panele
# (SSE ile) iletiyoruz - boylece QR kodu her zaman o anda GERCEKTEN
# calisan adresle uretiliyor, ucretli/kalici bir tunele gerek kalmiyor.
TUNNEL_METRICS_URL = os.environ.get("TUNNEL_METRICS_URL", "http://localhost:20241/quicktunnel")

SLOT_MINUTES = 5
SLOT_MS = SLOT_MINUTES * 60 * 1000
DEFAULT_MONTHLY_QUOTA = 1000

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

SCAN_DEBOUNCE_S = 2.5
TICKET_STALE_MS = 30 * 60 * 1000

# --------------------------------------------------------------------------
# Global Durum
# --------------------------------------------------------------------------
_time_offset_ms = 0
_offset_lock = threading.Lock()

_clients_lock = threading.Lock()
_clients = set()

_db_lock = threading.RLock()
_conn = None

_running = True
_last_scan_id = None
_last_scan_ts = 0.0

_out_of_stock = set()
_stock_lock = threading.Lock()


def now_ms() -> int:
    with _offset_lock:
        off = _time_offset_ms
    return int(time.time() * 1000) + off


def log(msg: str) -> None:
    print(f"{datetime.now():%Y-%m-%d %H:%M:%S}  {msg}", flush=True)


# --------------------------------------------------------------------------
# Veritabanı
# --------------------------------------------------------------------------
def db_init():
    global _conn
    _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    _conn.row_factory = sqlite3.Row
    _conn.execute("PRAGMA journal_mode=WAL")
    _conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            card_id          TEXT PRIMARY KEY,
            first_name       TEXT NOT NULL,
            last_name        TEXT NOT NULL,
            created_at       TEXT NOT NULL,
            updated_at       TEXT NOT NULL,
            balance          INTEGER NOT NULL DEFAULT 1000,
            monthly_quota    INTEGER NOT NULL DEFAULT 1000,
            is_blocked       INTEGER NOT NULL DEFAULT 0,
            quota_reset_date TEXT
        );
        CREATE TABLE IF NOT EXISTS tickets (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            card_id        TEXT NOT NULL,
            code           TEXT NOT NULL,
            scheduled_time INTEGER NOT NULL,
            picked_up      INTEGER NOT NULL DEFAULT 0,
            created_at     TEXT NOT NULL,
            picked_up_at   TEXT,
            points_spent   INTEGER NOT NULL DEFAULT 0,
            cancelled      INTEGER NOT NULL DEFAULT 0,
            cancelled_at   TEXT,
            items_summary  TEXT NOT NULL DEFAULT 'Standart Tost'
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
        CREATE TABLE IF NOT EXISTS account_deletion_requests (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            card_id    TEXT NOT NULL,
            created_at TEXT NOT NULL,
            status     TEXT NOT NULL DEFAULT 'pending'
        );
        CREATE INDEX IF NOT EXISTS ix_account_deletion_requests_status
            ON account_deletion_requests(status, created_at);
        """
    )

    cols = [r["name"] for r in _conn.execute("PRAGMA table_info(users)").fetchall()]
    if "balance" not in cols:
        _conn.execute("ALTER TABLE users ADD COLUMN balance INTEGER NOT NULL DEFAULT 1000")
    if "monthly_quota" not in cols:
        _conn.execute("ALTER TABLE users ADD COLUMN monthly_quota INTEGER NOT NULL DEFAULT 1000")
    if "is_blocked" not in cols:
        _conn.execute("ALTER TABLE users ADD COLUMN is_blocked INTEGER NOT NULL DEFAULT 0")
    if "quota_reset_date" not in cols:
        _conn.execute("ALTER TABLE users ADD COLUMN quota_reset_date TEXT")

    ticket_cols = [r["name"] for r in _conn.execute("PRAGMA table_info(tickets)").fetchall()]
    if "points_spent" not in ticket_cols:
        _conn.execute("ALTER TABLE tickets ADD COLUMN points_spent INTEGER NOT NULL DEFAULT 0")
    if "cancelled" not in ticket_cols:
        _conn.execute("ALTER TABLE tickets ADD COLUMN cancelled INTEGER NOT NULL DEFAULT 0")
    if "cancelled_at" not in ticket_cols:
        _conn.execute("ALTER TABLE tickets ADD COLUMN cancelled_at TEXT")
    if "items_summary" not in ticket_cols:
        _conn.execute("ALTER TABLE tickets ADD COLUMN items_summary TEXT NOT NULL DEFAULT 'Standart Tost'")

    adr_cols = [r["name"] for r in _conn.execute("PRAGMA table_info(account_deletion_requests)").fetchall()]
    if "resolved_at" not in adr_cols:
        _conn.execute("ALTER TABLE account_deletion_requests ADD COLUMN resolved_at TEXT")

    _conn.commit()

    cutoff = now_ms() - TICKET_STALE_MS
    with _db_lock:
        cur = _conn.execute(
            "UPDATE tickets SET picked_up=1, picked_up_at=? "
            "WHERE picked_up=0 AND scheduled_time < ?",
            (datetime.now().isoformat(timespec="seconds"), cutoff),
        )
        _conn.commit()
        if cur.rowcount:
            log(f"Açılışta {cur.rowcount} eski bilet otomatik kapatıldı.")


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


def check_and_renew_quota(card_id: str):
    user = q1("SELECT card_id, monthly_quota, quota_reset_date FROM users WHERE card_id=?", (card_id,))
    if not user or not user["quota_reset_date"]:
        return
    try:
        reset_dt = datetime.fromisoformat(user["quota_reset_date"])
        if datetime.now() >= reset_dt:
            next_reset = (datetime.now() + timedelta(days=30)).isoformat(timespec="seconds")
            execute(
                "UPDATE users SET balance=monthly_quota, quota_reset_date=? WHERE card_id=?",
                (next_reset, card_id)
            )
            log(f"Kullanıcı kotası yenilendi: {card_id} -> {user['monthly_quota']} Kredi")
    except Exception as e:
        log(f"Kota yenileme hatası: {e}")


def active_tickets():
    cutoff_cancelled = (datetime.now() - timedelta(seconds=45)).isoformat(timespec="seconds")
    rows = q(
        "SELECT t.id, t.card_id, t.code, t.scheduled_time, t.picked_up, t.cancelled, t.points_spent, t.items_summary, "
        "u.first_name, u.last_name, "
        "(SELECT COUNT(*) FROM tickets same "
        " WHERE same.card_id=t.card_id AND same.picked_up=0 AND same.cancelled=0) AS active_count "
        "FROM tickets t LEFT JOIN users u ON u.card_id=t.card_id "
        "WHERE (t.picked_up=0 AND t.cancelled=0) OR (t.cancelled=1 AND t.cancelled_at >= ?) "
        "ORDER BY t.scheduled_time ASC",
        (cutoff_cancelled,)
    )
    return [dict(r) for r in rows]


def get_user(card_id):
    check_and_renew_quota(card_id)
    r = q1(
        "SELECT card_id, first_name, last_name, balance, monthly_quota, is_blocked, quota_reset_date "
        "FROM users WHERE card_id=?",
        (card_id,)
    )
    return dict(r) if r else None


def get_profile(card_id):
    user = get_user(card_id)
    if not user:
        return None
    stats = q1(
        "SELECT COUNT(*) AS total_orders, "
        "SUM(CASE WHEN picked_up=1 THEN 1 ELSE 0 END) AS completed_orders, "
        "SUM(CASE WHEN picked_up=0 AND cancelled=0 THEN 1 ELSE 0 END) AS active_orders "
        "FROM tickets WHERE card_id=?",
        (card_id,),
    )
    orders = q(
        "SELECT id, code, scheduled_time, picked_up, cancelled, created_at, points_spent, items_summary "
        "FROM tickets WHERE card_id=? ORDER BY id DESC LIMIT 25",
        (card_id,)
    )
    return {
        **user,
        "total_orders": stats["total_orders"] or 0,
        "completed_orders": stats["completed_orders"] or 0,
        "active_orders": stats["active_orders"] or 0,
        "balance_enabled": True,
        "order_history": [dict(o) for o in orders],
    }


_tunnel_url_cache = {"url": None, "checked_at": 0}
_TUNNEL_URL_CACHE_MS = 10_000  # metrics ucuz/yerel ama her state_payload cagrisinda sormaya gerek yok


def get_tunnel_url():
    """cloudflared --metrics uc noktasindan o an GERCEKTEN calisan Quick
    Tunnel adresini okur. Adres sabit degil (her cloudflared yeniden
    baslatilmasinda degisir) - bu yuzden hic hardcode edilmiyor, her
    QR kodu uretiminde panel bu degeri (SSE'deki state uzerinden) taze
    okuyor. Tunel kapaliysa/bulunamiyorsa None doner (QR gosterilmez)."""
    now = time.time() * 1000
    if now - _tunnel_url_cache["checked_at"] < _TUNNEL_URL_CACHE_MS:
        return _tunnel_url_cache["url"]
    url = None
    try:
        with urlopen(TUNNEL_METRICS_URL, timeout=1.5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            hostname = data.get("hostname")
            if hostname:
                url = f"https://{hostname}"
    except (URLError, ValueError, OSError):
        url = None
    _tunnel_url_cache["url"] = url
    _tunnel_url_cache["checked_at"] = now
    return url


def state_payload():
    with _stock_lock:
        cur_stock = list(_out_of_stock)
    return {
        "type": "state",
        "now": now_ms(),
        "tunnel_url": get_tunnel_url(),
        "slot_ms": SLOT_MS,
        "tickets": active_tickets(),
        "out_of_stock": cur_stock,
    }


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


def em4100_core(payload: bytes) -> str:
    return payload[3:8].hex().upper() if len(payload) >= 8 else payload.hex().upper()


def make_code(card_id: str, em4100: str) -> str:
    base_hex = em4100 or card_id
    try:
        n = int(base_hex, 16)
    except ValueError:
        n = abs(hash(base_hex))
    taken = {t["code"] for t in active_tickets() if not t.get("cancelled")}
    start = n % 100
    for offset in range(100):
        code = f"{(start + offset) % 100:02d}"
        if code not in taken:
            return code
    return f"{start:02d}"


def emit_scan(card_id: str, em4100: str, raw_hex: str = ""):
    dt = datetime.now()
    execute(
        "INSERT INTO card_reads (ts, tarih, saat, card_id, em4100, raw_hex) VALUES (?,?,?,?,?,?)",
        (dt.isoformat(timespec="seconds"), dt.strftime("%Y-%m-%d"),
         dt.strftime("%H:%M:%S"), card_id, em4100, raw_hex or card_id),
    )

    user = get_user(card_id)
    existing = q1(
        "SELECT t.id, t.code, t.scheduled_time, u.first_name, u.last_name "
        "FROM tickets t LEFT JOIN users u ON u.card_id=t.card_id "
        "WHERE t.card_id=? AND t.picked_up=0 AND t.cancelled=0 ORDER BY t.scheduled_time ASC LIMIT 1",
        (card_id,),
    )
    active_count = q1(
        "SELECT COUNT(*) AS c FROM tickets WHERE card_id=? AND picked_up=0 AND cancelled=0",
        (card_id,)
    )["c"]
    evt = {
        "type": "scan",
        "now": now_ms(),
        "card_id": card_id,
        "em4100": em4100,
        "code_hint": make_code(card_id, em4100),
        "user": user,
        "active_count": active_count,
        "active_ticket": dict(existing) if existing else None,
    }
    log(f"Kart okundu: {card_id} (em4100 {em4100})"
        + (f" · {user['first_name']} (Bakiye: {user['balance']} Kredi)" if user else "")
        + (" · BLOKE" if user and user.get("is_blocked") else ""))
    broadcast(evt)


def record_remote_scan(card_id: str, raw_hex: str = ""):
    global _last_scan_id, _last_scan_ts
    card_id = card_id.strip().upper()
    try:
        payload = bytes.fromhex(card_id)
    except ValueError:
        return None, "card_id geçerli bir hex dizisi değil"
    em4100 = em4100_core(payload)

    t = time.time()
    if card_id == _last_scan_id and (t - _last_scan_ts) < SCAN_DEBOUNCE_S:
        _last_scan_ts = t
        return card_id, None
    _last_scan_id, _last_scan_ts = card_id, t
    emit_scan(card_id, em4100, (raw_hex or card_id).strip().upper())
    return card_id, None


def validate_and_create_ticket(card_id, scheduled_time, points=0, items_summary="Standart Tost"):
    scheduled_time = int(scheduled_time)
    points = int(points or 0)
    items_summary = (items_summary or "Standart Tost").strip()
    n = now_ms()

    user = get_user(card_id)
    if not user:
        return None, "Bu kart kayıtlı değil"

    if user.get("is_blocked"):
        return None, "Hesabınız yönetici tarafından engellenmiştir."

    if points > 0 and user["balance"] < points:
        return None, f"Yetersiz bakiye! Gerekli: {points} Kredi, Mevcut: {user['balance']} Kredi"

    if scheduled_time - n < SLOT_MS - 20000:
        return None, "Seçilen saat çok yakın"

    pos = -(-(scheduled_time - n) // SLOT_MS)
    for t in active_tickets():
        if t.get("cancelled"):
            continue
        rem = t["scheduled_time"] - n
        if rem > 0 and -(-rem // SLOT_MS) == pos:
            return None, "Bu saat dolu"

    em = q1("SELECT em4100 FROM card_reads WHERE card_id=? ORDER BY id DESC LIMIT 1", (card_id,))
    em4100 = em["em4100"] if em else ""
    code = make_code(card_id, em4100)

    with _db_lock:
        if points > 0:
            _conn.execute("UPDATE users SET balance = balance - ? WHERE card_id=?", (points, card_id))
        cur = _conn.execute(
            "INSERT INTO tickets (card_id, code, scheduled_time, created_at, points_spent, cancelled, items_summary) "
            "VALUES (?,?,?,?,?,0,?)",
            (card_id, code, scheduled_time, datetime.now().isoformat(timespec="seconds"), points, items_summary),
        )
        _conn.commit()

    row = q1(
        "SELECT id, card_id, code, scheduled_time, picked_up, points_spent, cancelled, items_summary "
        "FROM tickets WHERE id=?",
        (cur.lastrowid,)
    )
    log(f"Sipariş oluşturuldu: #{code} ({card_id}) - '{items_summary}' - {points} Kredi. Kalan: {user['balance'] - points}")
    return dict(row), None


def upsert_user(card_id, first_name, last_name):
    first_name = (first_name or "").strip()
    last_name = (last_name or "").strip()
    if not first_name or not last_name:
        return None, "İsim ve soyisim gerekli"
    ts = datetime.now().isoformat(timespec="seconds")
    next_reset = (datetime.now() + timedelta(days=30)).isoformat(timespec="seconds")
    execute(
        "INSERT INTO users (card_id, first_name, last_name, created_at, updated_at, balance, monthly_quota, is_blocked, quota_reset_date) "
        "VALUES (?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(card_id) DO UPDATE SET first_name=excluded.first_name, "
        "last_name=excluded.last_name, updated_at=excluded.updated_at",
        (card_id, first_name, last_name, ts, ts, DEFAULT_MONTHLY_QUOTA, DEFAULT_MONTHLY_QUOTA, 0, next_reset),
    )
    return get_user(card_id), None


# --------------------------------------------------------------------------
# HTTP İşleyici
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
        pass

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
        given = self.headers.get("X-Admin-Token", "")
        if secrets.compare_digest(given, ADMIN_TOKEN):
            return True
        self._send_json({"ok": False, "error": "Geçersiz veya eksik X-Admin-Token"}, 401)
        return False

    def _serve_from_dir(self, base_dir, path):
        """Verilen dizinden bir dosya sunmayi dener. Basarili olursa True,
        dosya orada yoksa hicbir sey yazmadan False doner (baska bir dizin
        denenebilsin diye)."""
        if path in ("/", ""):
            path = "/index.html"
        rel = path.lstrip("/")
        full = os.path.normpath(os.path.join(base_dir, rel))
        if not full.startswith(base_dir) or not os.path.isfile(full):
            return False
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
        return True

    def _serve_static(self, path):
        # React'in derlenmis mobil takip sayfasi (dist/) once denenir - QR
        # kodundan gelen telefonlar buraya dusuyor (MobileTrackView, ayni
        # portta/origin'de calissin diye). Orada yoksa eski backend/static
        # (arsiv vanilla JS uygulamasi + admin.html) denenir.
        if self._serve_from_dir(REACT_DIST_DIR, path):
            return
        if self._serve_from_dir(STATIC_DIR, path):
            return
        self.send_error(404)

    def do_GET(self):
        u = urlparse(self.path)
        p = u.path

        if p == "/api/version":
            deb_dir = os.path.normpath(os.path.join(HERE, "..", "frontend-react", "release"))
            latest_ver = None
            if os.path.isdir(deb_dir):
                debs = [f for f in os.listdir(deb_dir) if f.endswith(".deb")]
                if debs:
                    debs.sort(key=lambda x: os.path.getmtime(os.path.join(deb_dir, x)), reverse=True)
                    parts = debs[0].split("_")
                    if len(parts) >= 2:
                        latest_ver = parts[1]
            return self._send_json({"ok": True, "latest_version": latest_ver})

        if p == "/release/latest.deb":
            deb_dir = os.path.normpath(os.path.join(HERE, "..", "frontend-react", "release"))
            if os.path.isdir(deb_dir):
                debs = [f for f in os.listdir(deb_dir) if f.endswith(".deb")]
                if debs:
                    debs.sort(key=lambda x: os.path.getmtime(os.path.join(deb_dir, x)), reverse=True)
                    latest_deb = os.path.join(deb_dir, debs[0])
                    with open(latest_deb, "rb") as f:
                        data = f.read()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/vnd.debian.binary-package")
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("Content-Disposition", 'attachment; filename="latest.deb"')
                    self.end_headers()
                    self.wfile.write(data)
                    return
            self.send_error(404, "Debian paketi bulunamadı")
            return

        if p == "/events":
            return self._sse()

        if p == "/api/state":
            return self._send_json(state_payload())

        if p == "/api/stock":
            with _stock_lock:
                return self._send_json({"out_of_stock": list(_out_of_stock)})

        if p == "/api/user":
            qs = parse_qs(u.query)
            cid = (qs.get("card_id") or [""])[0]
            return self._send_json({"user": get_user(cid)})

        if p == "/api/profile":
            qs = parse_qs(u.query)
            cid = (qs.get("card_id") or [""])[0].strip().upper()
            profile = get_profile(cid)
            if not profile:
                return self._send_json({"ok": False, "error": "Bu kart için profil bulunamadı"}, 404)
            return self._send_json({"ok": True, "profile": profile})

        if p == "/api/health":
            return self._send_json({"ok": True, "now": now_ms()})

        if p == "/api/ticket-status":
            qs = parse_qs(u.query)
            tid = (qs.get("id") or [""])[0]
            if not tid.isdigit():
                return self._send_json({"ok": False, "error": "Geçersiz bilet id"}, 400)
            row = q1(
                "SELECT id, code, scheduled_time, picked_up, cancelled FROM tickets WHERE id=?",
                (int(tid),)
            )
            if not row:
                return self._send_json({"ok": True, "status": "not_found"})
            t = dict(row)
            n = now_ms()
            if t["cancelled"]:
                status = "cancelled"
            elif t["picked_up"]:
                status = "picked_up"
            elif t["scheduled_time"] <= n:
                status = "ready"
            else:
                status = "active"
            return self._send_json({
                "ok": True,
                "status": status,
                "code": t["code"],
                "scheduled_time": t["scheduled_time"],
                "now": n,
            })

        if p == "/api/admin/data":
            if not self._admin_ok():
                return
            return self._send_json({
                "now": now_ms(),
                "users": [dict(r) for r in q(
                    "SELECT card_id, first_name, last_name, created_at, updated_at, balance, monthly_quota, is_blocked, quota_reset_date "
                    "FROM users ORDER BY created_at DESC")],
                "tickets": [dict(r) for r in q(
                    "SELECT id, card_id, code, scheduled_time, picked_up, created_at, picked_up_at, points_spent, cancelled, cancelled_at, items_summary "
                    "FROM tickets ORDER BY id DESC")],
                "card_reads": [dict(r) for r in q(
                    "SELECT id, ts, card_id, em4100, raw_hex FROM card_reads ORDER BY id DESC LIMIT 200")],
                "account_deletion_requests": [dict(r) for r in q(
                    "SELECT r.id, r.card_id, r.created_at, r.status, r.resolved_at, "
                    "u.first_name, u.last_name "
                    "FROM account_deletion_requests r LEFT JOIN users u ON u.card_id=r.card_id "
                    "ORDER BY r.created_at DESC")],
                "counts": {
                    "users": q1("SELECT COUNT(*) c FROM users")["c"],
                    "tickets": q1("SELECT COUNT(*) c FROM tickets")["c"],
                    "tickets_active": q1("SELECT COUNT(*) c FROM tickets WHERE picked_up=0 AND cancelled=0")["c"],
                    "card_reads": q1("SELECT COUNT(*) c FROM card_reads")["c"],
                },
                # Admin panelinin gercekten AYNI veritabanini okudugunu somut
                # olarak gostermek icin - bagimsiz/mock bir kaynak degil.
                "db_info": {
                    "path": DB_PATH,
                    "size_bytes": os.path.getsize(DB_PATH) if os.path.isfile(DB_PATH) else 0,
                    "default_monthly_quota": DEFAULT_MONTHLY_QUOTA,
                },
            })

        return self._serve_static(p)

    def do_POST(self):
        u = urlparse(self.path)
        p = u.path
        body = self._read_json()

        # Sipariş İptal Rotası
        if p == "/api/order/cancel":
            tid = body.get("ticket_id")
            card_id = (body.get("card_id") or "").strip().upper()

            t = q1("SELECT * FROM tickets WHERE id=? AND picked_up=0 AND cancelled=0", (tid,))
            if not t:
                return self._send_json({"ok": False, "error": "Geçerli sipariş bulunamadı"}, 404)

            if card_id and t["card_id"].strip().upper() != card_id:
                return self._send_json({"ok": False, "error": "Bu sipariş bu karta ait değil"}, 403)

            t_card_id = t["card_id"]
            rem_ms = t["scheduled_time"] - now_ms()
            if rem_ms <= 5 * 60 * 1000:
                return self._send_json({"ok": False, "error": "Hazırlık aşamasına geçen siparişler (son 5 dk) iptal edilemez!"}, 400)

            now_iso = datetime.now().isoformat(timespec="seconds")
            with _db_lock:
                _conn.execute("UPDATE tickets SET cancelled=1, cancelled_at=? WHERE id=?", (now_iso, tid))
                if t["points_spent"] and t["points_spent"] > 0:
                    _conn.execute("UPDATE users SET balance=balance+? WHERE card_id=?", (t["points_spent"], t_card_id))
                _conn.commit()

            log(f"Sipariş İptal Edildi: #{t['code']} ({t_card_id}) - {t['points_spent']} Kredi iade edildi.")
            broadcast_state()
            return self._send_json({"ok": True, "refunded_points": t["points_spent"]})

        # Admin: Bakiye güncelleme
        if p == "/api/admin/user/balance":
            if not self._admin_ok():
                return
            card_id = (body.get("card_id") or "").strip().upper()
            balance = body.get("balance")
            quota = body.get("monthly_quota")
            if not card_id or balance is None:
                return self._send_json({"ok": False, "error": "card_id ve balance gerekli"}, 400)
            if quota is not None:
                execute("UPDATE users SET balance=?, monthly_quota=? WHERE card_id=?", (int(balance), int(quota), card_id))
            else:
                execute("UPDATE users SET balance=? WHERE card_id=?", (int(balance), card_id))
            log(f"ADMIN: Bakiye güncellendi: {card_id} -> {balance} Kredi")
            return self._send_json({"ok": True, "user": get_user(card_id)})

        # Admin: kullanıcı — TAM DÜZENLEME (isim, bakiye, limit, yenilenme
        # tarihi, engel — verilen alanlardan hangisi varsa o güncellenir).
        if p == "/api/admin/user/update":
            if not self._admin_ok():
                return
            card_id = (body.get("card_id") or "").strip().upper()
            if not card_id or not get_user(card_id):
                return self._send_json({"ok": False, "error": "Kullanıcı bulunamadı"}, 404)
            fields, values = [], []
            if "first_name" in body:
                fields.append("first_name=?"); values.append(str(body["first_name"]).strip())
            if "last_name" in body:
                fields.append("last_name=?"); values.append(str(body["last_name"]).strip())
            if "balance" in body:
                fields.append("balance=?"); values.append(int(body["balance"]))
            if "monthly_quota" in body:
                fields.append("monthly_quota=?"); values.append(int(body["monthly_quota"]))
            if "quota_reset_date" in body:
                fields.append("quota_reset_date=?"); values.append(body["quota_reset_date"])
            if "is_blocked" in body:
                fields.append("is_blocked=?"); values.append(1 if body["is_blocked"] else 0)
            if not fields:
                return self._send_json({"ok": False, "error": "Güncellenecek alan yok"}, 400)
            fields.append("updated_at=?")
            values.append(datetime.now().isoformat(timespec="seconds"))
            values.append(card_id)
            execute(f"UPDATE users SET {', '.join(fields)} WHERE card_id=?", tuple(values))
            log(f"ADMIN: Kullanıcı güncellendi: {card_id} -> {list(body.keys())}")
            broadcast_state()
            return self._send_json({"ok": True, "user": get_user(card_id)})

        # Admin: kredi limitini ŞİMDİ yenile (bakiye=limit, sayaç 30 gün
        # ileri) — normal aylık otomatik yenilemeyi elle tetiklemek icin.
        if p == "/api/admin/user/renew-quota":
            if not self._admin_ok():
                return
            card_id = (body.get("card_id") or "").strip().upper()
            user = get_user(card_id)
            if not user:
                return self._send_json({"ok": False, "error": "Kullanıcı bulunamadı"}, 404)
            next_reset = (datetime.now() + timedelta(days=30)).isoformat(timespec="seconds")
            execute("UPDATE users SET balance=monthly_quota, quota_reset_date=? WHERE card_id=?",
                    (next_reset, card_id))
            log(f"ADMIN: Kredi limiti manuel yenilendi: {card_id} -> {user['monthly_quota']} Kredi")
            return self._send_json({"ok": True, "user": get_user(card_id)})

        # Admin: bilet — TAM DÜZENLEME (kod, hedef saat, sipariş içeriği,
        # harcanan puan, teslim/iptal bayrakları — verilen alanlar güncellenir).
        if p == "/api/admin/ticket/update":
            if not self._admin_ok():
                return
            tid = body.get("ticket_id")
            t = q1("SELECT * FROM tickets WHERE id=?", (tid,))
            if not t:
                return self._send_json({"ok": False, "error": "Bilet bulunamadı"}, 404)
            fields, values = [], []
            if "code" in body:
                fields.append("code=?"); values.append(str(body["code"]).strip())
            if "scheduled_time" in body:
                fields.append("scheduled_time=?"); values.append(int(body["scheduled_time"]))
            if "items_summary" in body:
                fields.append("items_summary=?"); values.append(str(body["items_summary"]).strip())
            if "points_spent" in body:
                fields.append("points_spent=?"); values.append(int(body["points_spent"]))
            if "picked_up" in body:
                fields.append("picked_up=?"); values.append(1 if body["picked_up"] else 0)
            if "cancelled" in body:
                fields.append("cancelled=?"); values.append(1 if body["cancelled"] else 0)
            if not fields:
                return self._send_json({"ok": False, "error": "Güncellenecek alan yok"}, 400)
            values.append(tid)
            execute(f"UPDATE tickets SET {', '.join(fields)} WHERE id=?", tuple(values))
            log(f"ADMIN: Bilet güncellendi: #{t['code']} (id={tid}) -> {list(body.keys())}")
            broadcast_state()
            return self._send_json({"ok": True})

        # Admin: Blokaj güncelleme
        if p == "/api/admin/user/block":
            if not self._admin_ok():
                return
            card_id = (body.get("card_id") or "").strip().upper()
            is_blocked = 1 if body.get("is_blocked") else 0
            execute("UPDATE users SET is_blocked=? WHERE card_id=?", (is_blocked, card_id))
            log(f"ADMIN: Blokaj değişti: {card_id} -> is_blocked={is_blocked}")
            return self._send_json({"ok": True, "user": get_user(card_id)})

        # Admin: Stok güncelleme
        if p == "/api/admin/stock":
            if not self._admin_ok():
                return
            new_out = body.get("out_of_stock", [])
            global _out_of_stock
            with _stock_lock:
                _out_of_stock = set(new_out)
            broadcast_state()
            log(f"ADMIN: Stok güncellendi: {len(_out_of_stock)} ürün tükendi.")
            return self._send_json({"ok": True, "out_of_stock": list(_out_of_stock)})

        # Admin: tekil bilet iptali — normal /api/order/cancel'dan farkı,
        # kart eşleşmesi ve "son 5 dk" kısıtlaması aranmaz (admin override),
        # yine de puan iadesi yapılır.
        if p == "/api/admin/ticket/cancel":
            if not self._admin_ok():
                return
            tid = body.get("ticket_id")
            t = q1("SELECT * FROM tickets WHERE id=? AND picked_up=0 AND cancelled=0", (tid,))
            if not t:
                return self._send_json({"ok": False, "error": "Geçerli sipariş bulunamadı"}, 404)
            now_iso = datetime.now().isoformat(timespec="seconds")
            with _db_lock:
                _conn.execute("UPDATE tickets SET cancelled=1, cancelled_at=? WHERE id=?", (now_iso, tid))
                if t["points_spent"] and t["points_spent"] > 0:
                    _conn.execute("UPDATE users SET balance=balance+? WHERE card_id=?", (t["points_spent"], t["card_id"]))
                _conn.commit()
            log(f"ADMIN: Sipariş iptal edildi: #{t['code']} ({t['card_id']}) - {t['points_spent']} Kredi iade edildi.")
            broadcast_state()
            return self._send_json({"ok": True, "refunded_points": t["points_spent"]})

        # Admin: hesap kapatma talebini sonuçlandır (onayla=kullanıcıyı sil,
        # reddet=talebi 'rejected' işaretle, kullanıcı kalır).
        if p == "/api/admin/account-deletion-request/resolve":
            if not self._admin_ok():
                return
            rid = body.get("id")
            action = body.get("action")
            if action not in ("approve", "reject"):
                return self._send_json({"ok": False, "error": "action 'approve' ya da 'reject' olmali"}, 400)
            req = q1("SELECT * FROM account_deletion_requests WHERE id=?", (rid,))
            if not req:
                return self._send_json({"ok": False, "error": "Talep bulunamadi"}, 404)
            now_iso = datetime.now().isoformat(timespec="seconds")
            with _db_lock:
                if action == "approve":
                    _conn.execute("DELETE FROM users WHERE card_id=?", (req["card_id"],))
                    _conn.execute(
                        "UPDATE account_deletion_requests SET status='approved', resolved_at=? WHERE id=?",
                        (now_iso, rid),
                    )
                else:
                    _conn.execute(
                        "UPDATE account_deletion_requests SET status='rejected', resolved_at=? WHERE id=?",
                        (now_iso, rid),
                    )
                _conn.commit()
            log(f"ADMIN: Hesap kapatma talebi #{rid} ({req['card_id']}) -> {action}")
            return self._send_json({"ok": True})

        if p == "/api/card-scan":
            card_id = (body.get("card_id") or "").strip()
            raw_hex = (body.get("raw_hex") or "").strip()
            if not card_id:
                return self._send_json({"ok": False, "error": "card_id gerekli"}, 400)
            result, err = record_remote_scan(card_id, raw_hex)
            if err:
                return self._send_json({"ok": False, "error": err}, 400)
            return self._send_json({"ok": True, "card_id": result})

        if p == "/api/order":
            ticket, err = validate_and_create_ticket(
                body.get("card_id", ""),
                body.get("scheduled_time", 0),
                body.get("points", 0),
                body.get("items_summary", "Standart Tost")
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

        if p == "/api/account-deletion-request":
            card_id = (body.get("card_id") or "").strip().upper()
            if not card_id or not get_user(card_id):
                return self._send_json({"ok": False, "error": "Kayıtlı kullanıcı bulunamadı"}, 404)
            pending = q1(
                "SELECT id FROM account_deletion_requests "
                "WHERE card_id=? AND status='pending' ORDER BY id DESC LIMIT 1",
                (card_id,),
            )
            if pending:
                return self._send_json({"ok": True, "already_requested": True})
            execute(
                "INSERT INTO account_deletion_requests(card_id, created_at, status) VALUES (?,?,?)",
                (card_id, datetime.now().isoformat(timespec="seconds"), "pending"),
            )
            log(f"Hesap kapatma isteği: {card_id}")
            return self._send_json({"ok": True, "already_requested": False})

        if p == "/api/pickup":
            tid = body.get("ticket_id")
            card_id = body.get("card_id")
            if tid:
                execute(
                    "UPDATE tickets SET picked_up=1, picked_up_at=? WHERE id=? AND picked_up=0",
                    (datetime.now().isoformat(timespec="seconds"), tid),
                )
            elif card_id:
                execute(
                    "UPDATE tickets SET picked_up=1, picked_up_at=? WHERE card_id=? AND picked_up=0",
                    (datetime.now().isoformat(timespec="seconds"), card_id),
                )
            broadcast_state()
            return self._send_json({"ok": True})

        # İptal edilen bir bileti panoda GÖRÜLÜR GÖRÜLMEZ (45 sn'lik doğal
        # pencereyi beklemeden) kaldırmak için — kiosk'ta kırmızı karta
        # dokununca çağrılır. active_tickets()'in zaten kullandığı
        # cancelled_at penceresini geriye alarak filtreden düşürüyor,
        # ayrı bir şema/alan gerekmiyor.
        if p == "/api/ticket/dismiss":
            tid = body.get("ticket_id")
            t = q1("SELECT id, cancelled FROM tickets WHERE id=?", (tid,))
            if not t or not t["cancelled"]:
                return self._send_json({"ok": False, "error": "İptal edilmiş bilet bulunamadı"}, 404)
            past = (datetime.now() - timedelta(seconds=60)).isoformat(timespec="seconds")
            execute("UPDATE tickets SET cancelled_at=? WHERE id=?", (past, tid))
            broadcast_state()
            return self._send_json({"ok": True})

        # /api/dev/* — hepsi ADMIN token gerektirir. Backend artık genel
        # internete tunel ile acik oldugu icin (mobil QR takip), bu test/
        # debug uclari (veri silme, sahte kart okuma, saat oynatma) token'siz
        # birakilamaz - herhangi biri tunel adresini bulup tum veritabanini
        # silebilirdi.
        if p == "/api/dev/scan":
            if not self._admin_ok():
                return
            cid = (body.get("card_id") or "0040805A2D626F6B04").upper()
            em = (body.get("em4100") or (cid[6:16] if len(cid) >= 16 else cid)).upper()
            emit_scan(cid, em, cid)
            return self._send_json({"ok": True, "card_id": cid})

        # Kiosk'taki "test" panelinin butonları — kullanıcının açık isteğiyle
        # token'sız bırakıldı (yalnızca zaman ilerletme + bilet/okuma
        # silme; kullanıcı verisi silmiyor). Daha riskli olan reset-all ve
        # scan admin token istemeye devam ediyor.
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
            log("DEV: Tüm biletler ve okumalar silindi, zaman ofseti sıfırlandı.")
            return self._send_json({"ok": True})

        if p == "/api/dev/reset-all":
            if not self._admin_ok():
                return
            with _offset_lock:
                _time_offset_ms = 0
            execute("DELETE FROM tickets")
            execute("DELETE FROM card_reads")
            execute("DELETE FROM users")
            broadcast_state()
            log("DEV: Biletler, okumalar ve kayıtlı kartlar silindi, sistem sıfırlandı.")
            return self._send_json({"ok": True})

        self.send_error(404)

    def do_DELETE(self):
        p = urlparse(self.path).path
        parts = [x for x in p.split("/") if x]

        if len(parts) == 3 and parts[0] == "api" and parts[1] == "tickets":
            if not self._admin_ok():
                return
            try:
                tid = int(parts[2])
            except ValueError:
                return self._send_json({"ok": False, "error": "Geçersiz id"}, 400)
            cur = execute("DELETE FROM tickets WHERE id=?", (tid,))
            broadcast_state()
            return self._send_json({"ok": True, "deleted": cur.rowcount})

        if len(parts) == 3 and parts[0] == "api" and parts[1] == "users":
            if not self._admin_ok():
                return
            from urllib.parse import unquote
            card_id = unquote(parts[2])
            cur = execute("DELETE FROM users WHERE card_id=?", (card_id,))
            return self._send_json({"ok": True, "deleted": cur.rowcount})

        self.send_error(404)

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
        log("Kapatılıyor...")
        os._exit(0)

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    db_init()
    log(f"DB: {DB_PATH}")
    log(f"Admin Token: {ADMIN_TOKEN}  ({_TOKEN_FILE})")

    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    log(f"http://{HOST}:{PORT}  (Statik: {STATIC_DIR})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()