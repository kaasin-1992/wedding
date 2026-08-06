import { describe, it, expect } from 'vitest';
import { encodeQR, encodeQRWithQuiet, formatBits, versionBits, pickVersion, buildCodewords, MAX_VERSION } from '../lib/qr.js';

const rowsOf = m => m.map(r => Array.from(r).join(''));

describe('versionBits', () => {
  // Значення прямо з таблиці стандарту — саме ті вісімнадцять бітів, які
  // сканер шукає в кутах коду, починаючи з сьомої версії.
  it('matches the values published in the standard', () => {
    expect(versionBits(7)).toBe(0x07c94);
    expect(versionBits(8)).toBe(0x085bc);
    expect(versionBits(9)).toBe(0x09a99);
    expect(versionBits(10)).toBe(0x0a4d3);
  });
});

describe('formatBits', () => {
  // Теж табличні: рівень корекції + маска, закодовані BCH і зXORені з 0x5412.
  it('matches the values published in the standard', () => {
    expect(formatBits('L', 0)).toBe(0b111011111000100);
    expect(formatBits('L', 7)).toBe(0b110100101110110);
    expect(formatBits('M', 0)).toBe(0b101010000010010);
    expect(formatBits('M', 7)).toBe(0b100101010100000);
    expect(formatBits('Q', 0)).toBe(0b011010101011111);
    expect(formatBits('H', 0)).toBe(0b001011010001001);
  });
  it('never produces the all-zero pattern', () => {
    for (const lvl of ['L', 'M', 'Q', 'H']) {
      for (let m = 0; m < 8; m++) expect(formatBits(lvl, m)).not.toBe(0);
    }
  });
});

describe('pickVersion', () => {
  it('picks the smallest version that fits', () => {
    // У першу версію на рівні M влазить 16 слів даних, але чотири біти йдуть
    // на позначку режиму й вісім на довжину — тож самого тексту лишається 14 байтів.
    expect(pickVersion(5, 'M')).toBe(1);
    expect(pickVersion(14, 'M')).toBe(1);
    expect(pickVersion(15, 'M')).toBe(2);
  });
  it('needs a bigger code for stronger correction', () => {
    expect(pickVersion(7, 'H')).toBe(1);
    expect(pickVersion(8, 'H')).toBeGreaterThan(1);
    // що сильніша корекція, то менше влазить у ту саму версію
    expect(pickVersion(17, 'L')).toBe(1);
    expect(pickVersion(17, 'M')).toBeGreaterThan(1);
  });
  it('gives up past the largest supported version', () => {
    expect(pickVersion(5000, 'L')).toBeNull();
  });
});

describe('buildCodewords', () => {
  it('encodes "HELLO" byte-for-byte as the standard prescribes', () => {
    // 0100 — режим байтів, 00000101 — п'ять байтів, далі самі байти,
    // термінатор, і добивка чергуванням EC 11 до шістнадцяти слів даних.
    const bytes = Uint8Array.from([0x48, 0x45, 0x4c, 0x4c, 0x4f]);
    const cw = buildCodewords(bytes, 1, 'M');
    expect(Array.from(cw.slice(0, 16))).toEqual([
      0x40, 0x54, 0x84, 0x54, 0xc4, 0xc4, 0xf0,
      0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec,
    ]);
    expect(cw.length).toBe(26);   // 16 даних + 10 корекції для версії 1 рівня M
  });

  it('fills exactly the capacity for every version and level', () => {
    const totals = { 1: 26, 2: 44, 3: 70, 4: 100, 5: 134, 6: 172, 7: 196, 8: 242, 9: 292, 10: 346 };
    for (let v = 1; v <= MAX_VERSION; v++) {
      for (const lvl of ['L', 'M', 'Q', 'H']) {
        expect(buildCodewords(Uint8Array.from([65]), v, lvl).length).toBe(totals[v]);
      }
    }
  });
});

