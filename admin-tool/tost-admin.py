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

# Kiosk App.jsx menüsündeki tüm seçeneklerle birebir aynı (öğe adları
# backend'e gönderilen gerçek veri anahtarları olduğu için ÇEVRİLMEZ;
# yalnızca kategori başlıkları görüntü metnidir).
MENU_CATEGORIES = {
    "🥪 Standard Toasts": [
        'Sucuklu', 'Patatesli', 'Kaşarlı (Sade)', 'Kavurmalı',
        'Ton Balıklı', 'Yumurtalı', 'Karışık', 'Vejetaryen'
    ],
    "🍞 Bread Types": [
        'Tam Buğday', 'Kepekli', 'Beyaz Ekmek', 'Susamlı'
    ],
    "🥩 Fillings": [
        'Sucuk', 'Kavurma', 'Ton Balığı', 'Yumurta',
        'Kızartılmış Patates', 'Salam', 'Sosis'
    ],
    "🧀 Cheese Options": [
        'Kaşar Peyniri', 'Cheddar Peyniri', 'Peynir İstemiyorum'
    ],
    "🥗 Greens & Extras": [
        'Salatalık', 'Avokado', 'Marul', 'Zeytin', 'Mısır', 'Patates Püresi', 'Brokoli'
    ],
    "🥫 Sauce & Preference": [
        'Özel Sos', 'Organik İlaveli'
    ]
}

