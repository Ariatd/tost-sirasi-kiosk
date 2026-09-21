import { useEffect, useState } from 'react';
import { formatClock, formatMinutes } from './logic.js';
import { api, connectEvents } from './api.js';

export default function MobileTrackView({ ticketCode }) {
  const [tickets, setTickets] = useState([]);
  const [clockSkew, setClockSkew] = useState(0);
  const [, setTick] = useState(0);

  const now = () => Date.now() + clockSkew;

  useEffect(() => {
    const disconnect = connectEvents({
      onConnected: () => {},
      onState: (msg) => {
        setClockSkew(msg.now - Date.now());
        setTickets(msg.tickets || []);
      },
      onScan: () => {},
    });

    api('/api/state').then((r) => {
      if (r.ok) {
        setClockSkew(r.data.now - Date.now());
        setTickets(r.data.tickets || []);
      }
    });

    return disconnect;
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const nowMs = now();
  const ticket = tickets.find((t) => t.code?.toUpperCase() === ticketCode?.toUpperCase());
  const remaining = ticket ? ticket.scheduled_time - nowMs : null;
  const isReady = remaining !== null && remaining <= 0;

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
      <div style={{ fontSize: 44, marginBottom: 12 }}>🍞</div>
      <h2 style={{ margin: '0 0 4px 0', fontSize: 24, fontWeight: 700 }}>Tost Takip</h2>
      <p style={{ margin: '0 0 28px 0', color: '#94a3b8', fontSize: 14 }}>Canlı Sipariş Durumu</p>

      {!ticket ? (
        <div style={{
          background: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 20,
          padding: 32,
          maxWidth: 340,
          width: '100%'
        }}>
          <div style={{ fontSize: 32, fontWeight: 800, color: '#f59e0b', marginBottom: 10 }}>{ticketCode}</div>
          <p style={{ color: '#cbd5e1', fontSize: 15, margin: 0 }}>
            Sipariş sırada bulunamadı veya teslim edildi olarak işaretlendi.
          </p>
        </div>
      ) : isReady ? (
        <div style={{
          background: 'linear-gradient(135deg, rgba(16,185,129,0.25), rgba(5,150,105,0.4))',
          border: '2px solid #10b981',
          borderRadius: 24,
          padding: '36px 24px',
          maxWidth: 340,
          width: '100%',
          boxShadow: '0 0 32px rgba(16,185,129,0.3)'
        }}>
          <div style={{ fontSize: 48, fontWeight: 900, color: '#34d399', letterSpacing: 2 }}>{ticket.code}</div>
          {ticket.first_name && (
            <div style={{ fontSize: 18, color: '#e2e8f0', marginTop: 6 }}>{ticket.first_name} {ticket.last_name}</div>
          )}
          <div style={{
            marginTop: 20,
            fontSize: 26,
            fontWeight: 800,
            color: '#fff',
            textTransform: 'uppercase'
          }}>
            Tostunuz Hazır!
          </div>
          <p style={{ color: '#a7f3d0', fontSize: 14, marginTop: 8, marginBottom: 0 }}>
            Lütfen büfeden teslim alınız.
          </p>
        </div>
      ) : (
        <div style={{
          background: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 24,
          padding: '36px 24px',
          maxWidth: 340,
          width: '100%'
        }}>
          <div style={{ fontSize: 48, fontWeight: 900, color: '#60a5fa', letterSpacing: 2 }}>{ticket.code}</div>
          {ticket.first_name && (
            <div style={{ fontSize: 18, color: '#e2e8f0', marginTop: 6 }}>{ticket.first_name} {ticket.last_name}</div>
          )}
          <div style={{ marginTop: 24 }}>
            <div style={{ fontSize: 13, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1 }}>Kalan Süre</div>
            <div style={{ fontSize: 36, fontWeight: 800, color: '#f8fafc', marginTop: 4 }}>
              {formatMinutes(remaining)}
            </div>
            <div style={{ fontSize: 14, color: '#94a3b8', marginTop: 4 }}>
              Tahmini saat: {formatClock(ticket.scheduled_time)}
            </div>
          </div>
          <div style={{
            marginTop: 24,
            padding: '10px 14px',
            borderRadius: 12,
            background: 'rgba(59,130,246,0.12)',
            color: '#93c5fd',
            fontSize: 13
          }}>
            Hazırlanıyor · Ekranı kapatmayınız
          </div>
        </div>
      )}
    </div>
  );
}
