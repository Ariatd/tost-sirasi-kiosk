#!/usr/bin/env python3
"""
Tost Kiosk — Yönetim (admin) masaüstü uygulaması.

Panel PC'deki backend'e (http://10.42.0.74:8080) bağlanır; biletleri ve
kayıtlı kullanıcıları listeler, tek tek siler, tümünü sıfırlar.

- Yalnızca Python standart kütüphanesi (tkinter + urllib). Ekstra kurulum yok.
  (Ubuntu'da tkinter ayrı paket olabilir:  sudo apt install python3-tk)
- BU BİLGİSAYARDA çalışır, panelde değil.

Ayarlar — ortam değişkeni olarak verilir (kaynak koda GERÇEK token
YAZILMAZ; panelin ürettiği token'ı deponun dışında bir yerden alın:
~/tost-kiosk/admin_token, bkz. README "Admin aracını çalıştırma"):
    TOST_ADMIN_URL    (varsayılan http://10.42.0.74:8080)
    TOST_ADMIN_TOKEN  (ZORUNLU — backend'in ürettiği X-Admin-Token)

Kullanım:
    TOST_ADMIN_TOKEN=<panelden alınan token> python3 tost-admin.py
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
from tkinter import ttk, messagebox

# --------------------------------------------------------------------------
BASE_URL = os.environ.get("TOST_ADMIN_URL", "http://10.42.0.74:8080").rstrip("/")
ADMIN_TOKEN = os.environ.get("TOST_ADMIN_TOKEN", "")
AUTO_REFRESH_MS = 5000
HTTP_TIMEOUT = 5
# --------------------------------------------------------------------------

if not ADMIN_TOKEN:
    print(
        "HATA: TOST_ADMIN_TOKEN ortam değişkeni ayarlanmamış.\n"
        "Panelde ~/tost-kiosk/admin_token dosyasındaki değeri kullanın:\n"
        "  TOST_ADMIN_TOKEN=<token> python3 tost-admin.py",
        file=sys.stderr,
    )
    sys.exit(1)


def api(method, path, timeout=HTTP_TIMEOUT):
    """Backend'e istek at; (ok, veri_or_hata_mesaji) döndür."""
    req = urllib.request.Request(
        BASE_URL + path, method=method,
        headers={"X-Admin-Token": ADMIN_TOKEN, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8") or "{}"
        return True, json.loads(raw)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            return False, "Yetki hatası (401) — X-Admin-Token yanlış."
        try:
            msg = json.loads(e.read().decode("utf-8")).get("error", "")
        except Exception:
            msg = ""
        return False, f"HTTP {e.code}" + (f" — {msg}" if msg else "")
    except urllib.error.URLError as e:
        return False, f"Bağlantı yok — {e.reason}"
    except Exception as e:
        return False, str(e)


def fmt_time(ms):
    try:
        return datetime.fromtimestamp(int(ms) / 1000).strftime("%d.%m %H:%M")
    except Exception:
        return str(ms)


def ticket_status(t):
    if t.get("picked_up"):
        return "teslim edildi"
    try:
        left = int(t["scheduled_time"]) / 1000 - datetime.now().timestamp()
    except Exception:
        return "?"
    return "HAZIR" if left <= 0 else f"{int(left // 60)} dk sonra"


class AdminApp:
    def __init__(self, root):
        self.root = root
        self.busy = False
        root.title("Tost Kiosk — Yönetim")
        root.geometry("880x560")
        root.minsize(680, 420)

        style = ttk.Style(root)
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure("Treeview", rowheight=26)
        style.configure("Treeview.Heading", font=("TkDefaultFont", 9, "bold"))

        # ---- üst araç çubuğu ----
        bar = ttk.Frame(root, padding=(10, 8))
        bar.pack(fill="x")
        ttk.Button(bar, text="↻  Yenile", command=self.refresh).pack(side="left")
        ttk.Button(bar, text="⚠  Tümünü Sıfırla", command=self.reset_all).pack(side="left", padx=(6, 0))

        self.auto = tk.BooleanVar(value=True)
        ttk.Checkbutton(bar, text=f"Otomatik yenile ({AUTO_REFRESH_MS // 1000}s)",
                        variable=self.auto).pack(side="left", padx=(16, 0))

        self.status = ttk.Label(bar, text="hazır", foreground="#666")
        self.status.pack(side="right")

        ttk.Label(root, text=BASE_URL, foreground="#999",
                  padding=(12, 0, 0, 4)).pack(fill="x")

        # ---- sekmeler ----
        nb = ttk.Notebook(root)
        nb.pack(fill="both", expand=True, padx=10, pady=(2, 10))

        self.t_tickets = self._make_table(
            nb, "Biletler",
            [("id", "id", 50), ("code", "Kod", 70), ("sched", "Hedef saat", 110),
             ("status", "Durum", 110), ("created", "Oluşturma", 130),
             ("card", "Kart ID", 180), ("del", "", 70)],
            self.on_click_tickets)

        self.t_users = self._make_table(
            nb, "Kayıtlı Kullanıcılar",
            [("card", "Kart ID", 200), ("first", "İsim", 150), ("last", "Soyisim", 150),
             ("created", "Kayıt tarihi", 150), ("del", "", 70)],
            self.on_click_users)

        self.refresh()
        self._auto_tick()

    def _make_table(self, nb, title, cols, on_click):
        frame = ttk.Frame(nb)
        nb.add(frame, text=title)
        tv = ttk.Treeview(frame, columns=[c[0] for c in cols], show="headings", selectmode="browse")
        for key, label, width in cols:
            tv.heading(key, text=label)
            anchor = "center" if key in ("del", "id", "code") else "w"
            tv.column(key, width=width, anchor=anchor,
                      stretch=(key == "card" or key == "created"))
        vs = ttk.Scrollbar(frame, orient="vertical", command=tv.yview)
        tv.configure(yscrollcommand=vs.set)
        tv.grid(row=0, column=0, sticky="nsew")
        vs.grid(row=0, column=1, sticky="ns")
        frame.rowconfigure(0, weight=1)
        frame.columnconfigure(0, weight=1)
        tv.tag_configure("ready", foreground="#b23a30")
        tv.tag_configure("done", foreground="#999")
        tv.bind("<Button-1>", on_click, add="+")
        tv.bind("<Delete>", lambda e, t=title: self._delete_selected(t))
        return tv

    # ---- durum / meşgul ----
    def set_status(self, text, error=False):
        self.status.configure(text=text, foreground=("#b23a30" if error else "#666"))

    def _run(self, fn, done):
        """fn'i arka planda çalıştır, sonucu ana thread'de done(result)'a ver."""
        if self.busy:
            return
        self.busy = True

        def worker():
            res = fn()
            self.root.after(0, lambda: self._finish(done, res))

        threading.Thread(target=worker, daemon=True).start()

    def _finish(self, done, res):
        self.busy = False
        done(res)

    # ---- yenileme ----
    def _auto_tick(self):
        if self.auto.get() and not self.busy:
            self.refresh(silent=True)
        self.root.after(AUTO_REFRESH_MS, self._auto_tick)

    def refresh(self, silent=False):
        if not silent:
            self.set_status("yükleniyor…")

        def fetch():
            ok1, tickets = api("GET", "/api/tickets")
            ok2, users = api("GET", "/api/users")
            return (ok1, tickets, ok2, users)

        self._run(fetch, self._apply_refresh)

    def _apply_refresh(self, res):
        ok1, tickets, ok2, users = res
        if not ok1:
            self.set_status(tickets if isinstance(tickets, str) else "bilet alınamadı", error=True)
            return
        if not ok2:
            self.set_status(users if isinstance(users, str) else "kullanıcı alınamadı", error=True)
            return

        self._fill_tickets(tickets.get("tickets", []))
        self._fill_users(users.get("users", []))
        self.set_status(f"güncel · {datetime.now():%H:%M:%S} · "
                        f"{len(tickets.get('tickets', []))} bilet, {len(users.get('users', []))} kullanıcı")

    def _fill_tickets(self, rows):
        tv = self.t_tickets
        sel = set(tv.selection())
        tv.delete(*tv.get_children())
        for t in rows:
            tag = "done" if t.get("picked_up") else ("ready" if ticket_status(t) == "HAZIR" else "")
            iid = f"t{t['id']}"
            tv.insert("", "end", iid=iid, tags=(tag,), values=(
                t["id"], t.get("code", ""), fmt_time(t["scheduled_time"]),
                ticket_status(t), (t.get("created_at") or "").replace("T", " "),
                t.get("card_id", ""), "🗑 Sil"))
            if iid in sel:
                tv.selection_add(iid)

    def _fill_users(self, rows):
        tv = self.t_users
        sel = set(tv.selection())
        tv.delete(*tv.get_children())
        for u in rows:
            iid = f"u{u['card_id']}"
            tv.insert("", "end", iid=iid, values=(
                u["card_id"], u.get("first_name", ""), u.get("last_name", ""),
                (u.get("created_at") or "").replace("T", " "), "🗑 Sil"))
            if iid in sel:
                tv.selection_add(iid)

    # ---- satıra tıklama (Sil sütunu) ----
    def on_click_tickets(self, event):
        tv = self.t_tickets
        if tv.identify_region(event.x, event.y) != "cell":
            return
        if tv.identify_column(event.x) != f"#{len(tv['columns'])}":  # son sütun = del
            return
        iid = tv.identify_row(event.y)
        if iid:
            self._delete_ticket(iid[1:])

    def on_click_users(self, event):
        tv = self.t_users
        if tv.identify_region(event.x, event.y) != "cell":
            return
        if tv.identify_column(event.x) != f"#{len(tv['columns'])}":
            return
        iid = tv.identify_row(event.y)
        if iid:
            self._delete_user(iid[1:])

    def _delete_selected(self, title):
        if title == "Biletler":
            s = self.t_tickets.selection()
            if s:
                self._delete_ticket(s[0][1:])
        else:
            s = self.t_users.selection()
            if s:
                self._delete_user(s[0][1:])

    # ---- silme işlemleri ----
    def _delete_ticket(self, tid):
        vals = self.t_tickets.item(f"t{tid}", "values")
        code = vals[1] if vals else tid
        if not messagebox.askyesno("Bileti sil",
                                   f"#{tid} numaralı bilet (kod {code}) silinsin mi?\n"
                                   "Bu işlem geri alınamaz."):
            return
        self.set_status(f"bilet #{tid} siliniyor…")
        self._run(lambda: api("DELETE", f"/api/tickets/{tid}"), self._after_delete)

    def _delete_user(self, card_id):
        vals = self.t_users.item(f"u{card_id}", "values")
        name = f"{vals[1]} {vals[2]}" if vals else card_id
        if not messagebox.askyesno("Kullanıcıyı sil",
                                   f"{name}\n({card_id})\n\nkaydı silinsin mi?\n"
                                   "Bu kişi yeniden kayıt olana kadar sipariş veremez."):
            return
        self.set_status("kullanıcı siliniyor…")
        self._run(lambda: api("DELETE", f"/api/users/{urllib.parse.quote(card_id)}"),
                  self._after_delete)

    def _after_delete(self, res):
        ok, data = res
        if not ok:
            messagebox.showerror("Silme başarısız", str(data))
            self.set_status(str(data), error=True)
        else:
            self.set_status(f"silindi ({data.get('deleted', 0)} satır)")
        self.refresh(silent=True)

    def reset_all(self):
        if not messagebox.askyesno(
                "Tümünü sıfırla",
                "TÜM biletler ve kart okuma kayıtları silinecek.\n"
                "Kayıtlı kullanıcılar KORUNUR.\n\nDevam edilsin mi?"):
            return
        self.set_status("sıfırlanıyor…")
        self._run(lambda: api("POST", "/api/reset"), self._after_delete)


def main():
    root = tk.Tk()
    AdminApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
