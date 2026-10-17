// Actualiza los precios de referencia de las suscripciones en index.html.
//
// El precio que cargaste a mano siempre pisa este: la tabla solo se usa como
// punto de partida para no tipear el precio la primera vez. Si te cobran otra
// cosa, cargá la tuya y queda guardada para siempre.
//
// Fuente: impuestito.org, que calcula el precio final con impuestos
// (IVA + PAIS + Ganancias + IIBB) sobre un pago con Mercado Pago Débito.
// Esa página renderiza por JavaScript y Cloudflare reta al primero que llega,
// así que hace falta un navegador: se usa Chrome headless por el protocolo
// CDP, sin instalar dependencias (Node >= 21 trae WebSocket global).
//
// Uso:  node .github/scripts/precios-suscripciones.js
//       node .github/scripts/precios-suscripciones.js --dry-run   (sin escribir)
//       DEBUG=1 node ...   (imprime qué devolvió cada página, para cuando
//                           Cloudflare cambie algo y los precios no salgan)
//
// Sale con error si algún servicio queda sin precio: en vez de guardar datos
// a medias, se conserva lo que ya había.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

// Chrome del runner de GitHub o del que haya en la máquina.
const CHROME = process.env.CHROME_PATH || [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
].find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });

const BASE = "https://impuestito.org/suscripciones/";
const DRY = process.argv.includes("--dry-run");

// Qué plan de cada servicio corresponde a cada plan de la app. El nombre de la
// izquierda es como lo escribe Impuestito; el de la derecha, como está en
// SERVICES. Si un servicio no está en esta tabla, no se toca.
const SERVICIOS = {
  netflix: { slug: "netflix", prefijo: "Netflix", planes: {
    "Básico": "Netflix Básico", "Estándar": "Netflix Estándar",
    "Premium": "Netflix Premium" } },
  disney: { slug: "disney-plus", prefijo: "Disney+", planes: {
    "Estándar": "Disney+ Estándar", "Premium": "Disney+ Premium" } },
  hbomax: { slug: "hbo-max", prefijo: "HBO MAX", planes: {
    // El plan "Básico" de la app es el que viene con anuncios, y el tope se
    // llama Platino, no Premium.
    "Básico": "HBO MAX Básico (con anuncios)", "Estándar": "HBO MAX Estándar",
    "Premium": "HBO MAX Platino" } },
  prime: { slug: "amazon-prime-video", prefijo: "Prime Video", planes: {
    "Mensual": "Prime Video Estándar" } },
  crunchyroll: { slug: "crunchyroll", prefijo: "Crunchyroll", planes: {
    "Fan": "Crunchyroll Fan", "Mega Fan": "Crunchyroll Mega Fan" } },
  youtube: { slug: "youtube-premium", prefijo: "YouTube", planes: {
    "Individual": "YouTube Premium Individual", "Familiar": "YouTube Premium Familiar" } },
  spotify: { slug: "spotify", prefijo: "Spotify", planes: {
    "Individual": "Spotify Individual", "Duo": "Spotify Duo",
    "Familiar": "Spotify Familiar", "Estudiantes": "Spotify Estudiantes" } },
  playstation: { slug: "playstation-plus", prefijo: "PlayStation Plus", planes: {
    // PlayStation llama Deluxe a lo que la app llama Premium.
    "Essential": "PlayStation Plus Essential", "Extra": "PlayStation Plus Extra",
    "Premium": "PlayStation Plus Deluxe" } }
};

const esperar = ms => new Promise(r => setTimeout(r, ms));

async function puertoDebugger(dir) {
  for (let i = 0; i < 80; i++) {
    await esperar(250);
    try {
      const l = fs.readFileSync(path.join(dir, "DevToolsActivePort"), "utf8").split("\n")[0].trim();
      if (l) return Number(l);
    } catch (e) { /* todavía no */ }
  }
  throw new Error("Chrome no abrió el puerto de depuración");
}