if not ADMIN_TOKEN:
    print("ERROR: TOST_ADMIN_TOKEN is not set.", file=sys.stderr)
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
    """(label, tag) — backend'in /api/ticket-status ile aynı 4 durumu ayırt eder."""
    if t.get("cancelled"):
        return "Cancelled", "cancelled"
    if t.get("picked_up"):
        return "Picked Up", "picked_up"
    try:
        left = int(t["scheduled_time"]) / 1000 - datetime.now().timestamp()
    except Exception:
        return "?", ""
    if left <= 0:
        return "READY", "ready"
    mins = int(left // 60) + 1
    return f"in {mins} min", "active"


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
        ttk.Button(btns, text="Save", style="Amber.TButton", command=self._on_save).pack(side="left", padx=6)
        ttk.Button(btns, text="Cancel", command=self.destroy).pack(side="left", padx=6)
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
            messagebox.showerror("Invalid value", str(e))
            return
        self.destroy()

    def collect(self):
        raise NotImplementedError


class UserEditDialog(FormDialog):
    """Kullanıcının TÜM alanları: isim, bakiye, aylık kredi limiti, limit
    yenilenme tarihi, engel durumu — hepsi doğrudan düzenlenebilir."""

    def __init__(self, parent, user, on_renew_now):
        super().__init__(parent, "Edit User")
        card_id = user["card_id"]
        tk.Label(self, text=card_id, bg=BG_SURFACE, fg=TEXT_MUTED, font=("TkDefaultFont", 9)).grid(
            row=self._row, column=0, columnspan=2, sticky="w", padx=16, pady=(10, 0))
        self._row += 1

        self.first_var = self.add_text("First name:", user.get("first_name", ""))
        self.last_var = self.add_text("Last name:", user.get("last_name", ""))
        self.balance_var = self.add_text("Balance (currently spendable):", user.get("balance", 0))
        self.quota_var = self.add_text("Monthly Credit Limit:", user.get("monthly_quota", 0))
        self.reset_var = self.add_text("Limit Renewal Date (YYYY-MM-DD HH:MM):",
                                        fmt_iso(user.get("quota_reset_date")))
        self.blocked_var = self.add_check("Blocked (cannot place orders)", user.get("is_blocked"))
        self.add_note("When the renewal date is reached, the balance automatically resets "
                       "to the monthly limit. \"Renew Limit Now\" triggers this instantly "
                       "(balance = limit, counter moved 30 days forward).")

        def renew_now():
            if messagebox.askyesno("Renew Limit Now",
                                    f"Reset the balance to the limit and move the counter 30 days forward for {card_id}?"):
                on_renew_now(card_id)
                self.destroy()

        self.add_buttons(extra=("🔄 Renew Limit Now", renew_now))

    def collect(self):
        try:
            balance = int(self.balance_var.get())
            quota = int(self.quota_var.get())
        except ValueError:
            raise ValueError("Balance and credit limit must be whole numbers.")
        reset_raw = self.reset_var.get().strip()
        reset_iso = None
        if reset_raw:
            try:
                reset_iso = datetime.strptime(reset_raw, "%Y-%m-%d %H:%M").isoformat(timespec="seconds")
            except ValueError:
                raise ValueError("Renewal date must be in 'YYYY-MM-DD HH:MM' format (e.g. 2026-10-23 14:00).")
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
        super().__init__(parent, f"Ticket #{ticket['code']} — Edit")
        sched_str = datetime.fromtimestamp(ticket["scheduled_time"] / 1000).strftime("%Y-%m-%d %H:%M")
        self.code_var = self.add_text("Ticket Code:", ticket.get("code", ""))
        self.sched_var = self.add_text("Target Time (YYYY-MM-DD HH:MM):", sched_str)
        self.items_var = self.add_text("Order Contents:", ticket.get("items_summary", ""))
        self.points_var = self.add_text("Points Spent:", ticket.get("points_spent", 0))
        self.picked_var = self.add_check("Picked Up", ticket.get("picked_up"))
        self.cancelled_var = self.add_check("Cancelled", ticket.get("cancelled"))
        self.add_note("Changing the target time changes the moment the order is considered ready, "
                       "and the moment the QR tracking screen's countdown targets.")
        self.add_buttons()

    def collect(self):
        try:
            points = int(self.points_var.get())
        except ValueError:
            raise ValueError("Points spent must be a whole number.")
        try:
            sched_dt = datetime.strptime(self.sched_var.get().strip(), "%Y-%m-%d %H:%M")
        except ValueError:
            raise ValueError("Target time must be in 'YYYY-MM-DD HH:MM' format (e.g. 2026-09-23 14:30).")
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

        root.title("Tost Sırası — Admin Panel")
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
        style.configure("Header.TCheckbutton", background=BG_SURFACE, foreground=TEXT)
        style.map("Header.TCheckbutton", background=[("active", BG_SURFACE)])

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
        self.conn_label = tk.Label(left, text="● connecting…", bg=BG_SURFACE, fg=TEXT_MUTED,
                                    font=("TkDefaultFont", 9))
        self.conn_label.pack(anchor="w")
        self.db_label = tk.Label(left, text="", bg=BG_SURFACE, fg=TEXT_MUTED, font=("TkDefaultFont", 8))
        self.db_label.pack(anchor="w")

        stats = tk.Frame(bar, bg=BG_SURFACE)
        stats.pack(side="left", padx=(36, 0))
        self.stat_labels = {}
        for key, caption in [
            ("users", "Users"), ("tickets_active", "Active Orders"),
            ("tickets", "Total Tickets"), ("pending_requests", "Pending Requests"),
        ]:
            cell = tk.Frame(stats, bg=BG_SURFACE, padx=14)
            cell.pack(side="left")
            val = ttk.Label(cell, text="—", style="Stat.TLabel")
            val.pack()
            ttk.Label(cell, text=caption, style="StatCaption.TLabel").pack()
            self.stat_labels[key] = val

        right = tk.Frame(bar, bg=BG_SURFACE)
        right.pack(side="right")
        ttk.Button(right, text="↻ Refresh", style="Amber.TButton", command=self.refresh).pack(side="right")

        self.test_panel_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(
            right, text="Test panel (kiosk)", variable=self.test_panel_var,
            command=self.toggle_test_panel, style="Header.TCheckbutton"
        ).pack(side="right", padx=(0, 16))

    def _build_statusbar(self):
        self.status_var = tk.StringVar(value="Ready.")
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
        self.nb.add(tab, text="🥪 Menu & Stock")

        info = tk.Label(tab, text="Checked items get a red \"OUT OF STOCK\" badge on the kiosk screen and can't be selected.",
                         bg=BG_DEEP, fg=WARNING, font=("TkDefaultFont", 10, "bold"))
        info.pack(anchor="w", pady=(0, 10))

        bbar = tk.Frame(tab, bg=BG_DEEP)
        bbar.pack(fill="x", pady=(0, 10))
        ttk.Button(bbar, text="🔄 Restock All", command=self.reset_all_stocks).pack(side="left")

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
            self.set_status(f"Stock updated: {len(out)} item(s) out of stock.", "ok" if not out else "info")
        else:
            self.set_status(f"Stock update failed: {res}", "error")

    def reset_all_stocks(self):
        for v in self.stock_vars.values():
            v.set(False)
        self.push_stock_update()

    def toggle_test_panel(self):
        enabled = self.test_panel_var.get()
        ok, res = api("POST", "/api/admin/test-panel", body={"enabled": enabled})
        if ok:
            self.set_status(
                f"Test panel on the kiosk is now {'shown' if enabled else 'hidden'}.", "ok"
            )
        else:
            self.test_panel_var.set(not enabled)  # basarisizsa eski haline dondur
            self.set_status(f"Could not change test panel: {res}", "error")

    # -----------------------------------------------------------------
    # Sekme: Biletler
    # -----------------------------------------------------------------
    def _build_tickets_tab(self):
        frame = ttk.Frame(self.nb, padding=10)
        self.nb.add(frame, text="🎫 Tickets")

        top = tk.Frame(frame, bg=BG_DEEP)
        top.pack(fill="x", pady=(0, 8))
        tk.Label(top, text="Search:", bg=BG_DEEP, fg=TEXT_MUTED).pack(side="left")
        self.ticket_filter_var = tk.StringVar()
        self.ticket_filter_var.trace_add("write", lambda *_: self._render_tickets())
        ttk.Entry(top, textvariable=self.ticket_filter_var, width=30).pack(side="left", padx=6)
        tk.Label(top, text="filters by code / card / name", bg=BG_DEEP, fg=TEXT_MUTED,
                 font=("TkDefaultFont", 8)).pack(side="left")

        actions = tk.Frame(frame, bg=BG_DEEP)
        actions.pack(fill="x", pady=(8, 0), side="bottom")
        ttk.Button(actions, text="✎ Edit", style="Amber.TButton",
                   command=self.edit_selected_ticket).pack(side="left", padx=(0, 6))
        ttk.Button(actions, text="✔ Mark Picked Up", style="Success.TButton",
                   command=self.pickup_selected_ticket).pack(side="left", padx=6)
        ttk.Button(actions, text="✕ Cancel Order (refund points)",
                   command=self.cancel_selected_ticket).pack(side="left", padx=6)
        ttk.Button(actions, text="🗑 Delete Permanently", style="Danger.TButton",
                   command=self.delete_selected_ticket).pack(side="left", padx=6)
        tk.Label(actions, text="(double-click: edit)", bg=BG_DEEP, fg=TEXT_MUTED,
                 font=("TkDefaultFont", 8)).pack(side="right")

        cols = [
            ("code", "Code", 60), ("items", "Order", 220), ("name", "Customer", 150),
            ("card", "Card ID", 170), ("sched", "Target Time", 95), ("points", "Points", 60),
            ("status", "Status", 110),
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
            name = f"{u['first_name']} {u['last_name']}".strip() if u else "(unknown)"
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
            self.set_status("Select a ticket first.", "error")
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
            self.set_status("This ticket has already been picked up or cancelled.", "error")
            return
        ok, res = api("POST", "/api/pickup", body={"ticket_id": t["id"]})
        if ok:
            self.set_status(f"#{t['code']} marked as picked up.", "ok")
            self.refresh()
        else:
            self.set_status(f"Pickup failed: {res}", "error")

    def cancel_selected_ticket(self):
        t = self._selected_ticket()
        if not t:
            return
        if t.get("cancelled") or t.get("picked_up"):
            self.set_status("This ticket has already been cancelled or picked up.", "error")
            return
        if not messagebox.askyesno("Cancel Order",
                                    f"Cancel order #{t['code']}? ({t.get('points_spent', 0)} credit(s) will be refunded)"):
            return
        ok, res = api("POST", "/api/admin/ticket/cancel", body={"ticket_id": t["id"]})
        if ok:
            self.set_status(f"#{t['code']} cancelled, {res.get('refunded_points', 0)} credit(s) refunded.", "ok")
            self.refresh()
        else:
            self.set_status(f"Cancel failed: {res}", "error")

    def delete_selected_ticket(self):
        t = self._selected_ticket()
        if not t:
            return
        if not messagebox.askyesno("Delete Ticket Permanently",
                                    f"Permanently delete record #{t['code']} FROM THE DATABASE? This cannot be undone."):
            return
        ok, res = api("DELETE", f"/api/tickets/{t['id']}")
        if ok:
            self.set_status(f"#{t['code']} permanently deleted.", "ok")
            self.refresh()
        else:
            self.set_status(f"Delete failed: {res}", "error")

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
            self.set_status(f"#{t['code']} updated.", "ok")
            self.refresh()
        else:
            self.set_status(f"Update failed: {res}", "error")

    # -----------------------------------------------------------------
    # Sekme: Kullanıcılar
    # -----------------------------------------------------------------
    def _build_users_tab(self):
        frame = ttk.Frame(self.nb, padding=10)
        self.nb.add(frame, text="👥 Users")

        top = tk.Frame(frame, bg=BG_DEEP)
        top.pack(fill="x", pady=(0, 8))
        tk.Label(top, text="Search:", bg=BG_DEEP, fg=TEXT_MUTED).pack(side="left")
        self.user_filter_var = tk.StringVar()
        self.user_filter_var.trace_add("write", lambda *_: self._render_users())
        ttk.Entry(top, textvariable=self.user_filter_var, width=30).pack(side="left", padx=6)

        actions = tk.Frame(frame, bg=BG_DEEP)
        actions.pack(fill="x", pady=(8, 0), side="bottom")
        ttk.Button(actions, text="✎ Edit User", style="Amber.TButton",
                   command=self.edit_selected_user_balance).pack(side="left", padx=(0, 6))
        ttk.Button(actions, text="⛔ Block / Unblock",
                   command=self.toggle_selected_user_block).pack(side="left", padx=6)
        ttk.Button(actions, text="🗑 Delete User", style="Danger.TButton",
                   command=self.delete_selected_user).pack(side="left", padx=6)

        cols = [
            ("card", "Card ID", 190), ("name", "Full Name", 170), ("balance", "Balance", 75),
            ("quota", "Monthly Credit Limit", 120), ("renew", "Limit Renewal", 120),
            ("status", "Status", 80), ("created", "Registered", 120),
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
                "Blocked" if blocked else "Active", fmt_iso(u.get("created_at")),
            ), tags=("blocked" if blocked else "ok",))

    def _selected_user(self):
        sel = self.t_users.selection()
        if not sel:
            self.set_status("Select a user first.", "error")
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
                self.set_status(f"{name}: credit limit renewed now.", "ok")
                self.refresh()
            else:
                self.set_status(f"Renewal failed: {res}", "error")

        dlg = UserEditDialog(self.root, u, renew_now)
        self.root.wait_window(dlg)
        if dlg.result is None:
            return
        body = dict(dlg.result)
        body["card_id"] = u["card_id"]
        ok, res = api("POST", "/api/admin/user/update", body=body)
        if ok:
            self.set_status(f"{name}: information updated.", "ok")
            self.refresh()
        else:
            self.set_status(f"Update failed: {res}", "error")

    def toggle_selected_user_block(self):
        u = self._selected_user()
        if not u:
            return
        is_blocked = bool(u.get("is_blocked"))
        name = f"{u.get('first_name', '')} {u.get('last_name', '')}".strip()
        msg = f"Unblock {name}'s card?" if is_blocked else \
            f"Block {name}'s card? The user won't be able to place orders."
        if not messagebox.askyesno("Block Status", msg):
            return
        ok, res = api("POST", "/api/admin/user/block", body={"card_id": u["card_id"], "is_blocked": not is_blocked})
        if ok:
            self.set_status(f"{name}: {'blocked' if not is_blocked else 'unblocked'}.", "ok")
            self.refresh()
        else:
            self.set_status(f"Action failed: {res}", "error")

    def delete_selected_user(self):
        u = self._selected_user()
        if not u:
            return
        name = f"{u.get('first_name', '')} {u.get('last_name', '')}".strip()
        if not messagebox.askyesno("Delete User",
                                    f"Permanently delete {name} ({u['card_id']})?"):
            return
        ok, res = api("DELETE", f"/api/users/{urllib.parse.quote(u['card_id'])}")
        if ok:
            self.set_status(f"{name} deleted.", "ok")
            self.refresh()
        else:
            self.set_status(f"Delete failed: {res}", "error")

    # -----------------------------------------------------------------
    # Sekme: Hesap Kapatma Talepleri
    # -----------------------------------------------------------------
    def _build_requests_tab(self):
        frame = ttk.Frame(self.nb, padding=10)
        self.nb.add(frame, text="📨 Account Deletion Requests")

        actions = tk.Frame(frame, bg=BG_DEEP)
        actions.pack(fill="x", pady=(8, 0), side="bottom")
        ttk.Button(actions, text="✅ Approve (delete user)", style="Danger.TButton",
                   command=lambda: self.resolve_selected_request("approve")).pack(side="left", padx=(0, 6))
        ttk.Button(actions, text="✖ Reject", command=lambda: self.resolve_selected_request("reject")).pack(
            side="left", padx=6)

        cols = [
            ("id", "No.", 45), ("card", "Card ID", 180), ("name", "User", 170),
            ("created", "Requested", 130), ("status", "Status", 100), ("resolved", "Resolved", 130),
        ]
        self.t_requests = self._make_table(frame, cols)
        self.t_requests.tag_configure("pending", foreground=WARNING)
        self.t_requests.tag_configure("approved", foreground=DANGER)
        self.t_requests.tag_configure("rejected", foreground=TEXT_MUTED)

    def _render_requests(self):
        tv = self.t_requests
        tv.delete(*tv.get_children())
        for r in self.data.get("account_deletion_requests", []):
            name = f"{r.get('first_name') or ''} {r.get('last_name') or ''}".strip() or "(no profile)"
            status = r.get("status", "pending")
            status_en = {"pending": "Pending", "approved": "Approved", "rejected": "Rejected"}.get(status, status)
            tv.insert("", "end", iid=f"r{r['id']}", values=(
                r["id"], r.get("card_id", ""), name, fmt_iso(r.get("created_at")),
                status_en, fmt_iso(r.get("resolved_at")),
            ), tags=(status,))

    def resolve_selected_request(self, action):
        sel = self.t_requests.selection()
        if not sel:
            self.set_status("Select a request first.", "error")
            return
        rid = int(sel[0][1:])
        req = next((r for r in self.data.get("account_deletion_requests", []) if r["id"] == rid), None)
        if not req:
            return
        if req.get("status", "pending") != "pending":
            self.set_status("This request has already been resolved.", "error")
            return
        name = f"{req.get('first_name') or ''} {req.get('last_name') or ''}".strip() or req.get("card_id", "")
        if action == "approve":
            msg = f"DELETE {name}'s account? This cannot be undone."
        else:
            msg = f"Reject {name}'s account deletion request? The user will remain."
        if not messagebox.askyesno("Resolve Request", msg):
            return
        ok, res = api("POST", "/api/admin/account-deletion-request/resolve", body={"id": rid, "action": action})
        if ok:
            self.set_status(f"Request #{rid} {'approved' if action == 'approve' else 'rejected'}.", "ok")
            self.refresh()
        else:
            self.set_status(f"Action failed: {res}", "error")

    # -----------------------------------------------------------------
    # Sekme: Kart Okuma Geçmişi
    # -----------------------------------------------------------------
    def _build_cardreads_tab(self):
        frame = ttk.Frame(self.nb, padding=10)
        self.nb.add(frame, text="📇 Card Read History")

        top = tk.Frame(frame, bg=BG_DEEP)
        top.pack(fill="x", pady=(0, 8))
        tk.Label(top, text="Search:", bg=BG_DEEP, fg=TEXT_MUTED).pack(side="left")
        self.cardread_filter_var = tk.StringVar()
        self.cardread_filter_var.trace_add("write", lambda *_: self._render_cardreads())
        ttk.Entry(top, textvariable=self.cardread_filter_var, width=30).pack(side="left", padx=6)
        tk.Label(top, text="(last 200 reads, view only)", bg=BG_DEEP, fg=TEXT_MUTED,
                 font=("TkDefaultFont", 8)).pack(side="left", padx=8)

        cols = [("ts", "Time", 150), ("card", "Card ID", 190), ("em", "EM4100", 130), ("raw", "Raw Frame", 220)]
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
            self.conn_label.configure(text=f"● connected — last update {datetime.now().strftime('%H:%M:%S')}",
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
                self.db_label.configure(text=f"📁 {dbi['path']}  ({size_kb:.0f} KB) — live database, not independent")

            if "test_panel_enabled" in data:
                # .set() Checkbutton'ın command'ını TETİKLEMEZ (sadece
                # kullanıcı tıklamasında çalışır) — döngüye girme riski yok.
                self.test_panel_var.set(bool(data["test_panel_enabled"]))

            self._render_tickets()
            self._render_users()
            self._render_requests()
            self._render_cardreads()
        else:
            self.conn_label.configure(text=f"● connection error: {data}", fg=DANGER)

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
