import { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import MobileTrackView from './MobileTrackView.jsx';
import {
  SLOT_MS,
  formatMinutes,
  formatClock,
  computeMaps,
  describePosition,
  candidatePositions,
  nearestOpenPosition,
  ITEM_POINTS,
  calculateOrderPoints,
} from './logic.js';
import { api, connectEvents } from './api.js';
import { TRANSLATIONS } from './i18n.js';

const CONFIRM_TIMEOUT_MS = 12000;
const INACTIVITY_TIMEOUT_MS = 45000;
// Public tünel adresi ARTIK HARDCODE EDİLMİYOR — cloudflared her yeniden
// başlatıldığında rastgele yeni bir adres alır (ücretsiz Quick Tunnel).
// Backend, o an GERÇEKTEN çalışan adresi cloudflared'in --metrics uç
// noktasından okuyup state'e (tunnel_url) ekliyor; biz de burada onu
// canlı (SSE) state'den okuyoruz — bkz. aşağıdaki tunnelUrl state'i.

const STANDARD_TOASTS = ['Sucuklu', 'Patatesli', 'Kaşarlı (Sade)', 'Kavurmalı', 'Ton Balıklı', 'Yumurtalı', 'Karışık', 'Vejetaryen'];
const BREADS = ['Tam Buğday', 'Kepekli', 'Beyaz Ekmek', 'Susamlı'];
const FILLINGS = ['Sucuk', 'Kavurma', 'Ton Balığı', 'Yumurta', 'Kızartılmış Patates', 'Salam', 'Sosis'];
const CHEESES = ['Kaşar Peyniri', 'Cheddar Peyniri', 'Peynir İstemiyorum'];
const GREENS = ['Salatalık', 'Avokado', 'Marul', 'Zeytin', 'Mısır', 'Patates Püresi', 'Brokoli'];

function formatSelectionSummary(sel) {
  if (!sel) return 'Standart Tost';
  if (sel.type === 'standard') return sel.name || 'Standart Tost';
  if (sel.type === 'custom') {
    const parts = [];
    if (sel.bread) parts.push(sel.bread);
    if (Array.isArray(sel.fillings) && sel.fillings.length) parts.push(sel.fillings.join(', '));
    if (sel.cheese && sel.cheese !== 'Peynir İstemiyorum') parts.push(sel.cheese);
    if (Array.isArray(sel.greens) && sel.greens.length) parts.push(sel.greens.join(', '));
    if (sel.sauce && sel.sauce !== 'Özel Sos İstemiyorum') parts.push(sel.sauce);
    return parts.length ? parts.join(' · ') : 'Özel Tost';
  }
  return 'Standart Tost';
}

function isNewerVersion(remote, local) {
  if (!remote || !local) return false;
  const pRemote = remote.replace(/^v/, '').split('.').map(Number);
  const pLocal = local.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pRemote.length, pLocal.length); i++) {
    const r = pRemote[i] || 0;
    const l = pLocal[i] || 0;
    if (r > l) return true;
    if (r < l) return false;
  }
  return false;
}

