
export const maxDuration = 10;

const memoryCache = new Map();
const OPENAI_TIMEOUT_MS = 5200;
const MAX_RESULTS = 20;

const ORIGIN_LABELS = {
  melhores_opcoes: "base",
  sinonimos_comuns: "comuns",
  sinonimos_contextuais: "contexto",
  girias_e_fala: "gíria",
  bordoes_e_maneirismos: "fala",
  regionalismos: "região",
  memes_e_cultura: "meme"
};

const BANNED_PATTERNS = [
  /\bbaiano\b/i,
  /\bbaiana\b/i,
  /\bbaian[oa]s\b/i,
  /\bpaulista\b/i,
  /\bpaulistan[oa]s\b/i,
  /\bnordestin[oa]\b/i,
  /\bnordestin[oa]s\b/i,
  /\bsudestin[oa]\b/i,
  /\bsulist[ao]\b/i,
  /\bpreto\b/i,
  /\bpreta\b/i,
  /\bnegro\b/i,
  /\bnegra\b/i,
  /\bgay\b/i,
  /\bl[ée]sbica\b/i,
  /\btrans\b/i,
  /\btravesti\b/i,
  /\bviado\b/i,
  /\bbicha\b/i,
  /\bmulher\b/i,
  /\bhomem\b/i,
  /\bpobre\b/i,
  /\brico\b/i,
  /\bindio\b/i,
  /\bautista\b/i,
  /\bdeficient[ea]\b/i,
  /\baleijad[oa]\b/i,
  /\bretardad[oa]\b/i,
  /\bcripple\b/i
];

const BANNED_FRAGMENTS = [
  'geral:', 'tipo:', 'estilo:', 'modo:', 'jeito:',
  'sem ideia', 'enrolado', 'embola', 'embolado',
  'confuso mesmo', 'cabeça'
];

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

    const grouped = buildGroupedSynonyms(parsed, input);
    const result = {
      input,
      sentido_principal: sanitizeText(parsed.sentido_principal || ""),
      groups: grouped,
      synonyms: grouped.flatMap(group => group.items).slice(0, MAX_RESULTS)
    };

    setCache(cacheKey, result, 24 * 60 * 60 * 1000);

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
      "Você é o Símile, um gerador de equivalentes de linguagem em português do Brasil.",
      "Sua tarefa é devolver variações de entendimento e equivalentes naturais de uso.",
      "Não explique. Não contextualize. Não escreva observações.",
      "Priorize o sentido mais provável no uso real.",
      "Se a entrada for gíria, meme, internetês, fala cotidiana ou expressão idiomática, preserve o registro.",
      "Quando não houver sinônimo perfeito, devolva equivalentes curtos de uso.",
      "Nunca associe sentido, traço, defeito, valor ou comportamento a grupos regionais, raciais, étnicos, de gênero, orientação sexual, deficiência, religião, nacionalidade ou classe social.",
      "Nunca escreva rótulos como 'baiano: ...', 'nordestino: ...', 'gay: ...', 'preto: ...' ou equivalentes.",
      "Nunca use regionalismo, gíria ou referência identitária se isso introduzir estereótipo, preconceito, caricatura ou generalização.",
      "Evite parênteses.",
      "Retorne apenas JSON válido."
    ].join(" "),
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
      sinonimos_comuns: { type: "array", items: { type: "string" } },
      sinonimos_contextuais: { type: "array", items: { type: "string" } },
      girias_e_fala: { type: "array", items: { type: "string" } },
      bordoes_e_maneirismos: { type: "array", items: { type: "string" } },
      regionalismos: { type: "array", items: { type: "string" } },
      memes_e_cultura: { type: "array", items: { type: "string" } },
      melhores_opcoes: { type: "array", items: { type: "string" } }
    },
    required: [
      "input",
      "sentido_principal",
      "sinonimos_comuns",
      "sinonimos_contextuais",
      "girias_e_fala",
      "bordoes_e_maneirismos",
      "regionalismos",
      "memes_e_cultura",
      "melhores_opcoes"
    ]
  };
}

function buildGroupedSynonyms(parsed, input) {
  const bucketOrder = [
    "melhores_opcoes",
    "sinonimos_comuns",
    "sinonimos_contextuais",
    "girias_e_fala",
    "bordoes_e_maneirismos",
    "regionalismos",
    "memes_e_cultura"
  ];

  const seen = new Set();
  const groups = [];
  let total = 0;

  for (const bucket of bucketOrder) {
    const arr = Array.isArray(parsed[bucket]) ? parsed[bucket] : [];
    const items = [];

    for (const item of arr) {
      if (total >= MAX_RESULTS) break;
      const clean = sanitizeCandidate(item, input);
      const key = normalizeKey(clean);
      if (!clean || seen.has(key)) continue;
      if (!passesSafetyFilter(clean, input)) continue;
      seen.add(key);
      items.push(clean);
      total += 1;
    }

    if (items.length) {
      groups.push({
        label: ORIGIN_LABELS[bucket],
        items
      });
    }

    if (total >= MAX_RESULTS) break;
  }

  return groups;
}

function sanitizeCandidate(value, input) {
  let clean = sanitizeText(value);
  if (!clean) return "";

  clean = clean.replace(/\([^)]*\)/g, " ");
  clean = clean.replace(/\[[^\]]*\]/g, " ");
  clean = clean.replace(/\s{2,}/g, " ").trim();
  clean = clean.replace(/^[\-\–\—•·]+\s*/g, "");
  clean = clean.replace(/\s*[:：]\s*/g, " ");
  clean = clean.replace(/\.$/, "").trim();

  if (!clean) return "";
  if (normalizeKey(clean) === normalizeKey(input)) return "";
  return clean;
}

function sanitizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function passesSafetyFilter(candidate, input) {
  const text = sanitizeText(candidate);
  const normalized = normalizeKey(text);
  const normalizedInput = normalizeKey(input);

  if (!text) return false;
  if (text.length < 2) return false;
  if (normalized === normalizedInput) return false;
  if (/[()]/.test(text)) return false;
  if (/^[^a-zà-ÿ0-9]+$/i.test(text)) return false;

  for (const pattern of BANNED_PATTERNS) {
    if (pattern.test(text)) return false;
  }

  for (const fragment of BANNED_FRAGMENTS) {
    if (normalized.includes(normalizeKey(fragment))) return false;
  }

  if (/^[a-zà-ÿ]+ [a-zà-ÿ]+ [a-zà-ÿ]+ [a-zà-ÿ]+ [a-zà-ÿ]+ [a-zà-ÿ]+/i.test(text)) {
    return false;
  }

  return true;
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
