import { describe, it, expect } from 'vitest';
import {
  crc8, makeCommand, cmdFeed, cmdEnergy, cmdSpeed, cmdState,
  parseStatus, statusProblem,
  toGray, adjust, autoLevels, dither, packBits, isBlankRow,
  buildJob, toChunks, CMD, ROW_BYTES, PRINT_WIDTH,
  mmToDots, dotsToMm, rollLayout, rollFeed, measureByRef, rulerMarks, ROLL_PRESETS,
  uuid16, CAT_PRINT_SRV_STR, CAT_ADV_SRV_STR, CAT_PRINT_SRV, CAT_ADV_SRV,
} from '../lib/catprinter.js';

describe('crc8', () => {
  // Контрольне значення самого стандарту CRC-8 (поліном 0x07, без інверсій):
  // рядок "123456789" має давати 0xF4. Якщо тут розійдеться — принтер
  // відкидатиме кожен кадр, і виглядатиме це як "підключився, але не друкує".
  it('matches the published check value for "123456789"', () => {
    const bytes = Array.from('123456789', c => c.charCodeAt(0));
    expect(crc8(bytes)).toBe(0xf4);
  });
  it('is zero for empty input', () => {
    expect(crc8([])).toBe(0);
  });
  it('handles a single byte', () => {
    expect(crc8([0x00])).toBe(0x00);
    expect(crc8([0x01])).toBe(0x07);
  });
});

describe('makeCommand', () => {
  it('frames a command exactly as the printer expects', () => {
    const frame = makeCommand(0xa1, [0x64, 0x00]);
    expect(Array.from(frame)).toEqual([
      0x51, 0x78,        // магія
      0xa1,              // команда
      0x00,              // тип: від нас до принтера
      0x02, 0x00,        // довжина payload, little-endian
      0x64, 0x00,        // сам payload
      crc8([0x64, 0x00]),
      0xff,
    ]);
  });
  it('writes a two-byte length for payloads over 255 bytes', () => {
    const frame = makeCommand(0xa2, new Uint8Array(300));
    expect(frame[4]).toBe(300 & 0xff);
    expect(frame[5]).toBe(1);
    expect(frame.length).toBe(308);
    expect(frame[frame.length - 1]).toBe(0xff);
  });
  it('accepts both arrays and Uint8Array', () => {
    expect(Array.from(makeCommand(0xa1, [1, 2]))).toEqual(Array.from(makeCommand(0xa1, Uint8Array.from([1, 2]))));
  });
});

describe('command helpers', () => {
  it('encodes feed length as uint16 little-endian', () => {
    const f = cmdFeed(300);
    expect(f[2]).toBe(CMD.FEED);
    expect(f[6]).toBe(44);
    expect(f[7]).toBe(1);
  });
  it('encodes energy as uint32 little-endian', () => {
    const e = cmdEnergy(24000);
    expect(e[2]).toBe(CMD.ENERGY);
    expect([e[6], e[7], e[8], e[9]]).toEqual([24000 & 0xff, (24000 >> 8) & 0xff, 0, 0]);
  });
  it('encodes speed as a single byte', () => {
    const s = cmdSpeed(32);
    expect(s[4]).toBe(1);
    expect(s[6]).toBe(32);
  });
  it('asks for state with a one-byte payload', () => {
    expect(cmdState()[2]).toBe(CMD.STATE);
  });
});

describe('parseStatus', () => {
  const frame = flags => Uint8Array.from([0x51, 0x78, CMD.STATE, 0x01, 0x01, 0x00, flags, 0xff]);

  it('decodes the flag bits', () => {
    expect(parseStatus(frame(0x00))).toEqual({
      outOfPaper: false, coverOpen: false, overheat: false,
      lowPower: false, paused: false, busy: false,
    });
    expect(parseStatus(frame(0x01)).outOfPaper).toBe(true);
    expect(parseStatus(frame(0x04)).overheat).toBe(true);
    expect(parseStatus(frame(0x80)).busy).toBe(true);
    const both = parseStatus(frame(0x09));
    expect(both.outOfPaper).toBe(true);
    expect(both.lowPower).toBe(true);
  });

  it('returns null for anything that is not a state reply', () => {
    expect(parseStatus(null)).toBeNull();
    expect(parseStatus(Uint8Array.from([1, 2, 3]))).toBeNull();
    expect(parseStatus(Uint8Array.from([0x51, 0x78, CMD.BITMAP, 0, 1, 0, 0, 0xff]))).toBeNull();
  });

  it('reports the most important problem first', () => {
    expect(statusProblem(parseStatus(frame(0x00)))).toBeNull();
    expect(statusProblem(parseStatus(frame(0x01)))).toMatch(/папір/i);
    expect(statusProblem(parseStatus(frame(0x04)))).toMatch(/перегрів/i);
    // скінчився папір важливіше за сідаючу батарею
    expect(statusProblem(parseStatus(frame(0x09)))).toMatch(/папір/i);
    expect(statusProblem(null)).toBeNull();
  });
});

