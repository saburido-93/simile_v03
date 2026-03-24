export const maxDuration = 10;

const memoryCache = new Map();
const OPENAI_TIMEOUT_MS = 5200;

export async function GET() {
  return Response.json({
    ok: true,
    service: "simile",
    status: "online",
    method: "Use POST",
    example: { word: "casa" }
  });
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const input = String(body.word || "").trim();

    if (!input) {
      return Response.json({ ok: false, error: "Palavra ou frase não enviada." }, { status: 400 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return Response.json({ ok: false, error: "OPENAI_API_KEY não configurada." }, { status: 500 });
    }

    const cacheKey = normalizeKey(input);
    const cached = getCache(cacheKey);
    if (cached) {
      return Response.json({ ok: true, result: cached, cached: true }, { status: 200 });
    }

    const schema = getSchema();
    const payload = buildPayload(input, schema);
    const parsed = await callOpenAIWithBudget(payload, apiKey, OPENAI_TIMEOUT_MS);

    parsed.synonyms = buildFlatSynonyms(parsed);

    if (!parsed.synonyms.length) {
      parsed.synonyms = Array.isArray(parsed.melhores_opcoes) ? parsed.melhores_opcoes : [];
    }

    parsed.synonyms = rerankByIntent(input, parsed.synonyms).slice(0, 12);

    setCache(cacheKey, parsed, 24 * 60 * 60 * 1000);

    return Response.json({ ok: true, result: parsed }, { status: 200 });
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
      "Você é o Símile, um gerador de equivalentes de linguagem em português do Brasil.",
      "Sua tarefa NÃO é só dar sinônimo de dicionário.",
      "Você deve entender o sentido dominante da entrada e devolver formas naturais de dizer quase a mesma coisa no uso real.",
      "Priorize equivalência de uso.",
      "Se a entrada for gíria, meme, internetês, bordão, fala de rede social, expressão idiomática ou frase coloquial, priorize respostas no mesmo registro.",
      "Quando não existir sinônimo perfeito de uma palavra ou expressão, devolva equivalentes curtos de uso e paráfrases curtas naturais.",
      "Evite explicar demais.",
      "Evite respostas literais erradas por decompor a frase palavra por palavra.",
      "Não invente sentidos que não sejam comuns ou plausíveis em PT-BR.",
      "Prefira saídas que alguém realmente diria.",
      "Se houver mais de um sentido possível, escolha o mais provável no uso popular e digital.",
      "Não use linguagem ofensiva.",
      "Retorne apenas JSON válido.",
      "",
      "Exemplos de comportamento esperado:",
      'Entrada: "shippar"',
      'Saídas boas: "torcer pelo casal", "apoiar esse romance", "querer os dois juntos"',
      'Saídas ruins: "casar", "matrimônio", "pressionar para casar"',
      "",
      'Entrada: "close"',
      'Saídas boas: "intimidade", "proximidade", "vínculo", "parceria mais próxima" quando o sentido for social',
      'Saídas ruins: "fechar" se o uso pedido for gíria de relação',
      "",
      'Entrada: "biscoiteiro"',
      'Saídas boas: "caçador de likes", "buscador de atenção", "caçador de validação"',
      'Saídas ruins: respostas literais sem uso social real'
    ].join("\n"),
    input: `Entrada: "${input}"`,
    max_output_tokens: 420,
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
      registro: {
        type: "string",
        enum: ["formal", "neutro", "coloquial", "giria", "meme", "internet"]
      },
      sinonimos_comuns: { type: "array", items: { type: "string" } },
      equivalentes_de_uso: { type: "array", items: { type: "string" } },
      girias_e_internetes: { type: "array", items: { type: "string" } },
      melhores_opcoes: { type: "array", items: { type: "string" } },
      observacao_curta: { type: "string" }
    },
    required: [
      "input",
      "sentido_principal",
      "registro",
      "sinonimos_comuns",
      "equivalentes_de_uso",
      "girias_e_internetes",
      "melhores_opcoes",
      "observacao_curta"
    ]
  };
}

function buildFlatSynonyms(parsed) {
  const buckets = [
    parsed.melhores_opcoes,
    parsed.equivalentes_de_uso,
    parsed.girias_e_internetes,
    parsed.sinonimos_comuns
  ];

  const seen = new Set();
  const out = [];

  for (const arr of buckets) {
    if (!Array.isArray(arr)) continue;

    for (const item of arr) {
      const clean = sanitizeItem(item);
      const key = clean.toLowerCase();
      if (!clean || seen.has(key)) continue;
      seen.add(key);
      out.push(clean);
    }
  }

  return out;
}

function sanitizeItem(value) {
  return String(value || "")
    .trim()
    .replace(/\.$/, "")
    .replace(/\s+/g, " ");
}

function rerankByIntent(input, words) {
  const q = normalizeKey(input);

  const slangHints = [
    "shippar", "biscoiteiro", "biscoitar", "close", "flopar", "cringe",
    "ranço", "gatilho", "mood", "hitar", "sextou", "exposed", "shade"
  ];

  const looksSlang =
    slangHints.some((s) => q.includes(s)) ||
    /^[a-zà-ü-]{3,}$/.test(q) && (
      q.endsWith("ar") ||
      q.endsWith("eiro") ||
      q.endsWith("ona") ||
      q.endsWith("inho")
    );

  if (!looksSlang) return words;

  const score = (item) => {
    const t = normalizeKey(item);
    let n = 0;

    if (t.includes("likes")) n += 3;
    if (t.includes("atenção")) n += 3;
    if (t.includes("romance")) n += 3;
    if (t.includes("casal")) n += 4;
    if (t.includes("juntos")) n += 4;
    if (t.includes("internet")) n += 2;
    if (t.includes("social")) n += 2;
    if (t.split(" ").length >= 2 && t.split(" ").length <= 5) n += 2;
    if (t === q) n -= 10;
    if (["fechar", "encerrar", "trancar", "casar", "matrimônio"].includes(t)) n -= 4;

    return n;
  };

  return [...words].sort((a, b) => score(b) - score(a));
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