import { CULTURAL_MAP, buildCulturalIndex, normalizeText } from "../lib/cultural-map.js";

export const maxDuration = 10;

const memoryCache = new Map();
const CULTURAL_INDEX = buildCulturalIndex();
const OPENAI_TIMEOUT_MS = 5600;
const MAX_RESULTS = 30;

// ─── FILTRO ANTI-PRECONCEITO v2.0 ────────────────────────────────────────────
// Nenhum desses termos pode aparecer como item de saída (sinônimos/variações)
// fora do modo sensível. São demônios, gentílicos usados como insulto, slurs
// raciais, de gênero, identidade, capacitismo e classe.
const DEMONYM_BLOCKLIST = [
  // Gentílicos/regionais usados pejorativamente
  "baiano", "nordestino", "paulista", "carioca", "mineiro",
  "gaúcho", "gaucho", "paraibano", "cearense", "pernambucano",
  "maranhense", "amazonense", "paraense", "capixaba", "piauiense",
  "alagoano", "sergipano", "acreano", "goiano", "mato-grossense",
  "tocantinense", "rondoniense",
  // Slurs raciais e étnicos
  "negro", "preto", "branco", "mulato", "mulata", "crioulo",
  "macaco", "neguinho", "pretinho", "escuro",
  "chines", "japonês", "japones", "árabe", "arabe",
  "gringo", "estrangeiro", "judeu",
  // Slurs de orientação sexual e identidade de gênero
  "viado", "gay", "bicha", "sapatão", "sapatao",
  "traveco", "lésbica", "lesbica", "travesti", "trans",
  "bichinha", "veadinho", "veado",
  // Capacitismo
  "retardado", "mongol", "aleijado", "coxo", "manco",
  "louco", "doido", "demente", "idiota", "imbecil",
  "deficiente", "estúpido",
  // Classe social pejorativo
  "favelado", "mendigo", "vagabundo", "playboyzinho",
  // Misoginia
  "vadia", "piranha", "piranha", "puta", "galinha",
  "histérica", "histerico"
];

// Padrões que NUNCA devem aparecer em saída, independente de contexto
const HARD_BLOCK_PATTERNS = [
  // Associações entre identidade e qualidade/comportamento
  /(^|[\s:,])tipo de pessoa/i,
  /(^|[\s:,])raça/i,
  /(^|[\s:,])regional/i,
  /(^|[\s:,])estere[oó]tipo/i,
  /(^|[\s:,])povo\s+(de|do|da|que)/i,
  // Padrões de discriminação disfarçada
  /esses\s+(gay|preto|negro|nordestino|mulher|trans)/i,
  /\b(negro|preto|gay|trans|nordestino)\s+(é|são|costuma|tende)/i,
  // Xenofobia e nacionalismo negativo
  /(^|[\s:,])brasileiro[s]?\s+(são|é)\s+/i,
  /(^|[\s:,])típico\s+de\s+(negro|gay|trans|nordestino|mulher|homem)/i,
  // Padrões de classe e capacitismo velado
  /(^|[\s:,])gente\s+(pobre|rica|feia|suja|burra)/i,
  /(^|[\s:,])pessoa\s+(burra|idiota|retardada|louca)/i,
  // Combinações de identidade + insulto
  /\b(viado|bicha|sapatão|traveco|travesti)\s+(é|são)/i,
  /comportamento\s+(de\s+)?(negro|gay|nordestino|mulher|trans)/i
];

// Termos que ativam modo sensível mesmo que não estejam no CULTURAL_MAP como sensitive
const SENSITIVE_TRIGGER_TERMS = new Set([
  "suicidio", "suicídio", "matar", "se matar", "se machucar", "automutilacao",
  "automutilação", "overdose", "abuso", "violencia", "violência", "estupro",
  "assedio", "assédio", "pedofilia", "crianca", "criança", "menor",
  "droga", "cocaina", "cocaína", "crack", "heroina", "heroína",
  "bomba", "arma", "pistola", "faca", "explosivo"
]);

