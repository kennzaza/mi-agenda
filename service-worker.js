// Service worker de la agenda.
// Guarda los archivos de la web para que abra rápido y también sin internet.
// No usa IA, no usa claves y no necesita ninguna configuración en Cloudflare.

const CACHE_NAME = "agenda-cache-v3";
const APP_FILES = ["./", "index.html", "manifest.json", "icon-192.png", "icon-512.png"];

// Instalación: guarda los archivos principales.
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

// Pedidos: la página siempre se busca primero en internet (así ves los cambios al recargar)
// y solo si no hay conexión se usa la copia guardada.
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
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() =>
          caches.match(req)
            .then((cached) => cached || caches.match("index.html"))
            .then((cached) => cached || caches.match("./"))
        )
    );
    return;
  }

  // Íconos y demás archivos: se muestran desde la copia guardada y se actualizan en segundo plano.
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
