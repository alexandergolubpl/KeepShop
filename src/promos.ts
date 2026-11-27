// Поиск акций на товары из списка.
// 1) Gemini переводит названия в короткий польский запрос («Молоко» → mleko).
// 2) Blix.pl (агрегатор газеток) находит страницы газеток выбранных сетей, где есть товар.
// 3) Gemini читает картинки этих страниц и достаёт название, цену, скидку, условия и сроки.
// Всё на бесплатном ключе Gemini (поиск Google не нужен). Результаты кешируются; проверка раз в день по желанию.

import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { getGeminiKey, isNative, setModalBackHandler } from './native';
import { normName } from './price-hints';

export interface Promo {
  /** нормализованное название товара из списка (ключ для меток) */
  key: string;
  item: string;
  store: string;
  title: string;
  price: number | null;
  oldPrice: number | null;
  discount: number | null;
  from: string;
  to: string;
  condition: string;
  /** страница газетки на Blix */
  url: string;
  /** миниатюра страницы */
  img: string;
}

interface Source { title: string; uri: string }

interface PromoCache {
  at: number;
  items: string[];
  promos: Promo[];
  sources: Source[];
  model: string;
}

interface PromoSettings { stores: string[]; city: string; daily: boolean }

export interface PromoHost {
  /** названия не взятых товаров, на которые ищем акции */
  getItemNames: () => string[];
  /** перерисовать списки (метки 🏷) */
  onChanged: () => void;
  toast: (m: string) => void;
}

export const ALL_STORES = ['Biedronka', 'Lidl', 'Kaufland', 'Auchan', 'Carrefour', 'Netto', 'Dino', 'Aldi', 'Żabka', 'Stokrotka', 'Intermarche', 'POLOmarket', 'Lewiatan', 'Leclerc', 'Selgros', 'Makro', 'Rossmann', 'Hebe', 'Pepco', 'Action'];
const DEFAULT_STORES = ['Biedronka', 'Lidl', 'Kaufland', 'Auchan', 'Carrefour', 'Netto', 'Dino', 'Aldi'];

const CACHE_KEY = 'keepshop_promos';
const SETTINGS_KEY = 'keepshop_promos_settings';
const QUERY_KEY = 'keepshop_promos_q';
const MAX_ITEMS = 30;
const PAGES_PER_ITEM = 3;
const IMAGES_PER_REQUEST = 6;
const DAY = 86_400_000;
// lite читает газетку за 1–2 с; если лимит исчерпан — пробуем полную модель
const MODELS = ['gemini-flash-lite-latest', 'gemini-flash-latest'];

const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } },
};
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const isoToday = () => isoDate(new Date());
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** «Intermarché» = «intermarche», «Carrefour Market» начинается с «carrefour» */
const brandKey = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/gi, 'l').toLowerCase().replace(/[^a-z0-9]/g, '');

function loadSettings(): PromoSettings {
  try {
    const s = JSON.parse(ls.get(SETTINGS_KEY) || '{}');
    return {
      stores: Array.isArray(s.stores) && s.stores.length ? s.stores : DEFAULT_STORES,
      city: typeof s.city === 'string' ? s.city : '',
      daily: s.daily !== false,
    };
  } catch { return { stores: DEFAULT_STORES, city: '', daily: true }; }
}
function loadCache(): PromoCache | null {
  try { const c = JSON.parse(ls.get(CACHE_KEY) || 'null'); return c && Array.isArray(c.promos) ? c : null; } catch { return null; }
}

/** Акция ещё действует (или скоро начнётся)? */
export function isActive(p: Pick<Promo, 'to'>, today = isoToday()): boolean {
  return !p.to || !/^\d{4}-\d{2}-\d{2}$/.test(p.to) || p.to >= today;
}

// ---------- сеть ----------

