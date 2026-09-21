import { useEffect, useState } from 'react';

export default function MobileTrackView({ ticketCode, targetTime }) {
  const [scheduledTime, setScheduledTime] = useState(targetTime);
  const [nowMs, setNowMs] = useState(Date.now());

  // 1. Canlı saniye sayacı (Her saniye zamanı tazeler)
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // 2. Eğer targetTime gelmediyse backend'den sorgula (Fallback)
  useEffect(() => {
    if (scheduledTime) return;

    fetch('/api/state')
      .then((r) => r.json())
      .then((data) => {
        const tickets = data.tickets || [];
        const cleanTarget = String(ticketCode || '').trim().replace(/^0+/, '');
        const found = tickets.find((t) => {
          const cleanCode = String(t.code || '').trim().replace(/^0+/, '');
          return cleanCode === cleanTarget || String(t.code) === String(ticketCode);
        });
        if (found) {
          setScheduledTime(found.scheduled_time);
        }
      })
      .catch(() => {});
  }, [ticketCode, scheduledTime]);

  const remainingMs = scheduledTime ? scheduledTime - nowMs : null;
  const isReady = remainingMs !== null && remainingMs <= 0;

  function formatTime(ms) {
    if (ms === null || ms === undefined) return '--:--';
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }

  function formatClock(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

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

      {!scheduledTime ? (
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
          <div style={{ fontSize: 56, fontWeight: 900, color: '#34d399', letterSpacing: 2 }}>
            {ticketCode}
          </div>
          <div style={{
            marginTop: 20,
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
          <div style={{ fontSize: 56, fontWeight: 900, color: '#60a5fa', letterSpacing: 2 }}>
            {ticketCode}
          </div>
          <div style={{ marginTop: 24 }}>
            <div style={{ fontSize: 13, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 600 }}>
              Kalan Süre
            </div>
            <div style={{
              fontSize: 48,
              fontWeight: 900,
              color: '#38bdf8',
              marginTop: 6,
              fontVariantNumeric: 'tabular-nums'
            }}>
              {formatTime(remainingMs)}
            </div>
            <div style={{ fontSize: 14, color: '#94a3b8', marginTop: 8 }}>
              Tahmini teslim: <strong>{formatClock(scheduledTime)}</strong>
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
            Canlı geri sayım aktif · Ekranı kapatmayınız
          </div>
        </div>
      )}
    </div>
  );
}