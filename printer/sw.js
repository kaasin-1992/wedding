// Імʼя кешу — це і є версія. Бампаючи його, ми змушуємо браузер поставити новий SW:
// install перезаписує ASSETS свіжими копіями, activate видаляє кеш зі старим імʼям.
const CACHE = 'wedding-printer-v19';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  '../icon-180.png',
  '../icon-192.png',
  '../icon-512.png',
  // з ?v= і без: сторінка просить версіоновані адреси, а кеш за
  // замовчуванням враховує рядок запиту — інакше офлайн-фолбек не знайдеться
  '../lib/catprinter.js',
  '../lib/mxw01.js',
  '../lib/qr.js',
  '../lib/catprinter.js?v=13',
  '../lib/mxw01.js?v=13',
  '../lib/qr.js?v=13'
];

// Новий воркер забирає керування ОДРАЗУ, не чекаючи закриття всіх вкладок.
// Патерн із банером «є оновлення» скопіювався сюди з планера лише наполовину:
// сторінка ніколи не надсилала SKIP_WAITING, тож свіжий воркер міг лежати й
// чекати вічно. Для цього застосунку негайне оновлення важливіше за банер:
// тестувати старою збіркою й не знати про це — найдорожча з можливих втрат.
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {}));
});

self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// index.html і lib/*.js версіонуються РАЗОМ: свіжий HTML викликає функції зі свіжого lib.
// Якщо HTML брати з мережі, а lib — з кешу, рано чи пізно вони розʼїдуться, і на
// ініціалізації полетить помилка: обробники не навішуються, сторінка виглядає мертвою.
// Тому обидва — network-first, з фолбеком у кеш для офлайну.
const isVersioned = req => req.mode === 'navigate'
  || req.destination === 'document'
  || /\/lib\/[^/]+\.js$/.test(new URL(req.url).pathname);

function put(req, res) {
  const copy = res.clone();
  caches.open(CACHE).then(c => c.put(req, copy));
  return res;
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // зовнішнє (Firebase, шрифти) — завжди в мережу, не кешуємо
  if (url.origin !== location.origin) return;

  if (isVersioned(e.request)) {
    // cache:'no-store' — принципово. «Спершу мережа» не рятує, якщо мережа
    // віддає копію з HTTP-кешу браузера: GitHub Pages шле HTML із
    // max-age=600, і сторінка ще десять хвилин лишається старою. Саме через
    // це виправлення доїхало до телефона з запізненням на цілий цикл.
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then(res => put(e.request, res))
        .catch(() => caches.match(e.request).then(hit =>
          hit || (e.request.destination === 'document' ? caches.match('./index.html') : undefined)
        ))
    );
    return;
  }

  // решта власних файлів (іконки, manifest) — спершу кеш, потім мережа
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => put(e.request, res)))
  );
});
