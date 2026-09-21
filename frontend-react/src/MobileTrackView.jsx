import { useEffect, useState } from 'react';

export default function MobileTrackView({ ticketCode }) {
  const [ticket, setTicket] = useState(null);
  const [loading, setLoading] = useState(true);
  const [remainingSec, setRemainingSec] = useState(null);

  // 1. Backend'den güncel bilet durumunu çek (Doğrudan fetch ile)
  useEffect(() => {
    let isMounted = true;

    async function fetchTicket() {
      try {
        const res = await fetch('/api/state');
        if (!res.ok) throw new Error('Ağ hatası');
        const data = await res.json();
        
        const tickets = data.tickets || [];
        const cleanTarget = String(ticketCode || '').trim().replace(/^0+/, '');
        const found = tickets.find((t) => {
          const cleanCode = String(t.code || '').trim().replace(/^0+/, '');
          return cleanCode === cleanTarget || String(t.code) === String(ticketCode);
        });

        if (isMounted) {
          if (found) {
            setTicket(found);
            const diffSec = Math.max(0, Math.round((found.scheduled_time - (data.now || Date.now())) / 1000));
            setRemainingSec(diffSec);
          }
          setLoading(false);
        }
      } catch (err) {
        if (isMounted) setLoading(false);
      }
    }

    fetchTicket();

    // Canlı SSE dinleyicisi
    let es;
    try {
      es = new EventSource('/events');
      es.onmessage = (e) => {
        try {
          const parsed = JSON.parse(e.data);
          if (parsed.type === 'state' && parsed.tickets) {
            const cleanTarget = String(ticketCode || '').trim().replace(/^0+/, '');
            const found = parsed.tickets.find((t) => {
              const cleanCode = String(t.code || '').trim().replace(/^0+/, '');
              return cleanCode === cleanTarget || String(t.code) === String(ticketCode);
            });
            if (found && isMounted) {
              setTicket(found);
              const diffSec = Math.max(0, Math.round((found.scheduled_time - (parsed.now || Date.now())) / 1000));
              setRemainingSec(diffSec);
            }
          }
        } catch (_) {}
      };
    } catch (_) {}

    return () => {
      isMounted = false;
      if (es) es.close();
    };
  }, [ticketCode]);

  // 2. Canlı Saniyelik Geri Sayım Sayacı
  useEffect(() => {
    if (remainingSec === null || remainingSec <= 0) return;
    const interval = setInterval(() => {
      setRemainingSec((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(interval);
  }, [remainingSec]);

  function formatTime(totalSeconds) {
    if (totalSeconds === null || totalSeconds === undefined) return '--:--';
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }

  const isReady = remainingSec !== null && remainingSec <= 0;

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0f172a',
      color: '#f8fafc',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      fontFamily: 'system-ui, -apple-system, sans-serif',
      boxSizing: 'border-box',
      textAlign: 'center'
    }}>
      <div style={{ fontSize: 48, marginBottom: 8 }}>🍞</div>
      <h2 style={{ margin: '0 0 4px 0', fontSize: 26, fontWeight: 800 }}>Tost Sırası</h2>
      <p style={{ margin: '0 0 28px 0', color: '#94a3b8', fontSize: 14 }}>Canlı Sipariş Takibi</p>

      {loading ? (
        <div style={{ color: '#94a3b8', fontSize: 16 }}>Sipariş durumu sorgulanıyor…</div>
      ) : !ticket ? (
        <div style={{
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 24,
          padding: '36px 24px',
          maxWidth: 340,
          width: '100%'
        }}>
          <div style={{ fontSize: 44, fontWeight: 900, color: '#f59e0b', marginBottom: 12 }}>
            {ticketCode}
          </div>
          <p style={{ color: '#cbd5e1', fontSize: 15, margin: 0, lineHeight: 1.5 }}>
            Sipariş sırada bulunamadı veya teslim edildi olarak işaretlendi.
          </p>
        </div>
      ) : isReady ? (
        <div style={{
          background: 'linear-gradient(135deg, rgba(16,185,129,0.2), rgba(5,150,105,0.35))',
          border: '2px solid #10b981',
          borderRadius: 24,
          padding: '40px 24px',
          maxWidth: 340,
          width: '100%',
          boxShadow: '0 0 40px rgba(16,185,129,0.25)'
        }}>
          <div style={{ fontSize: 52, fontWeight: 900, color: '#34d399', letterSpacing: 2 }}>
            {ticket.code}
          </div>
          {ticket.first_name && (
            <div style={{ fontSize: 19, fontWeight: 600, color: '#f1f5f9', marginTop: 8 }}>
              {ticket.first_name} {ticket.last_name}
            </div>
          )}
          <div style={{
            marginTop: 24,
            fontSize: 28,
            fontWeight: 900,
            color: '#ffffff',
            letterSpacing: 1
          }}>
            TOSTUNUZ HAZIR!
          </div>
          <p style={{ color: '#a7f3d0', fontSize: 15, marginTop: 10, marginBottom: 0 }}>
            Lütfen büfeden teslim alınız.
          </p>
        </div>
      ) : (
        <div style={{
          background: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 24,
          padding: '40px 24px',
          maxWidth: 340,
          width: '100%',
          boxShadow: '0 12px 32px rgba(0,0,0,0.3)'
        }}>
          <div style={{ fontSize: 52, fontWeight: 900, color: '#60a5fa', letterSpacing: 2 }}>
            {ticket.code}
          </div>
          {ticket.first_name && (
            <div style={{ fontSize: 19, fontWeight: 600, color: '#f1f5f9', marginTop: 8 }}>
              {ticket.first_name} {ticket.last_name}
            </div>
          )}
          <div style={{ marginTop: 24 }}>
            <div style={{ fontSize: 13, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 600 }}>
              Kalan Süre
            </div>
            <div style={{ fontSize: 46, fontWeight: 900, color: '#38bdf8', marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>
              {formatTime(remainingSec)}
            </div>
          </div>
          <div style={{
            marginTop: 24,
            padding: '10px 16px',
            borderRadius: 14,
            background: 'rgba(59,130,246,0.14)',
            color: '#93c5fd',
            fontSize: 13,
            fontWeight: 500
          }}>
            Canlı geri sayım aktif
          </div>
        </div>
      )}
    </div>
  );
}