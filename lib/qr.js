/* ════════════════════════════════════════════════════════════════════════
   ГЕНЕРАТОР QR-КОДІВ

   Свій, а не з CDN: сторінка має працювати офлайн і не тягнути чужі скрипти.
   Байтовий режим (UTF-8), версії 1–10, усі чотири рівні корекції.
   Для наших задач — посилання на гру, контакти, підписи до наклейок — цього
   з головою: версія 10 на рівні L тримає ~270 байт.

   Повертає квадратну матрицю 0/1, де 1 = чорний модуль. Малювання — не тут:
   матрицю масштабує вже сторінка, під ширину принтера або наклейки.
   ════════════════════════════════════════════════════════════════════════ */

/* Скільки байтів даних і скільки корекції в кожному блоці.
   На версію та рівень: [байтів корекції на блок, блоків1, даних1, блоків2, даних2].
   Друга група є не всюди — там, де блоки різного розміру. */
const EC_TABLE = {
  L: [null,
    [7,1,19], [10,1,34], [15,1,55], [20,1,80], [26,1,108],
    [18,2,68], [20,2,78], [24,2,97], [30,2,116], [18,2,68,2,69]],
  M: [null,
    [10,1,16], [16,1,28], [26,1,44], [18,2,32], [24,2,43],
    [16,4,27], [18,4,31], [22,2,38,2,39], [22,3,36,2,37], [26,4,43,1,44]],
  Q: [null,
    [13,1,13], [22,1,22], [18,2,17], [26,2,24], [18,2,15,2,16],
    [24,4,19], [18,2,14,4,15], [22,4,18,2,19], [20,4,16,4,17], [24,6,19,2,20]],
  H: [null,
    [17,1,9], [28,1,16], [22,2,13], [16,4,9], [22,2,11,2,12],
    [28,4,15], [26,4,13,1,14], [26,4,14,2,15], [24,4,12,4,13], [28,6,15,2,16]],
};

/* Центри вирівнювальних квадратів. Версія 1 їх не має взагалі. */
const ALIGN_POS = [null, [], [6,18], [6,22], [6,26], [6,30], [6,34],
  [6,22,38], [6,24,42], [6,26,46], [6,28,50]];

const EC_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };
const MAX_VERSION = 10;

/* ── Арифметика в полі GF(256), примітивний многочлен 0x11D ── */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/* Многочлен-генератор для коду Ріда — Соломона на n байтів корекції. */
function rsGenerator(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/* Байти корекції для одного блоку даних. */
function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Uint8Array(ecLen);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ res[0];
    res.copyWithin(0, 1);
    res[ecLen - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecLen; j++) res[j] ^= gfMul(gen[j + 1], factor);
    }
  }
  return res;
}

/* ── Потік бітів ── */
function BitStream() { this.bits = []; }
BitStream.prototype.push = function (value, length) {
  for (let i = length - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
};
BitStream.prototype.toBytes = function () {
  const out = new Uint8Array(Math.ceil(this.bits.length / 8));
  for (let i = 0; i < this.bits.length; i++) {
    if (this.bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
  }
  return out;
};

function utf8Bytes(text) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
  return Uint8Array.from(unescape(encodeURIComponent(String(text))), c => c.charCodeAt(0));
}

const blockPlan = spec => (spec.length > 3
  ? [{ blocks: spec[1], data: spec[2] }, { blocks: spec[3], data: spec[4] }]
  : [{ blocks: spec[1], data: spec[2] }]);

const dataCapacity = spec => blockPlan(spec).reduce((sum, g) => sum + g.blocks * g.data, 0);

/* Найменша версія, у яку влізе стільки байтів. */
function pickVersion(byteLen, level) {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const spec = EC_TABLE[level][v];
    const countBits = v < 10 ? 8 : 16;
    const need = 4 + countBits + byteLen * 8;
    if (need <= dataCapacity(spec) * 8) return v;
  }
  return null;
}

