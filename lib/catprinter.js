/* ════════════════════════════════════════════════════════════════════════
   ПРОТОКОЛ BLE МІНІ-ПРИНТЕРІВ РОДИНИ «cat printer»
   (GB01, GB02, GB03, GT01, YT01, MX05…MX10 — усі говорять однаково)

   Пристрій рекламує сервіс 0xAF30, а працює через сервіс 0xAE30:
     0xAE01 — сюди ПИШЕМО команди (write without response)
     0xAE02 — звідси ЧИТАЄМО нотифікації про стан

   Кадр однієї команди:
     51 78 <cmd> <type> <len_lo> <len_hi> <payload…> <crc8(payload)> FF
   де type=0 для команд від нас, crc8 — поліном 0x07 без інверсій.

   Тут ЛИШЕ чиста логіка без DOM: рахунок CRC, збирання кадрів, корекція
   яскравості, дизеринг і упаковка бітів. Усе, що чіпає canvas чи Bluetooth,
   живе в printer/index.html — щоб оце можна було ганяти тестами у vitest.
   ════════════════════════════════════════════════════════════════════════ */

/* ── Ідентифікатори BLE ── */
const CAT_ADV_SRV   = 0xaf30;   // сервіс у рекламному пакеті — по ньому шукаємо принтер
const CAT_PRINT_SRV = 0xae30;   // робочий сервіс
const CAT_TX_CHAR   = 0xae01;   // ми → принтер
const CAT_RX_CHAR   = 0xae02;   // принтер → ми

/* Ті самі ідентифікатори повним рядком. Специфікація дозволяє передавати
   16-бітні UUID числом, і Chrome це приймає, але не кожна реалізація
   Web Bluetooth така сама щедра — а падає вона одразу, ще до показу списку
   пристроїв. Тому маємо під рукою обидві форми й пробуємо їх по черзі. */
const uuid16 = short => '0000' + short.toString(16).padStart(4, '0') + '-0000-1000-8000-00805f9b34fb';
const CAT_ADV_SRV_STR   = uuid16(CAT_ADV_SRV);
const CAT_PRINT_SRV_STR = uuid16(CAT_PRINT_SRV);

/* Ширина друку в точках. Це фізика термоголовки, а не налаштування:
   384 точки при 8 точках на міліметр = рівно 48 мм друкованої смуги
   (сама стрічка 58 мм, краї недруковані). Усе, що малюємо, малюємо такої ширини. */
const PRINT_WIDTH  = 384;
const ROW_BYTES    = PRINT_WIDTH / 8;   // 48 байт на один рядок точок
const DOTS_PER_MM  = 8;                 // однаково по горизонталі й вертикалі
const PRINT_WIDTH_MM = PRINT_WIDTH / DOTS_PER_MM;   // 48

const CMD = {
  RETRACT:      0xa0,   // втягнути папір, payload: uint16 LE — скільки рядків
  FEED:         0xa1,   // подати папір,   payload: uint16 LE
  BITMAP:       0xa2,   // один рядок точок, payload: 48 байт
  STATE:        0xa3,   // запит стану
  SET_DPI:      0xa4,
  LATTICE:      0xa6,   // «решітка» — службова преамбула/фіналка друку
  DEVICE_INFO:  0xa8,   // запит інформації про пристрій (модель, батарея)
  UPDATE:       0xa9,
  ENERGY:       0xaf,   // щільність, payload: uint32 LE
  SPEED:        0xbd,   // швидкість, payload: 1 байт
  APPLY_ENERGY: 0xbe,   // застосувати виставлену щільність
};

/* Магічні payload'и «решітки». Рідний застосунок обгортає ними кожне
   завдання друку, і на частині моделей без них друк виходить блідим або
   рваним. На інших — різниці нема, тому в застосунку це вимикається одним
   перемикачем, якщо раптом зашкодить. */
const LATTICE_START = [0xaa, 0x55, 0x17, 0x38, 0x44, 0x5f, 0x5f, 0x5f, 0x44, 0x38, 0x2c];
const LATTICE_END   = [0xaa, 0x55, 0x17, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x17];

/* Розумні значення за замовчуванням, підібрані під звичайний термопапір. */
const DEF_SPEED  = 32;
const DEF_ENERGY = 24000;
const DEF_FEED   = 80;    // скільки подати в кінці, щоб надруковане виїхало з-під кришки

/* ── CRC-8, поліном 0x07 ──────────────────────────────────────────────── */
function crc8(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] & 0xff;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc & 0xff;
}

