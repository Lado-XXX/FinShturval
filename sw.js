/* eslint-disable no-restricted-globals */
/**
 * ШТУРВАЛ — служебный обработчик (service worker).
 *
 * Он же — единственный надёжный источник правды о том, что лежит на сервере.
 * Причина: страница, которой управляет обработчик, НЕ МОЖЕТ обойти его своим
 * запросом. Ни `cache: 'reload'`, ни заголовок `Cache-Control`, ни `?v=…` не
 * помогают: они говорят про кэш браузера, а обработчик стоит ПЕРЕД ним и
 * отвечает первым. Поэтому проверка версии из страницы читала не сервер, а
 * копию, которую отдавал старый обработчик, — и делала вывод «всё свежее».
 *
 * Запросы за самим этим файлом браузер делает мимо любых обработчиков. Значит
 * отметка сборки внутри него — единственная величина, которую нельзя подменить
 * старой копией. На ней всё и построено.
 *
 * ВАЖНО ПРИ ВЫПУСКЕ: BUILD здесь обязан совпадать с BUILD_ID в index.html.
 * Несовпадение ловит набор тестов.
 */
const BUILD = '2026-08-09k';
const CACHE = `shturval-${BUILD}`;

// Оболочка приложения. Файл один — в нём и разметка, и стили, и код.
// Адрес у него два: с именем файла и без. Переход бывает по любому из них,
// а копия должна лежать под обоими — иначе офлайн зависит от того, какой из
// двух запросов при установке удался.
const SHELL_URL = './index.html';
const SHELL_KEYS = ['./index.html', './'];
// Значок и манифест: без них установленное приложение офлайн выглядит голым.
// Если какого-то файла в репозитории нет — пропускаем молча, это не поломка.
const EXTRAS = ['./manifest.webmanifest', './icon-192.png', './apple-touch-icon.png'];

/**
 * Установка. Забираем оболочку ПРИНУДИТЕЛЬНО из сети (`cache: 'reload'`):
 * иначе новый обработчик положил бы себе в кэш ту же старую копию, которую
 * ему отдаст кэш браузера, и обновление стало бы бессмысленным.
 *
 * skipWaiting здесь обязателен. Без него новый обработчик ждёт, пока закроются
 * ВСЕ вкладки со старым. Установленное приложение на Android не закрывают
 * неделями — так старая сборка и живёт месяцами, а человек «чинит» это
 * удалением приложения.
 */
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Оболочка качается ОДИН раз и кладётся под оба адреса. Раньше качались
    // оба адреса порознь: сбой любого из двух оставлял дыру, и офлайн-запасом
    // оказывалась пустота при живой копии под соседним ключом.
    let shell = null;
    for (const url of [SHELL_URL, './']) {
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (res && res.ok) { shell = res; break; }
      } catch { /* попробуем второй адрес */ }
    }
    if (shell) {
      for (const key of SHELL_KEYS) {
        try { await cache.put(key, shell.clone()); } catch { /* один ключ не встал — второй важнее */ }
      }
    }
    for (const url of EXTRAS) {
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (res && res.ok) await cache.put(url, res.clone());
      } catch { /* нет файла — и не надо */ }
    }
    await self.skipWaiting();
  })());
});

/**
 * Активация. Чужие кэши сносим целиком: имя кэша содержит сборку, поэтому
 * «чужой» = «от прошлой сборки». Затем берём под управление уже открытые
 * вкладки и СРАЗУ говорим им, какая сборка теперь главная.
 *
 * Одного clients.claim() мало: он меняет управляющего, но не перерисовывает
 * страницу. В памяти вкладки остаётся прежняя разметка — человек по-прежнему
 * видит старую сборку. Поэтому вкладке отправляется сообщение, а она решает,
 * перезагружаться ли.
 */
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
    await announce({ type: 'shturval:activated', build: BUILD });
  })());
});

/** Разослать сообщение всем вкладкам, включая ещё не управляемые. */
async function announce(msg) {
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of list) { try { c.postMessage(msg); } catch { /* вкладка ушла */ } }
}

