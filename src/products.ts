// Единая база товаров — справочник, не зависящий от списков.
// Из неё берут товары окно подбора, подсказки при вводе и оценка цен; её можно редактировать
// (добавлять, изменять, удалять товары). Новые товары из списков попадают в базу автоматически.
import { canonicalKey, hintPrice, normName } from './price-hints';
import { setModalBackHandler } from './native';

export interface Product {
  id: string;
  name: string;
  /** id отдела (категории каталога), 'other' — «Прочее» */
  cat: string;
  unit: string;
  /** цена за единицу, PLN; 0 — неизвестна */
  price: number;
  /** цена — ориентир «≈», а не цена из чека/ввода */
  priceEstimated: boolean;
  tags: string[];
  /** ручные связи «С этим берут» — id других товаров (двусторонние) */
  links?: string[];
  /** добавлен пользователем или из его списков (не из встроенного каталога) */
  custom?: boolean;
  updatedAt?: number;
  /** другие написания (сокращения из чеков и т.п.) — новые чеки получают нормальное название */
  aliases?: string[];
}

export interface Category { id: string; label: string; icon: string; group: string }
export interface Tag { id: string; label: string; icon: string }

/** Встроенный товар каталога: название, единица, отдел, метки. */
export interface SeedProduct { name: string; unit: string; cat: string; tags: string[] }

export interface ItemLike { name: string; unit?: string; price?: number; priceEstimated?: boolean }

export const OTHER_CATEGORY: Category = { id: 'other', label: 'Прочее', icon: '📦', group: 'home' };
export const UNITS = ['шт', 'кг', 'г', 'л', 'мл', 'уп'];

export const productKey = (name: string): string => normName(name);
const newId = () => 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);

/** Отдел для нового товара: по совпадению с базой (точно → по началу/вхождению названия). */
export function guessCategory(name: string, products: Product[]): string {
  const k = productKey(name);
  const exact = products.find(p => productKey(p.name) === k && p.cat !== 'other');
  if (exact) return exact.cat;
  // через справочник синонимов: «Орешки» → «орехи» → отдел товара «Орехи»
  const canon = canonicalKey(name);
  if (canon) {
    const viaCanon = products.find(p => productKey(p.name) === canon && p.cat !== 'other');
    if (viaCanon) return viaCanon.cat;
  }
  const partial = products
    .filter(p => p.cat !== 'other')
    .map(p => ({ p, pk: productKey(p.name) }))
    .filter(({ pk }) => pk.length > 2 && (k.startsWith(pk + ' ') || k.includes(pk) || pk.includes(k)))
    .sort((a, b) => b.pk.length - a.pk.length)[0];
  return partial ? partial.p.cat : 'other';
}

/** Первичное заполнение базы: встроенный каталог + все товары пользователя из списков и разделов. */
/** Товар из поставляемой базы src/data/products.json (связи — по названиям). */
export interface BundledProduct {
  name: string; cat: string; unit: string;
  price?: number; priceEstimated?: boolean; tags?: string[]; links?: string[];
}

export function seedProducts(builtIn: SeedProduct[], userItems: ItemLike[], bundled: BundledProduct[] = []): Product[] {
  const out: Product[] = [];
  const seen = new Set<string>();
  // 1) поставляемая база: отделы, цены, метки и связи уже размечены
  for (const b of bundled) {
    const k = productKey(b.name);
    if (!b.name || seen.has(k)) continue;
    seen.add(k);
    const h = b.price ? null : hintPrice(b.name, b.unit);
    out.push({
      id: newId(), name: b.name, cat: b.cat || 'other', unit: b.unit || 'шт',
      price: b.price || h?.price || 0, priceEstimated: b.price ? !!b.priceEstimated : !!h, tags: [...(b.tags || [])],
    });
  }
  const linkNames = new Map(bundled.filter(b => b.links?.length).map(b => [productKey(b.name), b.links!]));
  // 2) встроенный каталог — то, чего нет в поставляемой базе
  for (const b of builtIn) {
    const k = productKey(b.name);
    if (seen.has(k)) continue;
    seen.add(k);
    const h = hintPrice(b.name, b.unit);
    out.push({ id: newId(), name: b.name, cat: b.cat, unit: b.unit, price: h?.price || 0, priceEstimated: !!h, tags: [...b.tags] });
  }
  for (const it of userItems) {
    const name = String(it.name || '').trim();
    const k = productKey(name);
    if (!name || seen.has(k)) continue;
    seen.add(k);
    out.push({
      id: newId(), name, cat: guessCategory(name, out), unit: it.unit || 'шт',
      price: Number(it.price) > 0 ? Number(it.price) : 0, priceEstimated: Number(it.price) > 0 ? !!it.priceEstimated : false,
      tags: [], custom: true,
    });
  }
  // связи из поставляемой базы: названия → id
  if (linkNames.size) {
    const byKey = new Map(out.map(p => [productKey(p.name), p]));
    linkNames.forEach((names, k) => {
      const p = byKey.get(k);
      if (p) p.links = names.map(n => byKey.get(productKey(n))?.id).filter((id): id is string => !!id);
    });
  }
  return out;
}

