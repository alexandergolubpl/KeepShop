// «Навести порядок»: нормальные названия товаров во всех списках и актуальные цены.
// 1) Gemini разбирает все названия: расшифровывает сокращения из чеков (PiwTyskie0,5lPus → Пиво Tyskie 0,5 л),
//    исправляет опечатки и разговорные слова, даёт общий вид товара (base) для сопоставления.
// 2) Цены: последняя покупка того же товара (чеки, история) → той же группы (base) → ИИ-оценка для пустых.
// 3) Предпросмотр с галочками, копия базы перед применением, «Отменить».
// Новые чеки потом сами получают нормальные названия (псевдонимы хранятся в базе товаров).

import { normName, convertUnitPrice } from './price-hints';
import { setModalBackHandler } from './native';
import { upsertProduct, type Product } from './products';

export interface TidyItem { name: string; unit?: string; qty?: number; price?: number; priceEstimated?: boolean; basePrice?: number; date?: string; desc?: string }
interface PriceRec { productName: string; price: number; store?: string; date?: string }
export interface TidyState {
  lists: { id: string; title: string; isMain?: boolean; items: TidyItem[] }[];
  recent: TidyItem[];
  favorite: TidyItem[];
  backlog: TidyItem[];
  priceHistory: PriceRec[];
  products: (Product & { aliases?: string[] })[];
}

export interface TidyHost {
  getState: () => TidyState;
  /** сырой ответ Gemini (askGeminiWithBackoff) */
  ask: (payload: unknown, model?: string) => Promise<{ candidates?: { content?: { parts?: { text?: string }[] } }[] }>;
  estimate: (items: { name: string; unit: string }[]) => Promise<(number | null)[]>;
  makeUndo: (keys: string[], label: string) => () => void;
  backup: (reason: string) => Promise<unknown>;
  save: () => void;
  toast: (m: string, undo?: (() => void) | null) => void;
  formatMoney: (n: number) => string;
  hasKey: () => boolean;
}

interface NameInfo { name: string; base: string }
interface Rename { from: string; to: string; uses: number; on: boolean }
interface PriceChange { key: string; where: string; name: string; unit: string; from: number; fromEst: boolean; to: number; est: boolean; source: string; on: boolean; refs: TidyItem[] }

const CACHE_KEY = 'keepshop_tidy_names_v2';
const BATCH = 80;
const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } },
};
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------- 1. названия ----------

export function namesPrompt(names: string[]): string {
  return `Наведи порядок в названиях товаров из списка покупок (семья живёт в Польше, приложение на русском).
Для каждого названия верни:
- name — нормальное название на русском с заглавной буквы:
  • расшифруй сокращения из польских чеков: «Mle bez lakt 2 1l» → «Молоко без лактозы 2%, 1 л»; «PiwTyskie0,5lPus» → «Пиво Tyskie 0,5 л, банка»; «Kukur NaszSpiż285g» → «Кукуруза консервированная Nasza Spiżarnia, 285 г»; «Ćw Tyl z Kurczaka» → «Куриные окорочка»; «NapGazPepsiZero1l» → «Pepsi Zero, 1 л»;
  • польские и английские названия переведи: «Oliwki bez pestek» → «Оливки без косточек», «Reklamówka» → «Пакет»;
  • исправь опечатки: «Пудинг шоколандый» → «Пудинг шоколадный», «Круасан» → «Круассан»;
  • разговорные и уменьшительные слова замени обычными: «Морожко» → «Мороженое», «Пивасик» → «Пиво», «Макарошки» → «Макароны»;
  • марки оставь латиницей как есть; объём и вес оставь, если они были;
  • уточнения в скобках — это заметки пользователя (виды, марки, варианты): СОХРАНЯЙ их, можно только исправить опечатки внутри: «Сыр (моцарелла, чеддер)» остаётся «Сыр (моцарелла, чеддер)»; убирай скобки, только если в них просто перевод или синоним того же слова: «Fanta (Фанта)» → «Fanta», «Морковь (морковка)» → «Морковь»;
  • если не уверен в расшифровке сокращения — оставь название как есть; не придумывай марки и слова, которых нет в строке;
  • числа в строке чека часто означают вариант, цену или код («Reklamówka 50p» — пакет за 50 грошей → «Пакет»; «Jemy Jemy Zupa 2» → «Суп Jemy Jemy»), не превращай их в количество штук; частые сокращения: trusk. — truskawkowe (клубничные), luz — на вес, kaucja — залог за тару, OPUST — скидка;
  • если название уже нормальное — верни его БЕЗ изменений.
- base — общий вид товара по-русски, 1–2 слова (Молоко, Пиво, Куриные окорочка, Кукуруза консервированная).
Ответь ТОЛЬКО JSON-массивом: [{"i":0,"name":"Молоко без лактозы 2%, 1 л","base":"Молоко"}]

${names.map((n, i) => `${i}. ${n}`).join('\n')}`;
}

