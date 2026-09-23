import { useEffect, useRef, useState } from 'react';

const POLL_MS = 4000;

export default function MobileTrackView({ ticketCode, ticketId, targetTime }) {
  // URL'deki `until` ile İLK ANDA (bağlantı beklemeden) geri sayım başlar.
  // Ardından `id` üzerinden backend'e periyodik sorularak (polling) gerçek
  // durum (iptal/hazır/teslim alındı) canlı olarak yansıtılır.
  const [scheduledTime, setScheduledTime] = useState(targetTime);
  const [status, setStatus] = useState(targetTime ? 'active' : null); // active | ready | picked_up | cancelled | not_found | null(bilinmiyor)
  const [nowMs, setNowMs] = useState(Date.now());
  const pollFailCountRef = useRef(0);

  // 1. Canlı saniye sayacı
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // 2. Backend'e periyodik sor — iptal/hazır/teslim durumunu yakalamak için.
  //    ticketId yoksa (eski bir QR/link) bu adım atlanır, sadece statik
  //    geri sayım gösterilir (eskisi gibi davranır, geriye dönük uyumlu).
  useEffect(() => {
    if (!ticketId) return;

    let cancelled = false;

    async function poll() {
      try {
        const r = await fetch(`/api/ticket-status?id=${encodeURIComponent(ticketId)}`);
        const data = await r.json();
        if (cancelled || !data.ok) return;
        pollFailCountRef.current = 0;
        setStatus(data.status);
        if (data.status === 'active' || data.status === 'ready') {
          setScheduledTime(data.scheduled_time);
        }
      } catch (_) {
        // Ağ hatası (telefon sinyali kesildi vb.) — birkaç başarısız
        // denemeye kadar mevcut durumu koru, sonrasında da sessizce
        // yeniden denemeye devam et (bağlantı dönünce kendini toparlar).
        pollFailCountRef.current += 1;
      }
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [ticketId]);

  const remainingMs = scheduledTime ? scheduledTime - nowMs : null;
  const isReady = status === 'ready' || (status !== 'cancelled' && status !== 'picked_up' && remainingMs !== null && remainingMs <= 0);

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

  const shell = (children) => (
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
      {children}
    </div>
  );

  if (status === 'cancelled') {
    return shell(
      <div style={{
        background: 'rgba(239,68,68,0.12)',
        border: '2px solid #ef4444',
        borderRadius: 24,
        padding: '40px 24px',
        maxWidth: 340,
        width: '100%'
      }}>
        <div style={{ fontSize: 44, fontWeight: 900, color: '#f87171', marginBottom: 12 }}>
          {ticketCode || '—'}
        </div>
        <div style={{ fontSize: 22, fontWeight: 900, color: '#ffffff', marginBottom: 8 }}>
          SİPARİŞ İPTAL EDİLDİ
        </div>
        <p style={{ color: '#fecaca', fontSize: 15, margin: 0, lineHeight: 1.5 }}>
          Bu sipariş iptal edildi. Yeni bir sipariş vermek için kartınızı tekrar okutabilirsiniz.
        </p>
      </div>
    );
  }

  if (status === 'picked_up') {
    return shell(
      <div style={{
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 24,
        padding: '40px 24px',
        maxWidth: 340,
        width: '100%'
      }}>
        <div style={{ fontSize: 44, fontWeight: 900, color: '#cbd5e1', marginBottom: 12 }}>
          {ticketCode || '—'}
        </div>
        <div style={{ fontSize: 20, fontWeight: 800, color: '#ffffff' }}>
          Bu sipariş teslim alındı
        </div>
        <p style={{ color: '#94a3b8', fontSize: 14, marginTop: 8, marginBottom: 0 }}>
          Afiyet olsun!
        </p>
      </div>
    );
  }

  if (status === 'not_found') {
    return shell(
      <div style={{
        background: 'rgba(255,255,255,0.05)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 24,
        padding: '36px 24px',
        maxWidth: 340,
        width: '100%'
      }}>
        <div style={{ fontSize: 44, fontWeight: 900, color: '#f59e0b', marginBottom: 12 }}>
          {ticketCode || '—'}
        </div>
        <p style={{ color: '#cbd5e1', fontSize: 15, margin: 0, lineHeight: 1.5 }}>
          Sipariş sırada bulunamadı veya teslim edildi olarak işaretlendi.
        </p>
      </div>
    );
  }

  if (isReady) {
    return shell(
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
        <div style={{ marginTop: 20, fontSize: 28, fontWeight: 900, color: '#ffffff', letterSpacing: 1 }}>
          TOSTUNUZ HAZIR!
        </div>
        <p style={{ color: '#a7f3d0', fontSize: 15, marginTop: 10, marginBottom: 0 }}>
          Lütfen büfeden teslim alınız.
        </p>
      </div>
    );
  }

  return shell(
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
        <div style={{ fontSize: 48, fontWeight: 900, color: '#38bdf8', marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>
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
  );
}