/**
 * Добавляет товар в базу, если его там нет; если есть — дополняет неизвестную цену.
 * Возвращает true, если база изменилась.
 */
export function upsertProduct(products: Product[], it: ItemLike): boolean {
  const name = String(it.name || '').trim();
  if (!name) return false;
  const k = productKey(name);
  const existing = products.find(p => productKey(p.name) === k);
  const price = Number(it.price) || 0;
  if (existing) {
    // реальная цена важнее ориентировочной; ориентир не затирает реальную
    if (price > 0 && (!(existing.price > 0) || (existing.priceEstimated && !it.priceEstimated))) {
      existing.price = price;
      existing.priceEstimated = !!it.priceEstimated;
      existing.updatedAt = Date.now();
      return true;
    }
    return false;
  }
  products.push({
    id: newId(), name, cat: guessCategory(name, products), unit: it.unit || 'шт',
    price: price > 0 ? price : 0, priceEstimated: price > 0 ? !!it.priceEstimated : false,
    tags: [], custom: true, updatedAt: Date.now(),
  });
  return true;
}

export const findProduct = (products: Product[], name: string): Product | undefined =>
  products.find(p => productKey(p.name) === productKey(name))
  || products.find(p => (p.aliases || []).some(a => productKey(a) === productKey(name)));

// ==================== Окно «📚 База товаров» ====================
export interface ProductsUiDeps {
  getProducts: () => Product[];
  categories: () => Category[];
  tags: Tag[];
  iconFor: (name: string) => string;
  formatMoney: (n: number) => string;
  /** сохранить базу (и перерисовать приложение) */
  save: () => void;
  /** снимок для «Отменить»; возвращает функцию отмены */
  makeUndo: (label: string) => () => void;
  toast: (msg: string, undo?: (() => void) | null) => void;
  /** добавить товар в главный список «Недавние» */
  addToMain: (p: Product) => void;
  /** вызывается после изменений базы (например, перерисовать окно подбора) */
  onChanged?: () => void;
  /** связанные товары (src/associations.ts) */
  associations?: (name: string) => { name: string; reason: string }[];
  /** ИИ: отдел для каждого названия (null — не уверен) */
  aiCategorize?: (names: string[]) => Promise<(string | null)[]>;
}

