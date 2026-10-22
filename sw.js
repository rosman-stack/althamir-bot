// sw.js — Service Worker de Althamir
//
// Filosofía deliberadamente conservadora: solo guarda una copia del "cascarón"
// estático del sitio (HTML y CSS) para que funcione algo incluso sin señal.
// Con conexión, siempre muestra la versión más reciente. TODO lo demás
// (inventario, precios, pedidos, pagos, imágenes de productos) va SIEMPRE
// directo a la red, sin caché — es un sitio que vende con precios que
// cambian, no queremos arriesgarnos a mostrar algo viejo.

const CACHE_NAME = 'althamir-shell-v2';
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

  // Estrategia "red primero": siempre intenta traer la versión más reciente
  // del sitio (así un push se ve en la primera carga, sin recargar varias
  // veces) y guarda una copia. Solo si no hay internet usa la copia guardada.
  event.respondWith(
    fetch(event.request)
      .then((respuestaRed) => {
        if (respuestaRed && respuestaRed.ok) {
          const copia = respuestaRed.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copia));
        }
        return respuestaRed;
      })
      .catch(() => caches.match(event.request))
  );
});
