// Tost Sırası — backend istemcisi.
// AYNI gerçek backend'e (~/tost-kiosk/server.py) bağlanır; server.py hiç
// değişmedi. Kullanılan uçlar:
//   GET  /api/state            -> {type:"state", now, slot_ms, tickets:[...]}
//   GET  /api/user?card_id=    -> {user: {...}|null}
//   POST /api/order            {card_id, scheduled_time} -> {ok, ticket} | {ok:false, error}
//   POST /api/register         {card_id, first_name, last_name} -> {ok, user}
//   POST /api/pickup           {ticket_id} -> {ok}
//   GET  /events                (SSE) "state" ve "scan" olayları

// Build zamanında sabitlenir (Vite): .env / --define ile değiştirilebilir.
// Elektron paketinde varsayılan olarak panel PC'nin LAN adresi.
export const API_BASE = (
  new URLSearchParams(window.location.search).get('api') ||
  import.meta.env.VITE_API_BASE ||
  'http://10.42.0.74:8080'
).replace(/\/+$/, '');

export async function api(path, body) {
  const res = await fetch(API_BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
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