/* ── Збирання кадру команди ───────────────────────────────────────────── */
function makeCommand(cmd, payload, type) {
  const body = payload instanceof Uint8Array ? payload : Uint8Array.from(payload || []);
  const frame = new Uint8Array(body.length + 8);
  frame[0] = 0x51;
  frame[1] = 0x78;
  frame[2] = cmd & 0xff;
  frame[3] = (type || 0) & 0xff;
  frame[4] = body.length & 0xff;
  frame[5] = (body.length >> 8) & 0xff;
  frame.set(body, 6);
  frame[body.length + 6] = crc8(body);
  frame[body.length + 7] = 0xff;
  return frame;
}

/* Дрібні хелпери під конкретні команди — щоб у застосунку не було голих байтів. */
const cmdSpeed       = speed  => makeCommand(CMD.SPEED, [speed & 0xff]);
const cmdEnergy      = energy => makeCommand(CMD.ENERGY, [energy & 0xff, (energy >> 8) & 0xff, (energy >> 16) & 0xff, (energy >> 24) & 0xff]);
const cmdApplyEnergy = ()     => makeCommand(CMD.APPLY_ENERGY, [0x01]);
const cmdFeed        = lines  => makeCommand(CMD.FEED, [lines & 0xff, (lines >> 8) & 0xff]);
const cmdRetract     = lines  => makeCommand(CMD.RETRACT, [lines & 0xff, (lines >> 8) & 0xff]);
const cmdState       = ()     => makeCommand(CMD.STATE, [0x01]);
const cmdDeviceInfo  = ()     => makeCommand(CMD.DEVICE_INFO, [0x01]);
const cmdLattice     = start  => makeCommand(CMD.LATTICE, start ? LATTICE_START : LATTICE_END);

/* ── Стан принтера з нотифікації 0xAE02 ───────────────────────────────────
   Прилітає кадр того ж формату; для 0xA3 у payload перший байт — бітова маска.
   Повертаємо null, якщо це не відповідь про стан — щоб той, хто викликає,
   не сплутав «немає даних» із «усе гаразд». */
function parseStatus(bytes) {
  if (!bytes || bytes.length < 8) return null;
  if (bytes[0] !== 0x51 || bytes[1] !== 0x78) return null;
  if (bytes[2] !== CMD.STATE) return null;
  const flags = bytes[6];
  return {
    outOfPaper: !!(flags & 0x01),
    coverOpen:  !!(flags & 0x02),
    overheat:   !!(flags & 0x04),
    lowPower:   !!(flags & 0x08),
    paused:     !!(flags & 0x10),
    busy:       !!(flags & 0x80),
  };
}

/* Проблеми, які варто показати людині, — українською і по-людськи.
   Порядок важливий: показуємо найголовнішу причину, а не всі одразу. */
function statusProblem(st) {
  if (!st) return null;
  if (st.outOfPaper) return 'Скінчився папір';
  if (st.coverOpen)  return 'Відкрита кришка';
  if (st.overheat)   return 'Принтер перегрівся — дай йому хвилину охолонути';
  if (st.lowPower)   return 'Сідає батарея — постав на зарядку';
  return null;
}

/* ── Яскравість зображення ────────────────────────────────────────────────
   На вхід — RGBA з ImageData. Прозорі місця треба зводити на БІЛЕ, а не на
   чорне: інакше все, що ми не намалювали на canvas, надрукується суцільною
   чорною плямою і зжере пів рулона. */
function toGray(rgba, len) {
  const n = len || (rgba.length / 4) | 0;
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const a = rgba[p + 3] / 255;
    const lum = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    gray[i] = 255 + (lum - 255) * a;   // накладаємо на білий аркуш
  }
  return gray;
}

/* Корекція. brightness/contrast — від -100 до 100, gamma — 0.2…3
   (більша гама = світліше), invert — негатив.
   Повертаємо НОВИЙ масив: вхідний лишається цілим, щоб попередній перегляд
   можна було перемальовувати з тих самих вихідних даних без накопичення. */
function adjust(gray, opts) {
  const o = opts || {};
  const brightness = (o.brightness || 0) * 2.55;
  const c = Math.max(-100, Math.min(100, o.contrast || 0));
  const cf = (259 * (c + 255)) / (255 * (259 - c));
  const gamma = o.gamma > 0 ? o.gamma : 1;
  const invert = !!o.invert;
  const out = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    let v = gray[i] + brightness;
    v = cf * (v - 128) + 128;
    if (gamma !== 1) v = 255 * Math.pow(Math.max(0, v) / 255, 1 / gamma);
    if (invert) v = 255 - v;
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}

