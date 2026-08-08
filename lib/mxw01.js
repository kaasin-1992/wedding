/* ════════════════════════════════════════════════════════════════════════
   ПРОТОКОЛ MXW01

   Це НЕ діалект класичного «котячого» принтера, а інше залізо. Що спільного:
   ширина 384 точки, 48 байт на рядок, порядок бітів у байті (молодший = лівий
   піксель) і CRC-8 з поліномом 0x07. Тому packBits і crc8 беремо з
   lib/catprinter.js, а не переписуємо.

   Чим відрізняється:
     • преамбула пакета 22 21, а не 51 78;
     • три характеристики замість двох — зображення йде окремим потоком
       у AE03, а не рядок за рядком командами в AE01;
     • друк — це діалог, а не монолог: спершу питаємо стан, потім просимо
       дозвіл на N рядків, чекаємо «так», ллємо дані, кажемо «все» і чекаємо
       сигналу, що фізично додрукувало.

   Рамка команди (AE01):
     22 21 <cmd> 00 <len_lo> <len_hi> <payload…> <crc8(payload)> FF
   ════════════════════════════════════════════════════════════════════════ */

const MX_SRV    = 0xae30;   // той самий сервіс, що в класичного
const MX_CTRL   = 0xae01;   // команди
const MX_NOTIFY = 0xae02;   // відповіді
const MX_DATA   = 0xae03;   // сюди ллється саме зображення

const MX_WIDTH     = 384;
const MX_ROW_BYTES = 48;

/* Принтер не бере буфер, коротший за 4320 байт (90 рядків). Коротке
   завдання добиваємо нулями — заразом це й відступ, щоб надруковане
   виїхало з-під кришки. */
const MX_MIN_BYTES = 4320;
const MX_MIN_ROWS  = MX_MIN_BYTES / MX_ROW_BYTES;   // 90

const MX_CMD = {
  STATUS:    0xa1,
  INTENSITY: 0xa2,
  PRINT:     0xa9,
  COMPLETE:  0xaa,   // приходить від принтера, коли фізично додрукував
  BATTERY:   0xab,
  CANCEL:    0xac,
  FLUSH:     0xad,
  TYPE:      0xb0,
  VERSION:   0xb1,
};

/* Режими друку — четвертий байт у payload команди A9.

   УВАГА: опис протоколу тут суперечить сам собі. У таблиці команд приклад
   payload показаний як `line_count_le(2), 0x30, 0x01`, а в описі
   послідовності друку — `0x00` «для 1bpp». Виносимо обидва значення
   назовні: якщо принтер їде порожнім, це перше, що варто перемкнути. */
const MX_MODE_1BPP = 0x00;
const MX_MODE_ALT  = 0x01;

/* Рекомендована щільність із документації протоколу. */
const MX_DEF_INTENSITY = 0x5d;

/* ── Рамка команди ───────────────────────────────────────────────────────
   crc8 приходить з lib/catprinter.js (у браузері — глобальна, у тестах —
   через require). Алгоритм той самий, і він уже звірений з контрольним
   значенням стандарту, тож другої реалізації тут бути не повинно. */
const _crc8 = (typeof crc8 === 'function')
  ? crc8
  : require('./catprinter.js').crc8;

function mxCommand(cmd, payload) {
  const body = payload instanceof Uint8Array ? payload : Uint8Array.from(payload || []);
  const frame = new Uint8Array(body.length + 8);
  frame[0] = 0x22;
  frame[1] = 0x21;
  frame[2] = cmd & 0xff;
  frame[3] = 0x00;
  frame[4] = body.length & 0xff;
  frame[5] = (body.length >> 8) & 0xff;
  frame.set(body, 6);
  frame[body.length + 6] = _crc8(body);
  frame[body.length + 7] = 0xff;
  return frame;
}

const mxStatus    = ()    => mxCommand(MX_CMD.STATUS, [0x00]);
const mxBattery   = ()    => mxCommand(MX_CMD.BATTERY, [0x00]);
const mxVersion   = ()    => mxCommand(MX_CMD.VERSION, [0x00]);
const mxCancel    = ()    => mxCommand(MX_CMD.CANCEL, [0x00]);
const mxFlush     = ()    => mxCommand(MX_CMD.FLUSH, [0x00]);
const mxIntensity = v     => mxCommand(MX_CMD.INTENSITY, [v & 0xff]);
const mxPrint     = (lines, mode) => mxCommand(MX_CMD.PRINT,
  [lines & 0xff, (lines >> 8) & 0xff, 0x30, mode == null ? MX_MODE_1BPP : mode]);

/* ── Відповіді ───────────────────────────────────────────────────────────
   Формат той самий, тільки четвертий байт у принтера буває ненульовий —
   тому його не перевіряємо, а просто пропускаємо. */