// Termos curados como sensíveis no CULTURAL_MAP
const SENSITIVE_KEYS = new Set(
  Object.entries(CULTURAL_MAP)
    .filter(([, value]) => value.sensitive)
    .map(([key]) => normalizeText(key))
);

// ─── ENDPOINTS ────────────────────────────────────────────────────────────────

export async function GET() {
  return Response.json({
    ok: true,
    service: "simile",
    status: "online",
    version: "2.0",
    mode: "cultural-map-v2 + llm + safety-filter-v2",
    entries: Object.keys(CULTURAL_MAP).length,
    example: { word: "forninho" }
  });
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const input = String(body.word || "").trim();

    if (!input) {
      return Response.json({ ok: false, error: "Palavra ou expressão não enviada." }, { status: 400 });
    }

    // Bloqueio de entrada: se o input em si for um slur puro ou padrão proibido,
    // retorna modo seguro diretamente sem chamar LLM
    const normalizedInput = normalizeText(input);

    if (isHardBlockedInput(normalizedInput)) {
      const safeResult = buildSafeBlockedResult();
      return Response.json({ ok: true, result: safeResult, blocked: true }, { status: 200 });
    }

    const cacheKey = normalizedInput;
    const cached = getCache(cacheKey);
    if (cached) {
      return Response.json({ ok: true, result: cached, cached: true }, { status: 200 });
    }

    const exact = getExactCuratedResult(normalizedInput);
    if (exact) {
      setCache(cacheKey, exact, 24 * 60 * 60 * 1000);
      return Response.json({ ok: true, result: exact, curated: true }, { status: 200 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return Response.json({ ok: false, error: "OPENAI_API_KEY não configurada." }, { status: 500 });
    }

    const nearest = findNearestCuratedEntries(normalizedInput, 6);
    const payload = buildPayload(input, normalizedInput, nearest);
    const parsed = await callOpenAIWithBudget(payload, apiKey, OPENAI_TIMEOUT_MS);
    const result = finalizeResult(normalizedInput, parsed, nearest);

    setCache(cacheKey, result, 12 * 60 * 60 * 1000);
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

// ─── FUNÇÕES DE LOOKUP ────────────────────────────────────────────────────────

function getExactCuratedResult(normalizedInput) {
  const direct = CULTURAL_INDEX.byKey.get(normalizedInput);
  if (direct) return formatCuratedRecord(direct);

  const aliasKey = CULTURAL_INDEX.aliasToKey.get(normalizedInput);
  if (aliasKey && CULTURAL_INDEX.byKey.has(aliasKey)) {
    return formatCuratedRecord(CULTURAL_INDEX.byKey.get(aliasKey));
  }

  return null;
}

function formatCuratedRecord(record) {
  const base = sanitizeItems(record.base || [], record.sensitive);
  const uso = sanitizeItems(record.uso || [], record.sensitive);
  const extra = sanitizeItems(record.extra || [], record.sensitive);

  const sections = compactSections([
    { title: "base", items: base },
    { title: "uso", items: uso },
    { title: "extra", items: extra }
  ]);

  return {
    sections,
    synonyms: flattenSections(sections),
    source: "curated"
  };
}

function findNearestCuratedEntries(normalizedInput, limit = 6) {
  const tokens = normalizedInput.split(/\s+/).filter(Boolean);
  const results = [];

  for (const [key, value] of CULTURAL_INDEX.byKey.entries()) {
    let score = 0;

    if (key.includes(normalizedInput) || normalizedInput.includes(key)) score += 8;

    for (const token of tokens) {
      if (token.length < 3) continue;
      if (key.includes(token)) score += 3;
      if ((value.aliases || []).some((alias) => normalizeText(alias).includes(token))) score += 2;
      if ((value.base || []).some((item) => normalizeText(item).includes(token))) score += 1;
    }

    if (score > 0) {
      results.push({ key, score, value: { key, ...value } });
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.value);
}

// ─── CONSTRUÇÃO DO PAYLOAD PARA O LLM ────────────────────────────────────────

function buildPayload(input, normalizedInput, nearest) {
  const isSensitive = isSensitiveInput(normalizedInput);
  const schema = getSchema();

  const curatedContext = nearest.length
    ? nearest.map((entry) => ({
        termo: entry.key,
        base: entry.base.slice(0, 5),
        uso: entry.uso.slice(0, 4),
        extra: entry.extra.slice(0, 3),
        sensivel: !!entry.sensitive
      }))
    : [];

  // ── Instruções base sempre ativas ─────────────────────────────────────────
  const baseInstructions = [
    "Você é o Símile, ferramenta de variações de entendimento em português do Brasil.",
    "Priorize sentido real de uso: internet, meme, gíria, cultura digital, fala cotidiana.",
    "Retorne apenas listas úteis. Sem explicações. Sem observações. Sem parênteses nos itens.",
    "Agrupe em até 3 seções com títulos de até 2 palavras (ex: base, uso, digital, meme, tom).",
    "Máximo total de 30 itens.",
    "Nunca produza complementos entre parênteses.",
    "Nunca devolva saídas no formato 'grupo: termo'."
  ];

  // ── Instruções de segurança SEMPRE ativas — não são opcionais ─────────────
  const safetyInstructions = [
    "PROIBIDO ABSOLUTO: nunca gere estereótipos de grupo — racial, étnico, regional, de gênero, de classe, de orientação sexual, de deficiência ou de nacionalidade.",
    "PROIBIDO ABSOLUTO: nunca associe características negativas (preguiça, violência, burrice, desonestidade, etc.) a identidades de grupo.",
    "PROIBIDO ABSOLUTO: nunca use gentílicos como sinônimos de comportamento ou personalidade.",
    "PROIBIDO ABSOLUTO: nunca produza slurs, insultos ou diminutivos pejorativos ligados a identidade.",
    "PROIBIDO ABSOLUTO: nunca escreva variações que reforcem preconceito de forma velada ou sutil.",
    "Se houver dúvida se um item é preconceituoso, OMITA-O.",
    "Prefira formulações neutras e descritivas. Foque no comportamento ou situação, nunca no grupo."
  ];

  // ── Instruções de modo sensível (ativadas quando aplicável) ───────────────
  const sensitiveInstructions = isSensitive ? [
    "MODO SENSÍVEL ATIVO: este é um termo potencialmente ofensivo ou sensível.",
    "Devolva APENAS alternativas neutras, respeitosas e não-ofensivas.",
    "PROIBIDO: gíria ofensiva, meme pejorativo, ironia, diminutivo negativo, criatividade que possa ofender.",
    "Se o termo for um slur, explique apenas seu significado formal e neutro.",
    "Mantenha tom acadêmico, descritivo e seguro."
  ] : [
    "Para entradas culturais com aderência real, use registro de internet, meme e cultura digital.",
    "Mantenha coerência com o contexto cultural da entrada."
  ];

  const instructions = [
    ...baseInstructions,
    ...safetyInstructions,
    ...sensitiveInstructions
  ].join(" ");

  return {
    model: "gpt-5-mini",
    reasoning: { effort: "minimal" },
    instructions,
    input: [
      `Entrada: "${input}"`,
      curatedContext.length
        ? `Base cultural de apoio: ${JSON.stringify(curatedContext)}`
        : "Base cultural de apoio: []"
    ].join("\n"),
    max_output_tokens: 500,
    text: {
      format: {
        type: "json_schema",
        name: "simile_sections",
        schema
      }
    }
  };
}

// ─── CHAMADA AO LLM ───────────────────────────────────────────────────────────

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

// ─── SCHEMA ──────────────────────────────────────────────────────────────────

function getSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      sections: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            items: {
              type: "array",
              maxItems: 12,
              items: { type: "string" }
            }
          },
          required: ["title", "items"]
        }
      }
    },
    required: ["sections"]
  };
}

