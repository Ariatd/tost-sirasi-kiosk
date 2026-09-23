// Basamak/önizleme/bloke iş mantığı testleri (Vitest).
// Tekrarlanabilir olması için Date.now() yerine sabit bir NOW kullanılır.
import { describe, it, expect } from 'vitest';
import {
  SLOT_MS,
  bucketLabel,
  formatMinutes,
  computeMaps,
  describePosition,
  candidatePositions,
  nearestOpenPosition,
} from './logic.js';

const NOW = 1_800_000_000_000; // sabit referans an (ms)

describe('boş kuyruk', () => {
  it('en yakın uygun saat her zaman 5 dk (pozisyon 1)', () => {
    const maps = computeMaps([], NOW);
    const pos = nearestOpenPosition(NOW, maps);
    expect(pos).toBe(1);
    expect(describePosition(pos, NOW, maps).label).toBe('5 dk');
  });

  it('hiçbir basamak dolu/bloke değildir', () => {
    const maps = computeMaps([], NOW);
    for (const p of candidatePositions()) {
      const d = describePosition(p, NOW, maps);
      expect(d.taken).toBe(false);
      expect(d.label).toBe(bucketLabel(p));
    }
  });
});

describe('dolu basamak + senkron önizleme (bir önceki basamak)', () => {
  // Tek bilet: tam 40 dk sonrasına (pozisyon 8) planlanmış.
  const ticket = { id: 1, card_id: 'CARD1', code: '42', scheduled_time: NOW + 8 * SLOT_MS };

  it('dolu basamak (8) gerçek kalan süreyi gösterir, "#<kod>" etiketiyle', () => {
    const maps = computeMaps([ticket], NOW);
    const d = describePosition(8, NOW, maps);
    expect(d.taken).toBe(true);
    expect(d.blocked).toBeFalsy();
    expect(d.label).toBe(formatMinutes(ticket.scheduled_time - NOW));
    expect(d.subLabel).toBe('#42');
  });

  it('bir önceki basamak (7) canlı önizleme gösterir: hedef - 5dk', () => {
    const maps = computeMaps([ticket], NOW);
    const d = describePosition(7, NOW, maps);
    expect(d.taken).toBe(false);
    expect(d.label).toBe(formatMinutes(ticket.scheduled_time - SLOT_MS - NOW));
  });

  it('zaman ilerledikçe dolu (8) ve önizleme (7) senkron azalır — aralarındaki fark hep tam 5 dk', () => {
    for (const advanceMin of [0, 1, 2, 3, 4]) {
      const now = NOW + advanceMin * 60_000;
      const maps = computeMaps([ticket], now);
      const occRemaining = ticket.scheduled_time - now;
      const previewRemaining = ticket.scheduled_time - SLOT_MS - now;
      expect(occRemaining - previewRemaining).toBe(SLOT_MS);

      const occ = describePosition(8, now, maps);
      const prev = describePosition(7, now, maps);
      expect(occ.label).toBe(formatMinutes(occRemaining));
      // önizleme henüz 5 dk sınırının altına inmediyse aynı senkron mantıkla gösterilir
      if (previewRemaining >= SLOT_MS) {
        expect(prev.label).toBe(formatMinutes(previewRemaining));
        expect(prev.taken).toBe(false);
      }
    }
  });

  it('dolu basamak (8) 5 dk sınırını geçince bir alt basamağa (7) kayar', () => {
    // 5 dk ilerlet: artık gerçek kalan süre 35 dk -> ceil(35/5)=7
    const now = NOW + 5 * 60_000;
    const maps = computeMaps([ticket], now);
    expect(Boolean(maps.taken[7])).toBe(true);
    expect(Boolean(maps.taken[8])).toBe(false);
    const d7 = describePosition(7, now, maps);
    expect(d7.taken).toBe(true);
    expect(d7.subLabel).toBe('#42');
  });
});

describe('5 dk altına düşen önizleme "bloke" olur', () => {
  // Bilet 8 dk sonrasına planlı (pozisyon 2). Bir önceki basamak (1) için
  // önizleme hedefi = 8dk - 5dk = 3 dk sonrası -> SLOT_MS'nin altında.
  const ticket = { id: 2, card_id: 'CARD2', code: '07', scheduled_time: NOW + 8 * 60_000 };

  it('önizleme süresi 5 dk altındaysa taken=true, blocked=true, "Çok yakın"', () => {
    const maps = computeMaps([ticket], NOW);
    const d = describePosition(1, NOW, maps);
    expect(d.taken).toBe(true);
    expect(d.blocked).toBe(true);
    expect(d.subLabel).toBe('Çok yakın');
  });

  it('bloke basamak "en yakın uygun saat" önerisinden atlanır', () => {
    const maps = computeMaps([ticket], NOW);
    const nearest = nearestOpenPosition(NOW, maps);
    // pozisyon 1 bloke, pozisyon 2 dolu -> ilk uygun pozisyon 3 olmalı
    expect(nearest).toBe(3);
    expect(describePosition(nearest, NOW, maps).taken).toBe(false);
  });

  it('gerçek bir sipariş, önizlemesi 5 dk altına düşmüş basamağa seçilemez (UI disabled)', () => {
    const maps = computeMaps([ticket], NOW);
    const d = describePosition(1, NOW, maps);
    // taken=true olan basamaklar arayüzde disabled - burada sadece
    // "seçilebilir değil" durumunun doğru işaretlendiğini doğruluyoruz.
    expect(d.taken).toBe(true);
  });
});