// Navega, espera a que carguen los planes y devuelve el texto completo.
// El precio está en el DOM aunque innerText lo oculte, por eso textContent.
async function leerPagina(ws, sesion, url) {
  let id = 0;
  const pend = new Map();
  const hilo = ev => {
    const m = JSON.parse(ev.data);
    if (!m.id) return;
    if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  };
  ws.addEventListener("message", hilo);
  const enviar = (method, params = {}) => new Promise(res => {
    const mi = ++id;
    pend.set(mi, res);
    ws.send(JSON.stringify({ id: mi, sessionId: sesion, method, params }));
  });
  try {
    await enviar("Page.enable");
    await enviar("Page.navigate", { url });
    // El challenge de Cloudflare y el renderizado diferido tardan, y el
    // contenido de los planes recién aparece cuando se hace scroll. Se mira
    // cada poco y se corta en cuanto hay precios de verdad; si no llegan,
    // se devuelve igual y el que llama reintenta.
    let texto = "";
    for (let i = 0; i < 10; i++) {
      await esperar(1500);
      await enviar("Runtime.evaluate", {
        expression: "window.scrollTo(0, Math.max(document.body.scrollHeight, window.innerHeight))"
      });
      const r = await enviar("Runtime.evaluate", {
        expression: "document.body ? document.body.textContent : ''"
      });
      texto = (r.result && r.result.result && r.result.result.value) || "";
      if (texto.includes("Planes mensuales") && /\$\s*[\d.,]/.test(texto)) break;
    }
    return texto;
  } finally {
    ws.removeEventListener("message", hilo);
  }
}

// Extrae los planes de la sección mensual. El formato es repetido:
//   "Netflix Premium$ 30.598,47 /m Mercado Pago Débito"
// Al dividir por " /m " queda un bloque por plan; el nombre es lo que hay
// antes del "$". Solo se leen los mensuales: el campo de la app es "lo que
// te cobran por vez", y los planes trimestrales/anuales no aplican.
function parsearPlanes(txt) {
  const seccion = txt.indexOf("Planes mensuales");
  if (seccion < 0) return { planes: [], total: 0 };
  // El bloque termina en "Importante" o en la sección siguiente ("Planes
  // anuales"); si no hay ninguno, se toma un tramo generoso.
  let fin = txt.indexOf("Importante", seccion);
  const siguiente = txt.indexOf("Planes ", seccion + 10);
  if (siguiente > seccion && (fin < 0 || siguiente < fin)) fin = siguiente;
  const crudo = txt.slice(seccion, fin > seccion ? fin : seccion + 8000);

  // El conteo ("8 planes", "1 plan") va justo después del encabezado y a
  // veces sin separador: se corta ahí para que no arrastre el número ni la
  // "s" al nombre del primer plan. Con la "s" opcional en el mismo grupo, V8
  // no backtraea bien cuando el texto sigue con mayúscula ("1 planPrime"),
  // así que se prueban los dos.
  const m = crudo.match(/\d+\s*planes/) || crudo.match(/\d+\s*plan/);
  const total = m ? Number(m[0].match(/\d+/)[0]) : 0;
  const bloque = m ? crudo.slice(m.index + m[0].length) : crudo;

  const planes = [];
  for (const parte of bloque.split(/ \/m /)) {
    const i$ = parte.lastIndexOf("$");
    if (i$ < 0) continue;
    const nombre = parte.slice(0, i$)
      .replace(/Planes mensuales/, "")
      // El método de pago del plan anterior se cuela al inicio del nombre.
      .replace(/^(Mercado Pago Débito|Efectivo|Ripio|Lemon|Global66|Belo|Ualá|Wallbit|AstroPay|Naranja X|Tarjeta en dólares|Tarjeta en euros|Pesificando|Takenos|Reba|ARQ Global|ARQ Local)+/i, "")
      .trim();
    const precio = parseFloat(parte.slice(i$ + 1).trim().replace(/\./g, "").replace(",", "."));
    if (!nombre || !precio || precio < 100) continue;
    planes.push({ nombre, precio });
  }
  const vistos = new Set();
  return {
    planes: planes.filter(p => (vistos.has(p.nombre) ? false : (vistos.add(p.nombre), true))),
    total
  };
}

