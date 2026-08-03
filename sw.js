/**
 * Штурвал · офлайн-режим.
 *
 * Стратегия «сначала сеть, потом запас»: при живом интернете всегда
 * отдаётся свежий файл — иначе после загрузки новой сборки на экране
 * оставалась бы старая, и это была бы худшая из возможных путаниц.
 * Если сети нет, отдаётся последняя сохранённая копия: приложение
 * открывается в самолёте, в метро и в лифте.
 *
 * Данные (журнал, настройки, токен) живут в браузере отдельно и никогда
 * не попадают ни в этот файл, ни в кэш.
 */
const CACHE = 'shturval-v1';

self.addEventListener('install', event => {
  // Не ждём закрытия старых вкладок: новая версия вступает в силу сразу.
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Чистим кэши прошлых версий, чтобы не копить мусор.
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;

  // Кэшируем только само приложение. Запросы к бирже и брокеру всегда идут
  // в сеть: устаревшая цена хуже отсутствующей.
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      // Саму страницу приложения просим строго из сети и без кэша браузера:
      // именно на ней держалась старая сборка в установленном приложении.
      const isPage = req.mode === 'navigate' || url.pathname.endsWith('/')
        || url.pathname.endsWith('index.html');
      const fresh = await fetch(isPage ? new Request(req, { cache: 'reload' }) : req);
      const cache = await caches.open(CACHE);
      cache.put(req, fresh.clone());
      return fresh;
    } catch {
      const cached = await caches.match(req);
      if (cached) return cached;
      // Совсем нечего отдать — честная страница вместо пустоты браузера.
      return new Response(
        '<!doctype html><meta charset="utf-8">' +
        '<body style="background:#0b0e14;color:#e8edf5;font:15px/1.6 system-ui;padding:24px">' +
        '<h1 style="font-size:19px">Штурвал недоступен без интернета</h1>' +
        '<p style="color:#8a97ab">Приложение ещё ни разу не загружалось на этом устройстве, ' +
        'поэтому сохранённой копии нет. Открой его один раз при связи — дальше будет работать и без неё.</p>',
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    }
  })());
});