/** В приложении — нативный HTTP (у Blix нет CORS), в браузере — обычный fetch. */
async function httpGet(url: string, binary = false): Promise<string> {
  if (Capacitor.isNativePlatform()) {
    const r = await CapacitorHttp.get({ url, responseType: binary ? 'blob' : 'text', headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Mobile Safari/537.36' }, connectTimeout: 15000, readTimeout: 30000 });
    if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
    return binary ? String(r.data).replace(/\s+/g, '') : String(r.data);
  }
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (!binary) return r.text();
  const buf = new Uint8Array(await r.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

class GeminiError extends Error { constructor(public status: number, msg: string) { super(msg); } }

type GeminiRes = { candidates?: { content?: { parts?: { text?: string }[] } }[] };

let preferredModel = '';

async function gemini(key: string, parts: unknown[]): Promise<{ text: string; model: string }> {
  let lastErr: unknown = null;
  const order = preferredModel ? [preferredModel, ...MODELS.filter(m => m !== preferredModel)] : MODELS;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const model of order) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0.1 } }),
          signal: AbortSignal.timeout(90_000),
        });
        if (!res.ok) {
          let msg = '';
          try { msg = (await res.json())?.error?.message || ''; } catch { /* не JSON */ }
          throw new GeminiError(res.status, msg || `HTTP ${res.status}`);
        }
        const j: GeminiRes = await res.json();
        preferredModel = model;
        return { text: j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '', model };
      } catch (e) {
        lastErr = e;
        if (e instanceof GeminiError && (e.status === 401 || e.status === 403 || (e.status === 400 && /api key/i.test(e.message)))) throw e;
      }
    }
    // обе модели упёрлись в поминутный лимит — подождём и попробуем ещё раз
    if (lastErr instanceof GeminiError && lastErr.status === 429 && attempt === 0) await sleep(20_000);
    else break;
  }
  throw lastErr instanceof Error ? lastErr : new Error('Gemini недоступен');
}

function jsonArray(text: string): Record<string, unknown>[] {
  const start = text.indexOf('['), end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try { const a = JSON.parse(text.slice(start, end + 1)); return Array.isArray(a) ? a : []; } catch { return []; }
}

// ---------- шаг 1: польские запросы ----------

async function polishQueries(names: string[], key: string): Promise<Map<string, string>> {
  let cached: Record<string, string> = {};
  try { cached = JSON.parse(ls.get(QUERY_KEY) || '{}'); } catch { /* пусто */ }
  const out = new Map<string, string>();
  const todo = names.filter(n => { const q = cached[normName(n)]; if (q) out.set(n, q); return !q; });
  if (todo.length) {
    const prompt = `Для поиска в польских газетках с акциями переведи названия товаров в короткий поисковый запрос на польском: 1–2 слова, вид товара в именительном падеже, без объёма и веса. Марку оставь, только если без неё товар непонятен (Пиво Holba → piwo Holba). Примеры: Молоко → mleko, Лук красный → cebula czerwona, Сыр → ser żółty, Мочалка → gąbka do mycia.
Ответь ТОЛЬКО JSON-массивом [{"i":0,"q":"mleko"}].

${todo.map((n, i) => `${i}. ${n}`).join('\n')}`;
    const { text } = await gemini(key, [{ text: prompt }]);
    for (const r of jsonArray(text)) {
      const i = Number(r.i), q = String(r.q ?? '').trim().toLowerCase();
      if (Number.isInteger(i) && todo[i] && q && q.length < 60) { out.set(todo[i], q); cached[normName(todo[i])] = q; }
    }
    ls.set(QUERY_KEY, JSON.stringify(cached));
  }
  return out;
}

// ---------- шаг 2: страницы газеток на Blix ----------

export interface LeafletPage { store: string; leaflet: string; from: string; to: string; page: number; url: string; img: string; soon: boolean }

