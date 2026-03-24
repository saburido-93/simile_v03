import { CURATED_MAP } from "../data.js";

const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": status === 200 ? "s-maxage=3600, stale-while-revalidate=86400" : "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

function normalizeWord(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[“”"'`´]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function dedupe(items, max = 8) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const cleaned = String(item || "").trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= max) break;
  }
  return out;
}

function sanitizeSections(sections) {
  const allowedTitles = new Set(["base", "uso", "extra"]);
  return (Array.isArray(sections) ? sections : [])
    .map((section) => ({
      title: allowedTitles.has(String(section?.title || "").toLowerCase())
        ? String(section.title).toLowerCase()
        : "base",
      items: dedupe(Array.isArray(section?.items) ? section.items : [], 8)
    }))
    .filter((section) => section.items.length > 0)
    .slice(0, 3);
}

function getCurated(word) {
  const key = normalizeWord(word);
  return CURATED_MAP[key] || null;
}

function buildSchema() {
  return {
    name: "simile_synonyms",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        word: { type: "string" },
        confidence: { type: "number" },
        note: { type: "string" },
        sections: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string", enum: ["base", "uso", "extra"] },
              items: {
                type: "array",
                items: { type: "string" },
                maxItems: 8
              }
            },
            required: ["title", "items"]
          },
          maxItems: 3
        }
      },
      required: ["word", "confidence", "note", "sections"]
    }
  };
}

async function askOpenAI(word) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY não configurada na Vercel.");
  }

  const schema = buildSchema();
  const instructions = [
    "Você é um motor lexical em português do Brasil.",
    "Receba uma palavra ou expressão e devolva sinônimos, aproximações úteis e variações de uso real.",
    "Priorize português brasileiro contemporâneo.",
    "Não invente termos.",
    "Use gírias apenas quando fizer sentido no uso real.",
    "Nunca confunda significados ofensivos com usos neutros sem contexto.",
    "Organize a resposta em base, uso e extra.",
    "Base = sinônimos mais diretos.",
    "Uso = termos próximos por contexto, tom, registro ou cotidiano.",
    "Extra = uma observação curta de nuance, regionalidade ou ambiguidade.",
    "Se a confiança for baixa, devolva poucos itens ou arrays vazios.",
    "Responda apenas no formato estruturado pedido."
  ].join(" ");

  const body = {
    model: OPENAI_MODEL,
    reasoning: { effort: "low" },
    instructions,
    input: `Entrada: ${word}`,
    text: {
      format: {
        type: "json_schema",
        name: schema.name,
        schema: schema.schema,
        strict: true
      }
    }
  };

  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  const payload = await response.json();
  if (!response.ok) {
    const message = payload?.error?.message || `OpenAI error ${response.status}`;
    throw new Error(message);
  }

  const raw = payload?.output_text;
  if (!raw) {
    throw new Error("A OpenAI não retornou output_text.");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("A OpenAI retornou JSON inválido.");
  }

  return {
    word: String(parsed.word || word).trim(),
    source: "llm",
    confidence: Number(parsed.confidence || 0),
    note: String(parsed.note || "").trim(),
    sections: sanitizeSections(parsed.sections)
  };
}

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return json({}, 204);
  }

  if (request.method !== "GET") {
    return json({ error: "Use GET." }, 405);
  }

  const url = new URL(request.url);
  const word = String(url.searchParams.get("word") || "").trim();

  if (!word) {
    return json({ error: "Envie ?word=palavra" }, 400);
  }

  const curated = getCurated(word);
  if (curated) {
    return json({
      word,
      source: "curated",
      confidence: 0.99,
      note: curated.note || "",
      sections: sanitizeSections(curated.sections)
    });
  }

  try {
    const llm = await askOpenAI(word);
    return json({
      word: llm.word || word,
      source: llm.source,
      confidence: llm.confidence,
      note: llm.note,
      sections: llm.sections
    });
  } catch (error) {
    return json({
      error: error?.message || "Falha ao consultar a OpenAI.",
      word,
      source: "none",
      confidence: 0,
      note: "",
      sections: []
    }, 500);
  }
}