/* Авто-рівні: розтягуємо гістограму між 2-м і 98-м процентилями.
   Саме цього не вистачає фото з телефона — вони «сірі» й після порогу
   перетворюються на кашу. Хвости відрізаємо, щоб одна темна пляма
   чи відблиск не задавали діапазон на все фото. */
function autoLevels(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[Math.round(gray[i]) & 0xff]++;
  const cut = Math.max(1, Math.floor(gray.length * 0.02));
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= cut) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= cut) { hi = v; break; } }
  if (hi - lo < 8) return Float32Array.from(gray);   // майже однотонне — не чіпаємо
  const k = 255 / (hi - lo);
  const out = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    const v = (gray[i] - lo) * k;
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}

/* ── Дизеринг ─────────────────────────────────────────────────────────────
   Принтер уміє лише «крапка є / крапки нема». Тупий поріг перетворює фото
   на чорні плями — саме тому в рідному застосунку воно й негарне. Розсіювання
   похибки дає видиму напівтоновість.
   Повертаємо Uint8Array, де 1 = друкувати крапку. */

const BAYER8 = [
  [ 0, 32,  8, 40,  2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44,  4, 36, 14, 46,  6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [ 3, 35, 11, 43,  1, 33,  9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47,  7, 39, 13, 45,  5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

function dither(gray, width, height, mode, threshold) {
  const th = threshold == null ? 128 : threshold;
  const bits = new Uint8Array(width * height);

  if (mode === 'threshold') {
    for (let i = 0; i < bits.length; i++) bits[i] = gray[i] < th ? 1 : 0;
    return bits;
  }

  if (mode === 'bayer') {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        // матрицю 0..63 розтягуємо в 0..255 і зсуваємо навколо порога
        const limit = th + ((BAYER8[y & 7][x & 7] + 0.5) / 64 - 0.5) * 255;
        bits[i] = gray[i] < limit ? 1 : 0;
      }
    }
    return bits;
  }

  // Розсіювання похибки. Працюємо на копії, щоб не зіпсувати вхідні дані.
  const buf = Float32Array.from(gray);
  const atkinson = mode === 'atkinson';
  // dx, dy, вага
  const kernel = atkinson
    ? [[1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8]]
    : [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const old = buf[i];
      const black = old < th;
      bits[i] = black ? 1 : 0;
      const err = old - (black ? 0 : 255);
      for (let k = 0; k < kernel.length; k++) {
        const nx = x + kernel[k][0], ny = y + kernel[k][1];
        if (nx < 0 || nx >= width || ny >= height) continue;
        buf[ny * width + nx] += err * kernel[k][2];
      }
    }
  }
  return bits;
}

/* ── Упаковка в байти ─────────────────────────────────────────────────────
   Принтер чекає біти МОЛОДШИМ ВПЕРЕД: піксель x=0 — це біт 0 першого байта.
   Переплутати порядок = дзеркальні кляксами по 8 точок. */
function packBits(bits, width, height) {
  const rowBytes = Math.ceil(width / 8);
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    for (let x = 0; x < width; x++) {
      if (bits[y * width + x]) out[rowStart + (x >> 3)] |= 1 << (x & 7);
    }
  }
  return out;
}

function isBlankRow(packed, offset, rowBytes) {
  for (let i = 0; i < rowBytes; i++) if (packed[offset + i]) return false;
  return true;
}

/* ── Складання завдання друку ─────────────────────────────────────────────
   Повертаємо масив готових кадрів у порядку відправлення.

   Про порожні рядки. Спокуса — просто їх не слати (так роблять деякі
   бібліотеки), але тоді папір під ними не протягується і зникають усі
   відступи: текст злипається в кашу. Тому за замовчуванням шлемо ВСІ рядки,
   як є. Опція coalesceBlank замінює довгі порожні прогони однією командою
   подачі: друк помітно швидший, відступи зберігаються, але поведінка
   залежить від моделі — тому це вибір користувача, а не мовчазна магія. */
