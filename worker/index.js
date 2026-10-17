// Mini-servicio que le pide las ofertas de Steam a Valve y se las pasa a la
// agenda con los permisos (CORS) correctos. Vive en Cloudflare Workers (gratis).
//
// La agenda llama a: https://mi-agenda-ofertas.torresbraian358.workers.dev/offers
//
// No guarda nada: solo arma el JSON y responde. Si Steam se cae, responde 502
// y la web usa su copia de respaldo.

const STEAM_URL = "https://store.steampowered.com/api/featuredcategories/?json=1&cc=ar&l=spanish";
const CACHE_KEY = "https://mi-agenda-ofertas.workers.dev/offers";
const CACHE_TTL = 3600; // segundos: 1 hora de ofertas frescas en el borde

function toOffer(item, tipo) {
  if (!item || !item.id || !item.name) return null;
  const descuento = item.discount_percent || 0;
  const final = item.final_price || 0;
  // Un juego con 100% de descuento (o gratis con descuento activo) es un
  // giveaway o un free weekend: eso va marcado para que la web lo resalte.
  const esGratis = descuento >= 100 || (final === 0 && descuento > 0);
  return {
    id: item.id,
    nombre: item.name,
    descuento: descuento,
    precioOriginal: item.original_price || 0,
    precioFinal: final,
    moneda: item.currency || "",
    imagen: item.large_capsule_image || item.header_image || "",
    vence: item.discount_expiration || 0,
    tipo: esGratis ? "gratis" : tipo
  };
}

function armarOfertas(data) {
  const seen = new Set();
  const ofertas = [];
  const grupos = [
    [data.specials && data.specials.items, "oferta"],
    [data.cat_dailydeal && data.cat_dailydeal.items, "oferta del día"]
  ];
  for (const [items, tipo] of grupos) {
    if (!Array.isArray(items)) continue;
    for (const raw of items) {
      const offer = toOffer(raw, tipo);
      if (!offer || seen.has(offer.id)) continue;
      seen.add(offer.id);
      ofertas.push(offer);
    }
  }
  ofertas.sort((a, b) => {
    // Los juegos gratis van primero, después los de mayor descuento.
    if ((a.tipo === "gratis") !== (b.tipo === "gratis")) return a.tipo === "gratis" ? -1 : 1;
    return b.descuento - a.descuento;
  });
  return ofertas;
}

async function ofrecer() {
  const cache = caches.default;
  const hit = await cache.match(CACHE_KEY);
  if (hit) return hit;

  const resp = await fetch(STEAM_URL, { cf: { cacheTtl: CACHE_TTL } });
  if (!resp.ok) {
    return new Response(JSON.stringify({ error: "Steam respondió " + resp.status }), {
      status: 502,
      headers: jsonHeaders("no-store")
    });
  }

  const data = await resp.json();
  const body = JSON.stringify({ actualizado: new Date().toISOString(), ofertas: armarOfertas(data) });
  const out = new Response(body, { headers: jsonHeaders("public, max-age=600, s-maxage=3600") });
  await cache.put(CACHE_KEY, out.clone());
  return out;
}

function jsonHeaders(cacheControl) {
  return {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": cacheControl
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-max-age": "86400"
        }
      });
    }
    if (url.pathname === "/offers") {
      try {
        return await ofrecer();
      } catch (e) {
        return new Response(JSON.stringify({ error: "No se pudieron obtener las ofertas." }), {
          status: 500,
          headers: jsonHeaders("no-store")
        });
      }
    }
    return new Response("Usá /offers para ver las ofertas de Steam.", { status: 404 });
  }
};
