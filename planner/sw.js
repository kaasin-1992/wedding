// Імʼя кешу — це і є версія. Бампаючи його, ми змушуємо браузер поставити новий SW:
// install перезаписує ASSETS свіжими копіями, activate видаляє кеш зі старим імʼям.
const CACHE = 'wedding-planner-v14';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  '../icon-180.png',
  '../icon-192.png',
  '../icon-512.png',
  '../lib/guest-utils.js',
  '../lib/task-utils.js',
  '../lib/budget-utils.js'
];

self.addEventListener('install', e => {
  // не самоактивуємось одразу — чекаємо на команду SKIP_WAITING зі сторінки,
  // щоб застосунок міг показати банер "є оновлення" перед перезавантаженням
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
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
    e.respondWith(
      fetch(e.request)
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
