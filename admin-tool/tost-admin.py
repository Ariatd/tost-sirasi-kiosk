#!/usr/bin/env python3
"""
Tost Sırası — Yönetici Paneli (Admin & Aşçı & Stok).

Stdlib-only (tkinter/ttk) masaüstü uygulaması — backend'in /api/admin/data
uç noktasını tek kaynak olarak kullanır; stok, biletler, kullanıcılar,
hesap kapatma talepleri ve kart okuma geçmişi tek yerden yönetilir.
"""
import json
import os
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime

import tkinter as tk
from tkinter import ttk, messagebox, simpledialog

BASE_URL = os.environ.get("TOST_ADMIN_URL", "http://127.0.0.1:8080").rstrip("/")
ADMIN_TOKEN = os.environ.get("TOST_ADMIN_TOKEN", "")
AUTO_REFRESH_MS = 4000
HTTP_TIMEOUT = 6

# Kiosk App.jsx menüsündeki tüm seçeneklerle birebir aynı
MENU_CATEGORIES = {
    "🥪 Standart Tostlar": [
        'Sucuklu', 'Patatesli', 'Kaşarlı (Sade)', 'Kavurmalı',
        'Ton Balıklı', 'Yumurtalı', 'Karışık', 'Vejetaryen'
    ],
    "🍞 Ekmek Türleri": [
        'Tam Buğday', 'Kepekli', 'Beyaz Ekmek', 'Susamlı'
    ],
    "🥩 İç Malzemeler": [
        'Sucuk', 'Kavurma', 'Ton Balığı', 'Yumurta',
        'Kızartılmış Patates', 'Salam', 'Sosis'
    ],
    "🧀 Peynir İlavesi": [
        'Kaşar Peyniri', 'Cheddar Peyniri', 'Peynir İstemiyorum'
    ],
    "🥗 Yeşillik & İlaveler": [
        'Salatalık', 'Avokado', 'Marul', 'Zeytin', 'Mısır', 'Patates Püresi', 'Brokoli'
    ],
    "🥫 Sos & Tercih": [
        'Özel Sos', 'Organik İlaveli'
    ]
}

if not ADMIN_TOKEN:
    print("HATA: TOST_ADMIN_TOKEN ayarlanmamış.", file=sys.stderr)
    sys.exit(1)

# --------------------------------------------------------------------------
# Renk paleti (kiosk'un amber/koyu kimliğiyle tutarlı)
# --------------------------------------------------------------------------
BG_DEEP = "#17110d"
BG_SURFACE = "#211810"
BG_SURFACE2 = "#2a1f15"
BORDER = "#3a2c20"
TEXT = "#f5ede3"
TEXT_MUTED = "#a6957f"
AMBER = "#e08c34"
AMBER_DARK = "#b56f28"
SUCCESS = "#22c55e"
DANGER = "#ef4444"
WARNING = "#f59e0b"
INFO = "#38bdf8"


