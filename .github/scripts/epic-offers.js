// Arma data/ofertas-epic.json desde la API oficial de Epic Games Store.
//
// Epic no permite llamar desde el navegador (no envía cabeceras CORS), igual
// que Steam, así que este script baja las promociones y guarda el resultado en
// el repositorio. La agenda solo lee el archivo.
//
// Usa el endpoint público que alimenta la propia web de la tienda:
//   freeGamesPromotions  -> juegos gratis ahora + próximos con su descuento
//
// Uso: node .github/scripts/epic-offers.js
//      node .github/scripts/epic-offers.js ruta/descarga-epic.json   (sin red)

const fs = require("fs");
const path = require("path");

const API_URL =
  "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions" +
  "?locale=es-AR&country=AR&allowCountries=AR";

const MONEDA_DECIMALES = { USD: 2, EUR: 2 };

// La imagen de carátula más liviana disponible, en el mismo formato ancho que
// usa Steam para que las tarjetas se vean parecidas en la grilla.
function elegirImagen(keyImages) {
  const orden = ["Thumbnail", "OfferImageWide", "DieselStoreFrontWide", "OfferImageTall"];
  if (!Array.isArray(keyImages)) return "";
  for (const tipo of orden) {
    const img = keyImages.find(k => k && k.type === tipo && k.url);
    if (img) return img.url;
  }
  return "";
}

// Enlace a la página del juego. Epic usa el pageSlug del catálogo; si no
// existe, se arma con el namespace + id, que también resuelve.
function armarUrl(el) {
  const mapping = el.catalogNs && Array.isArray(el.catalogNs.mappings) ? el.catalogNs.mappings[0] : null;
  const slug = (mapping && (mapping.pageSlug || mapping.productSlug)) || el.productSlug;
  if (slug) return "https://store.epicgames.com/es/p/" + slug;
  if (el.namespace && el.id) return "https://store.epicgames.com/es/p/" + el.namespace + "-" + el.id;
  return "https://store.epicgames.com/es/free-games";
}

// Unix en segundos, para calzar con el formato que ya usa la web para Steam.
function aUnix(fechaIso) {
  if (!fechaIso) return 0;
  const t = Date.parse(fechaIso);
  return Number.isNaN(t) ? 0 : Math.floor(t / 1000);
}

// Recorre la estructura de promociones de Epic, que separa las vigentes
// (promotionalOffers) de las futuras (upcomingPromotionalOffers). Cada una es
// una lista de "grupos" y dentro de cada grupo va la lista real de ofertas:
//   promotions.promotionalOffers[ { promotionalOffers[ {startDate, endDate,
//                                                        discountSetting} ] } ]
function promosDe(el, campo) {
  const grupos = el.promotions && el.promotions[campo];
  if (!Array.isArray(grupos)) return [];
  const salida = [];
  for (const grupo of grupos) {
    if (!grupo || !Array.isArray(grupo.promotionalOffers)) continue;
    for (const oferta of grupo.promotionalOffers) {
      if (oferta) salida.push(oferta);
    }
  }
  return salida;
}

// Vigente = la promo ya corre, entonces Epic manda el precio rebajado listo.
// Próxima = todavía no arrancó, así que hay que calcular el precio con el %
// de la promo; si el % es 0, será un juego gratis.
function toOferta(el, promo, vigente) {
  if (!el || !el.id || !el.title) return null;

  const precio = (el.price && el.price.totalPrice) || {};
  const decimales = (precio.currencyInfo && precio.currencyInfo.decimals) != null
    ? precio.currencyInfo.decimals
    : (MONEDA_DECIMALES[precio.currencyCode] || 2);
  // Epic manda los importes en centavos para monedas con decimales, igual que
  // Steam; la web los divide por 100 al formatear.
  const divisor = decimales === 2 ? 100 : 1;

  const pct = (promo.discountSetting && promo.discountSetting.discountPercentage) || 0;
  const precioOriginal = Math.round(precio.originalPrice || 0);

  let precioFinal;
  let descuento;
  let esGratis;
  if (vigente) {
    precioFinal = Math.round(precio.discountPrice || 0);
    esGratis = pct <= 0 || precioFinal <= 0;
    if (esGratis) precioFinal = 0;
    descuento = esGratis
      ? 100
      : (pct || Math.max(0, Math.round((1 - precioFinal / (precioOriginal || 1)) * 100)));
  } else {
    esGratis = pct <= 0;
    precioFinal = esGratis ? 0 : Math.round(precioOriginal * (1 - pct / 100));
    descuento = esGratis ? 100 : pct;
  }

  const fin = aUnix(promo.endDate);
  const empieza = aUnix(promo.startDate);

  return {
    id: "epic-" + el.id,
    nombre: el.title,
    descuento,
    precioOriginal,
    precioFinal,
    moneda: precio.currencyCode || "USD",
    divisor,
    imagen: elegirImagen(el.keyImages),
    vence: fin,
    empieza,
    tipo: esGratis ? "gratis" : "oferta",
    fuente: "epic",
    url: armarUrl(el)
  };
}

