import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SLOT_MS,
  formatMinutes,
  bucketLabel,
  formatClock,
  computeMaps,
  describePosition,
  candidatePositions,
  nearestOpenPosition,
} from './logic.js';
import { api, connectEvents } from './api.js';

const CONFIRM_TIMEOUT_MS = 6000;

export default function App() {
  // ---- durum (mevcut vanilla app.js'teki S nesnesiyle birebir aynı alanlar) ----
  const [view, setView] = useState('idle');
  const [expanded, setExpanded] = useState(false);
  const [pendingCard, setPendingCard] = useState(null); // {id, code}
  const [pendingUser, setPendingUser] = useState(null); // {first_name, last_name}
  const [lastTicket, setLastTicket] = useState(null);
  const [registerFirst, setRegisterFirst] = useState('');
  const [registerLast, setRegisterLast] = useState('');
  const [tickets, setTickets] = useState([]);
  const [clockSkew, setClockSkew] = useState(0);
  const [connected, setConnected] = useState(false);
  const [, setTick] = useState(0); // saniyede bir yeniden çiz (canlı sayaçlar için)
  const [nativeReady, setNativeReady] = useState(!!window.tostNative);

  const confirmTimerRef = useRef(null);
  const now = () => Date.now() + clockSkew;

  // her zaman güncel değerleri SSE callback'inden okuyabilmek için ref aynası
  const stateRef = useRef({});
  stateRef.current = { view, tickets, pendingCard, pendingUser };

  // ---------------------------------------------------------------------
  // Sunucu bağlantısı
  // ---------------------------------------------------------------------
  const proceedToOrder = useCallback((card, activeTicketHint) => {
    const { tickets: curTickets } = stateRef.current;
    const cardTickets = curTickets.filter((t) => t.card_id === card.id);
    const activeCount = Math.max(card.activeCount || 0, cardTickets.length);
    const existing = cardTickets[0] ||
      (activeTicketHint
        ? { ...activeTicketHint, card_id: card.id, code: activeTicketHint.code || card.code }
        : null);
    if (activeCount >= 4) {
      setLastTicket({ ...existing, active_count: activeCount });
      setView('blocked');
    } else {
      setExpanded(false);
      setView('select');
    }
  }, []);

  const handleScan = useCallback(
    async (msg) => {
      const card = { id: msg.card_id, code: msg.code_hint, activeCount: msg.active_count };
      const { view: curView } = stateRef.current;

      if (curView === 'registerScanning') {
        const { pendingFirst, pendingLast } = stateRef.current;
        const r = await api('/api/register', {
          card_id: card.id,
          first_name: pendingFirst,
          last_name: pendingLast,
        });
        if (r.ok && r.data.ok) {
          setPendingCard(card);
          setPendingUser(r.data.user);
          setView('registerSuccess');
        } else {
          setView('registerForm');
        }
        return;
      }

      // Yalnızca "Kartınızı okuyucuya okutun…" ekranındayken (curView==='scanning')
      // gelen okumayı işle. Başka her ekranda (idle dahil) kart rastgele
      // okutulursa yok say — "Sipariş Ver"e basılmadan sipariş akışı başlamasın.
      if (curView === 'scanning') {
        clearTimeout(confirmTimerRef.current);
        setPendingCard(card);
        setPendingUser(msg.user || null);
        if (!msg.user) {
          setView('notRegistered');
          return;
        }
        proceedToOrder(card, msg.active_ticket);
      }
    },
    [proceedToOrder]
  );

  useEffect(() => {
    const disconnect = connectEvents({
      onConnected: setConnected,
      onState: (msg) => {
        setClockSkew(msg.now - Date.now());
        setTickets(msg.tickets || []);
      },
      onScan: (msg) => {
        handleScan(msg);
      },
    });
    // ilk durumu SSE gecikmesine karşı hemen çek
    api('/api/state').then((r) => {
      if (r.ok) {
        setClockSkew(r.data.now - Date.now());
        setTickets(r.data.tickets || []);
      }
    });
    return disconnect;
  }, [handleScan]);

  // registerFirst/registerLast'i de ref aynasına koy (handleScan içinde kullanılıyor)
  stateRef.current.pendingFirst = registerFirst;
  stateRef.current.pendingLast = registerLast;

  // saniyelik tik — canlı geri sayımlar için
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (window.tostNative) {
      setNativeReady(true);
      return;
    }
    const onReady = () => setNativeReady(true);
    window.addEventListener('tostnativeready', onReady);
    return () => window.removeEventListener('tostnativeready', onReady);
  }, []);

  useEffect(() => {
    if (view !== 'confirm') return;
    confirmTimerRef.current = setTimeout(() => goHome(), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(confirmTimerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // ---------------------------------------------------------------------
  // Eylemler
  // ---------------------------------------------------------------------
  function goHome() {
    clearTimeout(confirmTimerRef.current);
    setView('idle');
    setExpanded(false);
    setPendingCard(null);
    setPendingUser(null);
    setLastTicket(null);
    setRegisterFirst('');
    setRegisterLast('');
  }

  function startOrder() {
    setExpanded(false);
    setPendingCard(null);
    setPendingUser(null);
    setView('scanning');
  }

  function goRegisterForm() {
    setRegisterFirst('');
    setRegisterLast('');
    setView('registerForm');
  }

  function submitRegister(e) {
    e.preventDefault();
    if (!registerFirst.trim() || !registerLast.trim()) return;
    setView('registerScanning');
  }

  async function createTicket(scheduledTime) {
    if (!pendingCard) return;
    const r = await api('/api/order', { card_id: pendingCard.id, scheduled_time: Math.round(scheduledTime) });
    if (r.ok && r.data.ok) {
      setLastTicket(r.data.ticket);
      setView('confirm');
    } else {
      const cardTickets = tickets.filter((t) => t.card_id === pendingCard.id);
      if (r.data.error === 'Bu kartla en fazla 4 aktif siparis verebilirsiniz' || cardTickets.length >= 4) {
        window.alert('Bu kartla en fazla 4 aktif sipariş verebilirsiniz.');
      } else {
        window.alert(r.data.error || 'Sipariş oluşturulamadı');
      }
    }
  }

  async function pickUp(ticketId) {
    await api('/api/pickup', { ticket_id: ticketId });
  }

  // ---------------------------------------------------------------------
  // Görünüm
  // ---------------------------------------------------------------------
  const nowMs = now();
  const currentUser = pendingUser;
  const sortedTickets = [...tickets].sort((a, b) => a.scheduled_time - b.scheduled_time);

  return (
    <div className="tq-root">
      <Topbar
        now={nowMs}
        nativeReady={nativeReady}
        connected={connected}
      />

      {view === 'idle' && (
        <IdleView tickets={sortedTickets} now={nowMs} pickUp={pickUp} startOrder={startOrder} goRegisterForm={goRegisterForm} />
      )}
      {view === 'scanning' && <ScanningView text="Kartınızı okuyucuya okutun…" onCancel={goHome} />}
      {view === 'select' && (
        <SelectView
          now={nowMs}
          tickets={tickets}
          user={currentUser}
          expanded={expanded}
          setExpanded={setExpanded}
          onSelect={createTicket}
          onHome={goHome}
        />
      )}
      {view === 'confirm' && lastTicket && <ConfirmView ticket={lastTicket} now={nowMs} onHome={goHome} />}
      {view === 'blocked' && lastTicket && (
        <BlockedView ticket={lastTicket} now={nowMs} onHome={goHome} onPickup={() => pickUp(lastTicket.id).then(goHome)} />
      )}
      {view === 'notRegistered' && <NotRegisteredView onRegister={goRegisterForm} onHome={goHome} />}
      {view === 'registerForm' && (
        <RegisterFormView
          first={registerFirst}
          last={registerLast}
          setFirst={setRegisterFirst}
          setLast={setRegisterLast}
          onSubmit={submitRegister}
          onHome={goHome}
        />
      )}
      {view === 'registerScanning' && <ScanningView text="Kartınızı okutun, kayıt tamamlanıyor…" onCancel={goHome} />}
      {view === 'registerSuccess' && pendingUser && pendingCard && (
        <RegisterSuccessView
          user={pendingUser}
          card={pendingCard}
          onOrder={() => proceedToOrder(pendingCard, null)}
          onHome={goHome}
        />
      )}
    </div>
  );
}

// =====================================================================
// Alt bileşenler
// =====================================================================

function Topbar({ now, nativeReady, connected }) {
  return (
    <>
      <div className="tq-topbar">
        <div className="tq-brand">
          <span>🍞</span>
          <span>TOST SIRASI</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {!connected && <span className="tq-offline-dot" title="Bağlantı yok" />}
          <span className="tq-clock">{formatClock(now)}</span>
          <button className="tq-dev-btn" type="button">test</button>
          {nativeReady && (
            <>
              <button className="tq-win-btn" title="Küçült (Ctrl+Shift+M)" onClick={() => window.tostNative?.minimize()}>
                —
              </button>
              <button className="tq-win-btn" title="Kapat (Ctrl+Shift+Q)" onClick={() => {
                if (window.confirm('Kiosk uygulaması kapatılsın mı?')) window.tostNative?.quit();
              }}>
                ✕
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function IdleView({ tickets, now, pickUp, startOrder, goRegisterForm }) {
  return (
    <div className="tq-main">
      {tickets.length === 0 ? (
        <div className="tq-board-empty">
          <div className="big">Sırada kimse yok</div>
          <div>İlk tostu almak için kart okutabilirsiniz.</div>
        </div>
      ) : (
        <div className="tq-grid">
          {tickets.map((t) => {
            const remaining = t.scheduled_time - now;
            const ready = remaining <= 0;
            const preparing = !ready && remaining < 60000;
            const statusLabel = ready ? 'HAZIR' : preparing ? 'Hazırlanıyor' : `${formatMinutes(remaining)} kaldı`;
            return (
              <div
                key={t.id}
                className={`tq-tile${ready ? ' ready' : ''}`}
                onClick={ready ? () => pickUp(t.id) : undefined}
                title={ready ? 'Teslim edildi işaretlemek için dokun' : undefined}
              >
                <div className="n">{t.code}</div>
                {t.first_name && (
                  <div className="s">{t.first_name} {t.last_name}</div>
                )}
                <div className={`s${preparing ? ' preparing' : ''}`}>{statusLabel}</div>
              </div>
            );
          })}
        </div>
      )}
      <div className="tq-scan-cta">
        <div className="tq-home-btns">
          <button className="tq-scan-btn" onClick={startOrder}><span>💳</span> Sipariş Ver</button>
          <button className="tq-secondary-btn" onClick={goRegisterForm}><span>📝</span> Kayıt Ol</button>
        </div>
        <div className="tq-scan-note">
          Sipariş vermek için kartınızı okuyucuya okutun. Kartınız kayıtlı değilse önce &quot;Kayıt Ol&quot;a dokunun.
        </div>
      </div>
    </div>
  );
}

function ScanningView({ text, onCancel }) {
  return (
    <div className="tq-center">
      <div className="tq-scanning-icon">💳</div>
      <div>{text}</div>
      <button className="tq-confirm-btn" onClick={onCancel}>Vazgeç</button>
    </div>
  );
}

function SelectView({ now, tickets, user, expanded, setExpanded, onSelect, onHome }) {
  const maps = computeMaps(tickets, now);
  const positions = candidatePositions();
  const nearest = nearestOpenPosition(now, maps);

  let primary;
  if (nearest) {
    const d = describePosition(nearest, now, maps);
    primary = (
      <button className="tq-primary-slot" onClick={() => onSelect(d.time != null ? d.time : now + d.pos * SLOT_MS)}>
        <span className="big">{d.label} sonra</span>
        <span className="small">en yakın uygun saat</span>
      </button>
    );
  } else {
    primary = <button className="tq-primary-slot" disabled>Şu an uygun saat yok</button>;
  }

  return (
    <div className="tq-main">
      <button className="tq-back" onClick={onHome}>← Vazgeç</button>
      <div className="tq-center" style={{ flex: 1 }}>
        <div className="tq-select-title">
          {user ? `Merhaba ${user.first_name}, tost ne zaman hazır olsun?` : 'Tost ne zaman hazır olsun?'}
        </div>
        {primary}
        <button className="tq-expand-btn" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Saatleri gizle ▴' : 'Başka saat seç ▾'}
        </button>
        {expanded && (
          <div className="tq-slot-grid">
            {positions.map((p) => {
              const d = describePosition(p, now, maps);
              const cls = d.blocked ? ' blocked' : d.taken ? ' taken' : '';
              return (
                <button
                  key={p}
                  className={`tq-slot${cls}`}
                  disabled={d.taken}
                  onClick={() => !d.taken && onSelect(d.time != null ? d.time : now + p * SLOT_MS)}
                >
                  {d.label}
                  {d.taken && <div style={{ fontSize: 10, marginTop: 2 }}>{d.subLabel}</div>}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function ConfirmView({ ticket, now, onHome }) {
  return (
    <div className="tq-center">
      <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>Kodunuz</div>
      <div className="tq-confirm-num">{ticket.code}</div>
      <div className="tq-confirm-sub">
        {formatMinutes(ticket.scheduled_time - now)} sonra hazır olacak · {formatClock(ticket.scheduled_time)}
      </div>
      <button className="tq-confirm-btn" onClick={onHome}>Tamam</button>
    </div>
  );
}

function BlockedView({ ticket, now, onHome, onPickup }) {
  const ready = ticket.scheduled_time - now <= 0;
  return (
    <div className="tq-center">
      <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>
        {ticket.active_count >= 4 ? 'Bu kartla en fazla 4 aktif sipariş verilebilir' : 'Sipariş verilemedi'}
      </div>
      <div className="tq-confirm-num">{ticket.code}</div>
      {ticket.active_count >= 4 && ticket.first_name && (
        <div style={{ color: 'var(--text-muted)', fontSize: 16 }}>{ticket.first_name} {ticket.last_name}</div>
      )}
      <div className="tq-confirm-sub">
        {ready ? 'Hazır — yeni sipariş vermeden önce teslim alın.' : `${formatMinutes(ticket.scheduled_time - now)} sonra hazır olacak.`}
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
        {ready && <button className="tq-confirm-btn" onClick={onPickup}>Teslim Aldım</button>}
        <button className="tq-confirm-btn" onClick={onHome}>Tamam</button>
      </div>
    </div>
  );
}

function NotRegisteredView({ onRegister, onHome }) {
  return (
    <div className="tq-center">
      <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>Bu kart kayıtlı değil</div>
      <div style={{ fontSize: 20, fontWeight: 600, maxWidth: 320 }}>
        Sipariş verebilmek için önce kayıt olmanız gerekiyor.
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
        <button className="tq-scan-btn" onClick={onRegister}><span>📝</span> Kayıt Ol</button>
        <button className="tq-confirm-btn" onClick={onHome}>Ana Sayfa</button>
      </div>
    </div>
  );
}

function RegisterFormView({ first, last, setFirst, setLast, onSubmit, onHome }) {
  return (
    <div className="tq-main">
      <button className="tq-back" onClick={onHome}>← Vazgeç</button>
      <div className="tq-center" style={{ flex: 1 }}>
        <div className="tq-select-title">Yeni Kayıt</div>
        <form className="tq-form" onSubmit={onSubmit}>
          <div className="tq-field">
            <label htmlFor="tq-first">İsim</label>
            <input id="tq-first" className="tq-input" autoComplete="off" autoFocus
              value={first} onChange={(e) => setFirst(e.target.value)} placeholder="Adınız" />
          </div>
          <div className="tq-field">
            <label htmlFor="tq-last">Soyisim</label>
            <input id="tq-last" className="tq-input" autoComplete="off"
              value={last} onChange={(e) => setLast(e.target.value)} placeholder="Soyadınız" />
          </div>
          <button type="submit" className="tq-scan-btn" style={{ justifyContent: 'center' }}
            disabled={!first.trim() || !last.trim()}>
            Kaydet ve Kartı Oku
          </button>
        </form>
      </div>
    </div>
  );
}

function RegisterSuccessView({ user, card, onOrder, onHome }) {
  return (
    <div className="tq-center">
      <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>Hoş geldiniz</div>
      <div style={{ fontSize: 26, fontWeight: 700 }}>{user.first_name} {user.last_name}</div>
      <div className="tq-confirm-sub">Kaydınız oluşturuldu · kart kodu {card.code}</div>
      <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
        <button className="tq-scan-btn" onClick={onOrder}><span>💳</span> Şimdi Sipariş Ver</button>
        <button className="tq-confirm-btn" onClick={onHome}>Ana Sayfa</button>
      </div>
    </div>
  );
}