def api(method, path, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        BASE_URL + path, method=method, data=data,
        headers={"X-Admin-Token": ADMIN_TOKEN, "Accept": "application/json", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
            raw = r.read().decode("utf-8") or "{}"
        return True, json.loads(raw)
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read().decode("utf-8")).get("error", str(e))
        except Exception:
            detail = str(e)
        return False, detail
    except Exception as e:
        return False, str(e)


def fmt_time(ms):
    try:
        return datetime.fromtimestamp(int(ms) / 1000).strftime("%d.%m %H:%M")
    except Exception:
        return str(ms or "")


def fmt_iso(s):
    return (s or "").replace("T", " ")[:16]


def ticket_status(t):
    """(etiket, tag) — backend'in /api/ticket-status ile aynı 4 durumu ayırt eder."""
    if t.get("cancelled"):
        return "İptal Edildi", "cancelled"
    if t.get("picked_up"):
        return "Teslim Alındı", "picked_up"
    try:
        left = int(t["scheduled_time"]) / 1000 - datetime.now().timestamp()
    except Exception:
        return "?", ""
    if left <= 0:
        return "HAZIR", "ready"
    mins = int(left // 60) + 1
    return f"{mins} dk sonra", "active"


class FormDialog(tk.Toplevel):
    """Ortak form penceresi altyapısı — alt sınıflar _build() ile alanlarını ekler."""

    def __init__(self, parent, title):
        super().__init__(parent)
        self.result = None
        self.title(title)
        self.configure(bg=BG_SURFACE)
        self.resizable(False, False)
        self.transient(parent)
        self.grab_set()
        self._parent = parent
        self._row = 0

    def _label(self, text, wide=False):
        tk.Label(self, text=text, bg=BG_SURFACE, fg=TEXT_MUTED if wide else TEXT,
                 font=("TkDefaultFont", 8) if wide else ("TkDefaultFont", 10),
                 justify="left", wraplength=340 if wide else 0).grid(
            row=self._row, column=0, columnspan=2 if wide else 1,
            sticky="w" if wide else "e", padx=16, pady=6)
        if not wide:
            return self._row

    def add_text(self, label, value):
        r = self._row
        self._label(label)
        var = tk.StringVar(value="" if value is None else str(value))
        ttk.Entry(self, textvariable=var, width=26).grid(row=r, column=1, sticky="w", padx=16, pady=6)
        self._row += 1
        return var

    def add_check(self, label, value):
        r = self._row
        var = tk.BooleanVar(value=bool(value))
        ttk.Checkbutton(self, text=label, variable=var).grid(
            row=r, column=0, columnspan=2, sticky="w", padx=16, pady=6)
        self._row += 1
        return var

    def add_note(self, text):
        self._label(text, wide=True)
        self._row += 1

    def add_buttons(self, extra=None):
        btns = tk.Frame(self, bg=BG_SURFACE)
        btns.grid(row=self._row, column=0, columnspan=2, pady=(10, 14))
        self._row += 1
        ttk.Button(btns, text="Kaydet", style="Amber.TButton", command=self._on_save).pack(side="left", padx=6)
        ttk.Button(btns, text="Vazgeç", command=self.destroy).pack(side="left", padx=6)
        if extra:
            text, cmd = extra
            ttk.Button(btns, text=text, command=cmd).pack(side="left", padx=6)
        self.bind("<Return>", lambda _e: self._on_save())
        self.bind("<Escape>", lambda _e: self.destroy())
        self.update_idletasks()
        x = self._parent.winfo_rootx() + self._parent.winfo_width() // 2 - self.winfo_width() // 2
        y = self._parent.winfo_rooty() + self._parent.winfo_height() // 2 - self.winfo_height() // 2
        self.geometry(f"+{max(x, 0)}+{max(y, 0)}")

    def _on_save(self):
        try:
            self.result = self.collect()
        except ValueError as e:
            messagebox.showerror("Geçersiz değer", str(e))
            return
        self.destroy()

    def collect(self):
        raise NotImplementedError


class UserEditDialog(FormDialog):
    """Kullanıcının TÜM alanları: isim, bakiye, aylık kredi limiti, limit
    yenilenme tarihi, engel durumu — hepsi doğrudan düzenlenebilir."""

    def __init__(self, parent, user, on_renew_now):
        super().__init__(parent, "Kullanıcıyı Düzenle")
        card_id = user["card_id"]
        tk.Label(self, text=card_id, bg=BG_SURFACE, fg=TEXT_MUTED, font=("TkDefaultFont", 9)).grid(
            row=self._row, column=0, columnspan=2, sticky="w", padx=16, pady=(10, 0))
        self._row += 1

        self.first_var = self.add_text("Ad:", user.get("first_name", ""))
        self.last_var = self.add_text("Soyad:", user.get("last_name", ""))
        self.balance_var = self.add_text("Bakiye (şu an harcanabilir):", user.get("balance", 0))
        self.quota_var = self.add_text("Aylık Kredi Limiti:", user.get("monthly_quota", 0))
        self.reset_var = self.add_text("Limit Yenilenme Tarihi (YYYY-AA-GG SS:DD):",
                                        fmt_iso(user.get("quota_reset_date")))
        self.blocked_var = self.add_check("Engelli (sipariş veremez)", user.get("is_blocked"))
        self.add_note("Limit yenilenme tarihi geldiğinde bakiye otomatik olarak "
                       "aylık limite sıfırlanır. \"Limiti Şimdi Yenile\" bunu anında "
                       "(bakiye=limit, sayaç 30 gün ileri) tetikler.")

        def renew_now():
            if messagebox.askyesno("Limiti Şimdi Yenile",
                                    f"{card_id} için bakiye limite sıfırlanıp sayaç 30 gün ileri alınsın mı?"):
                on_renew_now(card_id)
                self.destroy()

        self.add_buttons(extra=("🔄 Limiti Şimdi Yenile", renew_now))

    def collect(self):
        try:
            balance = int(self.balance_var.get())
            quota = int(self.quota_var.get())
        except ValueError:
            raise ValueError("Bakiye ve kredi limiti tam sayı olmalı.")
        reset_raw = self.reset_var.get().strip()
        reset_iso = None
        if reset_raw:
            try:
                reset_iso = datetime.strptime(reset_raw, "%Y-%m-%d %H:%M").isoformat(timespec="seconds")
            except ValueError:
                raise ValueError("Yenilenme tarihi 'YYYY-AA-GG SS:DD' biçiminde olmalı (ör. 2026-10-23 14:00).")
        return {
            "first_name": self.first_var.get().strip(),
            "last_name": self.last_var.get().strip(),
            "balance": balance,
            "monthly_quota": quota,
            "quota_reset_date": reset_iso,
            "is_blocked": self.blocked_var.get(),
        }


class TicketEditDialog(FormDialog):
    """Biletin TÜM alanları: kod, hedef saat, sipariş içeriği, harcanan
    puan, teslim/iptal durumu — hepsi doğrudan düzenlenebilir."""

    def __init__(self, parent, ticket):
        super().__init__(parent, f"Bilet #{ticket['code']} — Düzenle")
        sched_str = datetime.fromtimestamp(ticket["scheduled_time"] / 1000).strftime("%Y-%m-%d %H:%M")
        self.code_var = self.add_text("Bilet Kodu:", ticket.get("code", ""))
        self.sched_var = self.add_text("Hedef Saat (YYYY-AA-GG SS:DD):", sched_str)
        self.items_var = self.add_text("Sipariş İçeriği:", ticket.get("items_summary", ""))
        self.points_var = self.add_text("Harcanan Puan:", ticket.get("points_spent", 0))
        self.picked_var = self.add_check("Teslim Alındı", ticket.get("picked_up"))
        self.cancelled_var = self.add_check("İptal Edildi", ticket.get("cancelled"))
        self.add_note("Hedef saati değiştirmek, siparişin hazır sayılacağı ve "
                       "takvim/QR takip ekranındaki geri sayımın hedeflediği anı değiştirir.")
        self.add_buttons()

    def collect(self):
        try:
            points = int(self.points_var.get())
        except ValueError:
            raise ValueError("Harcanan puan tam sayı olmalı.")
        try:
            sched_dt = datetime.strptime(self.sched_var.get().strip(), "%Y-%m-%d %H:%M")
        except ValueError:
            raise ValueError("Hedef saat 'YYYY-AA-GG SS:DD' biçiminde olmalı (ör. 2026-09-23 14:30).")
        return {
            "code": self.code_var.get().strip(),
            "scheduled_time": int(sched_dt.timestamp() * 1000),
            "items_summary": self.items_var.get().strip(),
            "points_spent": points,
            "picked_up": self.picked_var.get(),
            "cancelled": self.cancelled_var.get(),
        }


class AdminApp:
    def __init__(self, root):
        self.root = root
        self.data = {"users": [], "tickets": [], "card_reads": [], "account_deletion_requests": [], "counts": {}}
        self.stock = []
        self._busy = False

        root.title("Tost Sırası — Yönetici Paneli")
        root.geometry("1280x820")
        root.minsize(980, 600)
        root.configure(bg=BG_DEEP)

        self._setup_style()
        self._build_header()
        self._build_notebook()
        self._build_statusbar()

        self.refresh()
        self._auto_tick()

    # -----------------------------------------------------------------
    # Görünüm
    # -----------------------------------------------------------------
    def _setup_style(self):
        style = ttk.Style(self.root)
        try:
            style.theme_use("clam")
        except Exception:
            pass

        style.configure(".", background=BG_DEEP, foreground=TEXT, fieldbackground=BG_SURFACE,
                         font=("TkDefaultFont", 10))
        style.configure("TFrame", background=BG_DEEP)
        style.configure("Header.TFrame", background=BG_SURFACE)
        style.configure("TLabel", background=BG_DEEP, foreground=TEXT)
        style.configure("Header.TLabel", background=BG_SURFACE, foreground=TEXT)
        style.configure("Muted.TLabel", background=BG_DEEP, foreground=TEXT_MUTED)
        style.configure("HeaderMuted.TLabel", background=BG_SURFACE, foreground=TEXT_MUTED)
        style.configure("Stat.TLabel", background=BG_SURFACE, foreground=AMBER, font=("TkDefaultFont", 15, "bold"))
        style.configure("StatCaption.TLabel", background=BG_SURFACE, foreground=TEXT_MUTED, font=("TkDefaultFont", 9))

        style.configure("TNotebook", background=BG_DEEP, borderwidth=0)
        style.configure("TNotebook.Tab", background=BG_SURFACE2, foreground=TEXT_MUTED,
                         padding=(14, 8), font=("TkDefaultFont", 10, "bold"))
        style.map("TNotebook.Tab",
                  background=[("selected", AMBER)],
                  foreground=[("selected", "#1c1208")])

        style.configure("TButton", background=BG_SURFACE2, foreground=TEXT, borderwidth=0,
                         focuscolor=BG_SURFACE2, padding=(10, 6))
        style.map("TButton", background=[("active", BORDER)])
        style.configure("Amber.TButton", background=AMBER, foreground="#1c1208", padding=(10, 6))
        style.map("Amber.TButton", background=[("active", AMBER_DARK)])
        style.configure("Danger.TButton", background=DANGER, foreground="#210a0a", padding=(10, 6))
        style.map("Danger.TButton", background=[("active", "#b91c1c")])
        style.configure("Success.TButton", background=SUCCESS, foreground="#08210f", padding=(10, 6))
        style.map("Success.TButton", background=[("active", "#15803d")])

        style.configure("TEntry", fieldbackground=BG_SURFACE, foreground=TEXT, insertcolor=TEXT,
                         bordercolor=BORDER)
        style.configure("TLabelframe", background=BG_DEEP, bordercolor=BORDER)
        style.configure("TLabelframe.Label", background=BG_DEEP, foreground=TEXT_MUTED)
        style.configure("TCheckbutton", background=BG_DEEP, foreground=TEXT)
        style.map("TCheckbutton", background=[("active", BG_DEEP)])

        style.configure("Treeview", background=BG_SURFACE, fieldbackground=BG_SURFACE, foreground=TEXT,
                         rowheight=28, borderwidth=0, font=("TkDefaultFont", 10))
        style.configure("Treeview.Heading", background=BG_SURFACE2, foreground=TEXT_MUTED,
                         borderwidth=0, font=("TkDefaultFont", 9, "bold"))
        style.map("Treeview", background=[("selected", AMBER_DARK)], foreground=[("selected", "#fff")])
        style.configure("Vertical.TScrollbar", background=BG_SURFACE2, troughcolor=BG_DEEP, bordercolor=BG_DEEP)

    def _build_header(self):
        bar = tk.Frame(self.root, bg=BG_SURFACE, padx=16, pady=10)
        bar.pack(fill="x")

        left = tk.Frame(bar, bg=BG_SURFACE)
        left.pack(side="left")
        tk.Label(left, text="🍞 Tost Sırası", bg=BG_SURFACE, fg=TEXT,
                 font=("TkDefaultFont", 15, "bold")).pack(anchor="w")
        self.conn_label = tk.Label(left, text="● bağlanıyor…", bg=BG_SURFACE, fg=TEXT_MUTED,
                                    font=("TkDefaultFont", 9))
        self.conn_label.pack(anchor="w")
        self.db_label = tk.Label(left, text="", bg=BG_SURFACE, fg=TEXT_MUTED, font=("TkDefaultFont", 8))
        self.db_label.pack(anchor="w")

        stats = tk.Frame(bar, bg=BG_SURFACE)
        stats.pack(side="left", padx=(36, 0))
        self.stat_labels = {}
        for key, caption in [
            ("users", "Kullanıcı"), ("tickets_active", "Aktif Sipariş"),
            ("tickets", "Toplam Bilet"), ("pending_requests", "Bekleyen Talep"),
        ]:
            cell = tk.Frame(stats, bg=BG_SURFACE, padx=14)
            cell.pack(side="left")
            val = ttk.Label(cell, text="—", style="Stat.TLabel")
            val.pack()
            ttk.Label(cell, text=caption, style="StatCaption.TLabel").pack()
            self.stat_labels[key] = val

        right = tk.Frame(bar, bg=BG_SURFACE)
        right.pack(side="right")
        ttk.Button(right, text="↻ Yenile", style="Amber.TButton", command=self.refresh).pack(side="right")

    def _build_statusbar(self):
        self.status_var = tk.StringVar(value="Hazır.")
        sb = tk.Frame(self.root, bg=BG_SURFACE2)
        sb.pack(fill="x", side="bottom")
        self.status_label = tk.Label(sb, textvariable=self.status_var, bg=BG_SURFACE2, fg=TEXT_MUTED,
                                      anchor="w", padx=12, pady=5, font=("TkDefaultFont", 9))
        self.status_label.pack(fill="x")

    def set_status(self, msg, kind="ok"):
        color = {"ok": SUCCESS, "error": DANGER, "info": INFO}.get(kind, TEXT_MUTED)
        self.status_var.set(msg)
        self.status_label.configure(fg=color)

    def _build_notebook(self):
        self.nb = ttk.Notebook(self.root)
        self.nb.pack(fill="both", expand=True, padx=10, pady=(6, 0))

        self._build_stock_tab()
        self._build_tickets_tab()
        self._build_users_tab()
        self._build_requests_tab()
        self._build_cardreads_tab()

    # -----------------------------------------------------------------
    # Sekme: Menü & Stok
    # -----------------------------------------------------------------
    def _build_stock_tab(self):
        tab = ttk.Frame(self.nb, padding=14)
        self.nb.add(tab, text="🥪 Menü & Stok")

        info = tk.Label(tab, text="İşaretlenen ürünler kiosk ekranında kırmızı \"TÜKENDİ\" rozeti alır ve seçilemez.",
                         bg=BG_DEEP, fg=WARNING, font=("TkDefaultFont", 10, "bold"))
        info.pack(anchor="w", pady=(0, 10))

        bbar = tk.Frame(tab, bg=BG_DEEP)
        bbar.pack(fill="x", pady=(0, 10))
        ttk.Button(bbar, text="🔄 Tüm Stokları Aç", command=self.reset_all_stocks).pack(side="left")

        self.stock_vars = {}
        grid_container = tk.Frame(tab, bg=BG_DEEP)
        grid_container.pack(fill="both", expand=True)

        col_idx = row_idx = 0
        for cat_name, items in MENU_CATEGORIES.items():
            box = ttk.LabelFrame(grid_container, text=f" {cat_name} ", padding=10)
            box.grid(row=row_idx, column=col_idx, sticky="nsew", padx=6, pady=6)
            for item in items:
                v = tk.BooleanVar(value=False)
                self.stock_vars[item] = v
                ttk.Checkbutton(box, text=item, variable=v, command=self.push_stock_update).pack(anchor="w", pady=2)
            col_idx += 1
            if col_idx > 2:
                col_idx = 0
                row_idx += 1
        for c in range(3):
            grid_container.columnconfigure(c, weight=1)

    def push_stock_update(self):
        out = [item for item, var in self.stock_vars.items() if var.get()]
        ok, res = api("POST", "/api/admin/stock", body={"out_of_stock": out})
        if ok:
            self.set_status(f"Stok güncellendi: {len(out)} ürün tükendi.", "ok" if not out else "info")
        else:
            self.set_status(f"Stok güncellenemedi: {res}", "error")

    def reset_all_stocks(self):
        for v in self.stock_vars.values():
            v.set(False)
        self.push_stock_update()

    # -----------------------------------------------------------------
    # Sekme: Biletler
    # -----------------------------------------------------------------
    def _build_tickets_tab(self):
        frame = ttk.Frame(self.nb, padding=10)
        self.nb.add(frame, text="🎫 Biletler")

        top = tk.Frame(frame, bg=BG_DEEP)
        top.pack(fill="x", pady=(0, 8))
        tk.Label(top, text="Ara:", bg=BG_DEEP, fg=TEXT_MUTED).pack(side="left")
        self.ticket_filter_var = tk.StringVar()
        self.ticket_filter_var.trace_add("write", lambda *_: self._render_tickets())
        ttk.Entry(top, textvariable=self.ticket_filter_var, width=30).pack(side="left", padx=6)
        tk.Label(top, text="kod / kart / isim ile filtreler", bg=BG_DEEP, fg=TEXT_MUTED,
                 font=("TkDefaultFont", 8)).pack(side="left")

        actions = tk.Frame(frame, bg=BG_DEEP)
        actions.pack(fill="x", pady=(8, 0), side="bottom")
        ttk.Button(actions, text="✎ Düzenle", style="Amber.TButton",
                   command=self.edit_selected_ticket).pack(side="left", padx=(0, 6))
        ttk.Button(actions, text="✔ Teslim Et", style="Success.TButton",
                   command=self.pickup_selected_ticket).pack(side="left", padx=6)
        ttk.Button(actions, text="✕ Siparişi İptal Et (puan iade)",
                   command=self.cancel_selected_ticket).pack(side="left", padx=6)
        ttk.Button(actions, text="🗑 Kalıcı Sil", style="Danger.TButton",
                   command=self.delete_selected_ticket).pack(side="left", padx=6)
        tk.Label(actions, text="(çift tıkla: düzenle)", bg=BG_DEEP, fg=TEXT_MUTED,
                 font=("TkDefaultFont", 8)).pack(side="right")

        cols = [
            ("code", "Kod", 60), ("items", "Sipariş", 220), ("name", "Müşteri", 150),
            ("card", "Kart ID", 170), ("sched", "Hedef Saat", 95), ("points", "Puan", 60),
            ("status", "Durum", 110),
        ]
        self.t_tickets = self._make_table(frame, cols)
        self.t_tickets.bind("<Double-1>", self._on_ticket_double_click)
        for tag, color in [("active", INFO), ("ready", SUCCESS), ("picked_up", TEXT_MUTED), ("cancelled", DANGER)]:
            self.t_tickets.tag_configure(tag, foreground=color)

    def _render_tickets(self):
        tv = self.t_tickets
        tv.delete(*tv.get_children())
        q = self.ticket_filter_var.get().strip().lower()
        users_by_card = {u["card_id"]: u for u in self.data.get("users", [])}
        for t in self.data.get("tickets", []):
            u = users_by_card.get(t.get("card_id"))
            name = f"{u['first_name']} {u['last_name']}".strip() if u else "(bilinmiyor)"
            if q and q not in str(t.get("code", "")).lower() and q not in str(t.get("card_id", "")).lower() \
                    and q not in name.lower():
                continue
            label, tag = ticket_status(t)
            tv.insert("", "end", iid=f"t{t['id']}", values=(
                t.get("code", ""), t.get("items_summary", ""), name, t.get("card_id", ""),
                fmt_time(t["scheduled_time"]), t.get("points_spent", 0) or 0, label,
            ), tags=(tag,))

    def _selected_ticket_id(self):
        sel = self.t_tickets.selection()
        if not sel:
            self.set_status("Önce bir bilet seçin.", "error")
            return None
        return int(sel[0][1:])

    def _selected_ticket(self):
        tid = self._selected_ticket_id()
        if tid is None:
            return None
        return next((t for t in self.data.get("tickets", []) if t["id"] == tid), None)

    def pickup_selected_ticket(self):
        t = self._selected_ticket()
        if not t:
            return
        if t.get("picked_up") or t.get("cancelled"):
            self.set_status("Bu bilet zaten teslim alınmış ya da iptal edilmiş.", "error")
            return
        ok, res = api("POST", "/api/pickup", body={"ticket_id": t["id"]})
        if ok:
            self.set_status(f"#{t['code']} teslim edildi olarak işaretlendi.", "ok")
            self.refresh()
        else:
            self.set_status(f"Teslim işlemi başarısız: {res}", "error")

    def cancel_selected_ticket(self):
        t = self._selected_ticket()
        if not t:
            return
        if t.get("cancelled") or t.get("picked_up"):
            self.set_status("Bu bilet zaten iptal edilmiş ya da teslim alınmış.", "error")
            return
        if not messagebox.askyesno("Siparişi İptal Et",
                                    f"#{t['code']} siparişi iptal edilsin mi? ({t.get('points_spent', 0)} kredi iade edilecek)"):
            return
        ok, res = api("POST", "/api/admin/ticket/cancel", body={"ticket_id": t["id"]})
        if ok:
            self.set_status(f"#{t['code']} iptal edildi, {res.get('refunded_points', 0)} kredi iade edildi.", "ok")
            self.refresh()
        else:
            self.set_status(f"İptal başarısız: {res}", "error")

    def delete_selected_ticket(self):
        t = self._selected_ticket()
        if not t:
            return
        if not messagebox.askyesno("Bileti Kalıcı Sil",
                                    f"#{t['code']} kaydı VERİTABANINDAN tamamen silinsin mi? Bu işlem geri alınamaz."):
            return
        ok, res = api("DELETE", f"/api/tickets/{t['id']}")
        if ok:
            self.set_status(f"#{t['code']} kalıcı olarak silindi.", "ok")
            self.refresh()
        else:
            self.set_status(f"Silme başarısız: {res}", "error")

    def _on_ticket_double_click(self, _event):
        self.edit_selected_ticket()

    def edit_selected_ticket(self):
        t = self._selected_ticket()
        if not t:
            return
        dlg = TicketEditDialog(self.root, t)
        self.root.wait_window(dlg)
        if dlg.result is None:
            return
        body = dict(dlg.result)
        body["ticket_id"] = t["id"]
        ok, res = api("POST", "/api/admin/ticket/update", body=body)
        if ok:
            self.set_status(f"#{t['code']} güncellendi.", "ok")
            self.refresh()
        else:
            self.set_status(f"Güncelleme başarısız: {res}", "error")

    # -----------------------------------------------------------------
    # Sekme: Kullanıcılar
    # -----------------------------------------------------------------
    def _build_users_tab(self):
        frame = ttk.Frame(self.nb, padding=10)
        self.nb.add(frame, text="👥 Kullanıcılar")

        top = tk.Frame(frame, bg=BG_DEEP)
        top.pack(fill="x", pady=(0, 8))
        tk.Label(top, text="Ara:", bg=BG_DEEP, fg=TEXT_MUTED).pack(side="left")
        self.user_filter_var = tk.StringVar()
        self.user_filter_var.trace_add("write", lambda *_: self._render_users())
        ttk.Entry(top, textvariable=self.user_filter_var, width=30).pack(side="left", padx=6)

        actions = tk.Frame(frame, bg=BG_DEEP)
        actions.pack(fill="x", pady=(8, 0), side="bottom")
        ttk.Button(actions, text="✎ Kullanıcıyı Düzenle", style="Amber.TButton",
                   command=self.edit_selected_user_balance).pack(side="left", padx=(0, 6))
        ttk.Button(actions, text="⛔ Engelle / Kaldır",
                   command=self.toggle_selected_user_block).pack(side="left", padx=6)
        ttk.Button(actions, text="🗑 Kullanıcıyı Sil", style="Danger.TButton",
                   command=self.delete_selected_user).pack(side="left", padx=6)

        cols = [
            ("card", "Kart ID", 190), ("name", "Ad Soyad", 170), ("balance", "Bakiye", 75),
            ("quota", "Aylık Kredi Limiti", 120), ("renew", "Limit Yenilenme", 120),
            ("status", "Durum", 80), ("created", "Kayıt Tarihi", 120),
        ]
        self.t_users = self._make_table(frame, cols)
        self.t_users.tag_configure("blocked", foreground=DANGER)
        self.t_users.tag_configure("ok", foreground=SUCCESS)

    def _render_users(self):
        tv = self.t_users
        tv.delete(*tv.get_children())
        q = self.user_filter_var.get().strip().lower()
        for u in self.data.get("users", []):
            name = f"{u.get('first_name', '')} {u.get('last_name', '')}".strip()
            if q and q not in u.get("card_id", "").lower() and q not in name.lower():
                continue
            blocked = bool(u.get("is_blocked"))
            tv.insert("", "end", iid=f"u{u['card_id']}", values=(
                u["card_id"], name, u.get("balance", 0), u.get("monthly_quota", 0),
                fmt_iso(u.get("quota_reset_date")) or "—",
                "Engelli" if blocked else "Aktif", fmt_iso(u.get("created_at")),
            ), tags=("blocked" if blocked else "ok",))

    def _selected_user(self):
        sel = self.t_users.selection()
        if not sel:
            self.set_status("Önce bir kullanıcı seçin.", "error")
            return None
        card_id = sel[0][1:]
        return next((u for u in self.data.get("users", []) if u["card_id"] == card_id), None)

    def edit_selected_user_balance(self):
        u = self._selected_user()
        if not u:
            return
        name = f"{u.get('first_name', '')} {u.get('last_name', '')}".strip() or u["card_id"]

        def renew_now(card_id):
            ok, res = api("POST", "/api/admin/user/renew-quota", body={"card_id": card_id})
            if ok:
                self.set_status(f"{name}: kredi limiti şimdi yenilendi.", "ok")
                self.refresh()
            else:
                self.set_status(f"Yenileme başarısız: {res}", "error")

        dlg = UserEditDialog(self.root, u, renew_now)
        self.root.wait_window(dlg)
        if dlg.result is None:
            return
        body = dict(dlg.result)
        body["card_id"] = u["card_id"]
        ok, res = api("POST", "/api/admin/user/update", body=body)
        if ok:
            self.set_status(f"{name}: bilgiler güncellendi.", "ok")
            self.refresh()
        else:
            self.set_status(f"Güncelleme başarısız: {res}", "error")

    def toggle_selected_user_block(self):
        u = self._selected_user()
        if not u:
            return
        is_blocked = bool(u.get("is_blocked"))
        name = f"{u.get('first_name', '')} {u.get('last_name', '')}".strip()
        msg = f"{name} kartının engeli kaldırılsın mı?" if is_blocked else \
            f"{name} kartı engellensin mi? Kullanıcı sipariş veremeyecek."
        if not messagebox.askyesno("Engelleme Durumu", msg):
            return
        ok, res = api("POST", "/api/admin/user/block", body={"card_id": u["card_id"], "is_blocked": not is_blocked})
        if ok:
            self.set_status(f"{name}: {'engellendi' if not is_blocked else 'engeli kaldırıldı'}.", "ok")
            self.refresh()
        else:
            self.set_status(f"İşlem başarısız: {res}", "error")

    def delete_selected_user(self):
        u = self._selected_user()
        if not u:
            return
        name = f"{u.get('first_name', '')} {u.get('last_name', '')}".strip()
        if not messagebox.askyesno("Kullanıcıyı Sil",
                                    f"{name} ({u['card_id']}) kaydı kalıcı olarak silinsin mi?"):
            return
        ok, res = api("DELETE", f"/api/users/{urllib.parse.quote(u['card_id'])}")
        if ok:
            self.set_status(f"{name} silindi.", "ok")
            self.refresh()
        else:
            self.set_status(f"Silme başarısız: {res}", "error")

    # -----------------------------------------------------------------
    # Sekme: Hesap Kapatma Talepleri
    # -----------------------------------------------------------------
    def _build_requests_tab(self):
        frame = ttk.Frame(self.nb, padding=10)
        self.nb.add(frame, text="📨 Hesap Kapatma Talepleri")

        actions = tk.Frame(frame, bg=BG_DEEP)
        actions.pack(fill="x", pady=(8, 0), side="bottom")
        ttk.Button(actions, text="✅ Onayla (kullanıcıyı sil)", style="Danger.TButton",
                   command=lambda: self.resolve_selected_request("approve")).pack(side="left", padx=(0, 6))
        ttk.Button(actions, text="✖ Reddet", command=lambda: self.resolve_selected_request("reject")).pack(
            side="left", padx=6)

        cols = [
            ("id", "No", 45), ("card", "Kart ID", 180), ("name", "Kullanıcı", 170),
            ("created", "Talep Tarihi", 130), ("status", "Durum", 100), ("resolved", "Sonuç Tarihi", 130),
        ]
        self.t_requests = self._make_table(frame, cols)
        self.t_requests.tag_configure("pending", foreground=WARNING)
        self.t_requests.tag_configure("approved", foreground=DANGER)
        self.t_requests.tag_configure("rejected", foreground=TEXT_MUTED)

    def _render_requests(self):
        tv = self.t_requests
        tv.delete(*tv.get_children())
        for r in self.data.get("account_deletion_requests", []):
            name = f"{r.get('first_name') or ''} {r.get('last_name') or ''}".strip() or "(kayıt yok)"
            status = r.get("status", "pending")
            status_tr = {"pending": "Bekliyor", "approved": "Onaylandı", "rejected": "Reddedildi"}.get(status, status)
            tv.insert("", "end", iid=f"r{r['id']}", values=(
                r["id"], r.get("card_id", ""), name, fmt_iso(r.get("created_at")),
                status_tr, fmt_iso(r.get("resolved_at")),
            ), tags=(status,))

    def resolve_selected_request(self, action):
        sel = self.t_requests.selection()
        if not sel:
            self.set_status("Önce bir talep seçin.", "error")
            return
        rid = int(sel[0][1:])
        req = next((r for r in self.data.get("account_deletion_requests", []) if r["id"] == rid), None)
        if not req:
            return
        if req.get("status", "pending") != "pending":
            self.set_status("Bu talep zaten sonuçlandırılmış.", "error")
            return
        name = f"{req.get('first_name') or ''} {req.get('last_name') or ''}".strip() or req.get("card_id", "")
        if action == "approve":
            msg = f"{name} hesabı SİLİNSİN mi? Bu işlem geri alınamaz."
        else:
            msg = f"{name} hesabının kapatma talebi reddedilsin mi? Kullanıcı kalır."
        if not messagebox.askyesno("Talebi Sonuçlandır", msg):
            return
        ok, res = api("POST", "/api/admin/account-deletion-request/resolve", body={"id": rid, "action": action})
        if ok:
            self.set_status(f"Talep #{rid} {'onaylandı' if action == 'approve' else 'reddedildi'}.", "ok")
            self.refresh()
        else:
            self.set_status(f"İşlem başarısız: {res}", "error")

    # -----------------------------------------------------------------
    # Sekme: Kart Okuma Geçmişi
    # -----------------------------------------------------------------
    def _build_cardreads_tab(self):
        frame = ttk.Frame(self.nb, padding=10)
        self.nb.add(frame, text="📇 Kart Okuma Geçmişi")

        top = tk.Frame(frame, bg=BG_DEEP)
        top.pack(fill="x", pady=(0, 8))
        tk.Label(top, text="Ara:", bg=BG_DEEP, fg=TEXT_MUTED).pack(side="left")
        self.cardread_filter_var = tk.StringVar()
        self.cardread_filter_var.trace_add("write", lambda *_: self._render_cardreads())
        ttk.Entry(top, textvariable=self.cardread_filter_var, width=30).pack(side="left", padx=6)
        tk.Label(top, text="(son 200 okuma, sadece görüntüleme)", bg=BG_DEEP, fg=TEXT_MUTED,
                 font=("TkDefaultFont", 8)).pack(side="left", padx=8)

        cols = [("ts", "Zaman", 150), ("card", "Kart ID", 190), ("em", "EM4100", 130), ("raw", "Ham Çerçeve", 220)]
        self.t_cardreads = self._make_table(frame, cols)

    def _render_cardreads(self):
        tv = self.t_cardreads
        tv.delete(*tv.get_children())
        q = self.cardread_filter_var.get().strip().lower()
        for c in self.data.get("card_reads", []):
            if q and q not in str(c.get("card_id", "")).lower():
                continue
            tv.insert("", "end", iid=f"c{c['id']}", values=(
                fmt_iso(c.get("ts")), c.get("card_id", ""), c.get("em4100", ""), c.get("raw_hex", ""),
            ))

    # -----------------------------------------------------------------
    # Ortak tablo yardımcıları
    # -----------------------------------------------------------------
    def _make_table(self, frame, cols):
        tv = ttk.Treeview(frame, columns=[c[0] for c in cols], show="headings", selectmode="browse")
        for key, label, width in cols:
            tv.heading(key, text=label)
            tv.column(key, width=width, anchor="w")
        vs = ttk.Scrollbar(frame, orient="vertical", command=tv.yview)
        tv.configure(yscrollcommand=vs.set)
        tv.pack(side="left", fill="both", expand=True)
        vs.pack(side="left", fill="y")
        return tv

    # -----------------------------------------------------------------
    # Veri yükleme
    # -----------------------------------------------------------------
    def refresh(self):
        if self._busy:
            return
        self._busy = True

        def fetch():
            ok1, data = api("GET", "/api/admin/data")
            ok2, stock = api("GET", "/api/stock")
            self.root.after(0, lambda: self._apply(ok1, data, ok2, stock))

        threading.Thread(target=fetch, daemon=True).start()

    def _apply(self, ok1, data, ok2, stock):
        self._busy = False
        if ok1 and isinstance(data, dict):
            self.data = data
            self.conn_label.configure(text=f"● bağlı — son güncelleme {datetime.now().strftime('%H:%M:%S')}",
                                       fg=SUCCESS)
            counts = data.get("counts", {})
            pending = sum(1 for r in data.get("account_deletion_requests", [])
                          if r.get("status", "pending") == "pending")
            self.stat_labels["users"].configure(text=str(counts.get("users", "—")))
            self.stat_labels["tickets_active"].configure(text=str(counts.get("tickets_active", "—")))
            self.stat_labels["tickets"].configure(text=str(counts.get("tickets", "—")))
            self.stat_labels["pending_requests"].configure(text=str(pending))

            dbi = data.get("db_info") or {}
            if dbi.get("path"):
                size_kb = (dbi.get("size_bytes") or 0) / 1024
                self.db_label.configure(text=f"📁 {dbi['path']}  ({size_kb:.0f} KB) — canlı veritabanı, bağımsız değil")

            self._render_tickets()
            self._render_users()
            self._render_requests()
            self._render_cardreads()
        else:
            self.conn_label.configure(text=f"● bağlantı hatası: {data}", fg=DANGER)

        if ok2 and isinstance(stock, dict):
            outs = set(stock.get("out_of_stock", []))
            for item, var in self.stock_vars.items():
                var.set(item in outs)

    def _auto_tick(self):
        self.refresh()
        self.root.after(AUTO_REFRESH_MS, self._auto_tick)


if __name__ == "__main__":
    root = tk.Tk()
    AdminApp(root)
    root.mainloop()
