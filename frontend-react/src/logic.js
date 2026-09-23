// TostIQ — 2 Saatlik Sabit Slot Zamanlama, Dinamik Geri Sayım & Kredi Mantığı

export const SLOT_MINUTES = 5;
export const SLOT_MS = SLOT_MINUTES * 60 * 1000;
export const CANDIDATE_COUNT = 24; // 24 x 5 dk = 120 dakika (2 Saat)

export const ITEM_POINTS = {
  // Standart Menü
  'Kavurmalı': 120,
  'Sucuklu': 100,
  'Ton Balıklı': 85,
  'Karışık': 75,
  'Yumurtalı': 60,
  'Patatesli': 50,
  'Vejetaryen': 40,
  'Kaşarlı (Sade)': 45,

  // Ekmekler
  'Tam Buğday': 25,
  'Kepekli': 18,
  'Susamlı': 18,
  'Beyaz Ekmek': 10,

  // İç Malzemeler
  'Kavurma': 50,
  'Sucuk': 40,
  'Ton Balığı': 40,
  'Salam': 30,
  'Sosis': 30,
  'Yumurta': 20,
  'Kızartılmış Patates': 15,

  // Peynirler
  'Cheddar Peyniri': 25,
  'Kaşar Peyniri': 15,
  'Peynir İstemiyorum': 0,

  // Yeşillikler / İlaveler
  'Avokado': 30,
  'Zeytin': 20,
  'Mısır': 15,
  'Patates Püresi': 12,
  'Brokoli': 8,
  'Marul': 8,
  'Salatalık': 8,
  'Organik İlavesiz': 0,
  'Organik İlaveli': 0,

  // Soslar
  'Özel Sos': 10,
  'Özel Sos İstemiyorum': 0,
};

export function calculateOrderPoints(selection) {
  if (!selection) return 0;
  if (selection.type === 'standard') {
    return ITEM_POINTS[selection.name] || 50;
  }
  if (selection.type === 'custom') {
    let total = 0;
    if (selection.bread) total += ITEM_POINTS[selection.bread] || 0;
    if (Array.isArray(selection.fillings)) {
      selection.fillings.forEach((f) => (total += ITEM_POINTS[f] || 0));
    }
    if (selection.cheese) total += ITEM_POINTS[selection.cheese] || 0;
    if (Array.isArray(selection.greens)) {
      selection.greens.forEach((g) => (total += ITEM_POINTS[g] || 0));
    }
    if (selection.sauce) total += ITEM_POINTS[selection.sauce] || 0;
    return total;
  }
  return 0;
}

export function formatMinutes(ms, lang = 'tr') {
  const mins = Math.max(0, Math.ceil(ms / 60000));
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (lang === 'en') {
      return m > 0 ? `${h}h ${m}m` : `${h}h`;
    }
    return m > 0 ? `${h} sa ${m} dk` : `${h} sa`;
  }
  return lang === 'en' ? `${mins} min` : `${mins} dk`;
}

export function formatClock(ts) {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

export function bucketLabel(pos, lang = 'tr') {
  const totalMin = pos * SLOT_MINUTES;
  return formatMinutes(totalMin * 60000, lang);
}

export function candidatePositions() {
  const arr = [];
  for (let i = 1; i <= CANDIDATE_COUNT; i++) {
    arr.push(i);
  }
  return arr;
}

export function computeMaps(tickets, now) {
  const taken = {};
  (tickets || []).forEach((t) => {
    if (t.cancelled) return; // İptal edilen bilet slotu doldurmaz
    const rem = t.scheduled_time - now;
    if (rem > 0) {
      const pos = Math.ceil(rem / SLOT_MS);
      if (pos <= CANDIDATE_COUNT) {
        taken[pos] = t;
      }
    }
  });

  // ORİJİNAL DAVRANIŞ (geri getirildi): dolu basamağın BİR ÖNCESİ, aynı
  // biletin hedef saatinden 5 dk çıkarılarak hesaplanan değeri canlı
  // gösterir — ikisi birebir senkron iner. Bu önizleme 5 dk'nın altına
  // düşünce describePosition() basamağı "Çok yakın" ile bloke eder.
  const preview = {};
  (tickets || []).forEach((t) => {
    if (t.cancelled) return;
    const rem = t.scheduled_time - now;
    if (rem > 0) {
      const pos = Math.ceil(rem / SLOT_MS);
      const prevPos = pos - 1;
      if (prevPos >= 1 && !taken[prevPos]) {
        preview[prevPos] = { targetTime: t.scheduled_time - SLOT_MS, sourceTicket: t };
      }
    }
  });

  return { taken, preview };
}

export function describePosition(pos, now, maps, lang = 'tr', targetTime = null) {
  const takenTicket = maps.taken[pos];
  if (takenTicket) {
    const tRem = Math.max(0, takenTicket.scheduled_time - now);
    return {
      pos,
      time: targetTime != null ? targetTime : (now + pos * SLOT_MS),
      label: formatMinutes(tRem, lang),
      taken: true,
      blocked: false,
      subLabel: `#${takenTicket.code}`,
    };
  }

  const prev = maps.preview[pos];
  if (prev) {
    const remaining = prev.targetTime - now;
    if (remaining < SLOT_MS) {
      // ORİJİNAL DAVRANIŞ (geri getirildi): 5 dk'nın altına düşen önizleme
      // basamağı artık seçilemez — "Çok yakın" ile bloke olur.
      return {
        pos,
        time: null,
        label: formatMinutes(remaining, lang),
        taken: true,
        blocked: true,
        subLabel: 'Çok yakın',
      };
    }
    return {
      pos,
      time: prev.targetTime,
      label: formatMinutes(remaining, lang),
      taken: false,
      blocked: false,
      subLabel: '',
    };
  }

  return {
    pos,
    time: targetTime != null ? targetTime : (now + pos * SLOT_MS),
    label: formatMinutes(pos * SLOT_MS, lang),
    taken: false,
    blocked: false,
    subLabel: '',
  };
}

export function nearestOpenPosition(now, maps) {
  // describePosition() üzerinden kontrol ediliyor (maps.taken[p] değil) ki
  // henüz gerçek bilet olmayan ama 5 dk'dan az kalan (bloke) önizleme
  // basamakları da "uygun" sayılmasın — orijinal davranış.
  return candidatePositions().find((p) => !describePosition(p, now, maps).taken);
}