export default function App() {
  const urlParams = new URLSearchParams(window.location.search);
  const trackCode = urlParams.get('track');
  const trackId = urlParams.get('id');
  const trackUntil = urlParams.get('until');
  if (trackCode) {
    return (
      <MobileTrackView
        ticketCode={trackCode}
        ticketId={trackId ? Number(trackId) : null}
        targetTime={trackUntil ? Number(trackUntil) : null}
      />
    );
  }

  const [lang, setLang] = useState(() => {
    try {
      return localStorage.getItem('tost-kiosk-lang') || 'tr';
    } catch (_) {
      return 'tr';
    }
  });

  const t = TRANSLATIONS[lang] || TRANSLATIONS.tr;

  function toggleLang() {
    const next = lang === 'tr' ? 'en' : 'tr';
    setLang(next);
    try {
      localStorage.setItem('tost-kiosk-lang', next);
    } catch (_) {}
  }

  const [view, setView] = useState('idle');
  const [expanded, setExpanded] = useState(false);
  const [pendingCard, setPendingCard] = useState(null);
  const [pendingUser, setPendingUser] = useState(null);
  const [orderSelection, setOrderSelection] = useState(null);
  const [lastTicket, setLastTicket] = useState(null);
  const [profile, setProfile] = useState(null);
  const [deletionRequestSent, setDeletionRequestSent] = useState(false);
  const [registerFirst, setRegisterFirst] = useState('');
  const [registerLast, setRegisterLast] = useState('');
  const [tickets, setTickets] = useState([]);
  const [tunnelUrl, setTunnelUrl] = useState(null);
  const [devOpen, setDevOpen] = useState(false);
  const [outOfStock, setOutOfStock] = useState([]);
  const [clockSkew, setClockSkew] = useState(0);
  const [connected, setConnected] = useState(false);
  const [, setTick] = useState(0);
  const [nativeReady, setNativeReady] = useState(!!window.tostNative);
  const [userOrders, setUserOrders] = useState([]);
  const [brightness, setBrightness] = useState(() => {
    try {
      return Number(localStorage.getItem('tost-kiosk-brightness')) || 100;
    } catch (_) {
      return 100;
    }
  });

  const confirmTimerRef = useRef(null);
  const now = () => Date.now() + clockSkew;

  const stateRef = useRef({});
  stateRef.current = { view, tickets, pendingCard, pendingUser };

  const proceedToOrder = useCallback((card, activeTicketHint) => {
    setExpanded(false);
    setOrderSelection(null);
    setView('menu');
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

      if (curView === 'profileScanning') {
        const r = await api(`/api/profile?card_id=${encodeURIComponent(card.id)}`);
        if (r.ok && r.data.ok) {
          setProfile(r.data.profile);
          setDeletionRequestSent(false);
          setView('profile');
        } else {
          // Kart kayıtlı değil — ana sayfaya dönmek yerine doğrudan kayıt
          // akışına yönlendir (diğer tarama noktalarıyla tutarlı).
          setProfile(null);
          setPendingCard(card);
          setPendingUser(null);
          setView('registerForm');
        }
        return;
      }

      if (curView === 'cancelScanning') {
        setPendingCard(card);
        setPendingUser(msg.user || null);
        if (!msg.user) {
          setView('registerForm');
          return;
        }
        const myActive = (stateRef.current.tickets || []).filter(
          (t) => t.card_id === card.id && !t.cancelled && (t.scheduled_time - (Date.now() + clockSkew) > 0)
        );
        setUserOrders(myActive);
        setView('cancelOrdersList');
        return;
      }

      if (curView === 'scanning') {
        clearTimeout(confirmTimerRef.current);
        setPendingCard(card);
        setPendingUser(msg.user || null);
        if (!msg.user) {
          setView('registerForm');
          return;
        }
        if (msg.user.is_blocked) {
          window.alert(t.accountBlockedAlert);
          setView('idle');
          return;
        }
        proceedToOrder(card, msg.active_ticket);
      }
    },
    [proceedToOrder, t.accountBlockedAlert, clockSkew]
  );

  useEffect(() => {
    const disconnect = connectEvents({
      onConnected: setConnected,
      onState: (msg) => {
        setClockSkew(msg.now - Date.now());
        setTickets(msg.tickets || []);
        if (msg.out_of_stock) setOutOfStock(msg.out_of_stock);
        setTunnelUrl(msg.tunnel_url || null);
      },
      onScan: (msg) => {
        handleScan(msg);
      },
    });

    api('/api/state').then((r) => {
      if (r.ok) {
        setClockSkew(r.data.now - Date.now());
        setTickets(r.data.tickets || []);
        if (r.data.out_of_stock) setOutOfStock(r.data.out_of_stock);
        setTunnelUrl(r.data.tunnel_url || null);
      }
    });
    return disconnect;
  }, [handleScan]);

  stateRef.current.pendingFirst = registerFirst;
  stateRef.current.pendingLast = registerLast;

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
  }, [view]);

  useEffect(() => {
    if (view === 'idle' || view === 'confirm') return;

    let timer = setTimeout(() => {
      goHome();
    }, INACTIVITY_TIMEOUT_MS);

    function resetTimer() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        goHome();
      }, INACTIVITY_TIMEOUT_MS);
    }

    const events = ['pointerdown', 'touchstart', 'click', 'keydown'];
    events.forEach((evt) => window.addEventListener(evt, resetTimer));

    return () => {
      clearTimeout(timer);
      events.forEach((evt) => window.removeEventListener(evt, resetTimer));
    };
  }, [view]);

  useEffect(() => {
    try {
      localStorage.setItem('tost-kiosk-brightness', String(brightness));
    } catch (_) {}
  }, [brightness]);

  function goHome() {
    clearTimeout(confirmTimerRef.current);
    setView('idle');
    setExpanded(false);
    setPendingCard(null);
    setPendingUser(null);
    setOrderSelection(null);
    setLastTicket(null);
    setProfile(null);
    setUserOrders([]);
    setRegisterFirst('');
    setRegisterLast('');
  }

  function startOrder() {
    setExpanded(false);
    setPendingCard(null);
    setPendingUser(null);
    setOrderSelection(null);
    setView('scanning');
  }

  function startCancelFlow() {
    setPendingCard(null);
    setPendingUser(null);
    setUserOrders([]);
    setView('cancelScanning');
  }

  async function handleCancelOrder(ticketId) {
    if (!pendingCard) return;
    const r = await api('/api/order/cancel', {
      ticket_id: ticketId,
      card_id: pendingCard.id,
    });
    if (r.ok && r.data.ok) {
      window.alert(t.cancelSuccessMsg);
      goHome();
    } else {
      window.alert(r.data.error || 'İptal işlemi başarısız');
    }
  }

  function continueToSchedule(selection) {
    setOrderSelection(selection);
    setView('select');
  }

  function openSettings() {
    clearTimeout(confirmTimerRef.current);
    setProfile(null);
    setView('settings');
  }

  function startProfileScan() {
    setProfile(null);
    setDeletionRequestSent(false);
    setView('profileScanning');
  }

  async function requestAccountDeletion() {
    if (!profile || deletionRequestSent) return;
    const r = await api('/api/account-deletion-request', { card_id: profile.card_id });
    if (r.ok && r.data.ok) {
      setDeletionRequestSent(true);
    } else {
      window.alert(r.data.error || 'İstek gönderilemedi');
    }
  }

  function submitRegister(e) {
    e.preventDefault();
    if (!registerFirst.trim() || !registerLast.trim()) return;
    setView('registerScanning');
  }

  async function createTicket(scheduledTime) {
    if (!pendingCard) return;
    const points = orderSelection?.points || 0;
    const summaryStr = formatSelectionSummary(orderSelection);

    const r = await api('/api/order', {
      card_id: pendingCard.id,
      scheduled_time: Math.round(scheduledTime),
      points: points,
      items_summary: summaryStr,
    });
    if (r.ok && r.data.ok) {
      setLastTicket(r.data.ticket);
      setView('confirm');
    } else {
      window.alert(r.data.error || 'Sipariş oluşturulamadı');
    }
  }

  async function pickUp(ticketId) {
    await api('/api/pickup', { ticket_id: ticketId });
  }

  async function dismissCancelled(ticketId) {
    await api('/api/ticket/dismiss', { ticket_id: ticketId });
  }

  // Sıra listesindeki bekleyen (henüz hazır olmayan) bir karta dokununca
  // QR kodunu tekrar gösterir — ilk seferde yetişemeyen müşteri için.
  function showQrForTicket(ticket) {
    setLastTicket(ticket);
    setView('confirm');
  }

  async function devAdvance() {
    const r = await api('/api/dev/advance', { minutes: 5 });
    if (!r.ok) window.alert(r.data.error || 'Test zamanı ilerletilemedi');
  }

  async function devReset() {
    const r = await api('/api/dev/reset', {});
    if (r.ok) {
      setTickets([]);
      goHome();
    } else {
      window.alert(r.data.error || 'Test sıfırlanamadı');
    }
  }

  const nowMs = now();
  const currentUser = pendingUser;
  const sortedTickets = [...tickets].sort((a, b) => a.scheduled_time - b.scheduled_time);

  return (
    <div className="tq-root" style={{ filter: `brightness(${brightness}%)` }}>
      <Topbar
        t={t}
        lang={lang}
        toggleLang={toggleLang}
        now={nowMs}
        devOpen={devOpen}
        setDevOpen={setDevOpen}
        devAdvance={devAdvance}
        devReset={devReset}
        nativeReady={nativeReady}
        connected={connected}
        onSettings={openSettings}
      />

      {view === 'idle' && (
        <IdleView
          t={t}
          lang={lang}
          tickets={sortedTickets}
          now={nowMs}
          pickUp={pickUp}
          dismissCancelled={dismissCancelled}
          onShowQr={showQrForTicket}
          startOrder={startOrder}
          startCancelFlow={startCancelFlow}
        />
      )}
      {view === 'scanning' && <ScanningView text={t.cardScanPrompt} cancelText={t.cancel} onCancel={goHome} />}
      {view === 'cancelScanning' && <ScanningView text={t.cardScanCancelPrompt} cancelText={t.cancel} onCancel={goHome} />}
      
      {view === 'cancelOrdersList' && (
        <CancelOrdersView
          t={t}
          lang={lang}
          now={nowMs}
          orders={userOrders}
          onCancelOrder={handleCancelOrder}
          onHome={goHome}
        />
      )}

      {view === 'menu' && (
        <ToastMenuView
          t={t}
          user={currentUser}
          outOfStock={outOfStock}
          onContinue={continueToSchedule}
          onHome={goHome}
        />
      )}
      {view === 'select' && (
        <SelectView
          t={t}
          lang={lang}
          now={nowMs}
          tickets={tickets}
          user={currentUser}
          expanded={expanded}
          setExpanded={setExpanded}
          orderSelection={orderSelection}
          onSelect={createTicket}
          onHome={goHome}
        />
      )}
      {view === 'confirm' && lastTicket && <ConfirmView t={t} lang={lang} ticket={lastTicket} now={nowMs} tunnelUrl={tunnelUrl} onHome={goHome} />}
      {view === 'blocked' && lastTicket && (
        <BlockedView t={t} lang={lang} ticket={lastTicket} now={nowMs} onHome={goHome} onPickup={() => pickUp(lastTicket.id).then(goHome)} />
      )}
      {view === 'registerForm' && (
        <RegisterFormView
          t={t}
          first={registerFirst}
          last={registerLast}
          setFirst={setRegisterFirst}
          setLast={setRegisterLast}
          onSubmit={submitRegister}
          onHome={goHome}
        />
      )}
      {view === 'registerScanning' && <ScanningView text={t.cardScanRegisterPrompt} cancelText={t.cancel} onCancel={goHome} />}
      {view === 'registerSuccess' && pendingUser && pendingCard && (
        <RegisterSuccessView
          t={t}
          user={pendingUser}
          card={pendingCard}
          onOrder={() => proceedToOrder(pendingCard, null)}
          onHome={goHome}
        />
      )}
      {view === 'settings' && (
        <SettingsView
          t={t}
          brightness={brightness}
          setBrightness={setBrightness}
          nativeReady={nativeReady}
          connected={connected}
          onProfile={startProfileScan}
          onHome={goHome}
        />
      )}
      {view === 'profileScanning' && (
        <ScanningView text={t.cardScanProfilePrompt} cancelText={t.cancel} onCancel={openSettings} />
      )}
      {view === 'profile' && profile && (
        <ProfileView
          t={t}
          profile={profile}
          now={nowMs}
          deletionRequestSent={deletionRequestSent}
          onRequestDeletion={requestAccountDeletion}
          onHome={goHome}
          onBack={openSettings}
        />
      )}
    </div>
  );
}

