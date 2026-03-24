import { CURATED_MAP } from "../data.js";

const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": status === 200 ? "s-maxage=3600, stale-while-revalidate=86400" : "no-store",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

function normalizeWord(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function normalizeItem(item) {
  if (typeof item === "string") return item.trim();
  if (item && typeof item === "object") {
    const candidate = item.word || item.term || item.text || item.value || item.label || item.name || "";
    return String(candidate).trim();
  }
  return String(item || "").trim();
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const cleaned = normalizeItem(item);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
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
      items: dedupe(Array.isArray(section?.items) ? section.items : []).slice(0, 8)
    }))
    .filter((section) => section.items.length > 0);
}

function getCurated(word) {
  return CURATED_MAP[normalizeWord(word)] || null;
}

async function askOpenAI(word) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY não configurada na Vercel.");
  }

  const schema = {
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

  const instructions = [
    "Você é um motor lexical em português do Brasil.",
    "Receba uma palavra ou expressão e devolva sinônimos e termos próximos com foco em uso real.",
    "Priorize PT-BR atual e utilidade prática.",
    "Não invente palavras e não force gírias.",
    "Se a entrada for muito abstrata, ainda assim traga termos úteis do cotidiano.",
    "Organize em base, uso e extra.",
    "Base = sinônimos mais diretos.",
    "Uso = termos próximos por contexto.",
    "Extra = nuance, registro ou observação breve.",
    "Se não houver confiança, devolva arrays vazios e confidence baixo.",
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
      "Authorization": `Bearer ${apiKey}`
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
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });
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
      confidence: 0.98,
      note: curated.note || "",
      sections: sanitizeSections(curated.sections)
    });
  }

  try {
    const llm = await askOpenAI(word);
    if (!llm.sections.length) {
      return json({
        word,
        source: "llm",
        confidence: llm.confidence,
        note: llm.note || "Sem confiança suficiente para sugerir variações.",
        sections: []
      });
    }
    return json(llm);
  } catch (error) {
    return json({
      error: error?.message || "Falha ao consultar a OpenAI.",
      word,
      source: "none",
      sections: []
    }, 500);
  }
}
