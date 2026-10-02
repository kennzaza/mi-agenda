// Servidor intermedio para "Generar con IA".
// Usa Gemini y mantiene la clave de API protegida en Cloudflare.
//
// Variables que hay que configurar en Cloudflare:
//   GEMINI_API_KEY  (tipo Secret) -> tu clave de Google AI Studio
//   ALLOWED_ORIGIN  (tipo Text)   -> la dirección de tu web
//
// Ejemplo:
//   https://mi-agenda.torresbraian358.workers.dev

const MODEL = "gemini-2.5-flash-lite";

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

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...cors
    }
  });
}

export default {
  async fetch(request, env) {
    const allowed = env.ALLOWED_ORIGIN || "";

    const cors = {
      "Access-Control-Allow-Origin": allowed,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors
      });
    }

    if (request.method !== "POST") {
      return json(
        { error: "Método no permitido" },
        405,
        cors
      );
    }

    if (!allowed || request.headers.get("Origin") !== allowed) {
      return json(
        { error: "Origen no permitido" },
        403,
        cors
      );
    }

    if (!env.GEMINI_API_KEY) {
      return json(
        { error: "Falta configurar la clave en el servidor" },
        500,
        cors
      );
    }

    let body;

    try {
      body = await request.json();
    } catch (e) {
      return json(
        { error: "Pedido inválido" },
        400,
        cors
      );
    }

    // Validación y límites
    const subject = String(body.subject || "").slice(0, 100);

    const notes = String(body.notes || "").slice(0, 6000);

    const count = Math.min(
      Math.max(parseInt(body.count) || 5, 1),
      10
    );

    const level = Math.min(
      Math.max(parseInt(body.level) || 2, 1),
      5
    );

    const weak = Array.isArray(body.weak)
      ? body.weak
          .slice(0, 5)
          .map(w => String(w).slice(0, 200))
      : [];

    if (notes.length < 40) {
      return json(
        { error: "El texto es muy corto" },
        400,
        cors
      );
    }

    const weakText = weak.length
      ? "\nConceptos que a la persona le cuestan (reforzalos con preguntas distintas a estas):\n- " +
        weak.join("\n- ")
      : "";

    const userPrompt =
      "Materia: " +
      subject +
      "\n" +
      "Nivel de dificultad: " +
      level +
      " de 5 (" +
      LEVEL_DESC[level] +
      ")\n" +
      "Cantidad de tarjetas: " +
      count +
      weakText +
      "\n\n" +
      "Texto de estudio:\n" +
      notes;

    let apiRes;

    try {
      apiRes = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" +
          MODEL +
          ":generateContent",
        {
          method: "POST",

          headers: {
            "x-goog-api-key": env.GEMINI_API_KEY,
            "Content-Type": "application/json"
          },

          body: JSON.stringify({
            systemInstruction: {
              parts: [
                {
                  text: SYSTEM_PROMPT
                }
              ]
            },

            contents: [
              {
                role: "user",
                parts: [
                  {
                    text: userPrompt
                  }
                ]
              }
            ],

            generationConfig: {
              temperature: 0.4,
              maxOutputTokens: 2000,
              responseMimeType: "application/json"
            }
          })
        }
      );
    } catch (e) {
      return json(
        { error: "No se pudo conectar con la IA" },
        502,
        cors
      );
    }

    if (!apiRes.ok) {
      return json(
        {
          error:
            "La IA respondió con un error (" +
            apiRes.status +
            ")"
        },
        502,
        cors
      );
    }

    let data;

    try {
      data = await apiRes.json();
    } catch (e) {
      return json(
        { error: "Respuesta inválida de la IA" },
        502,
        cors
      );
    }

    const text =
      data?.candidates?.[0]?.content?.parts
        ?.map(part => part.text || "")
        .join("") || "";

    if (!text) {
      return json(
        { error: "La IA no devolvió tarjetas válidas" },
        502,
        cors
      );
    }

    let cards;

    try {
      cards = JSON.parse(text);
    } catch (e) {
      // Intentamos extraer el JSON por si Gemini agregó texto alrededor
      const start = text.indexOf("[");
      const end = text.lastIndexOf("]");

      if (start === -1 || end === -1) {
        return json(
          { error: "No se pudo leer la respuesta de la IA" },
          502,
          cors
        );
      }

      try {
        cards = JSON.parse(
          text.slice(start, end + 1)
        );
      } catch (e2) {
        return json(
          { error: "No se pudo leer la respuesta de la IA" },
          502,
          cors
        );
      }
    }

    if (!Array.isArray(cards)) {
      return json(
        { error: "La IA no devolvió una lista válida" },
        502,
        cors
      );
    }

    cards = cards
      .filter(c => c && c.front && c.back)
      .slice(0, count)
      .map(c => ({
        front: String(c.front).slice(0, 500),
        back: String(c.back).slice(0, 1000)
      }));

    return json(
      { cards },
      200,
      cors
    );
  }
};