// ─── FINALIZAÇÃO E FILTRO DE RESULTADO ───────────────────────────────────────

function finalizeResult(normalizedInput, parsed, nearest) {
  const isSensitive = isSensitiveInput(normalizedInput);

  const exactLike = nearest.find((entry) => entry.key === normalizedInput);
  const curatedSeed = exactLike ? formatCuratedRecord(exactLike).sections : [];

  const incomingSections = Array.isArray(parsed?.sections) ? parsed.sections : [];
  const mergedSections = mergeSections(curatedSeed, incomingSections);
  const safeSections = compactSections(
    mergedSections.map((section) => ({
      title: sanitizeTitle(section.title),
      items: sanitizeItems(section.items || [], isSensitive)
    }))
  );

  let finalSections = safeSections;
  if (!finalSections.length && nearest.length) {
    finalSections = compactSections(nearest.slice(0, 3).map((entry, index) => ({
      title: index === 0 ? "base" : index === 1 ? "uso" : "extra",
      items: sanitizeItems([...entry.base, ...entry.uso, ...entry.extra], isSensitive)
    })));
  }

  finalSections = limitSections(finalSections, MAX_RESULTS);

  if (!finalSections.length && isSensitive) {
    finalSections = compactSections([
      {
        title: "base",
        items: sanitizeItems([
          "termo potencialmente ofensivo",
          "uso não recomendado",
          "consulte alternativa respeitosa",
          "linguagem sensível"
        ], true)
      }
    ]);
  }

  return {
    sections: finalSections,
    synonyms: flattenSections(finalSections),
    source: "llm"
  };
}