function mxParseNotification(bytes) {
  if (!bytes || bytes.length < 7) return null;
  if (bytes[0] !== 0x22 || bytes[1] !== 0x21) return null;
  const len = bytes[4] | (bytes[5] << 8);
  return {
    cmd: bytes[2],
    payload: bytes.slice(6, Math.min(6 + len, bytes.length)),
    frame: bytes,   // деякі поля адресуються від початку кадру, а не payload
  };
}

/* Розбір відповіді на A1.

   ВАЖЛИВО: індекси відлічуються від початку ВСЬОГО КАДРУ, а не від payload.
   Опис протоколу називає їх «Payload[9]», «Payload[10]» — і це збиває з
   пантелику. Живий MXW01 розсудив суперечку остаточно; ось його відповідь:

     22 21 a1 03 0a 00 00 00 00 64 1d 00 00 00 02 02 00
      0  1  2  3  4  5  6  7  8  9 10 11 12 13

   Байт 9 = 0x64 = 100 (заряд у відсотках), байт 10 = 0x1d = 29 (градуси),
   байт 12 = 0 (усе гаразд). Від початку payload ці ж індекси дали б
   безглузді значення.

   Чого в короткому кадрі немає — віддаємо як null, а не як нуль:
   «невідомо» і «нуль» — різні речі, і показати «0% батареї» замість
   «невідомо» означало б збрехати. */
function mxParseStatus(frame) {
  if (!frame || frame.length < 7) return null;
  const at = i => (frame.length > i ? frame[i] : null);
  const flag = at(12);
  const errorCode = (flag != null && flag !== 0) ? at(13) : 0;
  return {
    state:       at(6),          // 0 — чекає, 1 — друкує
    battery:     at(9),
    temperature: at(10),
    ok:          flag === 0 || flag == null,
    errorCode:   errorCode,
  };
}

/* Коди помилок із протоколу. Показуємо найголовніше і людською мовою. */
function mxStatusProblem(st) {
  if (!st) return null;
  if (st.ok && !st.errorCode) return null;
  switch (st.errorCode) {
    case 1:
    case 9: return 'Скінчився папір';
    case 4: return 'Принтер перегрівся — дай йому хвилину охолонути';
    case 8: return 'Сідає батарея — постав на зарядку';
    default: return 'Принтер не готовий (код ' + st.errorCode + ')';
  }
}

/* ── Зображення ──────────────────────────────────────────────────────────
   На вхід — уже упаковані біти (packBits з catprinter.js: 48 байт на рядок,
   молодший біт = лівий піксель — MXW01 чекає рівно такого).
   Дописуємо порожні рядки (відступ під наклейку) і добиваємо до мінімуму. */
function mxPrepareImage(packed, rows, extraRows) {
  const pad = Math.max(0, extraRows || 0);
  const wanted = Math.max(MX_MIN_ROWS, rows + pad);
  const out = new Uint8Array(wanted * MX_ROW_BYTES);
  out.set(packed.subarray(0, Math.min(packed.length, rows * MX_ROW_BYTES)), 0);
  return { data: out, rows: wanted };
}

/* Суцільна чорна смуга — вирішальна перевірка каналу даних.
   Жодного canvas, жодного дизерингу, жодного тексту: самі одиниці.
   Якщо ця смуга виходить чорною — байти доходять, і винне зображення чи
   режим. Якщо порожньою — дані до принтера не доїжджають узагалі. */
function mxSolidBlack(rows) {
  const n = Math.max(MX_MIN_ROWS, rows || MX_MIN_ROWS);
  return { data: new Uint8Array(n * MX_ROW_BYTES).fill(0xff), rows: n };
}

/* Нарізка потоку зображення на порції для запису в AE03.

   Розмір порції ВИРІВНЮЄМО ПО РЯДКУ. Рядок зображення — рівно 48 байт, і
   якщо різати потік довільно (по 200 чи по 20), кожен запис розриває рядок
   посередині. Принтер приймав такі дані, підтверджував друк — і видавав
   білий папір. Кратність 48 прибирає цілий клас таких відмов і нічого не
   коштує. */
function mxDataChunks(data, chunkSize, align) {
  const raw = chunkSize || 192;
  const unit = align === false ? 1 : MX_ROW_BYTES;
  const size = Math.max(unit, Math.floor(raw / unit) * unit);
  const chunks = [];
  for (let i = 0; i < data.length; i += size) {
    chunks.push(data.subarray(i, Math.min(i + size, data.length)));
  }
  return chunks;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MX_SRV, MX_CTRL, MX_NOTIFY, MX_DATA,
    MX_WIDTH, MX_ROW_BYTES, MX_MIN_BYTES, MX_MIN_ROWS,
    MX_CMD, MX_MODE_1BPP, MX_MODE_ALT, MX_DEF_INTENSITY, mxSolidBlack,
    mxCommand, mxStatus, mxBattery, mxVersion, mxCancel, mxFlush,
    mxIntensity, mxPrint,
    mxParseNotification, mxParseStatus, mxStatusProblem,
    mxPrepareImage, mxDataChunks,
  };
}
