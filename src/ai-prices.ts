// Оценка цен через Gemini для товаров, которых нет в справочнике (price-hints.ts).
// Один запрос на пачку товаров; результат — ориентир «≈», а не цена конкретного магазина.

export interface PriceQuery { name: string; unit: string }

/** Отправляет запрос к Gemini и возвращает сырой ответ API (askGeminiWithBackoff из app.ts). */
export type GeminiAsk = (payload: unknown) => Promise<{
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}>;

const BATCH = 120;

function buildPrompt(items: PriceQuery[]): string {
  const list = items.map((it, i) => `${i}. ${it.name} — за 1 ${it.unit}`).join('\n');
  return `Ты помощник по покупкам. Оцени типичную цену в обычном супермаркете или магазине в Польше, в злотых (PLN).
Цена нужна за указанную единицу: «шт» — за одну штуку или стандартную упаковку, как товар обычно продаётся;
«кг»/«л» — за килограмм/литр; «г»/«мл» — за грамм/миллилитр; «уп» — за упаковку.
Названия могут быть на русском, польском или с опечатками. Если товар непонятен — верни null.
Ответь ТОЛЬКО JSON-массивом вида [{"i":0,"p":4.5},{"i":1,"p":null}], без пояснений.

Товары:
${list}`;
}

function parseAnswer(text: string, count: number): (number | null)[] {
  const out: (number | null)[] = new Array(count).fill(null);
  const json = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
  let arr: unknown;
  try { arr = JSON.parse(json); } catch { return out; }
  if (!Array.isArray(arr)) return out;
  for (const row of arr) {
    const i = Number((row as { i?: unknown }).i);
    const p = Number((row as { p?: unknown }).p);
    if (Number.isInteger(i) && i >= 0 && i < count && Number.isFinite(p) && p > 0 && p < 100000) {
      out[i] = Math.round(p * 100) / 100;
    }
  }
  return out;
}

/** Возвращает цены (PLN за единицу) в том же порядке, что и items; null — ИИ не смог оценить. */
export async function estimatePricesWithAI(items: PriceQuery[], ask: GeminiAsk): Promise<(number | null)[]> {
  const result: (number | null)[] = [];
  for (let start = 0; start < items.length; start += BATCH) {
    const chunk = items.slice(start, start + BATCH);
    const res = await ask({
      contents: [{ parts: [{ text: buildPrompt(chunk) }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
    });
    const text = res.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    result.push(...parseAnswer(text, chunk.length));
  }
  return result;
}

/** Раскладывает товары по отделам магазина. Возвращает id отдела для каждого названия (null — не уверен). */
export async function categorizeWithAI(
  names: string[],
  categories: { id: string; label: string }[],
  ask: GeminiAsk,
): Promise<(string | null)[]> {
  const ids = new Set(categories.map(c => c.id));
  const result: (string | null)[] = [];
  const cats = categories.map(c => `${c.id} — ${c.label}`).join('\n');
  for (let start = 0; start < names.length; start += BATCH) {
    const chunk = names.slice(start, start + BATCH);
    const prompt = `Разложи товары по отделам магазина. Отделы (id — название):
${cats}
Названия могут быть на русском, польском, с опечатками. Если не подходит ни один отдел — "other".
Ответь ТОЛЬКО JSON-массивом вида [{"i":0,"c":"dairy"}], без пояснений.

Товары:
${chunk.map((n, i) => `${i}. ${n}`).join('\n')}`;
    const res = await ask({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.1 } });
    const text = res.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    const out: (string | null)[] = new Array(chunk.length).fill(null);
    try {
      const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
      for (const row of Array.isArray(arr) ? arr : []) {
        const i = Number(row?.i), c = String(row?.c ?? '');
        if (Number.isInteger(i) && i >= 0 && i < chunk.length && ids.has(c)) out[i] = c;
      }
    } catch { /* неразборчивый ответ — оставляем null */ }
    result.push(...out);
  }
  return result;
}
