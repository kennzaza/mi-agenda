// Service worker de la agenda.
// Guarda iconos y archivos estáticos para que la app funcione sin internet.
// index.html NO se cachea: siempre se descarga fresco del servidor.
// No usa IA, no usa claves y no necesita ninguna configuración en Cloudflare.

const CACHE_NAME = "agenda-cache-v10";
// Solo cacheamos iconos y manifest. index.html se descarga siempre de la red.
const APP_FILES = ["manifest.json", "icon-192.png", "icon-512.png"];

// Instalación: guarda los archivos estáticos.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_FILES))
      .catch(() => {}) // si algún archivo falla, no se bloquea la instalación
      .then(() => self.skipWaiting())
  );
});

// Activación: borra las copias de versiones anteriores y toma el control.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// Mensajes desde la página: SKIP_WAITING para activar la nueva versión de inmediato.
self.addEventListener("message", (event)=>{
  if(event.data && event.data.type === "SKIP_WAITING"){
    self.skipWaiting();
  }
});

// Pedidos:
// - Navegación (index.html): siempre de internet, fallback a caché si no hay red.
// - Archivos estáticos: de caché primero, actualizan en segundo plano.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Clima, películas y otros servicios externos van directo a internet, sin guardarse.
  if (url.origin !== self.location.origin) return;

  const isPage =
    req.mode === "navigate" ||
    url.pathname.endsWith("/") ||
    url.pathname.endsWith(".html");

  if (isPage) {
    event.respondWith(
      fetch(req)
        .catch(() =>
          caches.match(req)
            .then((cached) => cached || caches.match("index.html"))
        )
    );
    return;
  }

  // Íconos y demás archivos: caché primero, actualizan en segundo plano.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      event.waitUntil(network.catch(() => {}));
      return cached || network;
    })
  );
});