/** Разбирает страницу поиска Blix: какие страницы каких газеток содержат товар. */
export function parseBlix(html: string, stores: string[], today = isoToday()): LeafletPage[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const wanted = stores.map(brandKey);
  const out: LeafletPage[] = [];
  const seen = new Set<string>();
  doc.querySelectorAll<HTMLElement>('.leaflet[data-brand-name][data-page-number]').forEach(el => {
    const brand = el.dataset.brandName || '';
    const bk = brandKey(brand);
    const idx = wanted.findIndex(w => bk === w || bk.startsWith(w));
    if (idx < 0) return;
    const end = new Date(el.dataset.dateEnd || '');
    const start = new Date(el.dataset.dateStart || '');
    const to = Number.isNaN(end.getTime()) ? '' : isoDate(end);
    if (to && to < today) return;
    const url = el.querySelector<HTMLAnchorElement>('a.leaflet__link')?.getAttribute('href') || '';
    const img = el.querySelector('img[data-src]')?.getAttribute('data-src') || '';
    if (!/^https:\/\/([a-z0-9-]+\.)*blix\.pl\//.test(url) || !/^https:\/\/imgproxy\.blix\.pl\//.test(img)) return;
    const id = `${el.dataset.leafletId}|${el.dataset.pageNumber}`;
    if (seen.has(id)) return;
    seen.add(id);
    const from = Number.isNaN(start.getTime()) ? '' : isoDate(start);
    out.push({ store: stores[idx], leaflet: el.dataset.leafletName || '', from, to, page: Number(el.dataset.pageNumber) || 0, url, img, soon: !!from && from > today });
  });
  // сначала действующие, по порядку магазинов в настройках; от каждой сети — по одной странице, потом остальные
  out.sort((a, b) => Number(a.soon) - Number(b.soon) || stores.indexOf(a.store) - stores.indexOf(b.store));
  const first: LeafletPage[] = [], rest: LeafletPage[] = [];
  const used = new Set<string>();
  for (const p of out) (used.has(p.store) ? rest : (used.add(p.store), first)).push(p);
  return [...first, ...rest];
}

// ---------- шаг 3: чтение страниц ----------

interface Task { name: string; query: string; page: LeafletPage }

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v.replace(',', '.').replace(/[^\d.]/g, '')) : Number(v);
  return Number.isFinite(n) && n > 0 && n < 100000 ? Math.round(n * 100) / 100 : null;
};
const dateStr = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : '');

export function readPrompt(tasks: Task[]): string {
  return `Это страницы польских газеток с акциями. Для каждой страницы указано, какой товар на ней искать.
${tasks.map((t, k) => `Страница ${k}: ${t.page.store}, газетка «${t.page.leaflet}»${t.page.from ? ` ${t.page.from} – ${t.page.to}` : ''}. Искать: «${t.name}» (${t.query}).`).join('\n')}

Найди на каждой странице АКЦИИ на указанный товар. Только то, что видно на странице, ничего не выдумывай.
Что подходит: этот самый продукт любой марки (для «Молоко» — питьевое молоко любой марки).
Что НЕ подходит: другой продукт, где слово лишь часть названия или вкус (детская смесь вместо молока, сыр с базиликом вместо базилика), игрушки, настольные игры, посуда и прочие непродуктовые товары с похожим названием.
Акция — это скидка: зачёркнутая или «обычная» цена, процент, «N+N gratis», «drugi taniej», «taniej», «supercena», цена «przy zakupie N». Обычная цена без признаков акции — не включай.
Ответь ТОЛЬКО JSON-массивом:
[{"page":0,"title":"Mleko Łowickie 3,2% 1 l","price":2.19,"oldPrice":3.99,"discount":45,"condition":"при покупке 6 шт., с картой Moja Biedronka","from":"2026-11-26","to":"2026-11-28"}]
- title — как написано на странице;
- price — цена по акции за 1 шт./кг в злотых; если цены нет (например «2+2 gratis») — null;
- oldPrice — обычная цена, если указана; discount — скидка в %, если указана;
- condition — условия, ОБЯЗАТЕЛЬНО переведённые на русский язык («при покупке 2 шт.», «второй за полцены», «2+2 бесплатно», «с картой Moja Biedronka», «с приложением Lidl Plus»), иначе пустая строка;
- from/to — даты акции в формате ГГГГ-ММ-ДД, если напечатаны на странице, иначе пустые строки;
- не больше 2 предложений на страницу; если товара на странице нет — не включай её.`;
}