/**
 * Разговор со страницей. Всё, что страница не может сделать сама, она просит
 * сделать здесь: узнать сборку обработчика, выбросить копии, встать немедленно.
 */
self.addEventListener('message', event => {
  const data = event.data || {};
  const reply = payload => {
    // Ответ идёт и в порт (если он есть), и всем вкладкам — вкладка могла
    // ещё не быть управляемой в момент вопроса.
    if (event.ports && event.ports[0]) { try { event.ports[0].postMessage(payload); } catch { /* порт закрыт */ } }
    else announce(payload);
  };

  if (data.type === 'shturval:whoami') { reply({ type: 'shturval:build', build: BUILD }); return; }

  if (data.type === 'shturval:skip-waiting') { self.skipWaiting(); return; }

  if (data.type === 'shturval:force') {
    event.waitUntil((async () => {
      // Чистить кэш из страницы бесполезно: обработчик положит копии обратно
      // при первом же запросе. Выбрасывает их тот, кто их и создаёт.
      const names = await caches.keys();
      await Promise.all(names.map(n => caches.delete(n)));
      await self.skipWaiting();
      reply({ type: 'shturval:forced', build: BUILD });
    })());
  }
});

/**
 * Запросы.
 *
 * Три правила, и каждое появилось из конкретной беды:
 *
 * 1. Чужие адреса не трогаем вовсе. Биржа и брокер должны идти в сеть напрямую:
 *    закэшированная цена — это неверная цена, а не «быстрая».
 * 2. За самим обработчиком и за отметкой версии не отвечаем: страница обязана
 *    иметь хотя бы один запрос, который гарантированно доходит до сервера.
 * 3. Переход на страницу — сначала сеть. Кэш оболочки нужен ровно для одного
 *    случая: сети нет совсем. Во всех остальных человек обязан получить то,
 *    что лежит на сервере, — иначе обновление зависит от везения.
 */
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;          // правило 1

  const path = url.pathname;
  if (path.endsWith('/sw.js') || path.endsWith('/version.json')) return;   // правило 2

  if (req.mode === 'navigate') {                            // правило 3
    event.respondWith((async () => {
      try {
        const fresh = await fetch(new Request(req.url, { cache: 'no-store' }));
        if (fresh && fresh.ok) {
          const cache = await caches.open(CACHE);
          // Кладём под общим именем: адрес перехода бывает с довеском вида
          // `?upd=…`, и без этого в кэше копилось бы по копии на каждый заход.
          for (const key of SHELL_KEYS) {
            try { await cache.put(key, fresh.clone()); } catch { /* второй ключ важнее */ }
          }
          return fresh;
        }
        // Сервер ответил, но отказом: 502 при выкладке, 500 при сбое. Отдать
        // это человеку значит показать пустой экран вместо рабочего
        // приложения — при том, что рабочая копия лежит рядом.
        const saved = await shellFromCache();
        return saved || fresh;
      } catch {
        const saved = await shellFromCache();
        return saved || new Response(
          '<!doctype html><meta charset="utf-8"><p style="font:16px system-ui;padding:24px">'
          + 'Нет сети, а сохранённой копии приложения ещё нет. Открой ещё раз, когда появится связь.',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    })());
    return;
  }

  // Остальное своё (значок, манифест) — из кэша, с тихим обновлением следом.
  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: false });
    const network = fetch(req).then(async res => {
      if (res && res.ok) { const cache = await caches.open(CACHE); await cache.put(req, res.clone()); }
      return res;
    }).catch(() => null);
    // Обновление копии обязано дожить до конца: без этого обработчик усыпят
    // сразу после ответа из кэша, и копия останется вчерашней навсегда.
    if (cached) event.waitUntil(network);
    return cached || (await network) || new Response('', { status: 504 });
  })());
});

/** Сохранённая оболочка — под любым из двух её адресов. */
async function shellFromCache() {
  for (const key of SHELL_KEYS) {
    const hit = await caches.match(key, { ignoreSearch: true });
    if (hit) return hit;
  }
  return null;
}