export function parseNames(text: string, names: string[]): Map<string, NameInfo> {
  const out = new Map<string, NameInfo>();
  const s = text.indexOf('['), e = text.lastIndexOf(']');
  if (s < 0 || e <= s) return out;
  let arr: unknown;
  try { arr = JSON.parse(text.slice(s, e + 1)); } catch { return out; }
  for (const r of Array.isArray(arr) ? arr as Record<string, unknown>[] : []) {
    const i = Number(r?.i);
    const raw = names[i];
    if (raw === undefined) continue;
    const name = String(r.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const base = String(r.base ?? '').trim().slice(0, 40);
    if (!name) continue;
    out.set(raw, { name, base: base || name });
  }
  return out;
}

// ---------- 2. цены ----------

interface Purchase { key: string; base: string; price: number; unit: string; date: string; store: string }

/** Последние покупки из чеков/истории, с единицей измерения, если она известна. */
function purchases(st: TidyState, info: (n: string) => NameInfo | undefined): Purchase[] {
  const unitOf = new Map<string, string>();
  st.recent.forEach(r => { if (r.unit) unitOf.set(normName(r.name), r.unit); });
  st.products.forEach(p => { if (!unitOf.has(normName(p.name))) unitOf.set(normName(p.name), p.unit); });
  const out: Purchase[] = [];
  const add = (name: string, price: number, unit: string, date: string, store: string) => {
    if (!(price > 0) || !name) return;
    const i = info(name);
    const nm = i?.name || name;
    out.push({ key: normName(nm), base: normName(i?.base || nm), price, unit, date: date || '', store });
  };
  // «Недавние» не используем как источник цены: туда попадают и ориентировочные цены отмеченных товаров
  // записи с названием списка вместо магазина появляются при отметке товара в списке — там могла быть оценка «≈»
  const listTitles = new Set(['недавние', ...st.lists.map(l => normName(l.title))]);
  st.priceHistory.forEach(p => { if (listTitles.has(normName(p.store || ''))) return; add(p.productName, Number(p.price) || 0, unitOf.get(normName(p.productName)) || '', p.date || '', p.store || ''); });
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

function priceFor(p: Purchase, unit: string): number | null {
  if (!p.unit || p.unit === unit) return p.price;
  return convertUnitPrice(p.price, p.unit, unit);
}

// ---------- UI ----------

export interface TidyApi { open: () => void; renameIncoming: (name: string) => string }

export function initTidy(host: TidyHost): TidyApi {
  let cache: Record<string, NameInfo> = {};
  try { cache = JSON.parse(ls.get(CACHE_KEY) || '{}'); } catch { /* пусто */ }
  let busy = false, progress = '', error = '';
  let renames: Rename[] = [];
  let prices: PriceChange[] = [];
  let scanned = false;

  const info = (n: string): NameInfo | undefined => cache[n];

  /** Название из нового чека → нормальное (по псевдонимам из базы и прошлым проверкам). */
  function renameIncoming(name: string): string {
    const k = normName(name);
    const p = host.getState().products.find(x => (x.aliases || []).some(a => normName(a) === k));
    if (p) return p.name;
    const c = cache[name];
    return c && c.name !== name ? c.name : name;
  }

  function allNames(st: TidyState): Map<string, number> {
    const uses = new Map<string, number>();
    const add = (n: unknown) => { const s = String(n ?? '').trim(); if (s) uses.set(s, (uses.get(s) || 0) + 1); };
    st.lists.forEach(l => l.items.forEach(i => add(i.name)));
    [st.recent, st.favorite, st.backlog].forEach(c => c.forEach(i => add(i.name)));
    st.priceHistory.forEach(p => add(p.productName));
    st.products.filter(p => p.custom).forEach(p => add(p.name));
    return uses;
  }

  async function scan(): Promise<void> {
    if (busy) return;
    if (!host.hasKey()) { error = 'Нужен ключ Gemini (меню ⋮ → «Ключ Gemini AI»).'; render(); return; }
    busy = true; error = ''; render();
    try {
      const st = host.getState();
      const uses = allNames(st);
      const todo = [...uses.keys()].filter(n => !cache[n]);
      for (let i = 0; i < todo.length; i += BATCH) {
        progress = `Проверяю названия: ${Math.min(i + BATCH, todo.length)} из ${todo.length}…`; render();
        const chunk = todo.slice(i, i + BATCH);
        const payload = { contents: [{ parts: [{ text: namesPrompt(chunk) }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.1 } };
        // быстрая модель справляется с правилами выше и имеет больший дневной лимит; запасная — полная
        const res = await host.ask(payload).catch(() => host.ask(payload, 'gemini-flash-latest'));
        const text = res.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
        parseNames(text, chunk).forEach((v, k) => { cache[k] = v; });
        ls.set(CACHE_KEY, JSON.stringify(cache));
      }
      renames = [...uses.entries()]
        .filter(([n]) => cache[n] && cache[n].name !== n)
        .map(([n, u]) => ({ from: n, to: cache[n].name, uses: u, on: true }))
        .sort((a, b) => b.uses - a.uses);
      progress = 'Сверяю цены с чеками…'; render();
      prices = await planPrices(st);
      scanned = true;
    } catch (e) {
      error = `Не удалось проверить: ${(e as Error).message || e}. Проверьте интернет и ключ Gemini.`;
    } finally { busy = false; progress = ''; render(); }
  }

  /** Цены по последним покупкам; пустые — оценка ИИ. Название берётся уже нормальное. */
  async function planPrices(st: TidyState): Promise<PriceChange[]> {
    const buys = purchases(st, info);
    const groups = new Map<string, PriceChange>();
    const visit = (where: string, it: TidyItem) => {
      const name = cache[it.name]?.name || it.name;
      const unit = it.unit || 'шт';
      const key = `${normName(name)}|${unit}|${Number(it.price) || 0}|${!!it.priceEstimated}`;
      const g = groups.get(key);
      if (g) { g.refs.push(it); if (!g.where.includes(where)) g.where += ', ' + where; return; }
      groups.set(key, { key, where, name, unit, from: Number(it.price) || 0, fromEst: !!it.priceEstimated, to: 0, est: true, source: '', on: true, refs: [it] });
    };
    st.lists.forEach(l => l.items.forEach(it => visit(l.isMain ? 'Недавние' : l.title, it)));
    st.favorite.forEach(it => visit('Избранное', it));
    st.backlog.forEach(it => visit('Отложено', it));

    const out: PriceChange[] = [];
    const needAi: PriceChange[] = [];
    for (const g of groups.values()) {
      const k = normName(g.name);
      const base = normName(cache[g.refs[0].name]?.base || g.name);
      const exact = buys.find(b => b.key === k && priceFor(b, g.unit) != null);
      // похожий товар (та же группа) — только для товаров совсем без цены: «Сыр» ≠ «Пармезан»
      const similar = exact || g.from > 0 ? null : buys.find(b => b.base === base && priceFor(b, g.unit) != null);
      const hit = exact || similar;
      if (hit) {
        const p = round2(priceFor(hit, g.unit)!);
        const est = !exact;
        // реальную цену меняем только на точную покупку того же товара
        if (g.from > 0 && !g.fromEst && !exact) continue;
        if (g.from > 0 && Math.abs(p - g.from) < 0.01 && g.fromEst === est) continue;
        g.to = p; g.est = est;
        g.source = `${exact ? 'чек' : 'похожий товар'}${hit.store ? ' ' + hit.store : ''}${hit.date ? ', ' + hit.date.split('-').reverse().slice(0, 2).join('.') : ''}`;
        out.push(g);
      } else if (!(g.from > 0)) needAi.push(g);
    }
    if (needAi.length && host.hasKey()) {
      progress = `Оцениваю цены без чеков: ${needAi.length}…`; render();
      try {
        const est = await host.estimate(needAi.map(g => ({ name: g.name, unit: g.unit })));
        needAi.forEach((g, i) => { const p = est[i]; if (p) { g.to = p; g.est = true; g.source = 'оценка ИИ'; out.push(g); } });
      } catch { /* без оценки */ }
    }
    return out.sort((a, b) => Number(a.est) - Number(b.est) || a.name.localeCompare(b.name, 'ru'));
  }

  async function apply(): Promise<void> {
    const rn = renames.filter(r => r.on && r.to.trim() && r.to.trim() !== r.from);
    const pc = prices.filter(p => p.on);
    if (!rn.length && !pc.length) { host.toast('Ничего не выбрано'); return; }
    try { await host.backup('before-tidy'); } catch { /* копия не удалась — всё равно есть «Отменить» */ }
    const undo = host.makeUndo(['lists', 'recent', 'favorite', 'backlog', 'priceHistory', 'products'], 'Порядок отменён');
    const st = host.getState();
    const map = new Map(rn.map(r => [r.from, r.to.trim()]));
    const ren = (n: string) => map.get(n) ?? n;
    // цены — до переименования (ссылки на сами объекты)
    pc.forEach(p => p.refs.forEach(it => { it.price = p.to; it.priceEstimated = p.est; if (p.est) it.basePrice = p.to; else delete it.basePrice; }));
    st.lists.forEach(l => l.items.forEach(i => { i.name = ren(i.name); }));
    [st.recent, st.favorite, st.backlog].forEach(c => c.forEach(i => { i.name = ren(i.name); }));
    st.priceHistory.forEach(p => { p.productName = ren(p.productName); });
    // база товаров: переименовать, слить дубли, запомнить старое название как псевдоним для будущих чеков
    for (const [from, to] of map) {
      const kFrom = normName(from), kTo = normName(to);
      const old = st.products.find(p => normName(p.name) === kFrom);
      let target = st.products.find(p => normName(p.name) === kTo && p !== old);
      if (old && target) {
        target.aliases = [...new Set([...(target.aliases || []), ...(old.aliases || []), from])];
        target.links = [...new Set([...(target.links || []), ...(old.links || [])])].filter(id => id !== target!.id && id !== old.id);
        if (!(target.price > 0) && old.price > 0) { target.price = old.price; target.priceEstimated = old.priceEstimated; }
        st.products.splice(st.products.indexOf(old), 1);
        st.products.forEach(p => { if (p.links) p.links = [...new Set(p.links.map(id => (id === old.id ? target!.id : id)))].filter(id => id !== p.id); });
      } else if (old) {
        old.name = to; old.aliases = [...new Set([...(old.aliases || []), from])]; old.updatedAt = Date.now();
      } else {
        if (!target) { upsertProduct(st.products, { name: to, unit: 'шт' }); target = st.products.find(p => normName(p.name) === kTo); }
        if (target) target.aliases = [...new Set([...(target.aliases || []), from])];
      }
    }
    // реальные цены — в базу товаров
    pc.filter(p => !p.est).forEach(p => upsertProduct(st.products, { name: ren(p.name), unit: p.unit, price: p.to, priceEstimated: false }));
    // переименованные — запоминаем, чтобы повторная проверка их не трогала
    map.forEach(to => { if (!cache[to]) cache[to] = { name: to, base: cache[[...map.entries()].find(([, t]) => t === to)![0]]?.base || to }; });
    ls.set(CACHE_KEY, JSON.stringify(cache));
    host.save();
    renames = []; prices = []; scanned = false;
    modal.classList.add('hidden');
    host.toast(`Готово: названий ${rn.length}, цен ${pc.length}. Копия базы сохранена`, undo);
  }

  // ---- окно ----
  const modal = document.createElement('div');
  modal.id = 'tidyModal';
  modal.className = 'modal-shell hidden fixed inset-0 z-[60] bg-black/55 flex items-end sm:items-center justify-center p-0 sm:p-4';
  modal.innerHTML = `<div class="modal-box w-full sm:max-w-lg h-[92vh] sm:h-[85vh] bg-white dark:bg-zinc-900 rounded-t-3xl sm:rounded-3xl shadow-2xl flex flex-col overflow-hidden">
    <div class="shrink-0 p-4 pb-2 flex items-center gap-2">
      <h3 class="flex-1 font-extrabold text-base">🧹 Навести порядок</h3>
      <button type="button" data-close-modal="tidyModal" class="w-9 h-9 rounded-xl hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-500">✕</button>
    </div>
    <div id="tidyBody" class="flex-1 overflow-y-auto px-4 pb-4"></div>
    <div id="tidyFoot" class="shrink-0 p-3 border-t border-slate-100 dark:border-zinc-800"></div>
  </div>`;
  document.body.appendChild(modal);
  setModalBackHandler('tidyModal', () => false);
  const body = modal.querySelector<HTMLElement>('#tidyBody')!;
  const foot = modal.querySelector<HTMLElement>('#tidyFoot')!;
  const btn = 'px-4 py-2.5 rounded-xl text-sm font-bold';
  const priceTxt = (n: number, est: boolean) => (n > 0 ? (est ? '≈' : '') + host.formatMoney(n) : '—');

  function render(): void {
    if (busy) {
      body.innerHTML = `<div class="py-16 text-center text-sm text-slate-500"><div class="text-3xl mb-3 animate-pulse">🧹</div>${esc(progress || 'Работаю…')}</div>`;
      foot.innerHTML = '';
      return;
    }
    if (!scanned) {
      body.innerHTML = `<div class="text-sm text-slate-600 dark:text-zinc-300 space-y-2 py-2">
        <p>Проверю все товары: списки, «Недавние», избранное, отложенное, историю покупок и базу товаров.</p>
        <ul class="list-disc pl-5 text-xs space-y-1 text-slate-500 dark:text-zinc-400">
          <li>сокращения из чеков станут нормальными названиями: «PiwTyskie0,5lPus» → «Пиво Tyskie 0,5 л, банка»;</li>
          <li>исправлю опечатки и разговорные слова: «Пудинг шоколандый», «Морожко»;</li>
          <li>цены возьму из последних чеков; где чеков нет и цены нет — оценю (≈);</li>
          <li>перед применением покажу все изменения — лишнее можно снять; копия базы сохранится автоматически.</li>
        </ul>
        ${error ? `<div class="p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 text-xs">${esc(error)}</div>` : ''}
      </div>`;
      foot.innerHTML = `<button type="button" data-td="scan" class="${btn} w-full bg-amber-500 hover:bg-amber-600 text-white">🔍 Проверить все товары</button>`;
      return;
    }
    const rOn = renames.filter(r => r.on).length, pOn = prices.filter(p => p.on).length;
    body.innerHTML = `
      ${error ? `<div class="mb-2 p-2.5 rounded-xl bg-rose-50 text-rose-700 text-xs">${esc(error)}</div>` : ''}
      <div class="flex items-center justify-between py-2">
        <div class="text-xs font-extrabold text-slate-600 dark:text-zinc-300">Названия · ${renames.length}</div>
        ${renames.length ? `<button type="button" data-td="all-r" class="text-[11px] font-bold text-amber-600">${rOn === renames.length ? 'снять все' : 'выбрать все'}</button>` : ''}
      </div>
      ${renames.length ? renames.map((r, i) => `<label class="flex items-start gap-2 py-1.5 border-b border-slate-100 dark:border-zinc-800">
        <input type="checkbox" data-td-r="${i}" ${r.on ? 'checked' : ''} class="mt-2 w-4 h-4 accent-amber-500 shrink-0">
        <div class="flex-1 min-w-0">
          <div class="text-[11px] text-slate-400 line-through break-words">${esc(r.from)}${r.uses > 1 ? ` <span class="no-underline">×${r.uses}</span>` : ''}</div>
          <input data-td-to="${i}" value="${esc(r.to)}" class="w-full text-sm font-semibold bg-transparent outline-none border-b border-transparent focus:border-amber-400">
        </div></label>`).join('') : '<div class="text-xs text-slate-400 py-2">Все названия в порядке ✓</div>'}
      <div class="flex items-center justify-between pt-4 pb-2">
        <div class="text-xs font-extrabold text-slate-600 dark:text-zinc-300">Цены · ${prices.length}</div>
        ${prices.length ? `<button type="button" data-td="all-p" class="text-[11px] font-bold text-amber-600">${pOn === prices.length ? 'снять все' : 'выбрать все'}</button>` : ''}
      </div>
      ${prices.length ? prices.map((p, i) => `<label class="flex items-center gap-2 py-1.5 border-b border-slate-100 dark:border-zinc-800">
        <input type="checkbox" data-td-p="${i}" ${p.on ? 'checked' : ''} class="w-4 h-4 accent-amber-500 shrink-0">
        <div class="flex-1 min-w-0">
          <div class="text-sm font-semibold truncate">${esc(p.name)} <span class="text-[11px] font-normal text-slate-400">за 1 ${esc(p.unit)}${p.refs.length > 1 ? ` · ×${p.refs.length}` : ''}</span></div>
          <div class="text-[11px] text-slate-400 truncate">${esc(p.source)} · ${esc(p.where)}</div>
        </div>
        <div class="shrink-0 text-right text-xs tabular-nums">
          <div class="text-slate-400 line-through">${priceTxt(p.from, p.fromEst)}</div>
          <div class="font-extrabold ${p.est ? 'text-slate-600 dark:text-zinc-300' : 'text-emerald-600'}">${priceTxt(p.to, p.est)}</div>
        </div></label>`).join('') : '<div class="text-xs text-slate-400 py-2">Цены актуальны ✓</div>'}`;
    foot.innerHTML = `<div class="flex gap-2">
      <button type="button" data-td="rescan" class="${btn} bg-slate-100 dark:bg-zinc-800">🔄</button>
      <button type="button" data-td="apply" ${rOn + pOn ? '' : 'disabled'} class="${btn} flex-1 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white">Применить: названий ${rOn}, цен ${pOn}</button>
    </div>`;
  }

  modal.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t === modal) { modal.classList.add('hidden'); return; }
    const act = t.closest<HTMLElement>('[data-td]')?.dataset.td;
    if (act === 'scan') void scan();
    else if (act === 'rescan') { scanned = false; void scan(); }
    else if (act === 'apply') void apply();
    else if (act === 'all-r') { const on = !renames.every(r => r.on); renames.forEach(r => { r.on = on; }); render(); }
    else if (act === 'all-p') { const on = !prices.every(p => p.on); prices.forEach(p => { p.on = on; }); render(); }
  });
  modal.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.tdR) { renames[+t.dataset.tdR].on = t.checked; render(); }
    if (t.dataset.tdP) { prices[+t.dataset.tdP].on = t.checked; render(); }
  });
  modal.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.tdTo) renames[+t.dataset.tdTo].to = t.value;
  });

  return {
    open() {
      document.getElementById('moreMenuDropdown')?.classList.add('hidden');
      if (!busy && !scanned) error = '';
      render();
      modal.classList.remove('hidden');
    },
    renameIncoming,
  };
}
