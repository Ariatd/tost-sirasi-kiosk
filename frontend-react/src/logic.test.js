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

  it('dolu basamak (8) gerçek kalan süreyi gösterir, "Dolu · <kod>" etiketiyle', () => {
    const maps = computeMaps([ticket], NOW);
    const d = describePosition(8, NOW, maps);
    expect(d.taken).toBe(true);
    expect(d.blocked).toBeFalsy();
    expect(d.label).toBe(formatMinutes(ticket.scheduled_time - NOW));
    expect(d.subLabel).toBe('Dolu · 42');
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
    expect(maps.occupiedMap.has(7)).toBe(true);
    expect(maps.occupiedMap.has(8)).toBe(false);
    const d7 = describePosition(7, now, maps);
    expect(d7.taken).toBe(true);
    expect(d7.subLabel).toBe('Dolu · 42');
  });

  it('31 dk → 30:00 sınırında anında sola kayar; 30 dk eski yuvada bekletilmez', () => {
    const at3100 = NOW + (8 * SLOT_MS - 31 * 60_000);
    const maps31 = computeMaps([ticket], at3100);
    expect(maps31.occupiedMap.get(7)?.code).toBe('42');
    expect(maps31.occupiedMap.has(6)).toBe(false);
    expect(describePosition(5, at3100, maps31).label).toBe('25 dk');
    expect(describePosition(6, at3100, maps31).label).toBe('26 dk');
    expect(describePosition(7, at3100, maps31).label).toBe('31 dk');

    // 30:59: hâlâ üst yuva, etiket 31 (30 eski yuvada yok) — sol boş basamak 25 ile çakışmaz
    const at3059 = at3100 + 1000;
    const maps3059 = computeMaps([ticket], at3059);
    expect(maps3059.occupiedMap.get(7)?.code).toBe('42');
    expect(maps3059.occupiedMap.has(6)).toBe(false);
    expect(describePosition(5, at3059, maps3059).label).toBe('25 dk');
    expect(describePosition(6, at3059, maps3059).label).toBe('26 dk');
    expect(describePosition(7, at3059, maps3059).label).toBe('31 dk');

    const at3000 = NOW + (8 * SLOT_MS - 30 * 60_000);
    const maps3000 = computeMaps([ticket], at3000);
    expect(maps3000.occupiedMap.get(6)?.code).toBe('42');
    expect(maps3000.occupiedMap.has(7)).toBe(false);
    expect(describePosition(5, at3000, maps3000).label).toBe('25 dk');
    expect(describePosition(6, at3000, maps3000).label).toBe('30 dk');
    expect(describePosition(7, at3000, maps3000).label).toBe('35 dk');
    const labels3000 = [5, 6, 7].map((p) => describePosition(p, at3000, maps3000).label);
    expect(new Set(labels3000).size).toBe(3);

    const at2959 = at3000 + 1000;
    const maps2959 = computeMaps([ticket], at2959);
    expect(maps2959.occupiedMap.get(6)?.code).toBe('42');
    expect(describePosition(5, at2959, maps2959).label).toBe('24 dk');
    expect(describePosition(6, at2959, maps2959).label).toBe('29 dk');
    expect(describePosition(7, at2959, maps2959).label).toBe('35 dk');
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

describe('kart başına aktif bilet sayısı — mantığın uygulama katmanına devri', () => {
  it('describePosition/computeMaps kart bazlı çakışma kontrolü yapmaz (bu App.jsx/proceedToOrder işi)', () => {
    // logic.js kartlardan bağımsız, saf basamak hesaplayıcıdır; kart başına
    // maksimum 4 aktif sipariş kuralı App.jsx (proceedToOrder) ve backend'de
    // (validate_and_create_ticket) uygulanır. Burada sadece iki farklı
    // biletin basamaklarının birbirini etkilemediğini doğruluyoruz.
    const t1 = { id: 1, card_id: 'A', code: '11', scheduled_time: NOW + 5 * 60_000 };
    const t2 = { id: 2, card_id: 'B', code: '22', scheduled_time: NOW + 10 * 60_000 };
    const maps = computeMaps([t1, t2], NOW);
    expect(maps.occupiedMap.get(1).card_id).toBe('A');
    expect(maps.occupiedMap.get(2).card_id).toBe('B');
  });
});

describe('sipariş kodları', () => {
  it('kodlar iki haneli gösterim için sıfırla doldurulur', () => {
    expect(String(7).padStart(2, '0')).toBe('07');
    expect(String(47).padStart(2, '0')).toBe('47');
  });
});