/* ── Дані → кодові слова з корекцією, у правильному чергуванні ── */
function buildCodewords(bytes, version, level) {
  const spec = EC_TABLE[level][version];
  const capacity = dataCapacity(spec);
  const countBits = version < 10 ? 8 : 16;

  const bs = new BitStream();
  bs.push(0b0100, 4);                 // режим: байти
  bs.push(bytes.length, countBits);
  for (let i = 0; i < bytes.length; i++) bs.push(bytes[i], 8);
  // термінатор до чотирьох нулів, далі добиваємо до цілого байта
  const room = capacity * 8 - bs.bits.length;
  bs.push(0, Math.min(4, room));
  while (bs.bits.length % 8 !== 0) bs.bits.push(0);

  const data = Array.from(bs.toBytes());
  const PAD = [0xec, 0x11];           // стандартний наповнювач
  for (let i = 0; data.length < capacity; i++) data.push(PAD[i % 2]);

  // ріжемо на блоки, кожному рахуємо свою корекцію
  const ecLen = spec[0];
  const dataBlocks = [], ecBlocks = [];
  let at = 0;
  blockPlan(spec).forEach(group => {
    for (let b = 0; b < group.blocks; b++) {
      const block = data.slice(at, at + group.data);
      at += group.data;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, ecLen));
    }
  });

  // чергування: спершу по одному байту з кожного блоку даних, потім те саме з корекції
  const out = [];
  const maxData = Math.max.apply(null, dataBlocks.map(b => b.length));
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < dataBlocks.length; b++) if (i < dataBlocks[b].length) out.push(dataBlocks[b][i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (let b = 0; b < ecBlocks.length; b++) out.push(ecBlocks[b][i]);
  }
  return Uint8Array.from(out);
}

/* ── Каркас матриці ──
   reserved позначає службові модулі, куди дані класти не можна. */
function buildTemplate(version) {
  const size = 17 + 4 * version;
  const m = [], reserved = [];
  for (let r = 0; r < size; r++) {
    m.push(new Uint8Array(size));
    reserved.push(new Uint8Array(size));
  }

  const setFinder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r, cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                       (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        m[rr][cc] = (inRing || inCore) ? 1 : 0;
        reserved[rr][cc] = 1;
      }
    }
  };
  setFinder(0, 0);
  setFinder(0, size - 7);
  setFinder(size - 7, 0);

  // синхродоріжки
  for (let i = 8; i < size - 8; i++) {
    const bit = i % 2 === 0 ? 1 : 0;
    m[6][i] = bit; reserved[6][i] = 1;
    m[i][6] = bit; reserved[i][6] = 1;
  }

  // Вирівнювальні квадрати. Пропускаємо РІВНО три — ті, що потрапили б на
  // кутові маркери. Спокусливо відсіювати їх перевіркою «чи місце вже зайняте»,
  // але тоді заразом злітають і квадрати, що стоять на синхродоріжці, — а вони
  // законні. Наслідок буде тихий: код зібрався, а даних у ньому на 40 біт
  // більше, ніж має бути, і жоден сканер його не прочитає.
  const pos = ALIGN_POS[version];
  const last = pos.length - 1;
  for (let a = 0; a < pos.length; a++) {
    for (let b = 0; b < pos.length; b++) {
      const onFinder = (a === 0 && b === 0) || (a === 0 && b === last) || (a === last && b === 0);
      if (onFinder) continue;
      const row = pos[a], col = pos[b];
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const edge = Math.max(Math.abs(r), Math.abs(c));
          m[row + r][col + c] = (edge === 1) ? 0 : 1;
          reserved[row + r][col + c] = 1;
        }
      }
    }
  }

  // завжди чорний модуль
  m[size - 8][8] = 1;
  reserved[size - 8][8] = 1;

  // місця під інформацію про формат
  for (let i = 0; i < 9; i++) {
    if (!reserved[8][i]) reserved[8][i] = 1;
    if (!reserved[i][8]) reserved[i][8] = 1;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = 1;
    reserved[size - 1 - i][8] = 1;
  }

  // з версії 7 додається блок з номером версії
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (bits >> i) & 1;
      const r = Math.floor(i / 3), c = i % 3;
      m[r][size - 11 + c] = bit; reserved[r][size - 11 + c] = 1;
      m[size - 11 + c][r] = bit; reserved[size - 11 + c][r] = 1;
    }
  }

  return { matrix: m, reserved, size };
}

/* BCH-коди службових полів — звичайний зсувний регістр із діленням на
   многочлен-генератор. */
function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
  return ((version << 12) | rem) & 0x3ffff;
}

