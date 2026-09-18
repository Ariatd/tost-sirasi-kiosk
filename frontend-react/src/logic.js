// Tost Sırası — iş mantığı (saf fonksiyonlar).
// ~/tost-kiosk/static/app.js (mevcut vanilla sürüm) ile BİREBİR aynı —
// sadece React'e taşınırken framework'e özgü hiçbir şey eklenmedi.

export const SLOT_MINUTES = 5;
export const SLOT_MS = SLOT_MINUTES * 60 * 1000;
export const HORIZON_POSITIONS = 24; // "başka saat seç" penceresi (2 saat)

export function formatMinutes(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes <= 0) return 'şimdi';
  if (totalMinutes < 60) return `${totalMinutes} dk`;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return mins === 0 ? `${hours} saat` : `${hours} saat ${mins} dk`;
}

// Tam 5 dk sınırında (ör. 30:00.000) bir alt yuvaya geçer.
// 30:00.001 hâlâ üst yuva — kayma gecikmesin diye ms/SLOT_MS tam bölünmede ceil=N.
export function slotPosition(remainingMs) {
  if (remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / SLOT_MS);
}

function formatMinutesInSlot(ms, pos) {
  const floorMin = Math.floor(ms / 60000);
  if (floorMin <= 0) return 'şimdi';
  // Üst yuvada 30:59…30:01 "31 dk" kalsın; "30 dk" eski yuvada 1 dk görünmesin.
  const minInSlot = (pos - 1) * SLOT_MINUTES + 1;
  const totalMinutes = Math.max(floorMin, minInSlot);
  if (totalMinutes < 60) return `${totalMinutes} dk`;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return mins === 0 ? `${hours} saat` : `${hours} saat ${mins} dk`;
}

export function bucketLabel(position) {
  const totalMinutes = position * SLOT_MINUTES;
  if (totalMinutes < 60) return `${totalMinutes} dk`;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return mins === 0 ? `${hours} saat` : `${hours} saat ${mins} dk`;
}

export function formatClock(ms) {
  return new Date(ms).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}

// activeTickets: server'dan gelen, picked_up=0 filtrelenmiş bilet listesi.
export function computeMaps(activeTickets, now) {
  const occupiedMap = new Map(); // position -> ticket
  for (const t of activeTickets) {
    const remaining = t.scheduled_time - now;
    if (remaining > 0) {
      const pos = slotPosition(remaining);
      if (pos >= 1) occupiedMap.set(pos, t);
    }
  }

  const previewMap = new Map(); // position -> { targetTime, sourceTicket }
  for (const t of activeTickets) {
    const remaining = t.scheduled_time - now;
    if (remaining > 0) {
      const pos = slotPosition(remaining);
      const prevPos = pos - 1;
      if (prevPos >= 1 && !occupiedMap.has(prevPos)) {
        previewMap.set(prevPos, { targetTime: t.scheduled_time - SLOT_MS, sourceTicket: t });
      }
    }
  }
  return { occupiedMap, previewMap };
}

export function describePosition(p, now, maps) {
  const occ = maps.occupiedMap.get(p);
  if (occ) {
    return {
      taken: true,
      label: formatMinutesInSlot(occ.scheduled_time - now, p),
      subLabel: `Dolu · ${occ.code}`,
      time: null,
    };
  }
  const prev = maps.previewMap.get(p);
  if (prev) {
    const remaining = prev.targetTime - now;
    if (remaining < SLOT_MS) {
      return { taken: true, blocked: true, label: formatMinutesInSlot(remaining, p), subLabel: 'Çok yakın', time: null };
    }
    return { taken: false, label: formatMinutesInSlot(remaining, p), time: prev.targetTime };
  }
  return { taken: false, label: bucketLabel(p), pos: p };
}

export function candidatePositions() {
  return Array.from({ length: HORIZON_POSITIONS }, (_, i) => i + 1);
}

export function nearestOpenPosition(now, maps) {
  return candidatePositions().find((p) => !describePosition(p, now, maps).taken);
}
