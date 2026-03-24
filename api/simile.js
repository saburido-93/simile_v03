export const maxDuration = 10;

const memoryCache = new Map();
const OPENAI_TIMEOUT_MS = 5200;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function GET() {
  return Response.json({
    ok: true,
    service: "simile",
    status: "online",
    method: "Use POST",
    example: { word: "shippar" }
  });
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const input = String(body.word || "").trim();

    if (!input) {
      return Response.json({ ok: false, error: "Palavra ou expressão não enviada." }, { status: 400 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return Response.json({ ok: false, error: "OPENAI_API_KEY não configurada." }, { status: 500 });
    }

    const normalized = normalizeKey(input);
    const cached = getCache(normalized);
    if (cached) {
      return Response.json({ ok: true, result: cached, cached: true }, { status: 200 });
    }

    const schema = getSchema();
    const payload = buildPayload(input, schema);
    const parsed = await callOpenAIWithBudget(payload, apiKey, OPENAI_TIMEOUT_MS);

    const synonyms = rerankByIntent(input, flattenResults(parsed)).slice(0, 12);

    const result = {
      input,
      sentido_principal: sanitizeText(parsed.sentido_principal) || input,
      synonyms
    };

    setCache(normalized, result, CACHE_TTL_MS);

    return Response.json({ ok: true, result }, { status: 200 });
  } catch (error) {
    const timeout = error?.name === "AbortError";

    return Response.json(
      {
        ok: false,
        error: timeout
          ? "A busca demorou demais para o orçamento de resposta."
          : (error.message || "Erro interno.")
      },
      { status: timeout ? 408 : 500 }
    );
  }
}

function buildPayload(input, schema) {
  return {
    model: "gpt-5-mini",
    reasoning: { effort: "minimal" },
    instructions: [
      "Você é o Símile.",
      "Gere variações de entendimento e equivalentes naturais em português do Brasil.",
      "Não seja um dicionário clássico.",
      "Priorize como brasileiros realmente falam, escrevem e entendem a entrada.",
      "Se a entrada for gíria, meme, regionalismo, internetês, expressão queer, expressão negra, periférica ou nordestina, preserve o registro e o sentido social mais provável.",
      "Quando não houver sinônimo exato, devolva equivalentes curtos de uso com o mesmo sentido percebido.",
      "Não explique o termo.",
      "Não dê aula.",
      "Não devolva observações.",
      "Não decomponha a frase palavra por palavra se isso empobrecer o sentido.",
      "Não higienize termos culturais.",
      "Se houver mais de um sentido possível, escolha o mais provável no uso popular e digital do Brasil.",
      "Evite repetições e evite respostas genéricas que caberiam para qualquer palavra.",
      "Prefira listas curtas, fortes e naturais.",
      "Retorne apenas JSON válido no schema pedido.",
      "Exemplo bom para shippar: torcer pelo casal, querer os dois juntos, apoiar esse romance.",
      "Exemplo ruim para shippar: casar, matrimônio, pressionar para casar.",
      "Exemplo bom para biscoiteiro: caçador de likes, buscador de atenção, caçador de validação.",
      "Exemplo bom para gag: piada, tirada, esquete curta, sacada engraçada."
    ].join(" "),
    input: `Entrada: "${input}"`,
    max_output_tokens: 260,
    text: {
      format: {
        type: "json_schema",
        name: "simile_output",
        schema
      }
    }
  };
}

async function callOpenAIWithBudget(payload, apiKey, budgetMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), budgetMs);

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const raw = await response.text();

    if (!response.ok) {
      throw new Error(`OpenAI ${response.status}: ${raw}`);
    }

    const data = JSON.parse(raw);
    const rawText = data.output_text || extractTextFromOutput(data.output) || "";

    if (!rawText) {
      throw new Error("A OpenAI não retornou conteúdo utilizável.");
    }

    return JSON.parse(rawText);
  } finally {
    clearTimeout(timeoutId);
  }
}

function extractTextFromOutput(output = []) {
  for (const item of output || []) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part.type === "output_text" && part.text) {
          return part.text;
        }
      }
    }
  }
  return "";
}

function getSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      input: { type: "string" },
      sentido_principal: { type: "string" },
      melhores_opcoes: { type: "array", items: { type: "string" } },
      equivalentes_de_uso: { type: "array", items: { type: "string" } },
      girias_e_internetes: { type: "array", items: { type: "string" } },
      variacoes_regionais: { type: "array", items: { type: "string" } }
    },
    required: [
      "input",
      "sentido_principal",
      "melhores_opcoes",
      "equivalentes_de_uso",
      "girias_e_internetes",
      "variacoes_regionais"
    ]
  };
}

function flattenResults(parsed) {
  const buckets = [
    parsed.melhores_opcoes,
    parsed.equivalentes_de_uso,
    parsed.girias_e_internetes,
    parsed.variacoes_regionais
  ];

  const seen = new Set();
  const out = [];

  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;

    for (const item of bucket) {
      const clean = sanitizeText(item);
      if (!clean) continue;
      const key = normalizeKey(clean);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(clean);
    }
  }

  return out;
}

function rerankByIntent(input, items) {
  const q = normalizeKey(input);
  const isPhrase = q.split(/\s+/).length >= 2;
  const slangish = looksCultural(q);

  return [...items].sort((a, b) => scoreItem(b, q, isPhrase, slangish) - scoreItem(a, q, isPhrase, slangish));
}

function scoreItem(item, q, isPhrase, slangish) {
  const t = normalizeKey(item);
  let score = 0;
  const wordCount = t.split(/\s+/).filter(Boolean).length;

  if (t === q) score -= 20;
  if (wordCount >= 2 && wordCount <= 5) score += 3;
  if (wordCount === 1) score += 1;
  if (isPhrase && wordCount >= 2) score += 2;

  const culturallyStrong = [
    "casal", "romance", "juntos", "ship", "likes", "curtidas", "atenção", "validação",
    "meme", "tirada", "piada", "esquete", "engraçada", "intimidade", "proximidade",
    "parceria", "vínculo", "chegado", "colado", "afeto", "deboche", "zoeira"
  ];

  if (culturallyStrong.some((term) => t.includes(term))) score += 4;
  if (slangish && wordCount >= 2 && wordCount <= 4) score += 2;

  const weakOrWrong = [
    "casar", "matrimônio", "fechar", "encerrar", "trancar", "concluir", "próximo", "perto"
  ];

  if (weakOrWrong.includes(t)) score -= 5;

  return score;
}

function looksCultural(text) {
  const terms = [
    "shippar", "biscoiteiro", "biscoitar", "close", "gag", "flopar", "ranço", "mood",
    "shade", "exposed", "cringe", "lacrar", "passada", "babado", "tombar", "bafo"
  ];

  return terms.some((term) => text.includes(term));
}

function sanitizeText(value) {
  return String(value || "")
    .trim()
    .replace(/^[\-•–—]\s*/, "")
    .replace(/\.$/, "")
    .replace(/\s+/g, " ");
}

function normalizeKey(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function getCache(key) {
  const item = memoryCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    memoryCache.delete(key);
    return null;
  }
  return item.value;
}

function setCache(key, value, ttlMs) {
  memoryCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });
}
