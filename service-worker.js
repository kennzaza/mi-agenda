// Servidor intermedio para "Generar con IA".
// Guarda la clave de la API en secreto y se la pide a Claude en nombre de tu web.
//
// Variables que hay que configurar en Cloudflare (Settings > Variables and Secrets):
//   ANTHROPIC_API_KEY  (tipo Secret)  -> tu clave de la API
//   ALLOWED_ORIGIN     (tipo Text)    -> la dirección de tu web, sin barra al final.
//                                         Ejemplo: https://tuusuario.github.io

const MODEL = "claude-haiku-4-5-20251001";

const LEVEL_DESC = {
  1: "recordar: definiciones, datos y conceptos básicos",
  2: "comprender: explicar ideas con palabras propias",
  3: "aplicar: usar el concepto en un caso concreto",
  4: "analizar: relacionar, comparar y encontrar causas",
  5: "transferir: casos nuevos y complejos que exigen razonar"
};

const SYSTEM_PROMPT =
  "Sos un tutor que crea tarjetas de estudio (pregunta y respuesta) en español rioplatense, claro y directo. " +
  "Respondé SOLO con un arreglo JSON válido, sin texto extra y sin bloques de código. " +
  'Cada elemento tiene esta forma: {"front": "pregunta", "back": "respuesta"}. ' +
  "Usá únicamente información del texto que te pasa el usuario o conocimiento general verificable; no inventes datos. " +
  "Una sola idea por tarjeta. Las respuestas tienen entre 1 y 3 oraciones.";

function json(body, status, cors){
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors }
  });
}

export default {
  async fetch(request, env){
    const allowed = env.ALLOWED_ORIGIN || "";
    const cors = {
      "Access-Control-Allow-Origin": allowed,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };

    if(request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if(request.method !== "POST") return json({ error: "Método no permitido" }, 405, cors);
    if(!allowed || request.headers.get("Origin") !== allowed){
      return json({ error: "Origen no permitido" }, 403, cors);
    }
    if(!env.ANTHROPIC_API_KEY) return json({ error: "Falta configurar la clave en el servidor" }, 500, cors);

    let body;
    try { body = await request.json(); }
    catch(e){ return json({ error: "Pedido inválido" }, 400, cors); }

    // Validación y límites: acá se cuida el gasto
    const subject = String(body.subject || "").slice(0, 100);
    const notes = String(body.notes || "").slice(0, 6000);
    const count = Math.min(Math.max(parseInt(body.count) || 5, 1), 10);
    const level = Math.min(Math.max(parseInt(body.level) || 2, 1), 5);
    const weak = Array.isArray(body.weak)
      ? body.weak.slice(0, 5).map(w => String(w).slice(0, 200))
      : [];

    if(notes.length < 40) return json({ error: "El texto es muy corto" }, 400, cors);

    const weakText = weak.length
      ? "\nConceptos que a la persona le cuestan (reforzalos con preguntas distintas a estas):\n- " + weak.join("\n- ")
      : "";

    const userPrompt =
      "Materia: " + subject + "\n" +
      "Nivel de dificultad: " + level + " de 5 (" + LEVEL_DESC[level] + ")\n" +
      "Cantidad de tarjetas: " + count + weakText + "\n\n" +
      "Texto de estudio:\n" + notes;

    let apiRes;
    try{
      apiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 2000,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userPrompt }]
        })
      });
    }catch(e){
      return json({ error: "No se pudo conectar con la IA" }, 502, cors);
    }

    if(!apiRes.ok){
      return json({ error: "La IA respondió con un error (" + apiRes.status + ")" }, 502, cors);
    }

    const data = await apiRes.json();
    const text = (data.content || []).map(b => b.text || "").join("");

    // Extraemos el arreglo JSON aunque venga con texto alrededor
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if(start === -1 || end === -1) return json({ error: "La IA no devolvió tarjetas válidas" }, 502, cors);

    let cards;
    try { cards = JSON.parse(text.slice(start, end + 1)); }
    catch(e){ return json({ error: "No se pudo leer la respuesta de la IA" }, 502, cors); }

    cards = cards
      .filter(c => c && c.front && c.back)
      .slice(0, count)
      .map(c => ({ front: String(c.front).slice(0, 500), back: String(c.back).slice(0, 1000) }));

    return json({ cards }, 200, cors);
  }
};