describe('encodeQR structure', () => {
  it('sizes the matrix as 17 + 4 × version', () => {
    for (let v = 1; v <= MAX_VERSION; v++) {
      const text = 'a'.repeat([0, 1, 20, 40, 60, 90, 120, 145, 180, 220, 260][v]);
      const r = encodeQR(text, 'L');
      expect(r.size).toBe(17 + 4 * r.version);
      expect(r.matrix.length).toBe(r.size);
    }
  });

  it('puts a finder pattern in all three corners', () => {
    const { matrix, size } = encodeQR('тест', 'M');
    const finderAt = (r0, c0) => {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          const ring = r === 0 || r === 6 || c === 0 || c === 6;
          const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          if (matrix[r0 + r][c0 + c] !== (ring || core ? 1 : 0)) return false;
        }
      }
      return true;
    };
    expect(finderAt(0, 0)).toBe(true);
    expect(finderAt(0, size - 7)).toBe(true);
    expect(finderAt(size - 7, 0)).toBe(true);
  });

  it('alternates the timing patterns', () => {
    const { matrix, size } = encodeQR('тест', 'M');
    for (let i = 8; i < size - 8; i++) {
      expect(matrix[6][i]).toBe(i % 2 === 0 ? 1 : 0);
      expect(matrix[i][6]).toBe(i % 2 === 0 ? 1 : 0);
    }
  });

  it('always sets the dark module', () => {
    for (const lvl of ['L', 'M', 'Q', 'H']) {
      const { matrix, size } = encodeQR('привіт', lvl);
      expect(matrix[size - 8][8]).toBe(1);
    }
  });

  it('keeps the light/dark balance in a readable range', () => {
    const { matrix, size } = encodeQR('https://лютевесілля.укр/kadr', 'M');
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += matrix[r][c];
    const share = dark / (size * size);
    expect(share).toBeGreaterThan(0.35);
    expect(share).toBeLessThan(0.65);
  });

  it('is deterministic', () => {
    const a = rowsOf(encodeQR('Катя & Діма', 'Q').matrix);
    const b = rowsOf(encodeQR('Катя & Діма', 'Q').matrix);
    expect(a).toEqual(b);
  });

  it('handles Cyrillic and emoji as UTF-8', () => {
    expect(() => encodeQR('Стіл №5 🎂', 'M')).not.toThrow();
    // кирилиця — два байти на символ, тож код виходить більший за латиницю
    expect(encodeQR('ааааааааааааааааааааа', 'M').version)
      .toBeGreaterThan(encodeQR('aaaaaaaaaaaaaaaaaaaaa', 'M').version);
  });

  it('explains itself in Ukrainian when the text will not fit', () => {
    expect(() => encodeQR('я'.repeat(1000), 'H')).toThrow(/Забагато тексту/);
  });
});

describe('encodeQRWithQuiet', () => {
  it('adds a quiet zone on every side', () => {
    const { matrix, size } = encodeQRWithQuiet('тест', 'M', 4);
    expect(size).toBe(encodeQR('тест', 'M').size + 8);
    for (let i = 0; i < size; i++) {
      expect(matrix[0][i]).toBe(0);
      expect(matrix[size - 1][i]).toBe(0);
      expect(matrix[i][0]).toBe(0);
      expect(matrix[i][size - 1]).toBe(0);
    }
  });
  it('defaults to the four-module quiet zone the spec requires', () => {
    expect(encodeQRWithQuiet('тест', 'M').size).toBe(encodeQR('тест', 'M').size + 8);
  });
});

describe('golden matrices', () => {
  // Ці зразки звірені модуль за модулем з еталонною реалізацією і прочитані
  // справжнім декодером. Тримаємо їх тут, щоб мовчазна зміна в укладанні
  // матриці не проїхала непоміченою: код, що не читається сканером, виглядає
  // рівно так само, як робочий.
  const golden = [
    { text: 'HELLO', level: 'M', version: 1, rows: ['18qrj','mwch','wqql','wrbx','wr4t','my4h','18prz','64g','okqh','51kf','vdki','142xc','84p2','5vv','18qkq','muci','wrcl','woaz','wqk8','mvgg','18p2t'] },
    { text: 'https://лютевесілля.укр', level: 'L', version: 3, rows: ['8tb62n','4jesld','6gv4gt','6gm82l','6hdr31','4j4ytd','8tz2pr','voxs','7bl306','1u02l5','1h7t3i','b82ly','53sduj','5p6zn4','72cv33','394u7e','2klzhu','1yxjcp','5hkdpf','pc99v','67ysxg','16s5z','8u32he','4ihjj0','6gr3sj','6hg9em','6gfnhp','4j62au','8uci3a'] },
    { text: 'Стіл 3', level: 'H', version: 2, rows: ['jutfj','a7k1t','ekv31','ekzfh','el3kt','a7zup','jvfy7','buo','33kce','1dx36','4kstw','1mgue','jv4dr','42iv5','fhcsq','2agkc','fhszb','29le','jvbkk','a7qc5','ejr3q','ejg1k','ekg6j','a5css','jtrhx'] },
  ];

  golden.forEach(g => {
    it('reproduces the verified code for ' + JSON.stringify(g.text) + ' at level ' + g.level, () => {
      const r = encodeQR(g.text, g.level);
      expect(r.version).toBe(g.version);
      const actual = r.matrix.map(row => parseInt(Array.from(row).join(''), 2).toString(36));
      expect(actual).toEqual(g.rows);
    });
  });
});
