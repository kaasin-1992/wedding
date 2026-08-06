import { describe, it, expect } from 'vitest';
import { crc8, packBits } from '../lib/catprinter.js';
import {
  mxCommand, mxStatus, mxFlush, mxIntensity, mxPrint, mxCancel,
  mxParseNotification, mxParseStatus, mxStatusProblem,
  mxPrepareImage, mxDataChunks,
  MX_CMD, MX_ROW_BYTES, MX_MIN_BYTES, MX_MIN_ROWS, MX_MODE_1BPP,
} from '../lib/mxw01.js';

describe('mxCommand', () => {
  it('frames with the 22 21 preamble, not the classic 51 78', () => {
    // Уся різниця між родинами починається саме тут. Переплутати преамбулу —
    // і принтер мовчки ігнорує все, що ми йому шлемо.
    const frame = mxCommand(0xa1, [0x00]);
    expect(Array.from(frame)).toEqual([
      0x22, 0x21,
      0xa1,
      0x00,
      0x01, 0x00,
      0x00,
      crc8([0x00]),
      0xff,
    ]);
  });

  it('writes payload length little-endian across two bytes', () => {
    const frame = mxCommand(0xa9, new Uint8Array(300));
    expect(frame[4]).toBe(300 & 0xff);
    expect(frame[5]).toBe(1);
    expect(frame.length).toBe(308);
    expect(frame[frame.length - 1]).toBe(0xff);
  });

  it('computes CRC over the payload only, never over the header', () => {
    const payload = [0x12, 0x34, 0x56];
    const frame = mxCommand(0xa2, payload);
    expect(frame[frame.length - 2]).toBe(crc8(payload));
  });
});

describe('command helpers', () => {
  it('asks for status', () => {
    expect(mxStatus()[2]).toBe(MX_CMD.STATUS);
  });
  it('sets intensity as a single byte', () => {
    const f = mxIntensity(0x5d);
    expect(f[2]).toBe(MX_CMD.INTENSITY);
    expect(f[6]).toBe(0x5d);
  });
  it('encodes the print request as line count LE, 0x30, mode', () => {
    const f = mxPrint(500, MX_MODE_1BPP);
    expect(f[2]).toBe(MX_CMD.PRINT);
    expect(f[4]).toBe(4);            // payload завдовжки 4 байти
    expect(f[6]).toBe(500 & 0xff);
    expect(f[7]).toBe(500 >> 8);
    expect(f[8]).toBe(0x30);
    expect(f[9]).toBe(0x00);
  });
  it('defaults the print mode to one bit per pixel', () => {
    expect(mxPrint(10)[9]).toBe(MX_MODE_1BPP);
  });
  it('flushes and cancels with a zero payload', () => {
    expect(mxFlush()[2]).toBe(MX_CMD.FLUSH);
    expect(mxFlush()[6]).toBe(0x00);
    expect(mxCancel()[2]).toBe(MX_CMD.CANCEL);
  });
});

describe('mxParseNotification', () => {
  it('pulls out the command and payload', () => {
    const n = mxParseNotification(Uint8Array.from([0x22, 0x21, 0xa9, 0x00, 0x01, 0x00, 0x00, 0xff]));
    expect(n.cmd).toBe(MX_CMD.PRINT);
    expect(Array.from(n.payload)).toEqual([0x00]);
  });
  it('tolerates the non-zero fourth byte the printer sometimes sends', () => {
    const n = mxParseNotification(Uint8Array.from([0x22, 0x21, 0xa1, 0x03, 0x01, 0x00, 0x07, 0xff]));
    expect(n.cmd).toBe(MX_CMD.STATUS);
    expect(Array.from(n.payload)).toEqual([0x07]);
  });
  it('rejects anything without the preamble', () => {
    expect(mxParseNotification(null)).toBeNull();
    expect(mxParseNotification(Uint8Array.from([1, 2, 3]))).toBeNull();
    // класичний кадр не має проходити як MXW01
    expect(mxParseNotification(Uint8Array.from([0x51, 0x78, 0xa3, 0, 1, 0, 0, 0xff]))).toBeNull();
  });
});

describe('mxParseStatus', () => {
  const frame = (flag, err, battery, temp) => {
    const p = new Uint8Array(14);
    p[6] = 0; p[9] = battery == null ? 80 : battery; p[10] = temp == null ? 25 : temp;
    p[12] = flag; p[13] = err || 0;
    return p;
  };

  it('reads battery, temperature and the ok flag', () => {
    const st = mxParseStatus(frame(0, 0, 73, 31));
    expect(st.ok).toBe(true);
    expect(st.battery).toBe(73);
    expect(st.temperature).toBe(31);
    expect(st.errorCode).toBe(0);
  });

  it('reads the error code only when the flag says something is wrong', () => {
    expect(mxParseStatus(frame(0, 4)).errorCode).toBe(0);
    expect(mxParseStatus(frame(1, 4)).errorCode).toBe(4);
  });

  it('says "unknown" rather than zero when the packet is too short', () => {
    // Показати «0% батареї» замість «невідомо» — це збрехати користувачу.
    const short = new Uint8Array(8);
    const st = mxParseStatus(short);
    expect(st.battery).toBeNull();
    expect(st.temperature).toBeNull();
  });

  it('returns null for a packet that is not a status reply at all', () => {
    expect(mxParseStatus(null)).toBeNull();
    expect(mxParseStatus(new Uint8Array(3))).toBeNull();
  });
});

