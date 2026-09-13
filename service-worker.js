const CACHE_NAME = "agenda-cache-v1";
const ASSETS = ["./agenda.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

// Chequeo periódico en segundo plano (soporte limitado: solo algunos Android/Chrome,
// y el sistema operativo decide cada cuánto lo ejecuta realmente, no es preciso al minuto).
self.addEventListener("periodicsync", (event) => {
  if (event.tag === "check-agenda") {
    event.waitUntil(checkAndNotify());
  }
});

// Fallback: algunos navegadores disparan "sync" simple en vez de periodicsync.
self.addEventListener("sync", (event) => {
  if (event.tag === "check-agenda") {
    event.waitUntil(checkAndNotify());
  }
});

async function checkAndNotify(){
  const clientsList = await self.clients.matchAll();
  // Le pedimos a una ventana abierta los datos (si hay alguna); si no hay, no podemos leer localStorage desde el SW.
  if (clientsList.length === 0) return;
  clientsList[0].postMessage({ type: "CHECK_DUE" });
}