// Abre Chrome, recorre los servicios y devuelve { "netflix|Premium": 30598.47, ... }.
async function bajarPrecios() {
  if (!CHROME) throw new Error("No encontré Chrome. Seteá CHROME_PATH.");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-precios-"));
  const proc = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=0", "--no-sandbox",
    "--disable-gpu", "--disable-dev-shm-usage",
    "--user-data-dir=" + dir,
    "--window-size=1280,3000", "about:blank"
  ], { stdio: "ignore" });

  try {
    const puerto = await puertoDebugger(dir);
    const info = await (await fetch("http://127.0.0.1:" + puerto + "/json/version")).json();
    const ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let id = 0;
    const pend = new Map();
    ws.addEventListener("message", ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    });
    const enviar = (method, params = {}) => new Promise(res => {
      const mi = ++id;
      pend.set(mi, res);
      ws.send(JSON.stringify({ id: mi, method, params }));
    });

    await enviar("Target.createTarget", { url: "about:blank" });
    const objs = await enviar("Target.getTargets");
    const pagina = objs.result.targetInfos.find(t => t.type === "page");
    const att = await enviar("Target.attachToTarget", { targetId: pagina.targetId, flatten: true });
    const sesion = att.result.sessionId;

    const precios = {};
    const faltantes = [];

    for (const [svcId, cfg] of Object.entries(SERVICIOS)) {
      let txt = "";
      for (let intento = 0; intento < 3; intento++) {
        txt = await leerPagina(ws, sesion, BASE + cfg.slug);
        if (txt.includes("Planes mensuales") && /\$\s*[\d.,]/.test(txt)) break;
      }
      const { planes, total } = parsearPlanes(txt);
      if (process.env.DEBUG) {
        const i = txt.indexOf("Planes mensuales");
        console.error(`[debug] ${svcId} texto=${txt.length} seccion=${i >= 0} ` +
          `hayDolar=${/\$\s*[\d.,]/.test(txt)} planes=${planes.length}/${total} ` +
          `crudo=${JSON.stringify(i >= 0 ? txt.slice(i, i + 45) : txt.slice(0, 45))}`);
      }
      const porNombre = new Map(planes.map(p => [p.nombre, p.precio]));
      let completo = true;
      for (const [planApp, nombreFuente] of Object.entries(cfg.planes)) {
        const precio = porNombre.get(nombreFuente);
        if (precio == null) {
          faltantes.push(`${svcId} → ${planApp} ("${nombreFuente}")`);
          completo = false;
          continue;
        }
        precios[svcId + "|" + planApp] = precio;
      }
      const hallados = Object.keys(cfg.planes).length - Object.values(cfg.planes)
        .filter(n => porNombre.get(n) == null).length;
      console.log(`${completo ? "ok  " : "PARCIAL"}  ${svcId.padEnd(12)} ${hallados}/${Object.keys(cfg.planes).length} planes (la página lista ${total})`);
    }

    ws.close();
    return { precios, faltantes };
  } finally {
    try { proc.kill(); } catch (e) { }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
  }
}