describe('toGray', () => {
  it('converts RGB to luminance', () => {
    const rgba = Uint8ClampedArray.from([0, 0, 0, 255, 255, 255, 255, 255]);
    const gray = toGray(rgba, 2);
    expect(gray[0]).toBe(0);
    expect(gray[1]).toBe(255);
  });
  it('treats transparent pixels as white, not black', () => {
    // Це не дрібниця: інакше все, що не намальовано на canvas, поїде
    // суцільною чорною плямою і зжере пів рулона.
    const rgba = Uint8ClampedArray.from([0, 0, 0, 0]);
    expect(toGray(rgba, 1)[0]).toBe(255);
  });
});

describe('adjust', () => {
  it('does not mutate the input', () => {
    const src = Float32Array.from([10, 128, 250]);
    adjust(src, { brightness: 50, contrast: 40 });
    expect(Array.from(src)).toEqual([10, 128, 250]);
  });
  it('brightens and clamps to 0..255', () => {
    const out = adjust(Float32Array.from([0, 128, 255]), { brightness: 100 });
    expect(out[0]).toBeGreaterThan(0);
    expect(out[2]).toBe(255);
    expect(Math.min(...out)).toBeGreaterThanOrEqual(0);
  });
  it('inverts', () => {
    const out = adjust(Float32Array.from([0, 255]), { invert: true });
    expect(out[0]).toBe(255);
    expect(out[1]).toBe(0);
  });
  it('leaves values untouched with neutral options', () => {
    const out = adjust(Float32Array.from([0, 64, 128, 255]), {});
    expect(Array.from(out)).toEqual([0, 64, 128, 255]);
  });
});

describe('autoLevels', () => {
  it('stretches a flat mid-grey photo across the full range', () => {
    const gray = new Float32Array(1000);
    for (let i = 0; i < gray.length; i++) gray[i] = 100 + (i % 50);   // 100..149
    const out = autoLevels(gray);
    expect(Math.max(...out) - Math.min(...out)).toBeGreaterThan(200);
  });
  it('leaves an almost uniform image alone instead of amplifying noise', () => {
    const gray = new Float32Array(100).fill(128);
    const out = autoLevels(gray);
    expect(Array.from(out).every(v => v === 128)).toBe(true);
  });
});