function buildJob(packed, opts) {
  const o = opts || {};
  const rowBytes = o.rowBytes || ROW_BYTES;
  const rows = o.rows != null ? o.rows : Math.floor(packed.length / rowBytes);
  const speed = o.speed != null ? o.speed : DEF_SPEED;
  const energy = o.energy != null ? o.energy : DEF_ENERGY;
  const feed = o.feed != null ? o.feed : DEF_FEED;
  const lattice = o.lattice !== false;
  const coalesce = o.coalesceBlank ? (o.coalesceMin || 16) : 0;

  const out = [];
  out.push(cmdSpeed(speed));
  out.push(cmdEnergy(energy));
  out.push(cmdApplyEnergy());
  if (lattice) out.push(cmdLattice(true));

  let y = 0;
  while (y < rows) {
    if (coalesce && isBlankRow(packed, y * rowBytes, rowBytes)) {
      let run = 1;
      while (y + run < rows && isBlankRow(packed, (y + run) * rowBytes, rowBytes)) run++;
      if (run >= coalesce) { out.push(cmdFeed(run)); y += run; continue; }
    }
    out.push(makeCommand(CMD.BITMAP, packed.subarray(y * rowBytes, (y + 1) * rowBytes)));
    y++;
  }

  if (lattice) out.push(cmdLattice(false));
  // фінальну подачу робимо на малій швидкості: на великій папір проскакує ривками
  if (feed > 0) { out.push(cmdSpeed(8)); out.push(cmdFeed(feed)); }
  return out;
}

/* ════════════════════════════════════════════════════════════════════════
   РУЛОНИ НАКЛЕЙОК
   Рулони бувають різні: наклейка може бути вужча за 48 мм друкованої смуги,
   а між наклейками є проміжок. Дешеві принтери цієї родини НЕ мають датчика
   міток — вони не знають, де закінчилась наклейка. Тому відлічуємо самі,
   у точках: 8 точок = 1 мм.

   Що з цього випливає для друку:
   • контент обмежуємо шириною наклейки і зсуваємо на її ліве поле;
   • висоту завдання обмежуємо висотою наклейки;
   • після наклейки подаємо рівно стільки, щоб стати на початок наступної.
   ════════════════════════════════════════════════════════════════════════ */

const mmToDots = mm => Math.round(mm * DOTS_PER_MM);
const dotsToMm = dots => dots / DOTS_PER_MM;

/* Ходові розміри. Це не догма — у застосунку можна завести свій розмір
   або зміряти наявний рулон. offsetMm — від лівого краю ДРУКОВАНОЇ смуги
   до лівого краю наклейки. */
const ROLL_PRESETS = [
  { id: 'full',    name: 'Суцільна стрічка 58 мм', widthMm: 48, heightMm: 0,  gapMm: 0, offsetMm: 0, continuous: true },
  { id: '40x30',   name: 'Наклейки 40 × 30 мм',    widthMm: 40, heightMm: 30, gapMm: 2, offsetMm: 4 },
  { id: '40x40',   name: 'Наклейки 40 × 40 мм',    widthMm: 40, heightMm: 40, gapMm: 2, offsetMm: 4 },
  { id: '40x60',   name: 'Наклейки 40 × 60 мм',    widthMm: 40, heightMm: 60, gapMm: 2, offsetMm: 4 },
  { id: '50x30',   name: 'Наклейки 50 × 30 мм',    widthMm: 48, heightMm: 30, gapMm: 2, offsetMm: 0 },
  { id: '30x20',   name: 'Наклейки 30 × 20 мм',    widthMm: 30, heightMm: 20, gapMm: 2, offsetMm: 9 },
  { id: '25x25',   name: 'Наклейки 25 × 25 мм',    widthMm: 25, heightMm: 25, gapMm: 2, offsetMm: 11 },
];

/* Геометрія рулона в точках. nudgeMm — ручна поправка вертикалі: якщо друк
   поволі сповзає з наклейки, тут його підтягують на пів міліметра. */
function rollLayout(roll) {
  const r = roll || {};
  const continuous = !!r.continuous || !(r.heightMm > 0);
  const widthPx = Math.max(8, Math.min(PRINT_WIDTH, mmToDots(r.widthMm || PRINT_WIDTH_MM)));
  const offsetPx = Math.max(0, Math.min(PRINT_WIDTH - widthPx, mmToDots(r.offsetMm || 0)));
  const heightPx = continuous ? 0 : Math.max(8, mmToDots(r.heightMm));
  const gapPx = continuous ? 0 : Math.max(0, mmToDots(r.gapMm || 0));
  return {
    continuous, widthPx, offsetPx, heightPx, gapPx,
    nudgePx: Math.round((r.nudgeMm || 0) * DOTS_PER_MM),
    pitchPx: continuous ? 0 : heightPx + gapPx,   // крок від початку однієї наклейки до наступної
  };
}

/* Скільки подати ПІСЛЯ надрукованого, щоб опинитись на початку наступної
   наклейки. Для суцільної стрічки — просто відступ, щоб надруковане виїхало
   з-під кришки й було що відірвати. */
