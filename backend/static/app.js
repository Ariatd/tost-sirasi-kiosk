/* Tost Sırası Kiosk — frontend (vanilla).
   İş mantığı reference.jsx'ten birebir portlanmıştır; tek fark: "kart okutma"
   artık gerçek seri porttan gelen SSE 'scan' olayı ile tetiklenir. */

"use strict";

const SLOT_MINUTES = 5;
const SLOT_MS = SLOT_MINUTES * 60 * 1000;
const HORIZON_POSITIONS = 24; // "başka saat seç" penceresi (2 saat)
const CONFIRM_TIMEOUT_MS = 6000;

// ---------------------------------------------------------------------------
// Durum
// ---------------------------------------------------------------------------
const S = {
  view: "idle", // idle | scanning | select | confirm | blocked
                // | registerForm | registerScanning | registerSuccess
  expanded: false,
  devOpen: false,
  pendingCard: null, // { id, code }
  pendingUser: null, // { first_name, last_name } | null
  lastTicket: null,  // ticket nesnesi
  registerFirst: "",
  registerLast: "",

  tickets: [],       // server'dan (aktif, picked_up=0)
  clockSkew: 0,      // serverNow - Date.now()
  connected: false,
  _confirmTimer: null,
};

const root = document.getElementById("root");
const offlineEl = document.getElementById("offline");

function serverNow() {
  return Date.now() + S.clockSkew;
}

// pywebview native penceresinde miyiz? (API sayfa yüklendikten sonra enjekte edilir)
let _nativeReady = typeof window !== "undefined" && !!window.pywebview;
function nativeReady() { return _nativeReady; }

// ---------------------------------------------------------------------------
// Biçimlendirme (reference.jsx ile birebir)
// ---------------------------------------------------------------------------
function formatMinutes(ms) {
  const totalMinutes = Math.round(ms / 60000);
  if (totalMinutes <= 0) return "şimdi";
  if (totalMinutes < 60) return `${totalMinutes} dk`;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return mins === 0 ? `${hours} saat` : `${hours} saat ${mins} dk`;
}

function bucketLabel(position) {
  const totalMinutes = position * SLOT_MINUTES;
  if (totalMinutes < 60) return `${totalMinutes} dk`;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return mins === 0 ? `${hours} saat` : `${hours} saat ${mins} dk`;
}

function formatClock(ms) {
  return new Date(ms).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// İş mantığı — basamak / önizleme / bloke (reference.jsx ile birebir)
// ---------------------------------------------------------------------------
function computeMaps(now) {
  const activeTickets = S.tickets; // server zaten picked_up=0 filtreliyor

  const occupiedMap = new Map(); // position -> ticket
  for (const t of activeTickets) {
    const remaining = t.scheduled_time - now;
    if (remaining > 0) {
      const pos = Math.ceil(remaining / SLOT_MS);
      if (pos >= 1) occupiedMap.set(pos, t);
    }
  }

  const previewMap = new Map(); // position -> { targetTime, sourceTicket }
  for (const t of activeTickets) {
    const remaining = t.scheduled_time - now;
    if (remaining > 0) {
      const pos = Math.ceil(remaining / SLOT_MS);
      const prevPos = pos - 1;
      if (prevPos >= 1 && !occupiedMap.has(prevPos)) {
        previewMap.set(prevPos, { targetTime: t.scheduled_time - SLOT_MS, sourceTicket: t });
      }
    }
  }
  return { occupiedMap, previewMap };
}

function describePosition(p, now, maps) {
  const occ = maps.occupiedMap.get(p);
  if (occ) {
    return {
      taken: true,
      label: formatMinutes(occ.scheduled_time - now),
      subLabel: `Dolu · ${occ.code}`,
      time: null,
    };
  }
  const prev = maps.previewMap.get(p);
  if (prev) {
    const remaining = prev.targetTime - now;
    if (remaining < SLOT_MS) {
      return {
        taken: true,
        blocked: true,
        label: formatMinutes(remaining),
        subLabel: "Çok yakın",
        time: null,
      };
    }
    return { taken: false, label: formatMinutes(remaining), time: prev.targetTime };
  }
  return { taken: false, label: bucketLabel(p), pos: p };
}

function candidatePositions() {
  return Array.from({ length: HORIZON_POSITIONS }, (_, i) => i + 1);
}

// ---------------------------------------------------------------------------
// Sunucu iletişimi
// ---------------------------------------------------------------------------
async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  return { ok: res.ok, status: res.status, data };
}