describe('dither', () => {
  const solid = (v, n) => Float32Array.from(new Array(n).fill(v));

  it('threshold marks dark pixels for printing', () => {
    const bits = dither(Float32Array.from([0, 127, 129, 255]), 4, 1, 'threshold');
    expect(Array.from(bits)).toEqual([1, 1, 0, 0]);
  });

  it('prints everything on solid black and nothing on solid white, in every mode', () => {
    ['threshold', 'bayer', 'floyd', 'atkinson'].forEach(mode => {
      expect(Array.from(dither(solid(0, 64), 8, 8, mode)).every(b => b === 1)).toBe(true);
      expect(Array.from(dither(solid(255, 64), 8, 8, mode)).every(b => b === 0)).toBe(true);
    });
  });

  it('renders mid-grey as roughly half the dots, not a solid blob', () => {
    // Саме через це фото в рідному застосунку виходить чорною плямою:
    // там простий поріг, і 50% сірого стає суцільним чорним.
    ['bayer', 'floyd', 'atkinson'].forEach(mode => {
      const bits = dither(solid(128, 4096), 64, 64, mode);
      const dots = bits.reduce((a, b) => a + b, 0);
      expect(dots).toBeGreaterThan(4096 * 0.3);
      expect(dots).toBeLessThan(4096 * 0.7);
    });
  });

  it('is deterministic — the preview matches what actually prints', () => {
    const gray = Float32Array.from(Array.from({ length: 256 }, (_, i) => (i * 7) % 256));
    const a = dither(gray, 16, 16, 'floyd');
    const b = dither(gray, 16, 16, 'floyd');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('does not mutate the source greyscale', () => {
    const gray = Float32Array.from([10, 200, 90, 140]);
    dither(gray, 2, 2, 'floyd');
    expect(Array.from(gray)).toEqual([10, 200, 90, 140]);
  });
});

describe('packBits', () => {
  it('packs least significant bit first — pixel 0 is bit 0', () => {
    const bits = Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(packBits(bits, 8, 1)[0]).toBe(0x01);
  });
  it('packs pixel 7 into the high bit', () => {
    const bits = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(packBits(bits, 8, 1)[0]).toBe(0x80);
  });
  it('produces 48 bytes per row at full print width', () => {
    const bits = new Uint8Array(PRINT_WIDTH * 3);
    expect(packBits(bits, PRINT_WIDTH, 3).length).toBe(ROW_BYTES * 3);
  });
  it('keeps rows independent', () => {
    const bits = new Uint8Array(16);
    bits[8] = 1;                       // перший піксель другого рядка
    const packed = packBits(bits, 8, 2);
    expect(packed[0]).toBe(0x00);
    expect(packed[1]).toBe(0x01);
  });
});

describe('isBlankRow', () => {
  it('spots empty and non-empty rows', () => {
    const packed = Uint8Array.from([0, 0, 0, 0, 1, 0]);
    expect(isBlankRow(packed, 0, 3)).toBe(true);
    expect(isBlankRow(packed, 3, 3)).toBe(false);
  });
});

describe('buildJob', () => {
  const rows = 4;
  const packed = new Uint8Array(ROW_BYTES * rows);
  packed[0] = 0xff;                    // тільки перший рядок непорожній

  it('sets speed and energy before printing anything', () => {
    const job = buildJob(packed, { rows, lattice: false, feed: 0 });
    expect(job[0][2]).toBe(CMD.SPEED);
    expect(job[1][2]).toBe(CMD.ENERGY);
    expect(job[2][2]).toBe(CMD.APPLY_ENERGY);
  });

  it('sends every row by default so vertical spacing survives', () => {
    // Пропускати порожні рядки — спокусливо й неправильно: папір під ними
    // не протягується, і текст злипається.
    const job = buildJob(packed, { rows, lattice: false, feed: 0 });
    expect(job.filter(p => p[2] === CMD.BITMAP).length).toBe(rows);
  });

  it('wraps the job in lattice commands when asked', () => {
    const job = buildJob(packed, { rows, lattice: true, feed: 0 });
    expect(job[3][2]).toBe(CMD.LATTICE);
    expect(job[job.length - 1][2]).toBe(CMD.LATTICE);
  });

  it('collapses long blank runs into a feed when coalescing is on', () => {
    const tall = new Uint8Array(ROW_BYTES * 40);
    tall[0] = 0xff;
    const job = buildJob(tall, { rows: 40, lattice: false, feed: 0, coalesceBlank: true, coalesceMin: 16 });
    expect(job.filter(p => p[2] === CMD.BITMAP).length).toBe(1);
    const feeds = job.filter(p => p[2] === CMD.FEED);
    expect(feeds.length).toBe(1);
    expect(feeds[0][6]).toBe(39);
  });

  it('drops to a slow speed for the final feed', () => {
    const job = buildJob(packed, { rows, lattice: false, feed: 50 });
    const tail = job.slice(-2);
    expect(tail[0][2]).toBe(CMD.SPEED);
    expect(tail[0][6]).toBe(8);
    expect(tail[1][2]).toBe(CMD.FEED);
    expect(tail[1][6]).toBe(50);
  });
});

describe('toChunks', () => {
  it('splits the whole stream into fixed-size pieces', () => {
    const packets = [Uint8Array.from([1, 2, 3]), Uint8Array.from([4, 5, 6, 7])];
    const chunks = toChunks(packets, 3);
    expect(chunks.map(c => Array.from(c))).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
  });
  it('preserves every byte in order', () => {
    const packets = [buildJob(new Uint8Array(ROW_BYTES * 2), { rows: 2 })].flat();
    const total = packets.reduce((n, p) => n + p.length, 0);
    const joined = toChunks(packets, 17).reduce((n, c) => n + c.length, 0);
    expect(joined).toBe(total);
  });
});

describe('roll geometry', () => {
  it('converts millimetres at 8 dots per mm', () => {
    expect(mmToDots(1)).toBe(8);
    expect(mmToDots(48)).toBe(PRINT_WIDTH);
    expect(dotsToMm(384)).toBe(48);
  });

  it('describes a continuous roll as full width with no pitch', () => {
    const l = rollLayout({ widthMm: 48, continuous: true });
    expect(l.continuous).toBe(true);
    expect(l.widthPx).toBe(PRINT_WIDTH);
    expect(l.pitchPx).toBe(0);
  });

  it('turns a sticker size into pixels and a pitch', () => {
    const l = rollLayout({ widthMm: 40, heightMm: 30, gapMm: 2, offsetMm: 4 });
    expect(l.widthPx).toBe(320);
    expect(l.heightPx).toBe(240);
    expect(l.gapPx).toBe(16);
    expect(l.offsetPx).toBe(32);
    expect(l.pitchPx).toBe(256);
  });

  it('never lets a sticker hang off the printable strip', () => {
    const l = rollLayout({ widthMm: 80, heightMm: 30, offsetMm: 40 });
    expect(l.widthPx).toBe(PRINT_WIDTH);
    expect(l.offsetPx).toBe(0);
    expect(l.widthPx + l.offsetPx).toBeLessThanOrEqual(PRINT_WIDTH);
  });

  it('feeds exactly to the start of the next sticker', () => {
    const l = rollLayout({ widthMm: 40, heightMm: 30, gapMm: 2 });   // крок 256
    expect(rollFeed(l, 240)).toBe(16);      // надрукували всю наклейку — лишився проміжок
    expect(rollFeed(l, 100)).toBe(156);     // надрукували менше — доганяємо до межі
    expect(rollFeed(l, 256)).toBe(256);     // рівно на межі — цілий крок до наступної
  });

  it('applies the manual nudge for rolls that drift', () => {
    const l = rollLayout({ widthMm: 40, heightMm: 30, gapMm: 2, nudgeMm: 0.5 });
    expect(rollFeed(l, 240)).toBe(16 + 4);
  });

  it('falls back to a plain feed on continuous tape', () => {
    expect(rollFeed(rollLayout({ continuous: true }), 100, 80)).toBe(80);
  });

  it('ships presets that all fit the printable width', () => {
    ROLL_PRESETS.forEach(p => {
      const l = rollLayout(p);
      expect(l.widthPx + l.offsetPx).toBeLessThanOrEqual(PRINT_WIDTH);
    });
  });
});

describe('measureByRef', () => {
  it('scales the sticker against a known reference', () => {
    // На фото банківська картка (85.6 мм) вийшла 428 px, наклейка — 200 px
    expect(measureByRef(428, 85.6, 200)).toBe(40);
  });
  it('rounds to a tenth of a millimetre', () => {
    expect(measureByRef(100, 85.6, 47)).toBe(40.2);
  });
  it('refuses nonsense instead of returning Infinity', () => {
    expect(measureByRef(0, 85.6, 200)).toBeNull();
    expect(measureByRef(428, 0, 200)).toBeNull();
  });
});

describe('rulerMarks', () => {
  it('marks every millimetre and flags the tens', () => {
    const marks = rulerMarks(20);
    expect(marks.length).toBe(21);
    expect(marks[10]).toEqual({ mm: 10, dots: 80, major: true, mid: true });
    expect(marks[5].major).toBe(false);
    expect(marks[5].mid).toBe(true);
  });
});

describe('uuid16', () => {
  it('expands a 16-bit id into the full canonical UUID string', () => {
    // Bluefy на iPhone не розбирає 16-бітні UUID числом і падає з
    // «Request payload could not be parsed» ще до показу списку пристроїв.
    // Тому повна форма — не косметика, а умова роботи на iOS.
    expect(uuid16(0xae30)).toBe('0000ae30-0000-1000-8000-00805f9b34fb');
    expect(uuid16(0xae01)).toBe('0000ae01-0000-1000-8000-00805f9b34fb');
    expect(uuid16(0xaf30)).toBe('0000af30-0000-1000-8000-00805f9b34fb');
  });
  it('pads short ids to four hex digits', () => {
    expect(uuid16(0x1a)).toBe('0000001a-0000-1000-8000-00805f9b34fb');
  });
  it('exports the printer services in string form', () => {
    expect(CAT_PRINT_SRV_STR).toBe(uuid16(CAT_PRINT_SRV));
    expect(CAT_ADV_SRV_STR).toBe(uuid16(CAT_ADV_SRV));
  });
});
