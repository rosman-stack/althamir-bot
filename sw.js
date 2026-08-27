// sw.js — Service Worker de Althamir
//
// Filosofía deliberadamente conservadora: solo cachea el "cascarón" estático
// del sitio (HTML, CSS, fuentes) para que abra más rápido en visitas
// repetidas y funcione algo incluso con mala señal. TODO lo demás
// (inventario, precios, pedidos, pagos, imágenes de productos) va SIEMPRE
// directo a la red, sin caché — es un sitio que vende con precios que
// cambian, no queremos arriesgarnos a mostrar algo viejo.

const CACHE_NAME = 'althamir-shell-v1';
const APP_SHELL = [
  '/',
  '/styles.css'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((nombres) =>
      Promise.all(
        nombres
          .filter((nombre) => nombre !== CACHE_NAME)
          .map((nombre) => caches.delete(nombre))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Solo interceptamos GET del mismo origen que estén en el app shell.
  // Todo lo demás (Sheets, Cloudinary, Groq, Render, Recurrente, WhatsApp,
  // Telegram, fuentes de Google) pasa directo a la red sin tocar caché.
  const esAppShell = event.request.method === 'GET' &&
    url.origin === self.location.origin &&
    (url.pathname === '/' || url.pathname === '/styles.css' || url.pathname === '/index.html');

  if (!esAppShell) return; // deja pasar la petición normal, sin interceptar

  event.respondWith(
    caches.match(event.request).then((cacheada) => {
      const redFetch = fetch(event.request)
        .then((respuestaRed) => {
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, respuestaRed.clone()));
          return respuestaRed;
        })
        .catch(() => cacheada); // sin internet: usa lo cacheado si existe

      // Estrategia "stale-while-revalidate": muestra lo cacheado al instante
      // si existe (carga rápida), y de fondo actualiza el caché para la
      // próxima vez — nunca bloquea mostrando algo viejo por mucho tiempo.
      return cacheada || redFetch;
    })
  );
});