function connectSSE() {
  const es = new EventSource("/events");
  es.onopen = () => { S.connected = true; updateOffline(); };
  es.onerror = () => { S.connected = false; updateOffline(); };
  es.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (_) { return; }
    if (msg.type === "state") {
      S.clockSkew = msg.now - Date.now();
      S.tickets = msg.tickets || [];
      if (S.lastTicket) {
        const fresh = S.tickets.find((t) => t.id === S.lastTicket.id);
        if (fresh) S.lastTicket = fresh;
      }
      render();
    } else if (msg.type === "scan") {
      handleScan(msg);
    }
  };
}

function updateOffline() {
  offlineEl.hidden = S.connected;
}

let _toastTimer = null;
function showToast(msg) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "tq-offline";
    el.style.background = "var(--blocked)";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

// ---------------------------------------------------------------------------
// Kart okuma olayı
// ---------------------------------------------------------------------------
async function handleScan(msg) {
  const card = { id: msg.card_id, code: msg.code_hint };

  if (S.view === "registerScanning") {
    const r = await api("/api/register", {
      card_id: card.id,
      first_name: S.registerFirst,
      last_name: S.registerLast,
    });
    if (r.ok && r.data.ok) {
      S.pendingCard = card;
      S.pendingUser = r.data.user;
      S.view = "registerSuccess";
    } else {
      // kayıt başarısızsa forma geri dön
      S.view = "registerForm";
    }
    render();
    return;
  }

  // Yalnızca "Kartınızı okuyucuya okutun…" ekranındayken (S.view==="scanning")
  // gelen okumayı işle. Başka her ekranda (idle dahil) kart rastgele
  // okutulursa yok say — "Sipariş Ver"e basılmadan sipariş akışı başlamasın.
  if (S.view === "scanning") {
    clearConfirmTimer();
    S.pendingCard = card;
    S.pendingUser = msg.user || null;
    // KAYIT ZORUNLU: kart users tablosunda yoksa siparişe izin verme
    if (!S.pendingUser) {
      S.view = "notRegistered";
      render();
      return;
    }
    proceedToOrder(card, msg.active_ticket);
    return;
  }
}

function proceedToOrder(card, activeTicketHint) {
  const existing =
    S.tickets.find((t) => t.card_id === card.id) ||
    (activeTicketHint
      ? { ...activeTicketHint, card_id: card.id, code: activeTicketHint.code || card.code }
      : null);
  if (existing) {
    S.lastTicket = existing;
    S.view = "blocked";
  } else {
    S.expanded = false;
    S.view = "select";
  }
  render();
}

// ---------------------------------------------------------------------------
// Eylemler
// ---------------------------------------------------------------------------
function goHome() {
  clearConfirmTimer();
  S.view = "idle";
  S.expanded = false;
  S.pendingCard = null;
  S.pendingUser = null;
  S.lastTicket = null;
  S.registerFirst = "";
  S.registerLast = "";
  render();
}

function startOrder() {
  // "Sipariş Ver" butonu — kart bekleme ekranına geç
  S.expanded = false;
  S.pendingCard = null;
  S.pendingUser = null;
  S.view = "scanning";
  render();
}

function goRegisterForm() {
  S.registerFirst = "";
  S.registerLast = "";
  S.view = "registerForm";
  render();
}

function submitRegister() {
  if (!S.registerFirst.trim() || !S.registerLast.trim()) return;
  S.view = "registerScanning";
  render();
}

async function createTicket(scheduledTime) {
  if (!S.pendingCard) return;
  const r = await api("/api/order", {
    card_id: S.pendingCard.id,
    scheduled_time: Math.round(scheduledTime),
  });
  if (r.ok && r.data.ok) {
    S.lastTicket = r.data.ticket;
    S.view = "confirm";
    startConfirmTimer();
    render();
  } else {
    // ör. "Zaten bir tostunuz var" — mevcut bilete düş
    const existing = S.tickets.find((t) => t.card_id === S.pendingCard.id);
    if (existing) {
      S.lastTicket = existing;
      S.view = "blocked";
    } else {
      showToast(r.data.error || "Sipariş oluşturulamadı");
    }
    render();
  }
}

async function pickUp(ticketId) {
  await api("/api/pickup", { ticket_id: ticketId });
  // state SSE ile gelecek
}