const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function initProductsUi(deps: ProductsUiDeps): { open: (catId?: string) => void } {
  // «Назад» Android: из редактора — к списку, из отдела — ко всем товарам
  setModalBackHandler('productsModal', () => {
    if (ui.editing) { ui.editing = null; render(); return true; }
    if (ui.cat !== 'all') { ui.cat = 'all'; render(); return true; }
    return false;
  });
  const ui = { query: '', cat: 'all', editing: null as Product | 'new' | null };

  const modal = document.createElement('div');
  modal.id = 'productsModal';
  modal.className = 'modal-shell hidden fixed inset-0 z-[55] bg-black/55 flex items-end sm:items-center justify-center p-0 sm:p-4';
  modal.innerHTML = `
    <div class="modal-box relative w-full sm:max-w-xl h-[92vh] sm:h-[86vh] bg-white dark:bg-zinc-900 rounded-t-3xl sm:rounded-3xl shadow-2xl flex flex-col overflow-hidden">
      <div class="shrink-0 bg-amber-500 text-white px-3 pt-3 pb-2 space-y-2">
        <div class="flex items-center gap-2">
          <h3 class="flex-1 font-extrabold text-base">📚 База товаров <span id="pdCount" class="opacity-80 font-bold text-sm"></span></h3>
          <button type="button" data-close-modal="productsModal" class="w-9 h-9 rounded-xl hover:bg-white/15 font-bold" title="Закрыть">✕</button>
        </div>
        <input type="search" id="pdSearch" autocomplete="off" placeholder="Найти товар…" class="w-full h-9 px-3 rounded-xl bg-white text-zinc-900 text-sm outline-none placeholder:text-slate-400" />
        <div id="pdCats" data-no-swipe class="flex gap-1.5 overflow-x-auto no-scrollbar -mx-3 px-3 pb-0.5"></div>
        <button type="button" id="pdAiCatBtn" class="hidden w-full py-1.5 rounded-xl bg-violet-600 hover:bg-violet-700 text-white text-xs font-bold"></button>
      </div>
      <div id="pdBody" class="flex-1 overflow-y-auto p-3 pb-24"></div>
      <button type="button" id="pdAddBtn" class="absolute right-4 bottom-4 px-5 py-3 rounded-full bg-amber-500 hover:bg-amber-600 active:scale-95 text-white font-extrabold text-sm shadow-xl">+ Товар</button>
    </div>`;
  document.body.appendChild(modal);
  const $ = <T extends HTMLElement>(sel: string) => modal.querySelector<T>(sel)!;

  const catOf = (id: string) => deps.categories().find(c => c.id === id) || OTHER_CATEGORY;

  function renderCats(): void {
    const products = deps.getProducts();
    const counts = new Map<string, number>();
    products.forEach(p => counts.set(p.cat, (counts.get(p.cat) || 0) + 1));
    const chip = (id: string, label: string, n: number) =>
      `<button type="button" data-pd-cat="${id}" class="shrink-0 px-2.5 py-1 rounded-full text-[11px] font-bold whitespace-nowrap ${ui.cat === id ? 'bg-white text-amber-700' : 'bg-white/20 hover:bg-white/30'}">${label} <span class="opacity-70">${n}</span></button>`;
    $('#pdCats').innerHTML = chip('all', 'Все', products.length) +
      deps.categories().filter(c => counts.get(c.id)).map(c => chip(c.id, `${c.icon} ${esc(c.label)}`, counts.get(c.id)!)).join('');
    $('#pdCount').textContent = `(${products.length})`;
    const other = counts.get('other') || 0;
    const aiBtn = $('#pdAiCatBtn');
    aiBtn.classList.toggle('hidden', !other || !deps.aiCategorize || !!ui.editing);
    if (!aiRunning) aiBtn.textContent = `✨ Разложить «Прочее» по отделам с ИИ (${other})`;
  }

  function renderList(): void {
    const q = productKey(ui.query);
    const products = deps.getProducts()
      .filter(p => (ui.cat === 'all' || p.cat === ui.cat) && (!q || productKey(p.name).includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    $('#pdAddBtn').classList.remove('hidden');
    if (!products.length) {
      $('#pdBody').innerHTML = `<div class="text-center text-sm text-slate-500 dark:text-zinc-400 py-10">Ничего не найдено${ui.query ? `<br><button type="button" data-pd-new-from-query class="mt-3 px-4 py-2 rounded-xl bg-amber-500 text-white text-xs font-bold">+ Добавить «${esc(ui.query)}»</button>` : ''}</div>`;
      return;
    }
    $('#pdBody').innerHTML = `<div class="ks-rows">${products.map(p => {
      const cat = catOf(p.cat);
      return `<div data-pd-id="${p.id}" class="ks-row flex items-center gap-2 pl-2 pr-1.5 h-10 cursor-pointer">
        <span class="w-6 text-center shrink-0">${deps.iconFor(p.name)}</span>
        <span class="flex-1 min-w-0 truncate text-[13px] font-medium">${esc(p.name)}</span>
        ${ui.cat === 'all' ? `<span class="shrink-0 text-[10px] text-slate-400 dark:text-zinc-500 max-w-[30%] truncate">${cat.icon} ${esc(cat.label)}</span>` : ''}
        <span class="shrink-0 text-[11px] font-bold tabular-nums ${p.price > 0 ? (p.priceEstimated ? 'text-slate-500 dark:text-zinc-400' : '') : 'text-slate-300 dark:text-zinc-600'}">${p.price > 0 ? (p.priceEstimated ? '≈' : '') + deps.formatMoney(p.price) : '—'}</span>
        <span class="shrink-0 min-w-[2.25rem] text-center px-1 py-0.5 rounded-md bg-black/5 dark:bg-white/10 text-[10px] font-semibold">${esc(p.unit)}</span>
      </div>`;
    }).join('')}</div>`;
  }

  function renderEditor(): void {
    const isNew = ui.editing === 'new';
    const p: Product = isNew
      ? { id: '', name: ui.query.trim(), cat: ui.cat !== 'all' ? ui.cat : 'other', unit: 'шт', price: 0, priceEstimated: false, tags: [] }
      : ui.editing as Product;
    $('#pdAddBtn').classList.add('hidden');
    const field = 'w-full h-10 px-3 rounded-xl bg-slate-100 dark:bg-zinc-800 text-sm outline-none';
    $('#pdBody').innerHTML = `
      <form id="pdForm" class="space-y-3">
        <div class="flex items-center gap-2">
          <button type="button" data-pd-back class="w-9 h-9 rounded-xl hover:bg-slate-100 dark:hover:bg-zinc-800 font-extrabold" title="Назад">←</button>
          <h4 class="font-extrabold">${isNew ? 'Новый товар' : 'Изменить товар'}</h4>
        </div>
        <label class="block text-xs font-bold text-slate-500 dark:text-zinc-400">Название
          <input name="name" required value="${esc(p.name)}" class="${field} mt-1 text-zinc-900 dark:text-zinc-100" />
        </label>
        <div class="grid grid-cols-2 gap-2">
          <label class="block text-xs font-bold text-slate-500 dark:text-zinc-400">Отдел
            <select name="cat" class="${field} mt-1 text-zinc-900 dark:text-zinc-100">${deps.categories().map(c => `<option value="${c.id}" ${c.id === p.cat ? 'selected' : ''}>${c.icon} ${esc(c.label)}</option>`).join('')}</select>
          </label>
          <label class="block text-xs font-bold text-slate-500 dark:text-zinc-400">Единица
            <select name="unit" class="${field} mt-1 text-zinc-900 dark:text-zinc-100">${[...new Set([...UNITS, p.unit])].map(u => `<option ${u === p.unit ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select>
          </label>
        </div>
        <label class="block text-xs font-bold text-slate-500 dark:text-zinc-400">Цена за единицу, zł ${p.priceEstimated && p.price > 0 ? '<span class="font-normal">(сейчас ориентировочная ≈)</span>' : ''}
          <input name="price" type="number" step="0.01" min="0" inputmode="decimal" value="${p.price > 0 ? p.price : ''}" placeholder="неизвестна" class="${field} mt-1 text-zinc-900 dark:text-zinc-100" />
        </label>
        <div>
          <div class="text-xs font-bold text-slate-500 dark:text-zinc-400 mb-1">Метки</div>
          <div class="flex flex-wrap gap-1.5">${deps.tags.map(t => `
            <label class="cursor-pointer"><input type="checkbox" name="tags" value="${t.id}" ${p.tags.includes(t.id) ? 'checked' : ''} class="peer hidden" />
              <span class="inline-block px-2.5 py-1 rounded-full border text-[11px] font-bold border-slate-200 dark:border-zinc-700 peer-checked:bg-amber-500 peer-checked:border-amber-500 peer-checked:text-white">${t.icon} ${esc(t.label)}</span></label>`).join('')}
          </div>
        </div>
        ${!isNew ? '<div id="pdLinks"></div>' : ''}
        <div class="flex flex-wrap items-center gap-2 pt-2">
          <button type="submit" class="px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-sm font-bold">Сохранить</button>
          ${!isNew ? `<button type="button" data-pd-to-main class="px-3 py-2.5 rounded-xl bg-amber-100 dark:bg-amber-500/20 text-amber-900 dark:text-amber-300 text-sm font-bold">+ В «Недавние»</button>` : ''}
          ${!isNew ? `<button type="button" data-pd-delete class="ml-auto px-3 py-2.5 rounded-xl text-sm font-bold text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40">Удалить</button>` : ''}
        </div>
      </form>`;
    const nameInput = $<HTMLInputElement>('#pdForm input[name="name"]');
    if (isNew) nameInput.focus(); else renderLinks(p);
  }

  /** Блок «🔗 С этим берут»: ручные связи (с ✕) и подсказки (тап — открыть товар). */
  function renderLinks(p: Product): void {
    const el = modal.querySelector<HTMLElement>('#pdLinks');
    if (!el) return;
    const all = deps.getProducts();
    const manual = (p.links || []).map(id => all.find(x => x.id === id)).filter((x): x is Product => !!x);
    const manualKeys = new Set(manual.map(x => productKey(x.name)));
    const auto = (deps.associations?.(p.name) || []).filter(s => !manualKeys.has(productKey(s.name))).slice(0, 8);
    el.innerHTML = `
      <div class="text-xs font-bold text-slate-500 dark:text-zinc-400 mb-1">🔗 С этим берут</div>
      <div class="flex flex-wrap gap-1.5">
        ${manual.map(x => `<span class="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full bg-amber-500 text-white text-[11px] font-bold">${esc(x.name)}<button type="button" data-pd-unlink="${x.id}" class="w-5 h-5 rounded-full hover:bg-white/20" title="Убрать связь">✕</button></span>`).join('')}
        ${auto.map(s => `<button type="button" data-pd-goto="${esc(s.name)}" title="${esc(s.reason)}" class="px-2.5 py-1 rounded-full bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 text-amber-900 dark:text-amber-300 text-[11px] font-bold">${esc(s.name)} <span class="font-normal opacity-60">· ${esc(s.reason)}</span></button>`).join('')}
        ${!manual.length && !auto.length ? '<span class="text-[11px] text-slate-400">Связей пока нет</span>' : ''}
      </div>
      <div class="flex gap-1.5 mt-2">
        <input id="pdLinkInput" list="pdAllNames" autocomplete="off" placeholder="Связать с товаром…" class="flex-1 min-w-0 h-9 px-3 rounded-xl bg-slate-100 dark:bg-zinc-800 text-sm outline-none" />
        <button type="button" data-pd-link class="px-3 h-9 rounded-xl bg-slate-200 dark:bg-zinc-700 text-xs font-bold">+ Связать</button>
      </div>
      <datalist id="pdAllNames">${all.filter(x => x !== p).map(x => `<option value="${esc(x.name)}">`).join('')}</datalist>`;
  }

  function setLink(a: Product, b: Product, on: boolean): void {
    const upd = (x: Product, id: string) => {
      const s = new Set(x.links || []);
      if (on) s.add(id); else s.delete(id);
      x.links = [...s];
    };
    upd(a, b.id); upd(b, a.id);
    deps.save();
    renderLinks(a);
  }

  function render(): void {
    renderCats();
    if (ui.editing) renderEditor(); else renderList();
  }

  function changed(): void { deps.save(); deps.onChanged?.(); }

  let aiRunning = false;
  async function aiCategorize(): Promise<void> {
    if (aiRunning || !deps.aiCategorize) return;
    const targets = deps.getProducts().filter(p => p.cat === 'other');
    if (!targets.length) return;
    aiRunning = true;
    $('#pdAiCatBtn').textContent = `✨ ИИ раскладывает ${targets.length} товар(ов)…`;
    const undo = deps.makeUndo('Раскладка по отделам отменена');
    try {
      const cats = await deps.aiCategorize(targets.map(p => p.name));
      let moved = 0;
      targets.forEach((p, i) => { const c = cats[i]; if (c && c !== 'other') { p.cat = c; moved++; } });
      changed();
      deps.toast(`Разложено по отделам: ${moved} из ${targets.length}`, moved ? undo : null);
    } catch {
      deps.toast('Не удалось: нет ключа Gemini, интернета или исчерпан лимит');
    } finally {
      aiRunning = false;
      render();
    }
  }

  modal.addEventListener('input', (e) => {
    if ((e.target as HTMLElement).id === 'pdSearch') { ui.query = (e.target as HTMLInputElement).value; ui.editing = null; renderList(); }
  });

  modal.addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const fd = new FormData(form);
    const name = String(fd.get('name') || '').trim();
    if (!name) return;
    const products = deps.getProducts();
    const dup = products.find(p => productKey(p.name) === productKey(name) && p !== ui.editing);
    if (dup) { deps.toast(`«${dup.name}» уже есть в базе`); return; }
    const priceRaw = String(fd.get('price') || '').replace(',', '.');
    const price = Math.max(0, parseFloat(priceRaw) || 0);
    const undo = deps.makeUndo(ui.editing === 'new' ? 'Добавление отменено' : 'Изменение отменено');
    if (ui.editing === 'new') {
      products.push({ id: newId(), name, cat: String(fd.get('cat')), unit: String(fd.get('unit')), price, priceEstimated: false, tags: fd.getAll('tags').map(String), custom: true, updatedAt: Date.now() });
      deps.toast(`«${name}» добавлен в базу`, undo);
    } else if (ui.editing) {
      const p = ui.editing;
      const priceChanged = Math.abs(price - (p.price || 0)) > 0.001;
      Object.assign(p, {
        name, cat: String(fd.get('cat')), unit: String(fd.get('unit')), price,
        priceEstimated: priceChanged ? false : p.priceEstimated && price > 0,
        tags: fd.getAll('tags').map(String), updatedAt: Date.now(),
      });
      deps.toast(`«${name}» сохранён`, undo);
    }
    ui.editing = null;
    changed();
    render();
  });

  modal.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t === modal) { modal.classList.add('hidden'); return; }
    const cat = t.closest<HTMLElement>('[data-pd-cat]');
    if (cat) { ui.cat = cat.dataset.pdCat!; ui.editing = null; render(); return; }
    if (t.closest('#pdAiCatBtn')) { void aiCategorize(); return; }
    if (t.closest('#pdAddBtn') || t.closest('[data-pd-new-from-query]')) { ui.editing = 'new'; render(); return; }
    if (t.closest('[data-pd-back]')) { ui.editing = null; render(); return; }
    const row = t.closest<HTMLElement>('[data-pd-id]');
    if (row) { ui.editing = deps.getProducts().find(p => p.id === row.dataset.pdId) || null; render(); return; }
    const editing = ui.editing;
    if (editing && editing !== 'new') {
      if (t.closest('[data-pd-delete]')) {
        const undo = deps.makeUndo('Товар возвращён в базу');
        const products = deps.getProducts();
        products.splice(products.indexOf(editing), 1);
        ui.editing = null;
        changed();
        render();
        deps.toast(`«${editing.name}» удалён из базы`, undo);
        return;
      }
      if (t.closest('[data-pd-to-main]')) { deps.addToMain(editing); return; }
      const unlink = t.closest<HTMLElement>('[data-pd-unlink]');
      if (unlink) { const other = deps.getProducts().find(x => x.id === unlink.dataset.pdUnlink); if (other) setLink(editing, other, false); return; }
      if (t.closest('[data-pd-link]')) {
        const name = modal.querySelector<HTMLInputElement>('#pdLinkInput')?.value.trim() || '';
        const other = name ? findProduct(deps.getProducts(), name) : undefined;
        if (!other) { deps.toast(name ? `«${name}» нет в базе — сначала добавьте товар` : 'Выберите товар для связи'); return; }
        if (other === editing) return;
        setLink(editing, other, true);
        deps.toast(`Связано: «${editing.name}» ↔ «${other.name}»`);
        return;
      }
      const go = t.closest<HTMLElement>('[data-pd-goto]');
      if (go) {
        const other = findProduct(deps.getProducts(), go.dataset.pdGoto || '');
        if (other) { ui.editing = other; render(); }
        else deps.toast(`«${go.dataset.pdGoto}» нет в базе`);
        return;
      }
    }
  });

  return {
    open(catId?: string) {
      ui.editing = null;
      ui.query = '';
      ui.cat = catId || 'all';
      $<HTMLInputElement>('#pdSearch').value = '';
      document.getElementById('moreMenuDropdown')?.classList.add('hidden');
      modal.classList.remove('hidden');
      render();
    },
  };
}