function formatBits(level, mask) {
  const data = (EC_BITS[level] << 3) | mask;
  let rem = data << 10;
  for (let i = 0; i < 5; i++) {
    if (rem & (1 << (14 - i))) rem ^= 0x537 << (4 - i);
  }
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

/* ── Розкладка даних змійкою від правого нижнього кута ── */
function placeData(tpl, codewords) {
  const { matrix, reserved, size } = tpl;
  let bitIndex = 0;
  const nextBit = () => {
    const i = bitIndex >> 3;
    const bit = i < codewords.length ? (codewords[i] >> (7 - (bitIndex & 7))) & 1 : 0;
    bitIndex++;
    return bit;
  };
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;          // шостий стовпець зайнятий синхродоріжкою
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (let c = 0; c < 2; c++) {
        const col = right - c;
        if (reserved[row][col]) continue;
        matrix[row][col] = nextBit();
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  r => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(tpl, maskIndex, level) {
  const { matrix, reserved, size } = tpl;
  const out = matrix.map(row => Uint8Array.from(row));
  const fn = MASKS[maskIndex];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!reserved[r][c] && fn(r, c)) out[r][c] ^= 1;
    }
  }
  // інформація про формат — уже після маскування, вона маскується окремо
  // Біти формату кладуться СТАРШИМ УПЕРЕД: позиція 0 отримує біт 14.
  // Переплутати напрямок — і код виглядає бездоганно, але не читається жодним
  // сканером: рівень корекції та маску він прочитає навиворіт.
  const fmt = formatBits(level, maskIndex);
  for (let i = 0; i < 15; i++) {
    const bit = (fmt >> (14 - i)) & 1;

    // копія навколо верхнього лівого маркера, в обхід синхродоріжки
    if (i < 6) out[8][i] = bit;
    else if (i === 6) out[8][7] = bit;
    else if (i === 7) out[8][8] = bit;
    else if (i === 8) out[7][8] = bit;
    else out[14 - i][8] = bit;

    // друга копія: сім бітів угору вздовж лівого краю, решта — вправо по рядку 8.
    // Рівно сім, а не вісім: позицію (size-8, 8) займає постійно чорний модуль.
    if (i < 7) out[size - 1 - i][8] = bit;
    else out[8][size - 15 + i] = bit;
  }
  out[size - 8][8] = 1;
  return out;
}

/* Штрафи за стандартом: чим менше, тим краще читається сканером. */
function penalty(m) {
  const size = m.length;
  let score = 0;

  const runScore = run => (run >= 5 ? run - 2 : 0);
  for (let r = 0; r < size; r++) {
    let runH = 1, runV = 1;
    for (let c = 1; c < size; c++) {
      runH = m[r][c] === m[r][c - 1] ? runH + 1 : (score += runScore(runH), 1);
      runV = m[c][r] === m[c - 1][r] ? runV + 1 : (score += runScore(runV), 1);
    }
    score += runScore(runH) + runScore(runV);
  }

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  // небезпечна послідовність 1:1:3:1:1 — сканер сплутає її з кутовим маркером
  const BAD = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const BAD_REV = BAD.slice().reverse();
  const matches = (get, at) => {
    for (let i = 0; i < BAD.length; i++) if (get(at + i) !== BAD[i]) return false;
    return true;
  };
  const matchesRev = (get, at) => {
    for (let i = 0; i < BAD_REV.length; i++) if (get(at + i) !== BAD_REV[i]) return false;
    return true;
  };
  for (let r = 0; r < size; r++) {
    for (let c = 0; c + BAD.length <= size; c++) {
      const row = i => m[r][i], col = i => m[i][r];
      if (matches(row, c) || matchesRev(row, c)) score += 40;
      if (matches(col, c) || matchesRev(col, c)) score += 40;
    }
  }

  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c];
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/* ── Головна функція ──
   text — що кодуємо, level — 'L'|'M'|'Q'|'H' (за замовчуванням 'M':
   для друку на термопапері запас корекції не зайвий, папір мнеться). */
function encodeQR(text, level) {
  const lvl = EC_TABLE[level] ? level : 'M';
  const bytes = utf8Bytes(text == null ? '' : String(text));
  const version = pickVersion(bytes.length, lvl);
  if (!version) {
    throw new Error('Забагато тексту для QR: ' + bytes.length + ' байт, вміщається щонайбільше ' +
      dataCapacity(EC_TABLE[lvl][MAX_VERSION]) + ' — скороти або зроби посилання коротшим');
  }

  const codewords = buildCodewords(bytes, version, lvl);
  const tpl = buildTemplate(version);
  placeData(tpl, codewords);

  let best = null, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = applyMask(tpl, mask, lvl);
    const score = penalty(candidate);
    if (score < bestScore) { bestScore = score; best = candidate; }
  }
  return { matrix: best, size: best.length, version, level: lvl };
}

/* Матриця + тиха зона, одним масивом рядків. Тиха зона обов'язкова:
   без неї сканер часто просто не бачить код. */
function encodeQRWithQuiet(text, level, quiet) {
  const q = quiet == null ? 4 : quiet;
  const { matrix, version, level: lvl } = encodeQR(text, level);
  const size = matrix.length + q * 2;
  const out = [];
  for (let r = 0; r < size; r++) {
    const row = new Uint8Array(size);
    if (r >= q && r < size - q) row.set(matrix[r - q], q);
    out.push(row);
  }
  return { matrix: out, size, version, level: lvl };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    encodeQR, encodeQRWithQuiet, MAX_VERSION,
    crcHelpers: { gfMul, rsGenerator, rsEncode },
    formatBits, versionBits, pickVersion, buildCodewords, penalty,
  };
}