describe('mxStatusProblem', () => {
  const withError = code => ({ ok: false, errorCode: code });
  it('translates the documented error codes', () => {
    expect(mxStatusProblem(withError(1))).toMatch(/папір/i);
    expect(mxStatusProblem(withError(9))).toMatch(/папір/i);
    expect(mxStatusProblem(withError(4))).toMatch(/перегрів/i);
    expect(mxStatusProblem(withError(8))).toMatch(/батаре/i);
  });
  it('still says something useful for an undocumented code', () => {
    expect(mxStatusProblem(withError(42))).toMatch(/42/);
  });
  it('stays quiet when everything is fine', () => {
    expect(mxStatusProblem({ ok: true, errorCode: 0 })).toBeNull();
    expect(mxStatusProblem(null)).toBeNull();
  });
});

describe('mxPrepareImage', () => {
  it('pads a short job up to the minimum the printer accepts', () => {
    // Коротший буфер принтер просто не бере — це не оптимізація, а вимога.
    const rows = 10;
    const packed = new Uint8Array(rows * MX_ROW_BYTES).fill(0xff);
    const out = mxPrepareImage(packed, rows, 0);
    expect(out.data.length).toBe(MX_MIN_BYTES);
    expect(out.rows).toBe(MX_MIN_ROWS);
  });

  it('keeps the real image at the top and pads with blank rows below', () => {
    const rows = 2;
    const packed = new Uint8Array(rows * MX_ROW_BYTES).fill(0xff);
    const out = mxPrepareImage(packed, rows, 0);
    expect(out.data[0]).toBe(0xff);
    expect(out.data[rows * MX_ROW_BYTES - 1]).toBe(0xff);
    expect(out.data[rows * MX_ROW_BYTES]).toBe(0x00);
    expect(out.data[out.data.length - 1]).toBe(0x00);
  });

  it('appends the requested feed as blank rows — MXW01 has no feed command', () => {
    const rows = 200;
    const packed = new Uint8Array(rows * MX_ROW_BYTES).fill(0xff);
    const out = mxPrepareImage(packed, rows, 56);
    expect(out.rows).toBe(256);
    expect(out.data.length).toBe(256 * MX_ROW_BYTES);
    expect(out.data[rows * MX_ROW_BYTES]).toBe(0x00);
  });

  it('does not shrink a job that is already long enough', () => {
    const rows = 300;
    const packed = new Uint8Array(rows * MX_ROW_BYTES).fill(0xff);
    expect(mxPrepareImage(packed, rows, 0).rows).toBe(300);
  });

  it('never reads past the declared rows even if the buffer is longer', () => {
    // Полотно живе довше за одне завдання, тож у буфері цілком може лежати
    // хвіст від попереднього малюнка — він не має потрапити в друк.
    const packed = new Uint8Array(500 * MX_ROW_BYTES).fill(0xff);
    const out = mxPrepareImage(packed, 20, 0);
    expect(out.rows).toBe(MX_MIN_ROWS);
    expect(out.data[20 * MX_ROW_BYTES - 1]).toBe(0xff);
    expect(out.data[20 * MX_ROW_BYTES]).toBe(0x00);
    expect(out.data[out.data.length - 1]).toBe(0x00);
  });
});

describe('mxDataChunks', () => {
  it('splits the image stream into fixed-size pieces', () => {
    const data = Uint8Array.from({ length: 10 }, (_, i) => i);
    expect(mxDataChunks(data, 4).map(c => Array.from(c)))
      .toEqual([[0, 1, 2, 3], [4, 5, 6, 7], [8, 9]]);
  });
  it('preserves every byte', () => {
    const data = new Uint8Array(MX_MIN_BYTES);
    expect(mxDataChunks(data, 180).reduce((n, c) => n + c.length, 0)).toBe(MX_MIN_BYTES);
  });
});

describe('bit packing shared with the classic driver', () => {
  it('uses the same least-significant-bit-first order MXW01 expects', () => {
    // Обидві родини чекають, що піксель 0 — це біт 0. Саме тому packBits
    // спільний, а не продубльований під кожен драйвер.
    const bits = new Uint8Array(384);
    bits[0] = 1;
    const packed = packBits(bits, 384, 1);
    expect(packed.length).toBe(MX_ROW_BYTES);
    expect(packed[0]).toBe(0x01);
  });
});