function rollFeed(layout, printedRows, defaultFeed) {
  if (!layout || layout.continuous) return defaultFeed == null ? DEF_FEED : defaultFeed;
  const rest = layout.pitchPx - (printedRows % layout.pitchPx);
  return Math.max(0, rest + layout.nudgePx);
}

/* ── Замір наклейки по фото ───────────────────────────────────────────────
   Абсолютний розмір із фотографії не дізнатись — камера не знає масштабу.
   Тому поруч із наклейкою має лежати щось відоме: банківська картка (85.6 мм
   по довгій стороні — розмір стандартизований) або наша ж надрукована
   лінійка. Людина ставить дві мітки на еталон і дві на наклейку, а ми просто
   рахуємо пропорцію. Чесно й повторювано. */
const MEASURE_REFS = [
  { id: 'card',  name: 'Банківська картка (довга сторона)', mm: 85.6 },
  { id: 'card2', name: 'Банківська картка (коротка сторона)', mm: 53.98 },
  { id: 'ruler', name: 'Наша надрукована лінійка, мітка 40 мм', mm: 40 },
];

function measureByRef(refPx, refMm, targetPx) {
  if (!(refPx > 0) || !(refMm > 0)) return null;
  return Math.round((targetPx / refPx) * refMm * 10) / 10;
}

/* Калібрувальна лінійка: список позначок у точках від початку друку.
   Друкуємо її, прикладаємо до неї наклейку — і видно реальні міліметри,
   разом із тим, чи не бреше подача паперу. */
function rulerMarks(lengthMm) {
  const marks = [];
  for (let mm = 0; mm <= (lengthMm || 50); mm++) {
    marks.push({ mm, dots: mmToDots(mm), major: mm % 10 === 0, mid: mm % 5 === 0 });
  }
  return marks;
}

/* ── Нарізка на BLE-порції ────────────────────────────────────────────────
   ОСЬ ТУТ І ХОВАЄТЬСЯ «принтер відвалюється». Кадри пишуться через
   writeWithoutResponse, підтвердження нема — і якщо гнати їх без пауз,
   буфер принтера переповнюється, він мовчки рве з'єднання посеред друку.
   Тому склеюємо все в один потік і ріжемо рівними порціями, які застосунок
   шле з паузою. Межі кадрів рвати можна: принтер розбирає саме потік. */
function toChunks(packets, chunkSize) {
  const size = chunkSize || 128;
  let total = 0;
  for (let i = 0; i < packets.length; i++) total += packets[i].length;
  const stream = new Uint8Array(total);
  let at = 0;
  for (let i = 0; i < packets.length; i++) { stream.set(packets[i], at); at += packets[i].length; }
  const chunks = [];
  for (let i = 0; i < stream.length; i += size) chunks.push(stream.subarray(i, Math.min(i + size, stream.length)));
  return chunks;
}

/* Зручний повний конвеєр: ImageData → готові порції для відправки.
   Один вхід для всіх вкладок застосунку — і текст, і фото, і QR йдуть сюди. */
function imageDataToChunks(imageData, opts) {
  const o = opts || {};
  const w = imageData.width, h = imageData.height;
  let gray = toGray(imageData.data, w * h);
  if (o.autoLevels) gray = autoLevels(gray);
  gray = adjust(gray, o);
  const bits = dither(gray, w, h, o.dither || 'floyd', o.threshold);
  const packed = packBits(bits, w, h);
  return { packed, rows: h, rowBytes: Math.ceil(w / 8), chunks: toChunks(buildJob(packed, Object.assign({ rows: h, rowBytes: Math.ceil(w / 8) }, o)), o.chunkSize) };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CAT_ADV_SRV, CAT_PRINT_SRV, CAT_TX_CHAR, CAT_RX_CHAR,
    CAT_ADV_SRV_STR, CAT_PRINT_SRV_STR, uuid16,
    PRINT_WIDTH, ROW_BYTES, DOTS_PER_MM, PRINT_WIDTH_MM, CMD, LATTICE_START, LATTICE_END,
    DEF_SPEED, DEF_ENERGY, DEF_FEED,
    crc8, makeCommand, parseStatus, statusProblem,
    cmdSpeed, cmdEnergy, cmdApplyEnergy, cmdFeed, cmdRetract, cmdState, cmdDeviceInfo, cmdLattice,
    toGray, adjust, autoLevels, dither, packBits, isBlankRow,
    mmToDots, dotsToMm, ROLL_PRESETS, rollLayout, rollFeed,
    MEASURE_REFS, measureByRef, rulerMarks,
    buildJob, toChunks, imageDataToChunks,
  };
}