// =====================================================================
// Topbar (Sade & Zarif Ortalanmış Saat)
// =====================================================================

function Topbar({ t, lang, toggleLang, now, devOpen, setDevOpen, devAdvance, devReset, nativeReady, connected, onSettings }) {
  return (
    <>
      <div className="tq-topbar" style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center' }}>
        <div className="tq-brand" style={{ display: 'flex', alignItems: 'center', gap: 8, justifySelf: 'start' }}>
          <span style={{ fontSize: 22 }}>🥪</span>
          <span style={{ fontWeight: 800, letterSpacing: 0.8 }}>{t.brand}</span>
          <span style={{ fontSize: 10, background: 'rgba(255,255,255,0.08)', padding: '2px 5px', borderRadius: 4, color: '#94a3b8' }}>
            {t.brandSubtitle}
          </span>
        </div>

        <div style={{ justifySelf: 'center', display: 'flex', alignItems: 'center', gap: 8 }}>
          {!connected && <span className="tq-offline-dot" title="Offline" />}
          <span style={{ fontSize: 18, fontWeight: 500, letterSpacing: 1.5, color: '#94a3b8' }}>
            {formatClock(now)}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifySelf: 'end' }}>
          <button
            onClick={toggleLang}
            style={{
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.2)',
              color: '#fff',
              fontWeight: 700,
              fontSize: 12,
              padding: '5px 10px',
              borderRadius: 8,
              cursor: 'pointer',
              letterSpacing: 0.5
            }}
            title="Language"
          >
            {lang === 'tr' ? '🇬🇧 EN' : '🇹🇷 TR'}
          </button>

          <button className="tq-dev-btn" onClick={() => setDevOpen((v) => !v)}>test</button>
          <button className="tq-settings-btn" title={t.settings} aria-label={t.settings} onClick={onSettings}>⚙</button>
          {nativeReady && (
            <>
              <button className="tq-win-btn" title="Minimize" onClick={() => window.tostNative?.minimize()}>
                —
              </button>
              <button className="tq-win-btn" title="Quit" onClick={() => {
                if (window.confirm('Kiosk uygulaması kapatılsın mı?')) window.tostNative?.quit();
              }}>
                ✕
              </button>
            </>
          )}
        </div>
      </div>
      {devOpen && (
        <div className="tq-dev-panel">
          <div className="row">
            <button className="tq-chip" onClick={devAdvance}>+5 dk</button>
            <button className="tq-chip warn" onClick={devReset}>Sıfırla</button>
          </div>
        </div>
      )}
    </>
  );
}

// =====================================================================
// Ana Ekran (Sipariş Ver + İptal Butonları & Yeşil/Kırmızı Kartlar)
// =====================================================================

function IdleView({ t, lang, tickets, now, pickUp, dismissCancelled, onShowQr, startOrder, startCancelFlow }) {
  const waitingTickets = tickets.filter((ticket) => !ticket.cancelled && ticket.scheduled_time - now > 0);
  const alertTickets = tickets.filter((ticket) => ticket.cancelled || ticket.scheduled_time - now <= 0);

  function renderWaitingTicket(ticket) {
    const remaining = ticket.scheduled_time - now;
    const preparing = remaining < 60000;
    const statusLabel = preparing ? t.preparing : `${formatMinutes(remaining, lang)} ${t.leftTime}`;
    return (
      <div
        key={ticket.id}
        className="tq-tile"
        onClick={() => onShowQr(ticket)}
        style={{ cursor: 'pointer' }}
        title="Takip QR kodunu tekrar göstermek için dokun"
      >
        <div className="n">{ticket.code}</div>
        {ticket.first_name && (
          <div className="s">{ticket.first_name} {ticket.last_name}</div>
        )}
        <div className={`s${preparing ? ' preparing' : ''}`}>{statusLabel}</div>
      </div>
    );
  }

  function renderAlertTicket(ticket) {
    const isCancelled = Boolean(ticket.cancelled);
    return (
      <div
        key={ticket.id}
        className={`tq-tile ${isCancelled ? 'cancelled-card' : 'ready'}`}
        onClick={() => (isCancelled ? dismissCancelled(ticket.id) : pickUp(ticket.id))}
        style={{
          borderColor: isCancelled ? '#ef4444' : '#10b981',
          background: isCancelled ? 'rgba(239, 68, 68, 0.15)' : 'rgba(16, 185, 129, 0.18)',
          boxShadow: isCancelled ? '0 0 16px rgba(239, 68, 68, 0.3)' : '0 0 16px rgba(16, 185, 129, 0.3)',
          cursor: 'pointer'
        }}
        title={isCancelled ? 'Kapatmak için dokun' : 'Teslim alındı işaretlemek için dokun'}
      >
        <div className="n" style={{ color: isCancelled ? '#fca5a5' : '#6ee7b7' }}>{ticket.code}</div>
        {ticket.first_name && (
          <div className="s">{ticket.first_name} {ticket.last_name}</div>
        )}
        <div className="s" style={{ color: isCancelled ? '#ef4444' : '#10b981', fontWeight: 800 }}>
          {isCancelled ? `✕ ${t.cancelledStatus}` : `✓ ${t.ready}`}
        </div>
      </div>
    );
  }

  return (
    <div className="tq-main">
      {tickets.length === 0 ? (
        <div className="tq-board-empty">
          <div className="big">{t.noOneInQueue}</div>
          <div>{t.scanForFirstToast}</div>
        </div>
      ) : (
        <>
          {waitingTickets.length > 0 && <div className="tq-grid">{waitingTickets.map(renderWaitingTicket)}</div>}
          {alertTickets.length > 0 && (
            <section className="tq-ready-section">
              <div className="tq-ready-separator">
                <span>{t.readySectionTitle}</span>
              </div>
              <div className="tq-grid">{alertTickets.map(renderAlertTicket)}</div>
            </section>
          )}
        </>
      )}

      <div className="tq-scan-cta">
        <div className="tq-home-btns" style={{ display: 'flex', gap: 16, justifyContent: 'center' }}>
          <button className="tq-scan-btn" onClick={startOrder} style={{ flex: 1, minHeight: 64, fontSize: 19 }}>
            <span>🥪</span> {t.orderNow}
          </button>
          <button 
            className="tq-secondary-btn" 
            onClick={startCancelFlow}
            style={{
              flex: 1,
              minHeight: 64,
              fontSize: 19,
              borderColor: 'rgba(239, 68, 68, 0.4)',
              background: 'rgba(239, 68, 68, 0.12)',
              color: '#fca5a5'
            }}
          >
            <span>✕</span> {t.cancelOrderBtn}
          </button>
        </div>
        <div className="tq-scan-note">{t.homeScanNote}</div>
      </div>
    </div>
  );
}