// Reescribe el precio de cada plan dentro de index.html, preservando el
// formato que ya estaba: solo se cambia el número que subió o bajó, no se
// regenera la tabla entera. Así un diff de precios es de verdad un diff de
// precios, y no un reformato que tapa el cambio.
//
// Ojo con el formato: 13768.47 y 11306.70 son el mismo número en JS, así que
// no se puede comparar por texto ni imprimir con toFixed (da coma flotante
// equivocada, 26542.879999999997). Se parsea el número viejo y se emite con la
// misma cantidad de decimales que ya traía el archivo.
function escribirIndex(precios) {
  const file = path.join(__dirname, "..", "..", "index.html");
  let src = fs.readFileSync(file, "utf8");

  const inicio = src.indexOf("const PRICE_REF = {");
  if (inicio < 0) throw new Error("No encontré PRICE_REF en index.html.");
  const fin = src.indexOf("\n};", inicio);
  if (fin < 0) throw new Error("No encontré el cierre de PRICE_REF.");
  const bloque = src.slice(inicio, fin);

  // Cada precio vive en su propia línea con forma de  "clave": 1234.56
  const lineas = bloque.split("\n");
  let tocaron = 0, agregaron = 0;
  const claves = new Set();

  for (let n = 0; n < lineas.length; n++) {
    const pareos = [...lineas[n].matchAll(/"([^"]+)"\s*:\s*([\d.]+)/g)];
    if (!pareos.length) continue;
    let l = lineas[n];
    // De atrás hacia adelante: así el reemplazo de un precio no corre los
    // índices de los que vienen después en la misma línea.
    for (let k = pareos.length - 1; k >= 0; k--) {
      const par = pareos[k];
      const clave = par[1], viejoTexto = par[2];
      claves.add(clave);
      const nuevo = precios[clave];
      if (nuevo == null) continue; // no está mapeado: se deja como está
      if (Number(viejoTexto) === nuevo) continue; // no cambió: se preserva
      // El valor va después de "clave": , no pegado a una comilla, así que se
      // reemplaza por posición exacta y no por texto adivinado.
      const donde = par.index + par[0].lastIndexOf(viejoTexto);
      const dec = (viejoTexto.split(".")[1] || "").length;
      l = l.slice(0, donde) + nuevo.toFixed(dec) + l.slice(donde + viejoTexto.length);
      tocaron++;
    }
    lineas[n] = l;
  }

  // Los planes que no existían en el archivo se agregan. El regex de arriba no
  // captura claves con acentos (Básico, Estándar), así que se busca aparte.
  for (const k of Object.keys(precios)) {
    if (src.includes('"' + k + '"')) claves.add(k);
  }
  const faltantes = Object.keys(precios).filter(k => !claves.has(k));
  if (faltantes.length) {
    const idxCierre = lineas.findIndex(l => l.trim() === "};");
    if (idxCierre < 0) throw new Error("No encontré el cierre de PRICE_REF.");
    const porSvc = {};
    for (const k of faltantes) {
      const svc = k.split("|")[0];
      (porSvc[svc] = porSvc[svc] || []).push(`"${k}": ${precios[k]}`);
    }
    const nuevas = Object.entries(porSvc)
      .map(([svc, arr]) => "  " + arr.join(", "))
      .join("\n");
    lineas.splice(idxCierre, 0, nuevas);
    agregaron = faltantes.length;
  }

  const nuevoBloque = lineas.join("\n");
  src = src.slice(0, inicio) + nuevoBloque + src.slice(fin);

  // El sello de corte solo se mueve si cambió o se agregó algún precio: así
  // el workflow no commitea por una fecha que no significa nada.
  const cambiaAlgo = tocaron + agregaron > 0;
  const ahora = new Date();
  const MESES = ["ene", "feb", "mar", "abr", "may", "jun",
    "jul", "ago", "sep", "oct", "nov", "dic"];
  const corteActual = MESES[ahora.getMonth()] + " " + ahora.getFullYear();
  if (cambiaAlgo) {
    src = src.replace(/const PRICE_REF_CORTE = "[^"]*";/,
      'const PRICE_REF_CORTE = "' + corteActual + '";');
  } else {
    const actual = (src.match(/const PRICE_REF_CORTE = "([^"]*)";/) || [])[1] || "";
    return { src, file, cambiaAlgo: false, corte: actual, tocaron, agregaron };
  }

  return { src, file, cambiaAlgo: true, corte: corteActual, tocaron, agregaron };
}

async function main() {
  if (!CHROME) {
    console.error("No encontré Chrome instalado. Seteá CHROME_PATH al binario.");
    process.exit(1);
  }
  const { precios, faltantes } = await bajarPrecios();

  if (faltantes.length) {
    console.error("\nFaltaron precios y NO se escribe nada (se conserva lo que había):");
    for (const f of faltantes) console.error("  - " + f);
    process.exit(1);
  }
  console.log(`\nTodos los precios leídos: ${Object.keys(precios).length}.`);

  const { src, file, cambiaAlgo, corte } = escribirIndex(precios);
  if (DRY) {
    console.log("Dry-run: no se escribió nada. Corte: " + corte);
    return;
  }
  fs.writeFileSync(file, src, "utf8");
  console.log(`Actualizado ${file} (corte ${corte}).` +
    (cambiaAlgo ? " Cambiaron precios." : " Sin cambios en los precios."));
}

main().catch(e => { console.error("FALLO: " + e.message); process.exit(1); });