export function parseRead(text: string, tasks: Task[]): Promo[] {
  const out: Promo[] = [];
  for (const r of jsonArray(text)) {
    const k = Number(r.page);
    const t = tasks[k];
    if (!t) continue;
    const title = String(r.title ?? '').trim();
    if (!title) continue;
    const price = num(r.price), oldPrice = num(r.oldPrice);
    let discount = num(r.discount);
    if (discount && discount >= 100) discount = null;
    if (!discount && price && oldPrice && oldPrice > price) discount = Math.round((1 - price / oldPrice) * 100);
    out.push({
      key: normName(t.name), item: t.name, store: t.page.store, title: title.slice(0, 120), price,
      oldPrice: oldPrice && (!price || oldPrice > price) ? oldPrice : null, discount: discount ? Math.round(discount) : null,
      from: dateStr(r.from) || t.page.from, to: dateStr(r.to) || t.page.to,
      condition: String(r.condition ?? '').trim().slice(0, 140),
      url: t.page.url,
      img: t.page.img.replace(/bucket=\d+/, 'bucket=400'),
    });
  }
  return out;
}

/** Шаг 4: текстовая проверка «это тот же товар?» — отсекает сыр с базиликом для «Базилик» и т.п. */
export async function verifyPromos(promos: Promo[], key: string): Promise<Promo[]> {
  if (!promos.length) return promos;
  const prompt = `Покупатель ищет акции на товары из своего списка. Для каждой пары «что ищет → что нашлось в газетке» ответь, подходит ли найденное как этот товар.
Подходит: тот же продукт любой марки, вкуса или фасовки (Молоко → Mleko Łaciate 3,2%; Пиво → Piwo Tyskie; Мешки → worki na śmieci).
Не подходит: другой продукт, где искомое лишь ингредиент, вкус или часть названия (Базилик → сыр с базиликом; Молоко → шоколад молочный или детская смесь Bebiko; Масло → чипсы на масле), игры, игрушки, посуда, другие категории (Картошка → настольная игра; Мешки → салфетки).
Ответь ТОЛЬКО JSON-массивом номеров подходящих пар, например [0,2,3].

${promos.map((p, i) => `${i}. ${p.item} → ${p.title}`).join('\n')}`;
  try {
    const { text } = await gemini(key, [{ text: prompt }]);
    const start = text.indexOf('['), end = text.lastIndexOf(']');
    const keep = new Set((JSON.parse(text.slice(start, end + 1)) as unknown[]).map(Number));
    return promos.filter((_, i) => keep.has(i));
  } catch { return promos; } // проверка не удалась — лучше показать всё, чем ничего
}

/** Полный поиск; onProgress(текст). */
export async function searchPromos(
  names: string[], s: PromoSettings, key: string,
  onProgress: (msg: string) => void = () => {},
): Promise<{ promos: Promo[]; sources: Source[]; model: string; failed: number }> {
  onProgress('Готовлю запросы…');
  const queries = await polishQueries(names, key);
  const tasks: Task[] = [];
  const sources = new Map<string, Source>();
  let failed = 0;
  let done = 0;
  for (const name of names) {
    const q = queries.get(name);
    onProgress(`Ищу в газетках: ${++done} из ${names.length} · ${name}`);
    if (!q) continue;
    try {
      const url = `https://blix.pl/szukaj/?szukaj=${encodeURIComponent(q)}`;
      const html = await httpGet(url).catch(async () => { await sleep(1500); return httpGet(url); }); // один повтор при сбое сети
      const pages = parseBlix(html, s.stores).slice(0, PAGES_PER_ITEM);
      pages.forEach(page => tasks.push({ name, query: q, page }));
    } catch (e) { failed++; console.warn('KeepShop promos blix', q, e); }
  }
  const promos: Promo[] = [];
  let model = '';
  for (let i = 0; i < tasks.length; i += IMAGES_PER_REQUEST) {
    const chunk = tasks.slice(i, i + IMAGES_PER_REQUEST);
    onProgress(`Читаю газетки: ${Math.min(i + IMAGES_PER_REQUEST, tasks.length)} из ${tasks.length} страниц…`);
    const images = await Promise.all(chunk.map(t => httpGet(t.page.img.replace(/bucket=\d+/, 'bucket=1200'), true).catch(() => '')));
    const ok = chunk.filter((_, k) => images[k]);
    if (!ok.length) { failed += chunk.length; continue; }
    const parts: unknown[] = [];
    ok.forEach((t, k) => { parts.push({ text: `Страница ${k}:` }, { inline_data: { mime_type: 'image/jpeg', data: images[chunk.indexOf(t)] } }); });
    parts.push({ text: readPrompt(ok) });
    const r = await gemini(key, parts);
    model = r.model;
    const found = parseRead(r.text, ok);
    for (const p of found) {
      if (/регулярн|regularn|обычная цена/i.test(p.condition)) continue; // не акция
      if (!p.discount && !p.oldPrice && /низк\S* цен|niska cena/i.test(p.condition)) continue; // «низкая цена» без скидки — постоянная цена
      if (!p.discount && !p.oldPrice && !p.condition) continue;           // нет признаков акции
      const dup = promos.some(x => x.key === p.key && x.store === p.store && normName(x.title) === normName(p.title));
      if (!dup) promos.push(p);
    }
    found.forEach(p => sources.set(p.url, { title: `${p.store} · газетка`, uri: p.url }));

  }
  onProgress('Проверяю совпадения…');
  const checked = await verifyPromos(promos.filter(p => isActive(p)), key);
  return { promos: checked, sources: [...sources.values()].filter(s => checked.some(p => p.url === s.uri)), model, failed };
}

