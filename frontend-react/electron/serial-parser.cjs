// Kart okuyucu çerçeve ayrıştırma — backend/server.py'nin (ve önceki
// ~/nfc/nfc_reader.py'nin) parse_frames() / em4100_core() mantığının
// JavaScript'e BİREBİR taşınmış hali.
//
// Çerçeve: AA | LEN (2 bayt, big-endian) | VERİ (LEN bayt) | XOR(LEN+VERİ) | BB
// EM4100 çekirdeği: VERİ'nin 3..8 baytları (bkz. backend/server.py em4100_core).
"use strict";

const FRAME_START = 0xaa;
const FRAME_END = 0xbb;

/**
 * buf içindeki tam çerçeveleri çıkarır, kalanı döndürür (buf'ı MUTATE ETMEZ).
 * @param {Buffer} buf
 * @returns {{ frames: {payload: Buffer, frame: Buffer}[], rest: Buffer }}
 */
function parseFrames(buf) {
  const out = [];
  while (true) {
    const start = buf.indexOf(FRAME_START);
    if (start === -1) {
      buf = Buffer.alloc(0);
      break;
    }
    if (start > 0) buf = buf.subarray(start);
    if (buf.length < 4) break;

    const length = (buf[1] << 8) | buf[2];
    const total = 1 + 2 + length + 1 + 1;
    if (length <= 0 || length > 64) {
      buf = buf.subarray(1);
      continue;
    }
    if (buf.length < total) break;

    const frame = buf.subarray(0, total);
    const payload = frame.subarray(3, 3 + length);
    const chk = frame[3 + length];
    const end = frame[4 + length];
    let calc = 0;
    for (let i = 1; i < 3 + length; i++) calc ^= frame[i];

    if (end === FRAME_END && chk === calc) {
      out.push({ payload: Buffer.from(payload), frame: Buffer.from(frame) });
      buf = buf.subarray(total);
    } else {
      buf = buf.subarray(1);
    }
  }
  return { frames: out, rest: Buffer.from(buf) };
}

function em4100Core(payload) {
  return payload.length >= 8
    ? payload.subarray(3, 8).toString("hex").toUpperCase()
    : payload.toString("hex").toUpperCase();
}

module.exports = { parseFrames, em4100Core, FRAME_START, FRAME_END };