// ─── RESULTADO PARA INPUT BLOQUEADO ──────────────────────────────────────────

function buildSafeBlockedResult() {
  return {
    sections: [
      {
        title: "base",
        items: [
          "termo com uso sensível",
          "linguagem potencialmente ofensiva",
          "expressão que pode causar dano",
          "conteúdo não disponível aqui"
        ]
      }
    ],
    synonyms: [
      "termo com uso sensível",
      "linguagem potencialmente ofensiva",
      "expressão que pode causar dano",
      "conteúdo não disponível aqui"
    ],
    source: "blocked"
  };
}

// ─── SANITIZAÇÃO E FILTRO DE ITENS ───────────────────────────────────────────

function sanitizeItems(items, isSensitive) {
  const out = [];
  const seen = new Set();

  for (const raw of items || []) {
    let clean = String(raw || "")
      .replace(/\([^)]*\)/g, " ")    // remove parênteses
      .replace(/["""']/g, "")         // remove aspas
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[;,:]+$/g, "");

    if (!clean) continue;
    if (clean.length < 2) continue;
    if (clean.length > 60) continue;
    if (clean.includes(":")) continue;

    const normalized = normalizeText(clean);

    if (!normalized) continue;
    if (seen.has(normalized)) continue;

    // ── Filtro de padrões hard-block: aplica SEMPRE, inclusive modo sensível ─
    if (HARD_BLOCK_PATTERNS.some((pattern) => pattern.test(clean))) continue;

    // ── Filtro de termos da blocklist ──────────────────────────────────────
    // No modo sensível, a blocklist NÃO se aplica (para permitir outputs
    // educativos/informativos sobre os próprios termos sensíveis).
    // Fora do modo sensível, a blocklist bloqueia totalmente.
    const hasBlockedTerm = DEMONYM_BLOCKLIST.some((term) => normalized.includes(term));
    if (hasBlockedTerm && !isSensitive) continue;

    // ── Modo sensível: filtro extra de itens criativos/ofensivos ───────────
    if (isSensitive) {
      // Bloqueia diminutivos depreciativos comuns
      const sensitivePatterns = [
        /zinho$/, /zinha$/, /eco$/, /eco\s/, /inha\s/,
        /piada/, /meme/, /anedota/, /tirada/, /apelido/,
        /zoação/, /zoar/, /chacotar/, /chacota/, /deboche/,
        /gozar de/, /rir de/, /gozação/
      ];
      if (sensitivePatterns.some((p) => p.test(normalized))) continue;
    }

    seen.add(normalized);
    out.push(clean);
    if (out.length >= 12) break;
  }

  return out;
}

// ─── VERIFICAÇÃO DE INPUT HARD-BLOCKED ───────────────────────────────────────

function isHardBlockedInput(normalizedInput) {
  // Verifica se o INPUT em si é um termo de alto risco (não apenas algo
  // que contenha um termo sensível). Inputs hard-blocked são aqueles onde
  // gerar sinônimos criativos seria inherentemente problemático.
  const hardBlockInputs = new Set([
    "suicidio", "suicída", "se matar", "se machucar",
    "automutilacao", "overdose", "pedofilia",
    "terrorismo", "genocidio", "genocídio"
  ]);

  // Verifica por ativadores de segurança extrema
  for (const trigger of SENSITIVE_TRIGGER_TERMS) {
    if (normalizedInput === trigger) return true;
  }

  return hardBlockInputs.has(normalizedInput);
}

// ─── DETECÇÃO DE INPUT SENSÍVEL ───────────────────────────────────────────────

function isSensitiveInput(normalizedInput) {
  // 1. Verificação direta no mapa curado
  if (SENSITIVE_KEYS.has(normalizedInput)) return true;

  // 2. Verificação se o input CONTÉM uma chave sensível curada
  if ([...SENSITIVE_KEYS].some((term) => normalizedInput.includes(term))) return true;

  // 3. Verificação nos termos gatilho de segurança
  if (SENSITIVE_TRIGGER_TERMS.has(normalizedInput)) return true;
  if ([...SENSITIVE_TRIGGER_TERMS].some((term) => normalizedInput.includes(term))) return true;

  // 4. Verificação se o input contém termo da blocklist
  if (DEMONYM_BLOCKLIST.some((term) => normalizedInput.includes(normalizeText(term)))) return true;

  return false;
}

// ─── UTILITÁRIOS ─────────────────────────────────────────────────────────────

function mergeSections(seedSections, incomingSections) {
  const out = [];
  for (const section of [...seedSections, ...incomingSections]) {
    if (!section || !Array.isArray(section.items)) continue;
    out.push({ title: section.title || "base", items: section.items });
  }
  return out;
}

function compactSections(sections) {
  return sections
    .map((section) => ({
      title: sanitizeTitle(section.title),
      items: uniqueStrings(section.items || [])
    }))
    .filter((section) => section.items.length > 0);
}

function sanitizeTitle(value) {
  const clean = normalizeTitle(String(value || "base"));
  if (!clean) return "base";

  const allowed = [
    "base", "uso", "extra", "rede", "meme", "tom",
    "digital", "geral", "seguro", "comuns", "cultural",
    "gíria", "giria", "formal", "internet", "reação", "reacao"
  ];
  const firstTwo = clean.split(/\s+/).slice(0, 2).join(" ");
  return allowed.includes(firstTwo) ? firstTwo : (allowed.includes(clean) ? clean : "base");
}

function normalizeTitle(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ");
}

function uniqueStrings(items) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const clean = String(item || "").trim();
    const key = normalizeText(clean);
    if (!clean || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function limitSections(sections, maxItems) {
  let remaining = maxItems;
  const out = [];
  for (const section of sections) {
    if (remaining <= 0) break;
    const slice = section.items.slice(0, remaining);
    if (!slice.length) continue;
    out.push({ title: section.title, items: slice });
    remaining -= slice.length;
  }
  return out;
}

function flattenSections(sections) {
  return sections.flatMap((section) => section.items);
}

// ─── CACHE ────────────────────────────────────────────────────────────────────

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
  memoryCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}
