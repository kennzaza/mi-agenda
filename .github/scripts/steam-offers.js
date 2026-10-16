// Arma data/ofertas-steam.json a partir de la descarga de la API de Steam.
//
// Steam no permite llamar desde el navegador (no envía cabeceras CORS),
// así que un workflow de GitHub Actions baja las ofertas todos los días
// y guarda este archivo en el repositorio. La web solo lee el archivo.
//
// Uso: node .github/scripts/steam-offers.js ruta/descarga-de-steam.json

const fs = require("fs");
const path = require("path");

const inputFile = process.argv[2];
if (!inputFile) {
  console.error("Falta la ruta del archivo descargado de Steam.");
  process.exit(1);
}

let data;
try {
  data = JSON.parse(fs.readFileSync(inputFile, "utf8"));
} catch (e) {
  console.error("No se pudo leer el JSON de Steam: " + e.message);
  process.exit(1);
}

if (!data || !data.specials || !Array.isArray(data.specials.items)) {
  console.error("El JSON de Steam no tiene la forma esperada (falta specials.items).");
  process.exit(1);
}

function toOffer(item, tipo) {
  if (!item || !item.id || !item.name) return null;
  return {
    id: item.id,
    nombre: item.name,
    descuento: item.discount_percent || 0,
    precioOriginal: item.original_price || 0,
    precioFinal: item.final_price || 0,
    moneda: item.currency || "",
    imagen: item.large_capsule_image || item.header_image || "",
    vence: item.discount_expiration || 0,
    tipo: tipo
  };
}

// Ofertas destacadas + oferta del día, sin repetir ningún juego.
const seen = new Set();
const ofertas = [];
[data.specials.items, data.cat_dailydeal ? data.cat_dailydeal.items : []].forEach((list, idx) => {
  list.forEach((raw) => {
    const offer = toOffer(raw, idx === 1 ? "oferta del día" : "oferta");
    if (!offer || seen.has(offer.id)) return;
    seen.add(offer.id);
    ofertas.push(offer);
  });
});

// De mayor descuento a menor.
ofertas.sort((a, b) => b.descuento - a.descuento);

const out = {
  actualizado: new Date().toISOString(),
  ofertas: ofertas
};

const outDir = path.join(__dirname, "..", "..", "data");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "ofertas-steam.json");
fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n", "utf8");

console.log(`Listo: ${ofertas.length} ofertas guardadas en ${outFile}`);