describe('Math.ceil ile slot geçişlerinde anında kayma', () => {
  // Tek bilet: tam 35 dk sonrasına planlanmış (pozisyon 7)
  const ticket = { id: 10, card_id: 'TEST', code: 'TS', scheduled_time: NOW + 7 * SLOT_MS }; // 35 minutes

  it('31:00 anında, etiketler doğru ve bilet hala 7. pozisyonda', () => {
    // `now` öyle bir an ki, biletin scheduled_time'ından geriye 31 dakika kalmış.
    const nowAt31MinRemaining = ticket.scheduled_time - 31 * 60_000;
    const maps = computeMaps([ticket], nowAt31MinRemaining);

    // Ticket should still be at position 7 (Math.ceil(31min / 5min) = Math.ceil(6.2) = 7)
    expect(maps.taken[7]?.code).toBe('TS');
    expect(Boolean(maps.taken[6])).toBe(false);

    // Label for occupied slot (pos 7): Remaining 31 minutes -> '31 dk'
    expect(describePosition(7, nowAt31MinRemaining, maps).label).toBe('31 dk');

    // Label for preview slot (pos 6): targetTime = scheduled_time - 5min. Remaining = (scheduled_time - 5min) - nowAt31MinRemaining
    // = (scheduled_time - nowAt31MinRemaining) - 5min = 31min - 5min = 26min
    expect(describePosition(6, nowAt31MinRemaining, maps).label).toBe('26 dk');

    // Label for an empty slot (pos 5): bucketLabel(5) -> '25 dk'
    expect(describePosition(5, nowAt31MinRemaining, maps).label).toBe('25 dk');
  });

  it('30:59 anında (1 saniye sonra), etiketler doğru ve bilet hala 7. pozisyonda', () => {
    const nowAt31MinRemaining = ticket.scheduled_time - 31 * 60_000;
    const nowAt30Min59SecRemaining = nowAt31MinRemaining + 1000; // 1 second later
    const maps = computeMaps([ticket], nowAt30Min59SecRemaining);

    // Ticket should still be at position 7 (Math.ceil(30min 59sec / 5min) = Math.ceil(6.19...) = 7)
    expect(maps.taken[7]?.code).toBe('TS');
    expect(Boolean(maps.taken[6])).toBe(false);

    // Label for occupied slot (pos 7): Remaining 30min 59sec -> Math.ceil(30.98) -> '31 dk'
    expect(describePosition(7, nowAt30Min59SecRemaining, maps).label).toBe('31 dk');

    // Label for preview slot (pos 6): Remaining 25min 59sec -> Math.ceil(25.98) -> '26 dk'
    expect(describePosition(6, nowAt30Min59SecRemaining, maps).label).toBe('26 dk');

    // Label for an empty slot (pos 5): bucketLabel(5) -> '25 dk'
    expect(describePosition(5, nowAt30Min59SecRemaining, maps).label).toBe('25 dk');
  });

  it('Tam 30:00 anında, bilet 6. pozisyona kayar ve etiketler doğru', () => {
    // `now` öyle bir an ki, biletin scheduled_time'ından geriye tam 30 dakika kalmış.
    const nowAt30MinRemaining = ticket.scheduled_time - 30 * 60_000;
    const maps = computeMaps([ticket], nowAt30MinRemaining);

    // Ticket should now be at position 6 (Math.ceil(30min / 5min) = Math.ceil(6) = 6)
    expect(Boolean(maps.taken[7])).toBe(false);
    expect(maps.taken[6]?.code).toBe('TS');

    // Label for occupied slot (pos 6): Remaining 30 minutes -> '30 dk'
    expect(describePosition(6, nowAt30MinRemaining, maps).label).toBe('30 dk');

    // Label for preview slot (pos 5): targetTime = scheduled_time - 5min. Remaining = (scheduled_time - 5min) - nowAt30MinRemaining
    // = (scheduled_time - nowAt30MinRemaining) - 5min = 30min - 5min = 25min
    expect(describePosition(5, nowAt30MinRemaining, maps).label).toBe('25 dk');

    // Label for an empty slot (pos 7): bucketLabel(7) -> '35 dk'
    expect(describePosition(7, nowAt30MinRemaining, maps).label).toBe('35 dk');
  });
});

describe('kart başına aktif bilet sayısı — mantığın uygulama katmanına devri', () => {
  it('describePosition/computeMaps kart bazlı çakışma kontrolü yapmaz (bu App.jsx/proceedToOrder işi)', () => {
    // logic.js kartlardan bağımsız, saf basamak hesaplayıcıdır; kart başına
    // maksimum 4 aktif sipariş kuralı App.jsx (proceedToOrder) ve backend'de
    // (validate_and_create_ticket) uygulanır. Burada sadece iki farklı
    // biletin basamaklarının birbirini etkilemediğini doğruluyoruz.
    const t1 = { id: 1, card_id: 'A', code: '11', scheduled_time: NOW + 5 * 60_000 };
    const t2 = { id: 2, card_id: 'B', code: '22', scheduled_time: NOW + 10 * 60_000 };
    const maps = computeMaps([t1, t2], NOW);
    expect(maps.taken[1].card_id).toBe('A');
    expect(maps.taken[2].card_id).toBe('B');
  });
});

describe('sipariş kodları', () => {
  it('kodlar iki haneli gösterim için sıfırla doldurulur', () => {
    expect(String(7).padStart(2, '0')).toBe('07');
    expect(String(47).padStart(2, '0')).toBe('47');
  });
});
