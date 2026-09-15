// Tost Sırası — backend istemcisi.
// AYNI gerçek backend API'sine bağlanır (backend/server.py — mimari artık
// "Client Mode": backend geliştiricinin kendi bilgisayarında, kart okuma
// panel PC'nin Electron istemcisinde). Kullanılan uçlar:
//   GET  /api/state            -> {type:"state", now, slot_ms, tickets:[...]}
//   GET  /api/user?card_id=    -> {user: {...}|null}
//   POST /api/order            {card_id, scheduled_time} -> {ok, ticket} | {ok:false, error}
//   POST /api/register         {card_id, first_name, last_name} -> {ok, user}
//   POST /api/pickup           {ticket_id} -> {ok}
//   GET  /events                (SSE) "state" ve "scan" olayları
//
// Adres HARDCODED DEĞİL: Electron paketinde electron/main.cjs, sayfayı
// yüklerken TOST_BACKEND_URL ortam değişkenini ?api= sorgu param olarak
// ekler (bkz. loadKioskApp()). Tarayıcıda `npm run dev` ile test ederken
// VITE_API_BASE ya da ?api= kullanılabilir; hiçbiri yoksa yerel geliştirme
// varsayımıyla localhost'a düşer.
export const API_BASE = (
  new URLSearchParams(window.location.search).get('api') ||
  import.meta.env.VITE_API_BASE ||
  'http://localhost:8080'
).replace(/\/+$/, '');

export async function api(path, body) {
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    return { ok: false, status: 0, data: { error: `Backend bağlantısı kurulamadı: ${error.message}` } };
  }
  let data = {};
  try {
    data = await res.json();
  } catch (_) {
    /* boş yanıt */
  }
  return { ok: res.ok, status: res.status, data };
}

export function getUser(cardId) {
  return api(`/api/user?card_id=${encodeURIComponent(cardId)}`);
}

/**
 * SSE bağlantısını açar. onState(msg) her 'state' olayında, onScan(msg) her
 * 'scan' olayında (gerçek kart okuması) çağrılır. Bağlantı kesilirse
 * EventSource kendiliğinden yeniden dener; her durum değişikliğinde
 * onConnected(bool) çağrılır.
 */
export function connectEvents({ onState, onScan, onConnected }) {
  const es = new EventSource(API_BASE + '/events');
  es.onopen = () => onConnected?.(true);
  es.onerror = () => onConnected?.(false);
  es.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch (_) {
      return;
    }
    if (msg.type === 'state') onState?.(msg);
    else if (msg.type === 'scan') onScan?.(msg);
  };
  return () => es.close();
}
