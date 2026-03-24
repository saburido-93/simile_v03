export const maxDuration = 15;

const OPENAI_URL = 'https://api.openai.com/v1/responses';
const OPENAI_TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 1000 * 60 * 60 * 24;
const cache = new Map();

export async function GET() {
  return Response.json({
    ok: true,
    service: 'simile',
    status: 'online',
    method: 'Use POST',
    example: { word: 'casa' }
  }, { status: 200 });
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const word = String(body.word || '').trim();

    if (!word) {
      return Response.json({ ok: false, error: 'Palavra não enviada.' }, { status: 400 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return Response.json({ ok: false, error: 'OPENAI_API_KEY não configurada.' }, { status: 500 });
    }

    const cacheKey = normalize(word);
    const cached = getCache(cacheKey);
    if (cached) {
      return Response.json({ ok: true, result: cached, cached: true }, { status: 200 });
    }

    const result = await fetchSynonymsFromOpenAI(word, apiKey);
    setCache(cacheKey, result);

    return Response.json({ ok: true, result }, { status: 200 });
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? 'A OpenAI demorou além do orçamento de resposta.'
      : (error?.message || 'Erro interno.');

    return Response.json({ ok: false, error: message }, { status: error?.name === 'AbortError' ? 408 : 500 });
  }
}

async function fetchSynonymsFromOpenAI(word, apiKey) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    const response = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'gpt-5-mini',
        reasoning: { effort: 'minimal' },
        max_output_tokens: 220,
        text: {
          format: {
            type: 'json_schema',
            name: 'simile_output',
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                input: { type: 'string' },
                sentido_principal: { type: 'string' },
                synonyms: {
                  type: 'array',
                  items: { type: 'string' }
                },
                observacao_curta: { type: 'string' }
              },
              required: ['input', 'sentido_principal', 'synonyms', 'observacao_curta']
            }
          }
        },
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text: 'Você é o Símile. Responda em português do Brasil. Gere apenas sinônimos ou equivalentes muito próximos e úteis para uso real. Nada de explicação longa. Nada de web search. Nada de bordão solto. Priorize velocidade.'
              }
            ]
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: `Palavra: ${word}`
              }
            ]
          }
        ]
      })
    });

    const raw = await response.text();

    if (!response.ok) {
      throw new Error(`OpenAI ${response.status}: ${raw}`);
    }

    const data = JSON.parse(raw);
    const outputText = data.output_text || extractOutputText(data.output);

    if (!outputText) {
      throw new Error('A OpenAI não retornou conteúdo utilizável.');
    }

    const parsed = JSON.parse(outputText);
    const synonyms = dedupe(parsed.synonyms || []);

    if (!synonyms.length) {
      throw new Error('Nenhum sinônimo retornado.');
    }

    return {
      input: parsed.input || word,
      sentido_principal: parsed.sentido_principal || '',
      observacao_curta: parsed.observacao_curta || '',
      synonyms
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function extractOutputText(output = []) {
  for (const item of output) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part.type === 'output_text' && part.text) {
        return part.text;
      }
    }
  }
  return '';
}

function dedupe(items) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const clean = String(item || '').trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
  }

  return result.slice(0, 12);
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

function setCache(key, value) {
  cache.set(key, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
}