async function traerJson() {
  const resp = await fetch(API_URL, { headers: { accept: "application/json" } });
  if (!resp.ok) throw new Error("Epic respondió " + resp.status);
  return resp.json();
}

async function main() {
  let data;
  const archivo = process.argv[2];
  if (archivo) {
    data = JSON.parse(fs.readFileSync(archivo, "utf8"));
    console.log("Usando descarga local: " + archivo);
  } else {
    data = await traerJson();
    console.log("Descargado de la API oficial de Epic.");
  }

  const elementos = data && data.data && data.data.Catalog && data.data.Catalog.searchStore
    ? data.data.Catalog.searchStore.elements
    : null;
  if (!Array.isArray(elementos)) {
    console.error("La respuesta de Epic no tiene la forma esperada (data.Catalog.searchStore.elements).");
    process.exit(1);
  }

  const ofertas = [];
  const vistos = new Set();

  for (const el of elementos) {
    // Vigentes primero: lo gratis ahora, y después las ofertas con % activas.
    const vigentes = promosDe(el, "promotionalOffers");
    for (const promo of vigentes) {
      const o = toOferta(el, promo, true);
      if (!o || vistos.has(o.id)) continue;
      vistos.add(o.id);
      ofertas.push(o);
    }
  }

  // Los próximos gratis/ofertas también interesan: dicen qué conviene esperar.
  let proximos = 0;
  for (const el of elementos) {
    const futuras = promosDe(el, "upcomingPromotionalOffers");
    for (const promo of futuras) {
      const o = toOferta(el, promo, false);
      if (!o || vistos.has(o.id)) continue;
      vistos.add(o.id);
      // Todavía no está activa: se marca para que la web lo diga con claridad.
      o.tipo = "próximamente";
      ofertas.push(o);
      proximos++;
    }
  }

  // Gratis y ofertas activas primero, los próximos al final; dentro, mayor
  // descuento arriba.
  const peso = t => (t === "gratis" ? 0 : t === "oferta" ? 1 : 2);
  ofertas.sort((a, b) => (peso(a.tipo) - peso(b.tipo)) || (b.descuento - a.descuento));

  // El sello de "actualizado" solo se mueve si las ofertas cambiaron. Así el
  // workflow de GitHub no commitea todos los día por una fecha que no significa
  // nada, y la web no muestra "recién actualizado" cuando nada varió.
  const outDir = path.join(__dirname, "..", "..", "data");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "ofertas-epic.json");
  const mismoContenido = (() => {
    try {
      const anterior = JSON.parse(fs.readFileSync(outFile, "utf8"));
      return JSON.stringify(anterior.ofertas || []) === JSON.stringify(ofertas);
    } catch (e) {
      return false; // primera vez o archivo ilegible: se considera nuevo
    }
  })();
  let actualizado = new Date().toISOString();
  if (mismoContenido) {
    try {
      actualizado = JSON.parse(fs.readFileSync(outFile, "utf8")).actualizado || actualizado;
    } catch (e) { /* no pasa nada: se usa la fecha de ahora */ }
  }

  const out = { actualizado, ofertas };
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n", "utf8");

  const gratis = ofertas.filter(o => o.tipo === "gratis").length;
  const activas = ofertas.filter(o => o.tipo !== "próximamente").length;
  console.log(
    `Listo: ${ofertas.length} de Epic en ${outFile} ` +
    `(${gratis} gratis ahora, ${activas} activas, ${proximos} próximas)` +
    (mismoContenido ? " · sin cambios respecto de lo guardado" : "")
  );
}

main().catch(e => {
  console.error("No se pudieron obtener las ofertas de Epic: " + e.message);
  process.exit(1);
});