// =====================================================================
// Sipariş İptal Listesi Ekranı
// =====================================================================

function CancelOrdersView({ t, lang, now, orders, onCancelOrder, onHome }) {
  return (
    <div className="tq-main" style={{ maxWidth: 800, margin: '0 auto', width: '100%' }}>
      <button className="tq-back" onClick={onHome} style={{ alignSelf: 'flex-start', marginBottom: 16 }}>{t.backHome}</button>
      
      <div style={{ marginBottom: 20 }}>
        <div className="tq-select-title" style={{ fontSize: 26, fontWeight: 800 }}>{t.cancelListViewTitle}</div>
        <div className="tq-confirm-sub">{t.cancelListViewSub}</div>
      </div>

      {orders.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px 20px', background: 'rgba(255,255,255,0.04)', borderRadius: 16 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>ℹ️</div>
          <div style={{ fontSize: 18, color: '#94a3b8' }}>{t.noActiveOrdersToCancel}</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {orders.map((item) => {
            const remMs = item.scheduled_time - now;
            const canCancel = remMs > 5 * 60 * 1000;
            
            return (
              <div
                key={item.id}
                style={{
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 14,
                  padding: '16px 20px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between'
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 22, fontWeight: 900, color: '#3b82f6' }}>#{item.code}</span>
                    <span style={{ fontSize: 15, color: '#f59e0b', fontWeight: 700 }}>
                      🪙 {item.points_spent || 0} {t.points}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: '#e2e8f0', marginTop: 4, fontWeight: 600 }}>
                    🥪 {item.items_summary || 'Standart Tost'}
                  </div>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>
                    Teslim: {formatClock(item.scheduled_time)} · Kalan: {formatMinutes(remMs, lang)}
                  </div>
                </div>

                {canCancel ? (
                  <button
                    onClick={() => onCancelOrder(item.id)}
                    style={{
                      background: '#ef4444',
                      color: '#fff',
                      border: 'none',
                      padding: '10px 18px',
                      borderRadius: 10,
                      fontWeight: 700,
                      cursor: 'pointer'
                    }}
                  >
                    {t.cancelThisOrder}
                  </button>
                ) : (
                  <span style={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: '#94a3b8',
                    background: 'rgba(255,255,255,0.06)',
                    padding: '8px 12px',
                    borderRadius: 8
                  }}>
                    🔒 {t.cannotCancelFiveMins}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ScanningView({ text, cancelText, onCancel }) {
  return (
    <div className="tq-center">
      <div className="tq-scanning-icon">💳</div>
      <div>{text}</div>
      <button className="tq-confirm-btn" onClick={onCancel}>{cancelText}</button>
    </div>
  );
}

function ToastMenuView({ t, user, onContinue, onHome, outOfStock = [] }) {
  const [mode, setMode] = useState(null);
  const [standard, setStandard] = useState('');
  const [bread, setBread] = useState('');
  const [fillings, setFillings] = useState([]);
  const [cheese, setCheese] = useState('');
  const [organic, setOrganic] = useState('');
  const [greens, setGreens] = useState([]);
  const [sauce, setSauce] = useState('');

  const customComplete = Boolean(
    bread && fillings.length > 0 && cheese && organic && sauce &&
    (organic === 'Organik İlavesiz' || greens.length > 0)
  );
  const canContinue = mode === 'standard' ? Boolean(standard) : mode === 'custom' && customComplete;

  const currentSelection = mode === 'standard'
    ? { type: 'standard', name: standard }
    : { type: 'custom', bread, fillings, cheese, organic, greens, sauce };

  const totalPoints = calculateOrderPoints(mode ? currentSelection : null);
  const userBalance = user?.balance != null ? user.balance : 1000;
  const isBalanceEnough = userBalance >= totalPoints;

  function toggleValue(value, values, setValues) {
    setValues(values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);
  }

  function continueMenu() {
    if (!canContinue) return;
    if (!isBalanceEnough) {
      window.alert(
        t.insufficientBalanceAlert
          .replace('{points}', totalPoints)
          .replace('{balance}', userBalance)
      );
      return;
    }
    onContinue({ ...currentSelection, points: totalPoints });
  }

  return (
    <div className="tq-main tq-menu-page" style={{ maxWidth: 960, margin: '0 auto', width: '100%', paddingBottom: 100 }}>
      <button className="tq-back" onClick={onHome} style={{ alignSelf: 'flex-start', marginBottom: 12 }}>{t.back}</button>
      
      <div className="tq-menu-header" style={{ marginBottom: 18 }}>
        <div className="tq-select-title" style={{ fontSize: 28, fontWeight: 700, marginBottom: 4 }}>{t.toastMenu}</div>
        <div className="tq-confirm-sub" style={{ fontSize: 16 }}>{t.menuSub}</div>
      </div>

      <section className="tq-menu-section" style={{
        background: 'rgba(255, 255, 255, 0.05)',
        border: '1px solid rgba(255, 255, 255, 0.12)',
        borderRadius: 16,
        padding: 20,
        marginBottom: 20
      }}>
        <div className="tq-menu-section-title" style={{ fontSize: 18, fontWeight: 600, marginBottom: 14 }}>{t.standardOptions}</div>
        <div className="tq-choice-grid" style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
          gap: 14
        }}>
          {STANDARD_TOASTS.map((item) => {
            const isOut = outOfStock.includes(item);
            const pts = ITEM_POINTS[item] || 0;
            const isSelected = mode === 'standard' && standard === item;
            return (
              <button
                key={item}
                disabled={isOut}
                style={{
                  minHeight: 88,
                  fontSize: 17,
                  fontWeight: 600,
                  borderRadius: 14,
                  padding: '10px 12px',
                  cursor: isOut ? 'not-allowed' : 'pointer',
                  opacity: isOut ? 0.35 : 1,
                  border: isSelected ? '2px solid #3b82f6' : '1px solid rgba(255,255,255,0.18)',
                  background: isOut ? '#1e293b' : (isSelected ? '#2563eb' : 'rgba(255,255,255,0.08)'),
                  color: isOut ? '#94a3b8' : '#fff',
                  boxShadow: isSelected ? '0 0 16px rgba(37,99,235,0.4)' : 'none',
                  transition: 'all 0.12s ease',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  textAlign: 'center'
                }}
                onClick={() => {
                  if (!isOut) {
                    setMode('standard');
                    setStandard(item);
                  }
                }}
              >
                <span>{item}</span>
                <span style={{
                  fontSize: 13,
                  fontWeight: 800,
                  color: isSelected ? '#fed7aa' : '#fbbf24',
                  marginTop: 5,
                  background: 'rgba(0,0,0,0.25)',
                  padding: '2px 8px',
                  borderRadius: 6,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4
                }}>
                  <span>🪙</span> {pts}
                </span>
                {isOut && (
                  <span style={{ display: 'block', color: '#ef4444', fontSize: 11, fontWeight: 800, marginTop: 4, letterSpacing: 0.5 }}>
                    {t.soldOut}
                  </span>
                )}
              </button>
            );
          })}
          <button
            style={{
              minHeight: 88,
              fontSize: 18,
              fontWeight: 700,
              borderRadius: 14,
              padding: '12px 14px',
              cursor: 'pointer',
              border: mode === 'custom' ? '2px solid #10b981' : '1px solid #10b981',
              background: mode === 'custom' ? '#059669' : 'rgba(16, 185, 129, 0.15)',
              color: '#fff',
              boxShadow: mode === 'custom' ? '0 0 16px rgba(16,185,129,0.4)' : 'none',
              transition: 'all 0.12s ease',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center'
            }}
            onClick={() => setMode('custom')}
          >
            <span>{t.customToast}</span>
            <span style={{ fontSize: 12, opacity: 0.85, fontWeight: 500, marginTop: 4 }}>{t.byIngredients}</span>
          </button>
        </div>
      </section>

      {mode === 'custom' && (
        <section className="tq-custom-flow" style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 20 }}>
          <CustomStep t={t} title={t.stepBread} complete={Boolean(bread)}>
            <ChoiceList t={t} values={BREADS} selected={bread} onSelect={setBread} outOfStock={outOfStock} />
          </CustomStep>
          {bread && (
            <CustomStep t={t} title={t.stepFillings} hint={t.maxThree} complete={fillings.length > 0}>
              <ChoiceList t={t} values={FILLINGS} selected={fillings} max={3} onSelect={(item) => toggleValue(item, fillings, setFillings)} outOfStock={outOfStock} />
            </CustomStep>
          )}
          {bread && fillings.length > 0 && (
            <CustomStep t={t} title={t.stepCheese} complete={Boolean(cheese)}>
              <ChoiceList t={t} values={CHEESES} selected={cheese} onSelect={setCheese} outOfStock={outOfStock} />
            </CustomStep>
          )}
          {bread && fillings.length > 0 && cheese && (
            <CustomStep t={t} title={t.stepOrganic} complete={Boolean(organic) && (organic === 'Organik İlavesiz' || greens.length > 0)}>
              <ChoiceList t={t} values={['Organik İlaveli', 'Organik İlavesiz']} selected={organic} onSelect={(item) => { setOrganic(item); if (item === 'Organik İlavesiz') setGreens([]); }} outOfStock={outOfStock} />
              {organic === 'Organik İlaveli' && (
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px dashed rgba(255,255,255,0.15)' }}>
                  <div style={{ fontSize: 14, marginBottom: 10, opacity: 0.8 }}>{t.maxThree}:</div>
                  <ChoiceList t={t} values={GREENS} selected={greens} max={3} onSelect={(item) => toggleValue(item, greens, setGreens)} outOfStock={outOfStock} />
                </div>
              )}
            </CustomStep>
          )}
          {bread && fillings.length > 0 && cheese && organic && (organic === 'Organik İlavesiz' || greens.length > 0) && (
            <CustomStep t={t} title={t.stepSauce} complete={Boolean(sauce)}>
              <ChoiceList t={t} values={['Özel Sos', 'Özel Sos İstemiyorum']} selected={sauce} onSelect={setSauce} outOfStock={outOfStock} />
            </CustomStep>
          )}
        </section>
      )}

      <div style={{
        marginTop: 24,
        background: 'rgba(23, 17, 13, 0.95)',
        border: '1px solid rgba(255,255,255,0.15)',
        borderRadius: 20,
        padding: '16px 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        backdropFilter: 'blur(10px)'
      }}>
        <div>
          <div style={{ fontSize: 13, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>
            {t.totalCost}
          </div>
          <div style={{ fontSize: 24, fontWeight: 800, color: isBalanceEnough ? '#f59e0b' : '#ef4444', marginTop: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>🪙</span>
            <span>{totalPoints > 0 ? `${totalPoints} ${t.points}` : `0 ${t.points}`}</span>
            {!isBalanceEnough && <span style={{ fontSize: 13, fontWeight: 600, marginLeft: 8 }}>{t.insufficientBalance}</span>}
          </div>
        </div>

        <button
          className="tq-scan-btn"
          disabled={!canContinue || !isBalanceEnough}
          onClick={continueMenu}
          style={{
            minHeight: 56,
            fontSize: 20,
            fontWeight: 700,
            borderRadius: 14,
            padding: '0 32px',
            background: (canContinue && isBalanceEnough) ? '#2563eb' : '#334155',
            color: (canContinue && isBalanceEnough) ? '#fff' : '#64748b',
            cursor: (canContinue && isBalanceEnough) ? 'pointer' : 'not-allowed',
            border: 'none',
            boxShadow: (canContinue && isBalanceEnough) ? '0 0 20px rgba(37,99,235,0.4)' : 'none'
          }}
        >
          {t.proceedToSchedule}
        </button>
      </div>
    </div>
  );
}

function CustomStep({ t, title, hint, complete, children }) {
  return (
    <div style={{
      background: 'rgba(255, 255, 255, 0.05)',
      border: '1px solid rgba(255, 255, 255, 0.12)',
      borderRadius: 14,
      padding: 16
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <strong style={{ fontSize: 17 }}>{title}</strong>
          {hint && <span style={{ fontSize: 13, opacity: 0.7 }}>({hint})</span>}
        </div>
        <span style={{
          fontSize: 13,
          fontWeight: 600,
          padding: '3px 10px',
          borderRadius: 8,
          background: complete ? '#059669' : 'rgba(255,255,255,0.1)',
          color: '#fff'
        }}>
          {complete ? t.completed : t.mandatory}
        </span>
      </div>
      {children}
    </div>
  );
}

function ChoiceList({ t, values, selected, max, onSelect, outOfStock = [] }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
      gap: 12
    }}>
      {values.map((value) => {
        const isOut = outOfStock.includes(value);
        const active = Array.isArray(selected) ? selected.includes(value) : selected === value;
        const capped = (max && Array.isArray(selected) && selected.length >= max && !active) || isOut;
        const pts = ITEM_POINTS[value] != null ? ITEM_POINTS[value] : 0;
        return (
          <button
            key={value}
            disabled={capped}
            style={{
              minHeight: 68,
              fontSize: 16,
              fontWeight: 600,
              borderRadius: 12,
              padding: '8px 10px',
              cursor: capped ? 'not-allowed' : 'pointer',
              opacity: isOut ? 0.35 : (capped ? 0.4 : 1),
              border: active ? '2px solid #3b82f6' : '1px solid rgba(255,255,255,0.15)',
              background: isOut ? '#1e293b' : (active ? '#2563eb' : 'rgba(255,255,255,0.06)'),
              color: isOut ? '#94a3b8' : '#fff',
              boxShadow: active ? '0 0 12px rgba(37,99,235,0.35)' : 'none',
              transition: 'all 0.1s ease',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center'
            }}
            onClick={() => !isOut && onSelect(value)}
          >
            <span>{value}</span>
            {pts > 0 && (
              <span style={{
                fontSize: 12,
                fontWeight: 800,
                color: active ? '#fed7aa' : '#fbbf24',
                marginTop: 3,
                opacity: 0.95,
                display: 'flex',
                alignItems: 'center',
                gap: 3
              }}>
                <span>🪙</span> +{pts}
              </span>
            )}
            {isOut && (
              <span style={{ display: 'block', color: '#ef4444', fontSize: 11, fontWeight: 800, marginTop: 2, letterSpacing: 0.5 }}>
                {t.soldOut}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// =====================================================================
// Saat Seçimi (2 Saate Kadar 24 Blok)
// =====================================================================

function SelectView({ t, lang, now, tickets, user, expanded, setExpanded, orderSelection, onSelect, onHome }) {
  const maps = computeMaps(tickets, now);
  const positions = candidatePositions();
  const nearest = nearestOpenPosition(now, maps);

  let primary;
  if (nearest) {
    const d = describePosition(nearest, now, maps, lang);
    primary = (
      <button className="tq-primary-slot" onClick={() => onSelect(d.time != null ? d.time : now + d.pos * SLOT_MS)}>
        <span className="big">{d.label} {t.later}</span>
        <span className="small">{t.nearestSlotSub}</span>
      </button>
    );
  } else {
    primary = <button className="tq-primary-slot" disabled>{t.noSlotAvailable}</button>;
  }

  return (
    <div className="tq-main">
      <button className="tq-back" onClick={onHome}>{t.back}</button>
      <div className="tq-center" style={{ flex: 1 }}>
        <div className="tq-select-title">
          {user ? t.whenReadyTitle.replace('{name}', user.first_name) : t.whenReadyTitleGeneric}
        </div>
        
        {orderSelection && (
          <div className="tq-order-summary" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span>{t.yourSelection}: <strong>{orderSelection.type === 'standard' ? orderSelection.name : t.customToast}</strong></span>
            {orderSelection.points ? (
              <span style={{ color: '#fbbf24', fontWeight: 800, display: 'flex', alignItems: 'center', gap: 4 }}>
                <span>🪙</span> {orderSelection.points}
              </span>
            ) : null}
          </div>
        )}

        {primary}

        <button className="tq-expand-btn" onClick={() => setExpanded((v) => !v)}>
          {expanded ? t.hideSlots : t.chooseAnotherSlot}
        </button>

        {expanded && (
          <div className="tq-slot-grid" style={{ maxWidth: 900, margin: '14px auto 0 auto' }}>
            {positions.map((p) => {
              const d = describePosition(p, now, maps, lang);
              const isBooked = d.taken;
              
              return (
                <button
                  key={p}
                  className={`tq-slot${isBooked ? ' taken' : ''}`}
                  disabled={isBooked}
                  style={{
                    minHeight: 64,
                    opacity: isBooked ? 0.35 : 1,
                    background: isBooked ? 'rgba(255, 255, 255, 0.03)' : undefined,
                    borderColor: isBooked ? 'rgba(255, 255, 255, 0.1)' : undefined,
                    color: isBooked ? '#64748b' : undefined,
                    cursor: isBooked ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '8px 12px'
                  }}
                  onClick={() => !isBooked && onSelect(d.time != null ? d.time : now + p * SLOT_MS)}
                >
                  <strong style={{ fontSize: 16 }}>{d.label}</strong>
                  {isBooked && d.subLabel && (
                    <div style={{ fontSize: 11, marginTop: 2, opacity: 0.8, fontWeight: 600 }}>
                      {d.subLabel}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function ConfirmView({ t, lang, ticket, now, tunnelUrl, onHome }) {
  // tunnelUrl backend'den (cloudflared --metrics üzerinden) o anki GERÇEK
  // adres olarak geliyor — hiçbir şey hardcode değil. Tünel şu an ayakta
  // değilse (null) QR gösterilmez, biletin kendisi yine oluşur.
  const trackUrl = tunnelUrl
    ? `${tunnelUrl}/?track=${encodeURIComponent(ticket.code)}&id=${ticket.id}&until=${ticket.scheduled_time}`
    : null;

  return (
    <div className="tq-center">
      <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>{t.yourCode}</div>
      <div className="tq-confirm-num">{ticket.code}</div>
      <div className="tq-confirm-sub">
        {t.readyAtMsg
          .replace('{minutes}', formatMinutes(ticket.scheduled_time - now, lang))
          .replace('{time}', formatClock(ticket.scheduled_time))}
      </div>

      {trackUrl && (
        <div style={{
          background: '#ffffff',
          padding: 16,
          borderRadius: 20,
          boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 8,
          marginTop: 6
        }}>
          <QRCodeSVG value={trackUrl} size={150} level="M" />
          <span style={{ color: '#0f172a', fontSize: 13, fontWeight: 700 }}>
            {t.qrTrackNote}
          </span>
        </div>
      )}

      <button className="tq-confirm-btn" onClick={onHome} style={{ minWidth: 200, marginTop: 10 }}>
        {t.ok}
      </button>
    </div>
  );
}

function BlockedView({ t, lang, ticket, now, onHome, onPickup }) {
  const ready = ticket.scheduled_time - now <= 0;
  return (
    <div className="tq-center">
      <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>
        {ticket.active_count >= 4 ? t.maxActiveOrders : t.orderFailed}
      </div>
      <div className="tq-confirm-num">{ticket.code}</div>
      {ticket.active_count >= 4 && ticket.first_name && (
        <div style={{ color: 'var(--text-muted)', fontSize: 16 }}>{ticket.first_name} {ticket.last_name}</div>
      )}
      <div className="tq-confirm-sub">
        {ready ? t.readyPickupFirst : `${formatMinutes(ticket.scheduled_time - now, lang)} ${t.leftTime}`}
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
        {ready && <button className="tq-confirm-btn" onClick={onPickup}>{t.received}</button>}
        <button className="tq-confirm-btn" onClick={onHome}>{t.ok}</button>
      </div>
    </div>
  );
}

function RegisterFormView({ t, first, last, setFirst, setLast, onSubmit, onHome }) {
  return (
    <div className="tq-main">
      <button className="tq-back" onClick={onHome}>{t.back}</button>
      <div className="tq-center" style={{ flex: 1 }}>
        <div className="tq-select-title">{t.newRegistration}</div>
        <form className="tq-form" onSubmit={onSubmit}>
          <div className="tq-field">
            <label htmlFor="tq-first">{t.firstName}</label>
            <input id="tq-first" className="tq-input" autoComplete="off" autoFocus
              value={first} onChange={(e) => setFirst(e.target.value)} placeholder={t.firstNamePlaceholder} />
          </div>
          <div className="tq-field">
            <label htmlFor="tq-last">{t.lastName}</label>
            <input id="tq-last" className="tq-input" autoComplete="off"
              value={last} onChange={(e) => setLast(e.target.value)} placeholder={t.lastNamePlaceholder} />
          </div>
          <button type="submit" className="tq-scan-btn" style={{ justifyContent: 'center' }}
            disabled={!first.trim() || !last.trim()}>
            {t.saveAndScan}
          </button>
        </form>
      </div>
    </div>
  );
}

function RegisterSuccessView({ t, user, card, onOrder, onHome }) {
  return (
    <div className="tq-center">
      <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>{t.welcome}</div>
      <div style={{ fontSize: 26, fontWeight: 700 }}>{user.first_name} {user.last_name}</div>
      <div className="tq-confirm-sub">{t.accountCreatedQuotaMsg}</div>
      <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
        <button className="tq-scan-btn" onClick={onOrder}><span>💳</span> {t.orderNowBtn}</button>
        <button className="tq-confirm-btn" onClick={onHome}>{t.ok}</button>
      </div>
    </div>
  );
}

function SettingsView({ t, brightness, setBrightness, nativeReady, connected, onProfile, onHome }) {
  // updateState ana süreçte (Electron) tutuluyor — bu ekrandan çıkıp geri
  // dönsek bile indirme arka planda devam ediyor, burada sadece o anki
  // durumu (yüzde dahil) gösteriyoruz.
  const [updateState, setUpdateState] = useState({
    phase: 'idle', progress: 0, downloadedBytes: 0, totalBytes: 0, error: null,
  });
  const [latestVersion, setLatestVersion] = useState(null);
  const [downloadUrl, setDownloadUrl] = useState('');
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [currentVersion, setCurrentVersion] = useState('2.2.14');

  useEffect(() => {
    let active = true;

    if (window.tostNative?.getUpdateState) {
      window.tostNative.getUpdateState().then((s) => {
        if (active && s) setUpdateState(s);
      });
    }
    const unsubscribe = window.tostNative?.onUpdateProgress
      ? window.tostNative.onUpdateProgress((s) => active && setUpdateState(s))
      : null;

    return () => {
      active = false;
      if (unsubscribe) unsubscribe();
    };
  }, []);

  useEffect(() => {
    let active = true;
    setCheckingUpdate(true);

    if (window.tostNative?.getVersion) {
      window.tostNative.getVersion().then((v) => {
        if (active && v) setCurrentVersion(v);
      });
    }

    fetch('https://api.github.com/repos/Ariatd/tost-sirasi-kiosk/releases/latest', {
      headers: { Accept: 'application/vnd.github.v3+json' },
    })
      .then((res) => {
        if (!res.ok) throw new Error('GitHub bilgisi alınamadı');
        return res.json();
      })
      .then((data) => {
        if (!active) return;
        const releaseTag = (data.tag_name || '').replace(/^v/, '').trim();
        const debAsset = (data.assets || []).find((a) => a.name.endsWith('.deb'));
        
        if (releaseTag) setLatestVersion(releaseTag);
        if (debAsset?.browser_download_url) {
          setDownloadUrl(debAsset.browser_download_url);
        }
      })
      .catch((err) => {
        console.warn('GitHub kontrol hatası:', err.message);
      })
      .finally(() => {
        if (active) setCheckingUpdate(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const hasUpdate = Boolean(isNewerVersion(latestVersion, currentVersion) && downloadUrl);

  const updating = updateState.phase === 'downloading' || updateState.phase === 'installing';

  async function handleUpdate() {
    if (!hasUpdate || !downloadUrl || !window.tostNative?.applyUpdate) return;
    try {
      const res = await window.tostNative.applyUpdate(downloadUrl, latestVersion);
      if (!res.ok) {
        setUpdateState((s) => ({ ...s, phase: 'error', error: res.error || 'Bilinmeyen hata' }));
      }
      // Başarılıysa gerçek durum zaten tost:updateProgress olaylarıyla geliyor.
    } catch (e) {
      setUpdateState((s) => ({ ...s, phase: 'error', error: e.message }));
    }
  }

  function fmtMB(bytes) {
    return (bytes / (1024 * 1024)).toFixed(1);
  }

  return (
    <div className="tq-main tq-settings-page" style={{ maxWidth: 1100, margin: '0 auto', width: '100%' }}>
      <button className="tq-back" onClick={onHome}>{t.backHome}</button>
      <div className="tq-settings-header" style={{ marginBottom: 20 }}>
        <div className="tq-settings-icon">⚙</div>
        <div>
          <div className="tq-select-title">{t.settingsTitle}</div>
          <div className="tq-confirm-sub">{t.settingsSub}</div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'row', gap: 24, alignItems: 'stretch', width: '100%' }}>
        <section className="tq-settings-card" style={{ flex: 1, margin: 0, display: 'flex', flexDirection: 'column' }}>
          <div className="tq-settings-card-title">{t.generalSettings}</div>
          <label className="tq-range-label" htmlFor="tq-brightness">
            <span>{t.appBrightness}</span><strong>{brightness}%</strong>
          </label>
          <input id="tq-brightness" className="tq-range" type="range" min="50" max="120" step="5"
            value={brightness} onChange={(e) => setBrightness(Number(e.target.value))} />
          <p className="tq-settings-note">{t.brightnessNote}</p>

          <div className="tq-settings-row">
            <div><strong>{t.backendConnection}</strong><span>{connected ? t.connectedText : t.waitingConnection}</span></div>
            <span className={`tq-status-pill${connected ? ' ok' : ''}`}>{connected ? t.online : t.offline}</span>
          </div>

          <div className="tq-settings-row stack" style={{ marginTop: 'auto', paddingTop: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <strong>{t.otaTitle}</strong>
                <span style={{ display: 'block', fontSize: 13, color: '#94a3b8' }}>
                  {t.installedVer}: <strong>v{currentVersion}</strong>
                  {latestVersion && ` · GitHub: v${latestVersion}`}
                </span>
              </div>
              <span className={`tq-status-pill${!hasUpdate ? ' ok' : ''}`} style={{ alignSelf: 'flex-start' }}>
                {checkingUpdate ? t.checkingUpdate : hasUpdate ? t.newVersionAvailable : t.upToDate}
              </span>
            </div>

            {!updating && updateState.phase !== 'done' && (
              <button
                className="tq-confirm-btn"
                disabled={!hasUpdate || !nativeReady}
                onClick={handleUpdate}
                style={{
                  background: hasUpdate ? '#059669' : 'rgba(255,255,255,0.06)',
                  borderColor: hasUpdate ? '#10b981' : 'rgba(255,255,255,0.15)',
                  color: hasUpdate ? '#fff' : '#64748b',
                  cursor: hasUpdate ? 'pointer' : 'default',
                  marginTop: 8
                }}
              >
                {hasUpdate
                  ? `${t.downloadAndInstall} (v${latestVersion})`
                  : `${t.systemUpToDate} (v${currentVersion})`}
              </button>
            )}

            {updateState.phase === 'downloading' && (
              <div style={{ marginTop: 8 }}>
                <div style={{
                  display: 'flex', justifyContent: 'space-between', fontSize: 13,
                  color: '#94a3b8', marginBottom: 4
                }}>
                  <span>İndiriliyor… %{updateState.progress}</span>
                  {updateState.totalBytes > 0 && (
                    <span>{fmtMB(updateState.downloadedBytes)} / {fmtMB(updateState.totalBytes)} MB</span>
                  )}
                </div>
                <div style={{
                  width: '100%', height: 10, borderRadius: 6,
                  background: 'rgba(255,255,255,0.08)', overflow: 'hidden'
                }}>
                  <div style={{
                    width: `${updateState.progress}%`, height: '100%',
                    background: '#10b981', transition: 'width 0.3s ease',
                    borderRadius: 6
                  }} />
                </div>
              </div>
            )}

            {updateState.phase === 'installing' && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 4 }}>Kuruluyor…</div>
                <div className="tq-progress-indeterminate" style={{
                  width: '100%', height: 10, borderRadius: 6,
                  background: 'rgba(255,255,255,0.08)', overflow: 'hidden', position: 'relative'
                }}>
                  <div className="tq-progress-indeterminate-bar" style={{
                    position: 'absolute', top: 0, bottom: 0, width: '40%',
                    background: '#10b981', borderRadius: 6
                  }} />
                </div>
              </div>
            )}

            {updateState.phase === 'done' && (
              <p className="tq-settings-note" style={{ color: '#10b981', fontWeight: 600 }}>
                Başarılı! Yeniden başlatılıyor…
              </p>
            )}

            {updateState.phase === 'error' && (
              <p className="tq-settings-note" style={{ color: '#ef4444', fontWeight: 600 }}>
                Hata: {updateState.error}
              </p>
            )}
          </div>
        </section>

        <section className="tq-settings-card profile-card" style={{ flex: 1, margin: 0, display: 'flex', flexDirection: 'column' }}>
          <div className="tq-settings-card-title">{t.profileSettings}</div>
          <p className="tq-settings-note" style={{ fontSize: 15, lineHeight: 1.6, marginBottom: 16 }}>
            {t.profileSettingsNote}
          </p>
          
          <div style={{
            background: 'rgba(255, 255, 255, 0.03)',
            border: '1px dashed rgba(255, 255, 255, 0.15)',
            borderRadius: 12,
            padding: '24px 16px',
            textAlign: 'center',
            margin: 'auto 0 20px 0',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8
          }}>
            <span style={{ fontSize: 36 }}>💳</span>
            <span style={{ color: '#94a3b8', fontSize: 14 }}>{t.profileScanHelper}</span>
          </div>

          <button className="tq-scan-btn" onClick={onProfile} style={{ width: '100%', justifyContent: 'center', minHeight: 52 }}>
            <span>💳</span> {t.profileScanBtn}
          </button>
        </section>
      </div>
    </div>
  );
}

// =====================================================================
// Kullanıcı Profil Ekranı (Sipariş İçerik Detaylı Geçmiş Listesi)
// =====================================================================

function ProfileView({ t, profile, now, deletionRequestSent, onRequestDeletion, onHome, onBack }) {
  const joined = profile.created_at ? new Date(profile.created_at).toLocaleDateString('tr-TR') : '—';
  const balance = profile.balance != null ? profile.balance : 1000;
  const quota = profile.monthly_quota != null ? profile.monthly_quota : 1000;
  const pct = Math.min(100, Math.max(0, Math.round((balance / quota) * 100)));
  const history = profile.order_history || [];

  function formatDateTime(isoOrTs) {
    if (!isoOrTs) return '—';
    const d = new Date(isoOrTs);
    const dateStr = d.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    return `${dateStr} · ${timeStr}`;
  }

  return (
    <div className="tq-main tq-profile-page" style={{ maxWidth: 740, margin: '0 auto', width: '100%', paddingBottom: 60 }}>
      <button className="tq-back" onClick={onBack}>{t.backSettings}</button>
      
      <div className="tq-profile-hero">
        <div className="tq-profile-avatar">{profile.first_name?.slice(0, 1)?.toUpperCase() || 'K'}</div>
        <div>
          <div className="tq-select-title">{profile.first_name} {profile.last_name}</div>
          <div className="tq-confirm-sub">{t.memberSince}: {joined}</div>
        </div>
      </div>

      <div style={{
        background: 'linear-gradient(135deg, rgba(37,99,235,0.15), rgba(16,185,129,0.15))',
        border: '1px solid rgba(255,255,255,0.2)',
        borderRadius: 16,
        padding: '18px 20px',
        marginBottom: 16
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: 14, color: '#94a3b8', fontWeight: 600 }}>{t.monthlyQuota}</span>
          <span style={{ fontSize: 20, fontWeight: 800, color: '#10b981', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>🪙</span> {balance} / {quota} {t.points}
          </span>
        </div>
        <div style={{ width: '100%', height: 10, background: 'rgba(255,255,255,0.1)', borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: '#10b981', transition: 'width 0.3s' }} />
        </div>
        {profile.is_blocked ? (
          <div style={{ color: '#ef4444', fontSize: 13, fontWeight: 700, marginTop: 10 }}>
            ⚠️ {t.accountBlockedAlert}
          </div>
        ) : null}
      </div>

      <div className="tq-profile-stats" style={{ marginBottom: 20 }}>
        <div><strong>{profile.total_orders}</strong><span>{t.totalOrders}</span></div>
        <div><strong>{profile.completed_orders}</strong><span>{t.completedOrders}</span></div>
        <div><strong>{profile.active_orders}</strong><span>{t.activeOrders}</span></div>
      </div>

      {/* Sipariş Geçmişi Listesi (Ürün İçeriği Dahil) */}
      <div style={{
        background: 'rgba(255, 255, 255, 0.04)',
        border: '1px solid rgba(255, 255, 255, 0.12)',
        borderRadius: 16,
        padding: '16px 20px',
        marginBottom: 20
      }}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>📜</span> Sipariş Geçmişi
        </div>

        {history.length === 0 ? (
          <div style={{ color: '#94a3b8', fontSize: 14, textAlign: 'center', padding: '16px 0' }}>
            Henüz verilmiş bir sipariş bulunmuyor.
          </div>
        ) : (
          <div style={{ maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, paddingRight: 4 }}>
            {history.map((ord) => {
              const isCancelled = Boolean(ord.cancelled);
              const isPickedUp = ord.picked_up === 1;
              // "Hazır" saate göre belirlenir (tıklamaya değil) — teslim
              // alınmamış olsa bile hedef saat geçtiyse artık "Hazır"dır.
              const isReady = !isCancelled && !isPickedUp && ord.scheduled_time <= now;
              const statusText = isCancelled ? 'İptal Edildi'
                : isPickedUp ? 'Teslim Alındı'
                : isReady ? 'Hazır'
                : 'Aktif / Hazırlanıyor';
              const statusColor = isCancelled ? '#ef4444' : (isPickedUp || isReady) ? '#10b981' : '#3b82f6';

              return (
                <div
                  key={ord.id}
                  style={{
                    background: 'rgba(0, 0, 0, 0.25)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: 12,
                    padding: '12px 14px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                    <span style={{ fontSize: 18, fontWeight: 900, color: '#f8fafc', background: 'rgba(255,255,255,0.08)', padding: '4px 10px', borderRadius: 8, marginTop: 2 }}>
                      #{ord.code}
                    </span>
                    <div>
                      {/* Sipariş Edilen Tost / Malzemeler */}
                      <div style={{ fontSize: 15, color: '#38bdf8', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span>🥪</span> {ord.items_summary || 'Standart Tost'}
                      </div>
                      <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4 }}>
                        Tarih: {formatDateTime(ord.created_at)}
                      </div>
                      <div style={{ fontSize: 11, color: '#64748b', marginTop: 1 }}>
                        Teslim Saati: {formatClock(ord.scheduled_time)}
                      </div>
                    </div>
                  </div>

                  <div style={{ textAlign: 'right', minWidth: 90 }}>
                    <div style={{ fontSize: 15, fontWeight: 800, color: '#fbbf24' }}>
                      🪙 {ord.points_spent || 0}
                    </div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: statusColor, marginTop: 4 }}>
                      {statusText}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="tq-profile-info" style={{ marginBottom: 16 }}>
        <strong>{t.recordManagement}</strong>
        <span>{t.deletionPolicyNote}</span>
      </div>

      <div style={{ display: 'flex', gap: 12 }}>
        <button className="tq-confirm-btn" style={{ flex: 1 }} onClick={onRequestDeletion} disabled={deletionRequestSent}>
          {deletionRequestSent ? t.deletionRequestedBtn : t.requestDeletionBtn}
        </button>
        <button className="tq-confirm-btn" style={{ flex: 1, background: '#2563eb' }} onClick={onHome}>{t.ok}</button>
      </div>
    </div>
  );
}

