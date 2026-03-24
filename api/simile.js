import { CULTURAL_MAP, buildCulturalIndex, normalizeText } from "../data.js";

const { byKey, aliasToKey } = buildCulturalIndex();

function unique(items = [], limit = 30) {
  return [...new Set((items || []).map((item) => String(item || "").trim()).filter(Boolean))].slice(0, limit);
}

function buildSections(entry) {
  return [
    { title: "base", items: unique(entry?.base) },
    { title: "uso", items: unique(entry?.uso) },
    { title: "extra", items: unique(entry?.extra) }
  ].filter((section) => section.items.length > 0);
}

function search(word) {
  const normalized = normalizeText(word);
  const directKey = aliasToKey.get(normalized) || normalized;
  const direct = byKey.get(directKey);

  if (direct) {
    return {
      query: word,
      normalized,
      exact: true,
      sections: buildSections(direct)
    };
  }

  const fuzzy = [];
  for (const [key, value] of byKey.entries()) {
    if (key.includes(normalized) || normalized.includes(key)) {
      fuzzy.push(value);
    }
  }

  if (!fuzzy.length) {
    for (const [alias, key] of aliasToKey.entries()) {
      if (alias.includes(normalized) || normalized.includes(alias)) {
        const found = byKey.get(key);
        if (found) fuzzy.push(found);
      }
    }
  }

  if (!fuzzy.length) {
    return {
      query: word,
      normalized,
      exact: false,
      sections: []
    };
  }

  const aggregate = { base: [], uso: [], extra: [] };
  fuzzy.slice(0, 8).forEach((entry) => {
    aggregate.base.push(...(entry.base || []));
    aggregate.uso.push(...(entry.uso || []));
    aggregate.extra.push(...(entry.extra || []));
  });

  return {
    query: word,
    normalized,
    exact: false,
    sections: buildSections(aggregate)
  };
}

export default function handler(req, res) {
  const word = String(req.query?.word || "").trim();

  if (!word) {
    res.status(400).json({ error: "Parâmetro word é obrigatório." });
    return;
  }

  try {
    const result = search(word);

    if (!result.sections.length) {
      res.status(404).json({ error: `Nada encontrado para "${word}".` });
      return;
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error?.message || "Erro interno no servidor." });
  }
}