async function devAdvance(min) {
  await api("/api/dev/advance", { minutes: min });
}
async function devReset() {
  await api("/api/dev/reset");
  goHome();
}

function clearConfirmTimer() {
  if (S._confirmTimer) { clearTimeout(S._confirmTimer); S._confirmTimer = null; }
}
function startConfirmTimer() {
  clearConfirmTimer();
  S._confirmTimer = setTimeout(() => { goHome(); }, CONFIRM_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// Görünüm (render)
// ---------------------------------------------------------------------------
function topbar(now) {
  return `
    <div class="tq-topbar">
      <div class="tq-brand"><span>🍞</span><span>TOST SIRASI</span></div>
      <div style="display:flex;align-items:center;gap:6px">
        <span class="tq-clock">${formatClock(now)}</span>
        <button class="tq-dev-btn" data-action="toggle-dev">test</button>
        ${nativeReady() ? `
          <button class="tq-win-btn" data-action="win-min" title="Küçült (Ctrl+Shift+M)">—</button>
          <button class="tq-win-btn" data-action="win-quit" title="Kapat (Ctrl+Shift+Q)">✕</button>
        ` : ""}
      </div>
    </div>
    ${S.devOpen ? `
    <div class="tq-dev-panel">
      <p>Test kontrolleri (gerçek sistemde yok)</p>
      <div class="row">
        <button class="tq-chip" data-action="dev-advance" data-min="5">+5 dk</button>
        <button class="tq-chip" data-action="dev-advance" data-min="15">+15 dk</button>
      </div>
      <div class="row">
        <button class="tq-chip" data-action="dev-advance" data-min="60">+60 dk</button>
        <button class="tq-chip warn" data-action="dev-reset">Sıfırla</button>
      </div>
      <p style="margin-top:4px">Donanımsız kart testi</p>
      <div class="row">
        <button class="tq-chip" data-action="dev-scan" data-card="0040805A2D626F6B04">Kart A</button>
        <button class="tq-chip" data-action="dev-scan" data-card="004080A1B2C3D4E508">Kart B</button>
      </div>
      ${nativeReady() ? `
      <p style="margin-top:4px">Pencere (F11 · Ctrl+Shift+M · Ctrl+Shift+Q)</p>
      <div class="row">
        <button class="tq-chip" data-action="win-min">Küçült</button>
        <button class="tq-chip" data-action="win-full">Tam ekran ⇄</button>
      </div>
      <div class="row">
        <button class="tq-chip warn" data-action="win-quit">Uygulamayı kapat</button>
      </div>` : ""}
    </div>` : ""}
  `;
}

function boardHTML(now) {
  const sorted = [...S.tickets].sort((a, b) => a.scheduled_time - b.scheduled_time);
  if (sorted.length === 0) {
    return `
      <div class="tq-board-empty">
        <div class="big">Sırada kimse yok</div>
        <div>İlk tostu almak için kart okutabilirsiniz.</div>
      </div>`;
  }
  const tiles = sorted.map((t) => {
    const remaining = t.scheduled_time - now;
    const ready = remaining <= 0;
    const preparing = !ready && remaining < 60000;
    const statusLabel = ready ? "HAZIR" : preparing ? "Hazırlanıyor" : `${formatMinutes(remaining)} kaldı`;
    return `
      <div class="tq-tile${ready ? " ready" : ""}" data-ticket-id="${t.id}"
           data-sched="${t.scheduled_time}"
           ${ready ? 'data-action="pickup"' : ""}
           ${ready ? 'title="Teslim edildi işaretlemek için dokun"' : ""}>
        <div class="n">${esc(t.code)}</div>
        <div class="s${preparing ? " preparing" : ""}">${statusLabel}</div>
      </div>`;
  }).join("");
  return `<div class="tq-grid">${tiles}</div>`;
}

function idleHTML(now) {
  return `
    <div class="tq-main">
      ${boardHTML(now)}
      <div class="tq-scan-cta">
        <div class="tq-home-btns">
          <button class="tq-scan-btn" data-action="start-order"><span>💳</span> Sipariş Ver</button>
          <button class="tq-secondary-btn" data-action="go-register"><span>📝</span> Kayıt Ol</button>
        </div>
        <div class="tq-scan-note">
          Sipariş vermek için kartınızı okuyucuya okutun. Kartınız kayıtlı
          değilse önce "Kayıt Ol"a dokunun.
        </div>
      </div>
    </div>`;
}

function scanningHTML(text) {
  return `
    <div class="tq-center">
      <div class="tq-scanning-icon">💳</div>
      <div>${esc(text)}</div>
      <button class="tq-confirm-btn" data-action="home">Vazgeç</button>
    </div>`;
}

function selectHTML(now) {
  const maps = computeMaps(now);
  const positions = candidatePositions();
  const nearest = positions.find((p) => !describePosition(p, now, maps).taken);
  const user = S.pendingUser;

  let primary;
  if (nearest) {
    const d = describePosition(nearest, now, maps);
    const attr = d.time != null ? `data-time="${d.time}"` : `data-pos="${d.pos}"`;
    primary = `
      <button class="tq-primary-slot" data-action="select-slot" ${attr}>
        <span class="big">${d.label} sonra</span>
        <span class="small">en yakın uygun saat</span>
      </button>`;
  } else {
    primary = `<button class="tq-primary-slot" disabled>Şu an uygun saat yok</button>`;
  }

  let grid = "";
  if (S.expanded) {
    const cells = positions.map((p) => {
      const d = describePosition(p, now, maps);
      const cls = d.blocked ? " blocked" : d.taken ? " taken" : "";
      const attr = d.taken ? "" : d.time != null ? `data-action="select-slot" data-time="${d.time}"`
                                                  : `data-action="select-slot" data-pos="${d.pos}"`;
      return `
        <button class="tq-slot${cls}" ${attr} ${d.taken ? "disabled" : ""}>
          ${d.label}
          ${d.taken ? `<div style="font-size:10px;margin-top:2px">${esc(d.subLabel)}</div>` : ""}
        </button>`;
    }).join("");
    grid = `<div class="tq-slot-grid">${cells}</div>`;
  }

  return `
    <div class="tq-main">
      <button class="tq-back" data-action="home">← Vazgeç</button>
      <div class="tq-center" style="flex:1">
        <div class="tq-select-title">
          ${user ? `Merhaba ${esc(user.first_name)}, tost ne zaman hazır olsun?`
                 : "Tost ne zaman hazır olsun?"}
        </div>
        ${primary}
        <button class="tq-expand-btn" data-action="toggle-expand">
          ${S.expanded ? "Saatleri gizle ▴" : "Başka saat seç ▾"}
        </button>
        ${grid}
      </div>
    </div>`;
}

function confirmHTML(now) {
  const t = S.lastTicket;
  if (!t) return idleHTML(now);
  return `
    <div class="tq-center">
      <div style="color:var(--text-muted);font-size:14px">Kodunuz</div>
      <div class="tq-confirm-num">${esc(t.code)}</div>
      <div class="tq-confirm-sub">
        ${formatMinutes(t.scheduled_time - now)} sonra hazır olacak · ${formatClock(t.scheduled_time)}
      </div>
      <button class="tq-confirm-btn" data-action="home">Tamam</button>
    </div>`;
}

function blockedHTML(now) {
  const t = S.lastTicket;
  if (!t) return idleHTML(now);
  const ready = t.scheduled_time - now <= 0;
  return `
    <div class="tq-center">
      <div style="color:var(--text-muted);font-size:14px">Zaten bir tostunuz var</div>
      <div class="tq-confirm-num">${esc(t.code)}</div>
      <div class="tq-confirm-sub">
        ${ready ? "Hazır — yeni sipariş vermeden önce teslim alın."
                : `${formatMinutes(t.scheduled_time - now)} sonra hazır olacak.`}
      </div>
      <div style="display:flex;gap:10px;margin-top:6px">
        ${ready ? `<button class="tq-confirm-btn" data-action="pickup-home" data-ticket-id="${t.id}">Teslim Aldım</button>` : ""}
        <button class="tq-confirm-btn" data-action="home">Tamam</button>
      </div>
    </div>`;
}

function notRegisteredHTML() {
  return `
    <div class="tq-center">
      <div style="color:var(--text-muted);font-size:14px">Bu kart kayıtlı değil</div>
      <div style="font-size:20px;font-weight:600;max-width:320px">
        Sipariş verebilmek için önce kayıt olmanız gerekiyor.
      </div>
      <div style="display:flex;gap:10px;margin-top:6px">
        <button class="tq-scan-btn" data-action="go-register"><span>📝</span> Kayıt Ol</button>
        <button class="tq-confirm-btn" data-action="home">Ana Sayfa</button>
      </div>
    </div>`;
}

function registerFormHTML() {
  return `
    <div class="tq-main">
      <button class="tq-back" data-action="home">← Vazgeç</button>
      <div class="tq-center" style="flex:1">
        <div class="tq-select-title">Yeni Kayıt</div>
        <form class="tq-form" data-action="register-submit">
          <div class="tq-field">
            <label for="tq-first">İsim</label>
            <input id="tq-first" class="tq-input" name="first" autocomplete="off"
                   value="${esc(S.registerFirst)}" placeholder="Adınız" autofocus />
          </div>
          <div class="tq-field">
            <label for="tq-last">Soyisim</label>
            <input id="tq-last" class="tq-input" name="last" autocomplete="off"
                   value="${esc(S.registerLast)}" placeholder="Soyadınız" />
          </div>
          <button type="submit" class="tq-scan-btn" style="justify-content:center"
                  ${(!S.registerFirst.trim() || !S.registerLast.trim()) ? "disabled" : ""}>
            Kaydet ve Kartı Oku
          </button>
        </form>
      </div>
    </div>`;
}

function registerSuccessHTML() {
  const u = S.pendingUser, c = S.pendingCard;
  if (!u || !c) return idleHTML(serverNow());
  return `
    <div class="tq-center">
      <div style="color:var(--text-muted);font-size:14px">Hoş geldiniz</div>
      <div style="font-size:26px;font-weight:700">${esc(u.first_name)} ${esc(u.last_name)}</div>
      <div class="tq-confirm-sub">Kaydınız oluşturuldu · kart kodu ${esc(c.code)}</div>
      <div style="display:flex;gap:10px;margin-top:6px">
        <button class="tq-scan-btn" data-action="proceed-order"><span>💳</span> Şimdi Sipariş Ver</button>
        <button class="tq-confirm-btn" data-action="home">Ana Sayfa</button>
      </div>
    </div>`;
}

function render() {
  const now = serverNow();
  let inner = topbar(now);
  switch (S.view) {
    case "idle": inner += idleHTML(now); break;
    case "scanning": inner += scanningHTML("Kartınızı okuyucuya okutun…"); break;
    case "select": inner += selectHTML(now); break;
    case "confirm": inner += confirmHTML(now); break;
    case "blocked": inner += blockedHTML(now); break;
    case "notRegistered": inner += notRegisteredHTML(); break;
    case "registerForm": inner += registerFormHTML(); break;
    case "registerScanning": inner += scanningHTML("Kartınızı okutun, kayıt tamamlanıyor…"); break;
    case "registerSuccess": inner += registerSuccessHTML(); break;
    default: inner += idleHTML(now);
  }
  root.innerHTML = inner;
  S._lastSig = computeSignature();

  if (S.view === "registerForm") {
    const f = root.querySelector("#tq-first");
    if (f) { f.focus(); const v = f.value; f.value = ""; f.value = v; }
  }
}

// Zaman-bağımlı ekranların "imzası" — sadece degistiginde yeniden ciz.
// Bu, saniyede bir DOM'u bosu bosuna yeniden kurmayi (ve dokunma yarislarini)
// engeller: select ekrani pratikte dakikada bir yenilenir.
function computeSignature() {
  const now = serverNow();
  if (S.view === "select") {
    const maps = computeMaps(now);
    const pos = candidatePositions();
    const parts = pos.map((p) => {
      const d = describePosition(p, now, maps);
      return `${d.label}|${!!d.taken}|${!!d.blocked}`;
    });
    const nearest = pos.find((p) => !describePosition(p, now, maps).taken);
    return `sel:${S.expanded}:${nearest}:${parts.join(",")}`;
  }
  if (S.view === "confirm" || S.view === "blocked") {
    const t = S.lastTicket;
    if (!t) return S.view;
    return `${S.view}:${formatMinutes(t.scheduled_time - now)}:${t.scheduled_time - now <= 0}`;
  }
  return `${S.view}:${S.devOpen}`;
}

// Her saniye: saat + canlı süreler.
function tick() {
  const now = serverNow();
  const clock = root.querySelector(".tq-clock");
  if (clock) clock.textContent = formatClock(now);

  if (S.view === "idle") {
    updateBoardInPlace(now);
  } else if (S.view === "select" || S.view === "confirm" || S.view === "blocked") {
    if (computeSignature() !== S._lastSig) render();
  }
}

function updateBoardInPlace(now) {
  const tiles = root.querySelectorAll(".tq-tile[data-ticket-id]");
  if (tiles.length !== S.tickets.length) { render(); return; }
  tiles.forEach((el) => {
    const sched = Number(el.dataset.sched);
    const remaining = sched - now;
    const ready = remaining <= 0;
    const preparing = !ready && remaining < 60000;
    const statusLabel = ready ? "HAZIR" : preparing ? "Hazırlanıyor" : `${formatMinutes(remaining)} kaldı`;
    const s = el.querySelector(".s");
    if (s) { s.textContent = statusLabel; s.classList.toggle("preparing", preparing); }
    if (ready && !el.classList.contains("ready")) {
      el.classList.add("ready");
      el.setAttribute("data-action", "pickup");
    }
  });
}

// ---------------------------------------------------------------------------
// Olay yönlendirme
// ---------------------------------------------------------------------------
root.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const a = el.dataset.action;
  if (a === "toggle-dev") { S.devOpen = !S.devOpen; render(); }
  else if (a === "dev-advance") { devAdvance(Number(el.dataset.min)); }
  else if (a === "dev-reset") { devReset(); }
  else if (a === "dev-scan") { api("/api/dev/scan", { card_id: el.dataset.card }); }
  else if (a === "win-min") { window.pywebview?.api.minimize(); }
  else if (a === "win-full") { window.pywebview?.api.toggle_fullscreen(); }
  else if (a === "win-quit") {
    if (window.confirm("Kiosk uygulaması kapatılsın mı?")) window.pywebview?.api.quit();
  }
  else if (a === "start-order") { startOrder(); }
  else if (a === "go-register") { goRegisterForm(); }
  else if (a === "home") { goHome(); }
  else if (a === "toggle-expand") { S.expanded = !S.expanded; render(); }
  else if (a === "pickup") { pickUp(Number(el.dataset.ticketId)); }
  else if (a === "pickup-home") { pickUp(Number(el.dataset.ticketId)).then(goHome); }
  else if (a === "proceed-order") {
    if (S.pendingCard) proceedToOrder(S.pendingCard, null);
  }
  else if (a === "select-slot") {
    if (el.disabled) return;
    const t = el.dataset.time != null
      ? Number(el.dataset.time)
      : serverNow() + Number(el.dataset.pos) * SLOT_MS;
    createTicket(t);
  }
});