// ---------- интерфейс ----------

export interface PromosApi {
  open: (itemName?: string) => void;
  /** лучшая действующая акция на товар (для метки 🏷 в списке) */
  badgeFor: (name: string) => Promo | null;
  /** проверка раз в день при запуске */
  autoCheck: () => void;
}

export function initPromos(host: PromoHost): PromosApi {
  let settings = loadSettings();
  let cache = loadCache();
  let busy = false;
  let progress = '';
  let error = '';
  let focusKey = '';
  let best = new Map<string, Promo>();

  function rebuildIndex(): void {
    best = new Map();
    const today = isoToday();
    for (const p of cache?.promos || []) {
      if (!isActive(p, today)) continue;
      const cur = best.get(p.key);
      if (!cur || (p.discount || 0) > (cur.discount || 0)) best.set(p.key, p);
    }
  }
  rebuildIndex();

  const saveSettings = () => ls.set(SETTINGS_KEY, JSON.stringify(settings));

  const modal = document.createElement('div');
  modal.id = 'promosModal';
  modal.className = 'modal-shell hidden fixed inset-0 z-[60] bg-black/55 flex items-end sm:items-center justify-center p-0 sm:p-4';
  modal.innerHTML = `<div class="modal-box w-full sm:max-w-lg h-[90vh] sm:h-[85vh] bg-white dark:bg-zinc-900 rounded-t-3xl sm:rounded-3xl shadow-2xl flex flex-col overflow-hidden">
    <div class="shrink-0 p-4 pb-2 flex items-center gap-2">
      <h3 class="flex-1 font-extrabold text-base">🏷 Акции на ваш список</h3>
      <button type="button" data-pr="settings" class="w-9 h-9 rounded-xl hover:bg-slate-100 dark:hover:bg-zinc-800" title="Магазины и настройки">⚙️</button>
      <button type="button" data-close-modal="promosModal" class="w-9 h-9 rounded-xl hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-500">✕</button>
    </div>
    <div id="promosSettings" class="hidden shrink-0 mx-4 mb-2 p-3 rounded-2xl bg-slate-50 dark:bg-zinc-800/60 space-y-2 text-xs"></div>
    <div id="promosHead" class="shrink-0 px-4 pb-2"></div>
    <div id="promosBody" class="flex-1 overflow-y-auto px-4 pb-6"></div>
  </div>`;
  document.body.appendChild(modal);
  setModalBackHandler('promosModal', () => false);
  const $ = <T extends HTMLElement>(sel: string) => modal.querySelector<T>(sel)!;

  function ago(ms: number): string {
    const min = Math.round((Date.now() - ms) / 60_000);
    if (min < 1) return 'только что';
    if (min < 60) return `${min} мин назад`;
    const h = Math.round(min / 60);
    if (h < 24) return `${h} ч назад`;
    return new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  }
  const fmtDate = (d: string) => (d ? new Date(d + 'T12:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '');
  const money = (n: number | null) => (n == null ? '' : n.toFixed(2).replace('.', ',') + ' zł');

  function renderSettings(): void {
    $('#promosSettings').innerHTML = `
      <div class="font-bold text-slate-600 dark:text-zinc-300">Магазины</div>
      <div class="flex flex-wrap gap-1.5">${ALL_STORES.map(st => {
        const on = settings.stores.includes(st);
        return `<button type="button" data-pr-store="${esc(st)}" class="px-2.5 py-1 rounded-full border font-semibold ${on ? 'bg-amber-500 border-amber-500 text-white' : 'border-slate-300 dark:border-zinc-600 text-slate-600 dark:text-zinc-300'}">${esc(st)}</button>`;
      }).join('')}</div>
      <label class="flex items-center gap-2"><input type="checkbox" id="promosDaily" ${settings.daily ? 'checked' : ''} class="w-4 h-4 accent-amber-500" />
        Проверять раз в день при запуске</label>`;
  }

  function promoCard(p: Promo): string {
    const dates = p.from && p.to ? `${fmtDate(p.from)} – ${fmtDate(p.to)}` : p.to ? `до ${fmtDate(p.to)}` : p.from ? fmtDate(p.from) : '';
    const future = p.from && p.from > isoToday();
    return `<div class="flex items-start gap-2.5 p-2.5 rounded-2xl border border-slate-200 dark:border-zinc-800">
      <div class="shrink-0 w-14 text-center">
        <div class="text-[10px] font-extrabold uppercase tracking-tight text-slate-500 dark:text-zinc-400 truncate">${esc(p.store)}</div>
        ${p.discount ? `<div class="mt-0.5 rounded-lg bg-rose-600 text-white text-xs font-extrabold py-0.5">−${p.discount}%</div>` : '<div class="mt-0.5 text-lg">🏷</div>'}
      </div>
      <div class="flex-1 min-w-0 text-sm">
        <div class="font-semibold leading-snug break-words">${esc(p.title)}</div>
        <div class="flex flex-wrap items-baseline gap-x-2">
          ${p.price != null ? `<span class="font-extrabold text-rose-600 dark:text-rose-400">${money(p.price)}</span>` : ''}
          ${p.oldPrice != null ? `<span class="text-xs line-through text-slate-400">${money(p.oldPrice)}</span>` : ''}
          ${dates ? `<span class="text-[11px] ${future ? 'text-blue-600 dark:text-blue-400 font-semibold' : 'text-slate-500 dark:text-zinc-400'}">${future ? 'с ' : ''}${dates}</span>` : ''}
        </div>
        ${p.condition ? `<div class="text-[11px] text-amber-700 dark:text-amber-400">${esc(p.condition)}</div>` : ''}
      </div>
      ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer" class="shrink-0 block w-12 rounded-lg overflow-hidden border border-slate-200 dark:border-zinc-700 bg-slate-100 dark:bg-zinc-800" title="Открыть страницу газетки">${p.img ? `<img src="${esc(p.img)}" alt="" loading="lazy" class="w-full h-16 object-cover object-top">` : '<span class="block text-center py-4 text-blue-600">↗</span>'}</a>` : ''}
    </div>`;
  }

  function render(): void {
    renderSettings();
    const names = host.getItemNames();
    $('#promosHead').innerHTML = `
      <div class="flex items-center gap-2">
        <button type="button" data-pr="search" ${busy || !names.length ? 'disabled' : ''} class="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-sm font-bold">${busy ? '⏳ Ищу…' : cache ? '🔄 Обновить' : '🔍 Найти акции'}</button>
        <div class="flex-1 min-w-0 text-[11px] text-slate-500 dark:text-zinc-400 leading-tight">
          ${busy ? esc(progress) : cache ? `Проверено ${ago(cache.at)} · ${cache.items.length} товаров` : `${Math.min(names.length, MAX_ITEMS)} товаров из «Недавних» и списков`}
        </div>
      </div>
      ${error ? `<div class="mt-2 p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 text-xs">${esc(error)}</div>` : ''}`;
    const body = $('#promosBody');
    if (!names.length && !cache) { body.innerHTML = '<div class="text-center text-sm text-slate-400 py-12">Добавьте товары в список — и здесь появятся акции на них.</div>'; return; }
    if (!cache) {
      body.innerHTML = `<div class="text-sm text-slate-500 dark:text-zinc-400 py-6 space-y-2">
        <p>Приложение найдёт товары, которые вы ещё не взяли, в свежих газетках выбранных магазинов (через Blix.pl), а Gemini прочитает со страниц цену, скидку и условия.</p>
        <p class="text-xs">Используется ваш бесплатный ключ Gemini. Поиск занимает 1–2 минуты. ИИ может ошибиться при чтении — у каждой акции есть ссылка на страницу газетки.</p></div>`;
      return;
    }
    const today = isoToday();
    const active = cache.promos.filter(p => isActive(p, today));
    const groups = new Map<string, Promo[]>();
    for (const p of active) { if (!groups.has(p.key)) groups.set(p.key, []); groups.get(p.key)!.push(p); }
    const ordered = [...groups.entries()].sort((a, b) => Math.max(...b[1].map(p => p.discount || 0)) - Math.max(...a[1].map(p => p.discount || 0)));
    const none = cache.items.filter(n => !groups.has(normName(n)));
    body.innerHTML = `
      ${ordered.length ? '' : '<div class="text-center text-sm text-slate-400 py-8">Акций на товары из списка не нашлось.</div>'}
      ${ordered.map(([key, list]) => `<div data-pr-group="${esc(key)}" class="mb-3">
        <div class="py-1.5 text-xs font-extrabold text-slate-600 dark:text-zinc-300">${esc(list[0].item)} <span class="font-normal text-slate-400">· ${list.length}</span></div>
        <div class="space-y-1.5">${list.sort((a, b) => (b.discount || 0) - (a.discount || 0)).map(promoCard).join('')}</div>
      </div>`).join('')}
      ${none.length ? `<div class="mt-3 text-[11px] text-slate-400">Без акций: ${none.map(esc).join(', ')}</div>` : ''}
      ${cache.sources.length ? `<details class="mt-3 text-[11px] text-slate-500 dark:text-zinc-400"><summary class="cursor-pointer font-bold">Страницы газеток (${cache.sources.length})</summary>
        <div class="mt-1 space-y-0.5">${cache.sources.slice(0, 40).map(s => `<a href="${esc(s.uri)}" target="_blank" rel="noopener noreferrer" class="block truncate text-blue-600 dark:text-blue-400">${esc(s.title)}</a>`).join('')}</div></details>` : ''}
      <div class="mt-3 text-[10px] text-slate-400">Источник — газетки на Blix.pl, цены прочитаны ИИ со страниц. Перед покупкой сверьтесь с газеткой.</div>`;
    if (focusKey) {
      const el = body.querySelector<HTMLElement>(`[data-pr-group="${CSS.escape(focusKey)}"]`);
      if (el) { el.scrollIntoView({ block: 'start' }); el.classList.add('ring-2', 'ring-rose-400', 'rounded-2xl'); setTimeout(() => el.classList.remove('ring-2', 'ring-rose-400'), 1600); }
      focusKey = '';
    }
  }

  async function run(silent: boolean): Promise<void> {
    if (busy) return;
    const names = [...new Set(host.getItemNames())].slice(0, MAX_ITEMS);
    if (!names.length) return;
    let key = '';
    try { key = silent ? (localStorage.getItem('keepshop_gemini_api_key') || '') : await getGeminiKey(); } catch { /* нет хранилища */ }
    if (!key) { if (!silent) { error = 'Нужен ключ Gemini (меню ⋮ → «Ключ Gemini AI»).'; render(); } return; }
    if (!settings.stores.length) { error = 'Выберите хотя бы один магазин в ⚙️.'; render(); return; }
    busy = true; error = '';
    const before = new Set((cache?.promos || []).filter(p => isActive(p)).map(p => p.key + '|' + p.store + '|' + p.title));
    if (!silent) render();
    try {
      const r = await searchPromos(names, settings, key, (m) => { progress = m; if (!modal.classList.contains('hidden')) render(); });
      cache = { at: Date.now(), items: names, promos: r.promos, sources: r.sources, model: r.model };
      ls.set(CACHE_KEY, JSON.stringify(cache));
      rebuildIndex();
      host.onChanged();
      const fresh = r.promos.filter(p => !before.has(p.key + '|' + p.store + '|' + p.title));
      const itemsWith = new Set(r.promos.map(p => p.key)).size;
      if (silent && fresh.length) notify(fresh);
      else if (!silent) host.toast(itemsWith ? `🏷 Акции на ${itemsWith} из ${names.length} товаров` : r.failed ? 'Не удалось открыть газетки — проверьте интернет' : 'Акций на товары из списка не нашлось');
    } catch (e) {
      const status = e instanceof GeminiError ? e.status : 0;
      error = status === 429 ? 'Исчерпан лимит запросов Gemini. Попробуйте позже.'
        : status === 400 || status === 403 ? `Gemini отказал: ${(e as Error).message}`
        : navigator.onLine === false ? 'Нет интернета.' : !isNative && /fetch/i.test(String((e as Error).message)) ? 'В браузере газетки недоступны — поиск акций работает в приложении Android.' : `Не удалось найти акции: ${(e as Error).message || e}`;
      if (silent) console.warn('KeepShop promos', e);
    } finally {
      busy = false; progress = '';
      if (!modal.classList.contains('hidden')) render();
    }
  }

  // ---- уведомление о новых акциях после фоновой проверки ----
  async function notify(fresh: Promo[]): Promise<void> {
    const top = [...fresh].sort((a, b) => (b.discount || 0) - (a.discount || 0)).slice(0, 3);
    const text = top.map(p => `${p.item}: ${p.store}${p.discount ? ` −${p.discount}%` : ''}`).join(', ');
    const n = new Set(fresh.map(p => p.key)).size;
    if (document.visibilityState === 'hidden' && isNative) {
      try {
        const { LocalNotifications } = await import('@capacitor/local-notifications');
        const p = await LocalNotifications.checkPermissions();
        if (p.display === 'granted') {
          await LocalNotifications.schedule({ notifications: [{ id: 1_900_000_000 + (Date.now() % 1000), title: `🏷 Акции на ${n} товаров из списка`, body: text, largeBody: text }] });
          return;
        }
      } catch { /* нет плагина */ }
    }
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'fixed bottom-20 inset-x-3 sm:left-auto sm:right-4 sm:w-96 z-[80] text-left flex items-start gap-2 p-3 rounded-2xl bg-rose-600 text-white shadow-2xl transition duration-300 opacity-0 translate-y-2';
    el.innerHTML = `<span class="text-lg leading-none">🏷</span><span class="flex-1 min-w-0 text-sm"><b>Новые акции на ${n} ${n === 1 ? 'товар' : n < 5 ? 'товара' : 'товаров'}</b><br><span class="text-white/85 text-xs">${esc(text)}</span></span>`;
    el.addEventListener('click', () => { el.remove(); open(); });
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.remove('opacity-0', 'translate-y-2'));
    setTimeout(() => { el.classList.add('opacity-0'); setTimeout(() => el.remove(), 300); }, 8000);
  }

  function open(itemName?: string): void {
    document.getElementById('moreMenuDropdown')?.classList.add('hidden');
    focusKey = itemName ? normName(itemName) : '';
    error = '';
    render();
    modal.classList.remove('hidden');
  }

  modal.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t === modal) { modal.classList.add('hidden'); return; }
    const store = t.closest<HTMLElement>('[data-pr-store]')?.dataset.prStore;
    if (store) {
      settings.stores = settings.stores.includes(store) ? settings.stores.filter(s => s !== store) : [...settings.stores, store];
      saveSettings(); renderSettings(); return;
    }
    const act = t.closest<HTMLElement>('[data-pr]')?.dataset.pr;
    if (act === 'settings') $('#promosSettings').classList.toggle('hidden');
    else if (act === 'search') void run(false);
  });
  modal.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.id === 'promosCity') { settings.city = t.value.trim(); saveSettings(); }
    if (t.id === 'promosDaily') { settings.daily = t.checked; saveSettings(); }
  });

  return {
    open,
    badgeFor: (name) => best.get(normName(name)) || null,
    autoCheck() {
      if (!settings.daily || (cache && Date.now() - cache.at < DAY - 3_600_000)) return;
      // не мешаем запуску: ждём, пока приложение отрисуется и подтянет данные семьи
      setTimeout(() => { if (navigator.onLine !== false) void run(true); }, 8000);
    },
  };
}