root.addEventListener("input", (e) => {
  const el = e.target;
  if (el.name === "first") { S.registerFirst = el.value; syncRegisterButton(); }
  else if (el.name === "last") { S.registerLast = el.value; syncRegisterButton(); }
});

function syncRegisterButton() {
  const btn = root.querySelector('form[data-action="register-submit"] button[type="submit"]');
  if (btn) btn.disabled = !S.registerFirst.trim() || !S.registerLast.trim();
}

root.addEventListener("submit", (e) => {
  const form = e.target.closest('form[data-action="register-submit"]');
  if (!form) return;
  e.preventDefault();
  submitRegister();
});

// ---- native pencere (pywebview) kısayolları ----
window.addEventListener("keydown", (e) => {
  const w = window.pywebview;
  if (!w) return;
  const k = e.key.toLowerCase();
  if (e.key === "F11") { e.preventDefault(); w.api.toggle_fullscreen(); }
  else if (e.ctrlKey && e.shiftKey && k === "m") { e.preventDefault(); w.api.minimize(); }
  else if (e.ctrlKey && e.shiftKey && k === "q") {
    e.preventDefault();
    if (window.confirm("Kiosk uygulaması kapatılsın mı?")) w.api.quit();
  }
});

// pywebview API'si sayfa yüklendikten sonra enjekte edilir; hazır olunca
// üst çubuktaki pencere butonları belirsin diye yeniden çiz.
window.addEventListener("pywebviewready", () => { _nativeReady = true; render(); });
// güvenlik ağı: bazı sürümlerde event kaçabilir
setTimeout(() => {
  if (!_nativeReady && window.pywebview) { _nativeReady = true; render(); }
}, 1500);

// ---------------------------------------------------------------------------
// Başlat
// ---------------------------------------------------------------------------
connectSSE();
render();
setInterval(tick, 1000);

// İlk state'i hemen çek (SSE gecikmesine karşı)
api("/api/state").then((r) => {
  if (r.ok) {
    S.clockSkew = r.data.now - Date.now();
    S.tickets = r.data.tickets || [];
    render();
  }
});
