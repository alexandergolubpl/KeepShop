// Дисконтные карты (по образцу Catima): список, добавление сканом камеры / из фото / вручную,
// просмотр с крупным штрихкодом, редактирование, удаление с отменой.
// Карты хранятся в общей базе приложения (state.cards) и попадают в резервные копии.
import { setModalBackHandler } from './native';
import { exportCatimaZip, importCardsFile } from './cards-io';

export type BarcodeType =
  | 'qr_code' | 'ean_13' | 'ean_8' | 'upc_a' | 'upc_e' | 'code_128' | 'code_39' | 'code_93'
  | 'itf' | 'pdf417' | 'aztec' | 'data_matrix' | 'codabar' | 'none';

export interface LoyaltyCard {
  id: string;
  store: string;
  cardId: string;
  barcodeType: BarcodeType;
  color: string;
  note: string;
  balance: string;
  expiry: string;        // YYYY-MM-DD или ''
  starred: boolean;
  /** значение штрихкода, если отличается от номера карты (barcodeid в Catima) */
  barcodeValue?: string;
  frontImage?: string;   // data:image/jpeg;base64,… (сжатое)
  backImage?: string;
  createdAt: number;
  lastUsed?: number;
}

export interface CardsDeps {
  getCards: () => LoyaltyCard[];
  save: () => void;
  makeUndo: (label: string) => () => void;
  toast: (msg: string, undo?: (() => void) | null) => void;
  /** сохранить/поделиться файлом (в APK — системное меню «Поделиться») */
  saveFile: (blob: Blob, filename: string) => void;
}

export const BARCODE_TYPES: { id: BarcodeType; label: string; bcid: string }[] = [
  { id: 'code_128', label: 'Code 128', bcid: 'code128' },
  { id: 'ean_13', label: 'EAN-13', bcid: 'ean13' },
  { id: 'qr_code', label: 'QR-код', bcid: 'qrcode' },
  { id: 'ean_8', label: 'EAN-8', bcid: 'ean8' },
  { id: 'upc_a', label: 'UPC-A', bcid: 'upca' },
  { id: 'upc_e', label: 'UPC-E', bcid: 'upce' },
  { id: 'code_39', label: 'Code 39', bcid: 'code39' },
  { id: 'code_93', label: 'Code 93', bcid: 'code93' },
  { id: 'itf', label: 'ITF', bcid: 'interleaved2of5' },
  { id: 'pdf417', label: 'PDF417', bcid: 'pdf417' },
  { id: 'aztec', label: 'Aztec', bcid: 'azteccode' },
  { id: 'data_matrix', label: 'Data Matrix', bcid: 'datamatrix' },
  { id: 'codabar', label: 'Codabar', bcid: 'rationalizedCodabar' },
  { id: 'none', label: 'Без штрихкода', bcid: '' },
];
const TWO_D: BarcodeType[] = ['qr_code', 'aztec', 'data_matrix'];

// Известные сети: цвет карты подставляется автоматически (можно поменять)
const BRAND_COLORS: [RegExp, string][] = [
  [/biedronk/i, '#e30613'], [/lidl/i, '#0050aa'], [/[zż]abk/i, '#00a651'], [/auchan/i, '#e2001a'],
  [/carrefour/i, '#004e9f'], [/kaufland/i, '#e10915'], [/rossmann/i, '#c8102e'], [/hebe/i, '#e5006d'],
  [/pepco/i, '#0055a5'], [/action/i, '#0f3c8c'], [/ikea/i, '#0058a3'], [/decathlon/i, '#0082c3'],
  [/media ?expert/i, '#e30613'], [/orlen/i, '#e2001a'], [/shell/i, '#fbce07'], [/circle ?k/i, '#ee3124'],
  [/dino/i, '#e30613'], [/netto/i, '#ffd100'], [/stokrotk/i, '#6db33f'], [/empik/i, '#e50050'],
  [/leroy/i, '#78be20'], [/castorama/i, '#0078d7'], [/obi\b/i, '#ff7900'], [/h&m|h ?& ?m/i, '#e50010'],
  [/zara/i, '#111111'], [/sephora/i, '#111111'], [/douglas/i, '#9bdcd2'], [/mcdonald/i, '#ffc72c'],
  [/starbucks/i, '#00704a'], [/пят[её]рочк/i, '#e31e24'], [/магнит/i, '#e30613'], [/перекр[её]ст/i, '#00703c'],
];
const PALETTE = ['#e11d48', '#ea580c', '#f59e0b', '#16a34a', '#0d9488', '#0284c7', '#2563eb', '#7c3aed', '#c026d3', '#475569', '#111827', '#a16207'];

const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const newId = () => 'card-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
const brandColor = (store: string) => BRAND_COLORS.find(([re]) => re.test(store))?.[1] || '';
/** Цвет текста поверх цвета карты: тёмный на светлом фоне, белый на тёмном. */
function textOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.62 ? '#111827' : '#fff';
}
const fmtDate = (iso: string) => iso ? iso.split('-').reverse().join('.') : '';
const isExpired = (iso: string) => !!iso && iso < new Date().toISOString().slice(0, 10);

// ---------- Штрихкод: отрисовка (bwip-js, подгружается по требованию) ----------
type Bwip = typeof import('bwip-js/browser');
let bwipPromise: Promise<Bwip> | null = null;
const loadBwip = () => (bwipPromise ??= import('bwip-js/browser'));

export async function renderBarcodeSvg(type: BarcodeType, value: string, large = false): Promise<string> {
  const t = BARCODE_TYPES.find(b => b.id === type);
  if (!t || !t.bcid || !value) return '';
  const bwip = await loadBwip();
  const twoD = TWO_D.includes(type);
  return bwip.toSVG({
    bcid: t.bcid, text: value, scale: large ? 4 : 3,
    ...(twoD ? {} : { height: large ? 22 : 16 }),
    includetext: false, paddingwidth: 4, paddingheight: 4, backgroundcolor: 'FFFFFF',
  } as Parameters<Bwip['toSVG']>[0]);
}

// ---------- Штрихкод: распознавание ----------
interface Detected { value: string; type: BarcodeType }
const ZXING_TO_TYPE: Record<string, BarcodeType> = {
  QR_CODE: 'qr_code', EAN_13: 'ean_13', EAN_8: 'ean_8', UPC_A: 'upc_a', UPC_E: 'upc_e', CODE_128: 'code_128',
  CODE_39: 'code_39', CODE_93: 'code_93', ITF: 'itf', PDF_417: 'pdf417', AZTEC: 'aztec', DATA_MATRIX: 'data_matrix', CODABAR: 'codabar',
};
type NativeDetector = { detect: (src: CanvasImageSource | ImageBitmap) => Promise<{ rawValue: string; format: string }[]> };

async function nativeDetector(): Promise<NativeDetector | null> {
  const BD = (window as unknown as { BarcodeDetector?: { new(o?: { formats: string[] }): NativeDetector; getSupportedFormats(): Promise<string[]> } }).BarcodeDetector;
  if (!BD) return null;
  try {
    const formats = await BD.getSupportedFormats();
    return formats.length ? new BD({ formats }) : null;
  } catch { return null; }
}
const fromNative = (r: { rawValue: string; format: string }): Detected =>
  ({ value: r.rawValue, type: (BARCODE_TYPES.some(b => b.id === r.format) ? r.format : 'code_128') as BarcodeType });

/** Штрихкод на фото; null — не найден. */
async function decodeImage(file: Blob): Promise<Detected | null> {
  const det = await nativeDetector();
  if (det) {
    try {
      const bmp = await createImageBitmap(file);
      const res = await det.detect(bmp);
      if (res[0]) return fromNative(res[0]);
    } catch { /* пробуем zxing */ }
  }
  try {
    const { BrowserMultiFormatReader } = await import('@zxing/browser');
    const url = URL.createObjectURL(file);
    try {
      const r = await new BrowserMultiFormatReader().decodeFromImageUrl(url);
      const { BarcodeFormat } = await import('@zxing/library');
      return { value: r.getText(), type: ZXING_TO_TYPE[BarcodeFormat[r.getBarcodeFormat()]] || 'code_128' };
    } finally { URL.revokeObjectURL(url); }
  } catch { return null; }
}

/** Сжатие фото карты: до 720 px по длинной стороне, JPEG. */
async function compressImage(file: Blob): Promise<string> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 720 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.72);
}

// ==================== Интерфейс ====================
export function initCards(deps: CardsDeps): { open: () => void } {
  type View = { kind: 'list' } | { kind: 'view'; id: string } | { kind: 'edit'; card: LoyaltyCard; isNew: boolean } | { kind: 'scan' } | { kind: 'add' };
  let view: View = { kind: 'list' };
  let query = '';
  // вид списка карт: строки или цветные плитки (запоминается на устройстве)
  let listMode: 'list' | 'tiles' = (() => { try { return localStorage.getItem('keepshop_cards_view') === 'tiles' ? 'tiles' : 'list'; } catch { return 'list'; } })();
  let stopScan: (() => void) | null = null;

  const modal = document.createElement('div');
  modal.id = 'cardsModal';
  modal.className = 'modal-shell hidden fixed inset-0 z-[55] bg-black/55 flex items-end sm:items-center justify-center p-0 sm:p-4';
  modal.innerHTML = `<div id="cdBox" class="modal-box relative w-full sm:max-w-xl h-[94vh] sm:h-[88vh] bg-slate-50 dark:bg-zinc-950 rounded-t-3xl sm:rounded-3xl shadow-2xl flex flex-col overflow-hidden"></div>
    <input type="file" accept="image/*" id="cdPhotoInput" class="hidden" />
    <input type="file" accept=".csv,.zip,text/csv,application/zip,application/x-zip-compressed" id="cdImportInput" class="hidden" />
    <input type="file" accept="image/*" capture="environment" id="cdCameraPhotoInput" class="hidden" />`;
  document.body.appendChild(modal);
  const box = modal.querySelector<HTMLElement>('#cdBox')!;
  let photoTarget: 'decode' | 'front' | 'back' = 'decode';

  const cards = () => deps.getCards();
  const find = (id: string) => cards().find(c => c.id === id);

  const header = (title: string, left = '', right = '', color = '#4f46e5') => `
    <div class="shrink-0 px-3 pt-3 pb-3 flex items-center gap-2" style="background:${color};color:${textOn(color)}">
      ${left}
      <h3 class="flex-1 min-w-0 font-extrabold text-base truncate">${title}</h3>
      ${right}
      <button type="button" data-close-modal="cardsModal" class="w-9 h-9 rounded-xl hover:bg-black/10 font-bold shrink-0" title="Закрыть">✕</button>
    </div>`;
  const backBtn = `<button type="button" data-cd="back" class="w-9 h-9 rounded-xl hover:bg-black/10 font-extrabold text-lg shrink-0" title="Назад">←</button>`;
  const thumb = (c: LoyaltyCard, size = 'w-14 h-14 text-xl') => c.frontImage
    ? `<img src="${c.frontImage}" alt="" class="${size} rounded-xl object-cover shrink-0 border border-black/10" />`
    : `<div class="${size} rounded-xl shrink-0 flex items-center justify-center font-extrabold" style="background:${c.color};color:${textOn(c.color)}">${esc((c.store.trim()[0] || '?').toUpperCase())}</div>`;

  // ---------- Список ----------
  function renderList(): void {
    const q = query.trim().toLowerCase();
    const list = cards()
      .filter(c => !q || c.store.toLowerCase().includes(q) || c.note.toLowerCase().includes(q) || c.cardId.includes(q))
      .sort((a, b) => Number(b.starred) - Number(a.starred) || (b.lastUsed || 0) - (a.lastUsed || 0) || a.store.localeCompare(b.store, 'ru'));
    const tiles = listMode === 'tiles';
    const empty = `<div class="col-span-full text-center py-14 text-sm text-slate-500 dark:text-zinc-400">${q ? 'Ничего не найдено' : 'Карт пока нет.<br>Нажмите «+», чтобы отсканировать первую.'}</div>`;
    box.innerHTML = header(`💳 Дисконтные карты <span class="opacity-75 text-sm">(${cards().length})</span>`, '', `<button type="button" data-cd="io" class="h-9 px-2.5 rounded-xl hover:bg-black/10 font-bold text-xs shrink-0" title="Импорт и экспорт">⇅ Импорт</button>`) + `
      <div class="shrink-0 px-3 pt-3 flex items-center gap-2">
        <input type="search" id="cdSearch" value="${esc(query)}" placeholder="Найти карту…" autocomplete="off"
          class="flex-1 min-w-0 h-10 px-3 rounded-xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 text-sm outline-none" />
        <button type="button" data-cd="view" class="h-10 px-3 rounded-xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 text-xs font-bold whitespace-nowrap shrink-0" title="${tiles ? 'Показать списком' : 'Показать плитками'}">${tiles ? '☰ Список' : '▦ Плитки'}</button>
      </div>
      ${tiles ? `
      <div class="flex-1 overflow-y-auto p-3 pb-24 grid grid-cols-2 sm:grid-cols-3 gap-2.5 content-start">
        ${list.length ? list.map(c => {
          const fg = textOn(c.color);
          return `
          <div data-cd-open="${c.id}" class="relative aspect-[1.586] rounded-2xl p-3 flex flex-col justify-between cursor-pointer shadow-sm active:scale-[.98] transition overflow-hidden" style="background:${c.color};color:${fg}">
            <button type="button" data-cd-star="${c.id}" class="absolute top-1 right-1 w-8 h-8 rounded-xl text-base" style="opacity:${c.starred ? 1 : 0.35}" title="Избранная">★</button>
            <div class="font-extrabold text-base sm:text-lg leading-tight break-words line-clamp-3 pr-6">${esc(c.store)}</div>
            <div class="text-[11px] leading-snug font-semibold opacity-90 min-w-0">
              ${c.balance ? `<div class="truncate">${esc(c.balance)}</div>` : ''}
              ${c.expiry ? `<div class="truncate ${isExpired(c.expiry) ? 'underline' : ''}">${isExpired(c.expiry) ? 'Истекла' : 'до'} ${fmtDate(c.expiry)}</div>` : ''}
              ${!c.balance && !c.expiry && c.cardId ? `<div class="truncate font-mono opacity-80">•••• ${esc(c.cardId.slice(-4))}</div>` : ''}
            </div>
          </div>`;
        }).join('') : empty}
      </div>` : `
      <div class="flex-1 overflow-y-auto p-3 pb-24 space-y-2">
        ${list.length ? list.map(c => `
          <div data-cd-open="${c.id}" class="flex items-center gap-3 p-2.5 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 cursor-pointer active:scale-[.99] transition">
            ${thumb(c)}
            <div class="flex-1 min-w-0">
              <div class="font-extrabold text-sm truncate">${esc(c.store)}</div>
              ${c.balance ? `<div class="text-xs text-slate-600 dark:text-zinc-300">Баланс: <b>${esc(c.balance)}</b></div>` : ''}
              ${c.expiry ? `<div class="text-[11px] ${isExpired(c.expiry) ? 'text-rose-500 font-bold' : 'text-slate-400'}">${isExpired(c.expiry) ? 'Истекла' : 'До'} ${fmtDate(c.expiry)}</div>` : ''}
              ${c.note ? `<div class="text-[11px] text-slate-400 truncate">${esc(c.note)}</div>` : ''}
            </div>
            <button type="button" data-cd-star="${c.id}" class="w-9 h-9 rounded-xl text-lg ${c.starred ? 'text-amber-500' : 'text-slate-300 dark:text-zinc-600'}" title="Избранная">★</button>
          </div>`).join('') : empty}
      </div>`}
      <button type="button" data-cd="add" class="absolute right-4 bottom-4 w-14 h-14 rounded-2xl bg-indigo-600 hover:bg-indigo-700 active:scale-95 text-white text-3xl font-light shadow-xl" title="Добавить карту">+</button>`;
  }

  // ---------- Способ добавления ----------
  function renderAdd(): void {
    renderList();
    const sheet = document.createElement('div');
    sheet.className = 'absolute inset-0 bg-black/40 flex items-end';
    sheet.dataset.cd = 'list';
    sheet.innerHTML = `<div class="w-full bg-white dark:bg-zinc-900 rounded-t-3xl p-4 space-y-2" data-cd-sheet>
      <div class="font-extrabold mb-1">Добавить карту</div>
      <button type="button" data-cd="scan" class="w-full flex items-center gap-3 p-3 rounded-2xl bg-indigo-50 dark:bg-indigo-500/15 text-left"><span class="text-2xl">📷</span><span><b class="block text-sm">Сканировать камерой</b><span class="text-xs text-slate-500">Наведите на штрихкод или QR</span></span></button>
      <button type="button" data-cd="photo" class="w-full flex items-center gap-3 p-3 rounded-2xl bg-slate-100 dark:bg-zinc-800 text-left"><span class="text-2xl">🖼️</span><span><b class="block text-sm">Из фото</b><span class="text-xs text-slate-500">Найду штрихкод на снимке и сохраню фото карты</span></span></button>
      <button type="button" data-cd="manual" class="w-full flex items-center gap-3 p-3 rounded-2xl bg-slate-100 dark:bg-zinc-800 text-left"><span class="text-2xl">⌨️</span><span><b class="block text-sm">Ввести вручную</b><span class="text-xs text-slate-500">Номер карты и формат штрихкода</span></span></button>
    </div>`;
    box.appendChild(sheet);
  }

  // ---------- Импорт / экспорт (Catima) ----------
  function renderIo(): void {
    renderList();
    const sheet = document.createElement('div');
    sheet.className = 'absolute inset-0 bg-black/40 flex items-end';
    sheet.dataset.cd = 'list';
    sheet.innerHTML = `<div class="w-full bg-white dark:bg-zinc-900 rounded-t-3xl p-4 space-y-2">
      <div class="font-extrabold mb-1">Импорт и экспорт карт</div>
      <button type="button" data-cd="import" class="w-full flex items-center gap-3 p-3 rounded-2xl bg-indigo-50 dark:bg-indigo-500/15 text-left"><span class="text-2xl">📥</span><span><b class="block text-sm">Импорт из Catima или CSV</b><span class="text-xs text-slate-500">ZIP-экспорт Catima (вместе с фото), catima.csv или CSV с колонками «магазин» и «номер»</span></span></button>
      <button type="button" data-cd="export" class="w-full flex items-center gap-3 p-3 rounded-2xl bg-slate-100 dark:bg-zinc-800 text-left"><span class="text-2xl">📤</span><span><b class="block text-sm">Экспорт для Catima (ZIP)</b><span class="text-xs text-slate-500">Все карты с фото — можно открыть в Catima или сохранить на Drive</span></span></button>
      <p class="text-[11px] text-slate-400 px-1">В Catima: ⋮ → Импорт/экспорт → Экспорт. Если задан пароль, экспортируйте без него — зашифрованный архив прочитать нельзя.</p>
    </div>`;
    box.appendChild(sheet);
  }

  async function runImport(file: File): Promise<void> {
    deps.toast('Читаю файл…');
    try {
      const imported = await importCardsFile(file, compressImage);
      if (!imported.length) { deps.toast('В файле не найдено карт'); return; }
      const list = cards();
      const key = (c: LoyaltyCard) => c.store.trim().toLowerCase() + '|' + c.cardId.trim();
      const have = new Set(list.map(key));
      const undo = deps.makeUndo('Импорт карт отменён');
      let added = 0, dup = 0;
      for (const ic of imported) {
        if (have.has(key(ic.card))) { dup++; continue; }
        if (ic.archived) ic.card.note = [ic.card.note, '(была в архиве Catima)'].filter(Boolean).join('\n');
        list.push(ic.card);
        have.add(key(ic.card));
        added++;
      }
      deps.save();
      view = { kind: 'list' };
      render();
      deps.toast(`Импортировано карт: ${added}${dup ? `, уже были: ${dup}` : ''}`, added ? undo : null);
    } catch (e) {
      deps.toast('Импорт не удался: ' + ((e as Error)?.message || e));
    }
  }

  async function runExport(): Promise<void> {
    const list = cards();
    if (!list.length) { deps.toast('Нет карт для экспорта'); return; }
    try {
      const blob = await exportCatimaZip(list);
      const d = new Date();
      deps.saveFile(blob, `catima-keepshop-${d.toISOString().slice(0, 10)}.zip`);
      view = { kind: 'list' };
      render();
    } catch (e) {
      deps.toast('Экспорт не удался: ' + ((e as Error)?.message || e));
    }
  }

  // ---------- Сканер камеры ----------
  async function renderScan(): Promise<void> {
    box.innerHTML = header('📷 Наведите камеру на штрихкод', backBtn, '', '#111827') + `
      <div class="relative flex-1 bg-black overflow-hidden">
        <video id="cdVideo" playsinline muted class="absolute inset-0 w-full h-full object-cover"></video>
        <div class="absolute inset-x-8 top-1/2 -translate-y-1/2 h-48 rounded-3xl border-4 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,.45)]"></div>
        <div id="cdScanMsg" class="absolute inset-x-0 bottom-6 text-center text-white text-sm font-semibold px-4">Запуск камеры…</div>
      </div>
      <div class="shrink-0 p-3 bg-black flex gap-2">
        <button type="button" data-cd="photo" class="flex-1 py-2.5 rounded-xl bg-white/15 text-white text-sm font-bold">🖼️ Из фото</button>
        <button type="button" data-cd="manual" class="flex-1 py-2.5 rounded-xl bg-white/15 text-white text-sm font-bold">⌨️ Вручную</button>
      </div>`;
    const video = box.querySelector<HTMLVideoElement>('#cdVideo')!;
    const msg = box.querySelector<HTMLElement>('#cdScanMsg')!;
    let stopped = false;
    let stream: MediaStream | null = null;
    let zxingControls: { stop: () => void } | null = null;
    stopScan = () => {
      stopped = true;
      zxingControls?.stop();
      stream?.getTracks().forEach(t => t.stop());
      stopScan = null;
    };
    const found = (d: Detected) => {
      if (stopped) return;
      stopScan?.();
      try { navigator.vibrate?.(60); } catch { /* нет вибро */ }
      openEditor({ ...blankCard(), cardId: d.value, barcodeType: d.type }, true);
    };
    try {
      const det = await nativeDetector();
      if (det) {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        if (stopped) { stream.getTracks().forEach(t => t.stop()); return; }
        video.srcObject = stream;
        await video.play();
        msg.textContent = 'Держите штрихкод в рамке';
        const loop = async () => {
          if (stopped) return;
          try {
            const res = await det.detect(video);
            if (res[0]?.rawValue) { found(fromNative(res[0])); return; }
          } catch { /* кадр не готов */ }
          setTimeout(() => { void loop(); }, 180);
        };
        void loop();
      } else {
        const { BrowserMultiFormatReader } = await import('@zxing/browser');
        const { BarcodeFormat } = await import('@zxing/library');
        msg.textContent = 'Держите штрихкод в рамке';
        zxingControls = await new BrowserMultiFormatReader().decodeFromConstraints(
          { video: { facingMode: 'environment' } }, video,
          (r) => { if (r) found({ value: r.getText(), type: ZXING_TO_TYPE[BarcodeFormat[r.getBarcodeFormat()]] || 'code_128' }); });
        if (stopped) zxingControls.stop();
      }
    } catch (e) {
      const m = String((e as Error)?.message ?? e);
      msg.textContent = /permission|denied|NotAllowed/i.test(m) ? 'Нет доступа к камере. Разрешите камеру в настройках приложения или добавьте карту из фото.' : 'Камера недоступна: ' + m;
    }
  }

  // ---------- Редактор ----------
  function blankCard(): LoyaltyCard {
    return { id: newId(), store: '', cardId: '', barcodeType: 'code_128', color: PALETTE[6], note: '', balance: '', expiry: '', starred: false, createdAt: Date.now() };
  }

  function openEditor(card: LoyaltyCard, isNew: boolean): void {
    stopScan?.();
    view = { kind: 'edit', card: { ...card }, isNew };
    renderEditor();
  }

  async function refreshPreview(): Promise<void> {
    if (view.kind !== 'edit') return;
    const el = box.querySelector<HTMLElement>('#cdPreview');
    if (!el) return;
    const { barcodeType } = view.card;
    const cardId = view.card.barcodeValue || view.card.cardId;
    if (barcodeType === 'none' || !cardId) { el.innerHTML = '<div class="text-xs text-slate-400 py-6">Штрихкод появится здесь</div>'; return; }
    try {
      const svg = await renderBarcodeSvg(barcodeType, cardId);
      el.innerHTML = `<div class="cd-barcode mx-auto">${svg}</div>`;
    } catch {
      el.innerHTML = '<div class="text-xs text-rose-500 py-6">Номер не подходит для этого формата штрихкода</div>';
    }
  }

  function renderEditor(): void {
    if (view.kind !== 'edit') return;
    const c = view.card;
    const field = 'w-full h-10 px-3 rounded-xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 text-sm outline-none';
    const img = (key: 'front' | 'back', src?: string) => `
      <div class="flex-1">
        <div class="text-[11px] font-bold text-slate-500 mb-1">${key === 'front' ? 'Лицевая сторона' : 'Обратная сторона'}</div>
        ${src ? `<div class="relative"><img src="${src}" class="w-full h-24 object-cover rounded-xl border border-slate-200 dark:border-zinc-800" alt="" />
            <button type="button" data-cd-img-del="${key}" class="absolute top-1 right-1 w-7 h-7 rounded-lg bg-black/60 text-white text-xs">✕</button></div>`
          : `<div class="flex gap-1.5"><button type="button" data-cd-img="${key}" data-src="camera" class="flex-1 h-24 rounded-xl border-2 border-dashed border-slate-300 dark:border-zinc-700 text-xs text-slate-500">📷 Снять</button>
             <button type="button" data-cd-img="${key}" data-src="gallery" class="flex-1 h-24 rounded-xl border-2 border-dashed border-slate-300 dark:border-zinc-700 text-xs text-slate-500">🖼️ Галерея</button></div>`}
      </div>`;
    box.innerHTML = header(view.isNew ? 'Новая карта' : 'Изменить карту', backBtn, '', c.color) + `
      <form id="cdForm" class="flex-1 overflow-y-auto p-3 space-y-3">
        <div id="cdPreview" class="bg-white rounded-2xl border border-slate-200 dark:border-zinc-800 p-3 text-center min-h-[96px] flex items-center justify-center"></div>
        <label class="block text-xs font-bold text-slate-500">Магазин
          <input name="store" required value="${esc(c.store)}" list="cdStoreList" placeholder="Например, Biedronka" class="${field} mt-1 text-zinc-900 dark:text-zinc-100" /></label>
        <datalist id="cdStoreList">${['Biedronka', 'Lidl', 'Żabka', 'Auchan', 'Carrefour', 'Kaufland', 'Rossmann', 'Hebe', 'Pepco', 'Action', 'IKEA', 'Decathlon', 'Media Expert', 'Orlen', 'Shell', 'Circle K', 'Dino', 'Netto', 'Stokrotka', 'Empik', 'Leroy Merlin', 'Castorama', 'OBI', 'Douglas', 'Sephora'].map(s => `<option value="${s}">`).join('')}</datalist>
        <label class="block text-xs font-bold text-slate-500">Номер карты
          <input name="cardId" value="${esc(c.cardId)}" inputmode="text" autocomplete="off" class="${field} mt-1 font-mono text-zinc-900 dark:text-zinc-100" /></label>
        <label class="block text-xs font-bold text-slate-500">Формат штрихкода
          <select name="barcodeType" class="${field} mt-1 text-zinc-900 dark:text-zinc-100">${BARCODE_TYPES.map(b => `<option value="${b.id}" ${b.id === c.barcodeType ? 'selected' : ''}>${b.label}</option>`).join('')}</select></label>
        <div>
          <div class="text-xs font-bold text-slate-500 mb-1">Цвет</div>
          <div class="flex flex-wrap gap-2 items-center">
            ${PALETTE.map(p => `<button type="button" data-cd-color="${p}" class="w-8 h-8 rounded-full border-2 ${p === c.color ? 'border-zinc-900 dark:border-white scale-110' : 'border-transparent'}" style="background:${p}"></button>`).join('')}
            <input type="color" name="color" value="${esc(c.color)}" class="w-9 h-9 rounded-full border-0 bg-transparent cursor-pointer" title="Свой цвет" />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <label class="block text-xs font-bold text-slate-500">Баланс / баллы
            <input name="balance" value="${esc(c.balance)}" placeholder="—" class="${field} mt-1 text-zinc-900 dark:text-zinc-100" /></label>
          <label class="block text-xs font-bold text-slate-500">Действует до
            <input name="expiry" type="date" value="${esc(c.expiry)}" class="${field} mt-1 text-zinc-900 dark:text-zinc-100" /></label>
        </div>
        <label class="block text-xs font-bold text-slate-500">Заметка
          <textarea name="note" rows="2" class="w-full px-3 py-2 rounded-xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 text-sm outline-none mt-1 text-zinc-900 dark:text-zinc-100">${esc(c.note)}</textarea></label>
        <div class="flex gap-2">${img('front', c.frontImage)}${img('back', c.backImage)}</div>
        <label class="flex items-center gap-2 text-sm font-bold"><input type="checkbox" name="starred" ${c.starred ? 'checked' : ''} class="w-5 h-5 accent-amber-500" /> ★ Избранная (вверху списка)</label>
        <div class="flex gap-2 pt-1 pb-4">
          <button type="submit" class="flex-1 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-extrabold">Сохранить</button>
          ${!view.isNew ? '<button type="button" data-cd="delete" class="px-4 py-3 rounded-xl text-rose-500 font-bold text-sm hover:bg-rose-50 dark:hover:bg-rose-950/40">Удалить</button>' : ''}
        </div>
      </form>`;
    void refreshPreview();
  }

  /** Поля формы → черновик карты (без перерисовки, чтобы не сбивать ввод). */
  function readForm(): void {
    if (view.kind !== 'edit') return;
    const f = box.querySelector<HTMLFormElement>('#cdForm');
    if (!f) return;
    const fd = new FormData(f);
    Object.assign(view.card, {
      store: String(fd.get('store') || '').trim(),
      cardId: String(fd.get('cardId') || '').trim(),
      barcodeType: String(fd.get('barcodeType') || 'code_128') as BarcodeType,
      color: String(fd.get('color') || view.card.color),
      balance: String(fd.get('balance') || '').trim(),
      expiry: String(fd.get('expiry') || ''),
      note: String(fd.get('note') || '').trim(),
      starred: fd.get('starred') === 'on',
    });
  }

  // ---------- Просмотр карты ----------
  async function renderView(id: string): Promise<void> {
    const c = find(id);
    if (!c) { view = { kind: 'list' }; render(); return; }
    c.lastUsed = Date.now();
    deps.save();
    box.innerHTML = header(esc(c.store), backBtn, `<button type="button" data-cd-star="${c.id}" class="w-9 h-9 rounded-xl hover:bg-black/10 text-lg" style="opacity:${c.starred ? 1 : 0.55}" title="Избранная">★</button>`, c.color) + `
      <div class="flex-1 overflow-y-auto p-3 space-y-3">
        ${c.barcodeType !== 'none' && c.cardId ? `
          <button type="button" data-cd="fullscreen" class="block w-full bg-white rounded-3xl p-4 shadow-sm border border-slate-200 dark:border-zinc-800" title="Во весь экран">
            <div id="cdBig" class="cd-barcode mx-auto ${TWO_D.includes(c.barcodeType) ? 'max-w-[260px]' : ''}"></div>
            <div class="mt-2 font-mono text-base tracking-wider text-zinc-900 break-all">${esc(c.cardId)}</div>
            <div class="text-[10px] text-slate-400 mt-1">Нажмите, чтобы открыть во весь экран</div>
          </button>` : `<div class="bg-white dark:bg-zinc-900 rounded-3xl p-5 text-center border border-slate-200 dark:border-zinc-800">
            <div class="text-xs text-slate-400 mb-1">Номер карты</div><div class="font-mono text-xl tracking-wider break-all">${esc(c.cardId || '—')}</div></div>`}
        <div class="grid grid-cols-2 gap-2 text-sm">
          ${c.balance ? `<div class="p-3 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800"><div class="text-[11px] text-slate-400">Баланс</div><b>${esc(c.balance)}</b></div>` : ''}
          ${c.expiry ? `<div class="p-3 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800"><div class="text-[11px] text-slate-400">Действует до</div><b class="${isExpired(c.expiry) ? 'text-rose-500' : ''}">${fmtDate(c.expiry)}${isExpired(c.expiry) ? ' (истекла)' : ''}</b></div>` : ''}
        </div>
        ${c.note ? `<div class="p-3 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 text-sm whitespace-pre-wrap">${esc(c.note)}</div>` : ''}
        ${c.frontImage || c.backImage ? `<div class="flex gap-2">${[c.frontImage, c.backImage].filter(Boolean).map(src => `<img src="${src}" data-cd-photo class="flex-1 min-w-0 h-28 object-cover rounded-2xl border border-slate-200 dark:border-zinc-800 cursor-zoom-in" alt="" />`).join('')}</div>` : ''}
        <div class="flex gap-2 pt-1">
          <button type="button" data-cd="edit" class="flex-1 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold">✏️ Изменить</button>
          <button type="button" data-cd="delete" class="px-4 py-3 rounded-xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 text-rose-500 text-sm font-bold">Удалить</button>
        </div>
      </div>`;
    if (c.barcodeType !== 'none' && c.cardId) {
      try { box.querySelector('#cdBig')!.innerHTML = await renderBarcodeSvg(c.barcodeType, c.barcodeValue || c.cardId, true); }
      catch { box.querySelector('#cdBig')!.innerHTML = '<div class="text-xs text-rose-500">Не удалось нарисовать штрихкод — проверьте номер и формат</div>'; }
    }
  }

  async function showFullscreen(c: LoyaltyCard): Promise<void> {
    const ov = document.createElement('div');
    ov.className = 'fixed inset-0 z-[70] bg-white flex flex-col items-center justify-center p-6 gap-4';
    ov.innerHTML = `<div class="text-lg font-extrabold text-zinc-900">${esc(c.store)}</div><div class="cd-barcode w-full ${TWO_D.includes(c.barcodeType) ? 'max-w-[80vmin]' : ''}" id="cdFull"></div>
      <div class="font-mono text-xl tracking-widest text-zinc-900 break-all text-center">${esc(c.cardId)}</div><div class="text-xs text-slate-400">Нажмите, чтобы закрыть</div>`;
    ov.addEventListener('click', () => ov.remove());
    document.body.appendChild(ov);
    try { ov.querySelector('#cdFull')!.innerHTML = await renderBarcodeSvg(c.barcodeType, c.barcodeValue || c.cardId, true); } catch { /* показан номер */ }
  }

  function render(): void {
    if (view.kind !== 'scan') stopScan?.();
    if (view.kind === 'list') renderList();
    else if (view.kind === 'add') renderAdd();
    else if (view.kind === 'scan') void renderScan();
    else if (view.kind === 'view') void renderView(view.id);
    else renderEditor();
  }

  function goBack(): boolean {
    if (view.kind === 'list') return false;
    if (view.kind === 'edit' && !view.isNew) view = { kind: 'view', id: view.card.id };
    else view = { kind: 'list' };
    render();
    return true;
  }
  setModalBackHandler('cardsModal', goBack);
  // после «Отменить» — перерисовать окно, если оно открыто
  document.addEventListener('ks:cards-changed', () => {
    if (modal.classList.contains('hidden')) return;
    if (view.kind === 'view' && !find(view.id)) view = { kind: 'list' };
    if (view.kind === 'list' || view.kind === 'view') render();
  });

  // ---------- События ----------
  modal.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.id === 'cdSearch') {
      query = t.value;
      const pos = t.selectionStart;
      renderList();
      const s = box.querySelector<HTMLInputElement>('#cdSearch')!;
      s.focus(); s.setSelectionRange(pos, pos);
      return;
    }
    if (view.kind !== 'edit') return;
    readForm();
    if (t.name === 'store' && view.isNew) {
      // известная сеть — подставить фирменный цвет
      const bc = brandColor(view.card.store);
      if (bc && bc !== view.card.color) { view.card.color = bc; box.querySelector<HTMLInputElement>('input[name="color"]')!.value = bc; updateHeaderColor(); }
    }
    if (t.name === 'color') updateHeaderColor();
    if (t.name === 'cardId' || t.name === 'barcodeType') void refreshPreview();
  });
  modal.addEventListener('change', async (e) => {
    const t = e.target as HTMLInputElement;
    if (t.id === 'cdImportInput') {
      const file = t.files?.[0];
      t.value = '';
      if (file) await runImport(file);
      return;
    }
    if (t.id === 'cdPhotoInput' || t.id === 'cdCameraPhotoInput') {
      const file = t.files?.[0];
      t.value = '';
      if (!file) return;
      if (photoTarget === 'decode') {
        deps.toast('Ищу штрихкод на фото…');
        const [det, img] = await Promise.all([decodeImage(file), compressImage(file).catch(() => '')]);
        const card = { ...blankCard(), frontImage: img || undefined, ...(det ? { cardId: det.value, barcodeType: det.type } : {}) };
        if (!det) deps.toast('Штрихкод на фото не найден — введите номер вручную');
        openEditor(card, true);
      } else if (view.kind === 'edit') {
        readForm();
        const img = await compressImage(file);
        if (photoTarget === 'front') view.card.frontImage = img; else view.card.backImage = img;
        renderEditor();
      }
      return;
    }
    if (view.kind === 'edit') { readForm(); if (t.name === 'barcodeType') void refreshPreview(); }
  });

  function updateHeaderColor(): void {
    if (view.kind !== 'edit') return;
    const color = view.card.color;
    const h = box.firstElementChild as HTMLElement;
    h.style.background = color;
    h.style.color = textOn(color);
    box.querySelectorAll<HTMLElement>('[data-cd-color]').forEach(b => {
      const on = b.dataset.cdColor === color;
      b.classList.toggle('border-zinc-900', on); b.classList.toggle('dark:border-white', on);
      b.classList.toggle('scale-110', on); b.classList.toggle('border-transparent', !on);
    });
  }

  modal.addEventListener('submit', (e) => {
    e.preventDefault();
    if (view.kind !== 'edit') return;
    readForm();
    const c = view.card;
    if (!c.store) { deps.toast('Укажите магазин'); return; }
    const list = cards();
    const undo = deps.makeUndo(view.isNew ? 'Карта удалена' : 'Изменения карты отменены');
    const idx = list.findIndex(x => x.id === c.id);
    if (idx >= 0) list[idx] = { ...c }; else list.push({ ...c });
    deps.save();
    deps.toast(view.isNew ? `Карта «${c.store}» добавлена` : `Карта «${c.store}» сохранена`, undo);
    view = { kind: 'view', id: c.id };
    render();
  });

  modal.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t === modal) { stopScan?.(); modal.classList.add('hidden'); return; }
    if (t.closest('[data-close-modal]')) { stopScan?.(); return; } // закрывает общий обработчик приложения
    const star = t.closest<HTMLElement>('[data-cd-star]');
    if (star) {
      const c = find(star.dataset.cdStar!);
      if (c) { c.starred = !c.starred; deps.save(); render(); }
      return;
    }
    const open = t.closest<HTMLElement>('[data-cd-open]');
    if (open) { view = { kind: 'view', id: open.dataset.cdOpen! }; render(); return; }
    const color = t.closest<HTMLElement>('[data-cd-color]');
    if (color && view.kind === 'edit') {
      readForm();
      view.card.color = color.dataset.cdColor!;
      box.querySelector<HTMLInputElement>('input[name="color"]')!.value = view.card.color;
      updateHeaderColor();
      return;
    }
    const imgBtn = t.closest<HTMLElement>('[data-cd-img]');
    if (imgBtn) {
      photoTarget = imgBtn.dataset.cdImg as 'front' | 'back';
      modal.querySelector<HTMLInputElement>(imgBtn.dataset.src === 'camera' ? '#cdCameraPhotoInput' : '#cdPhotoInput')!.click();
      return;
    }
    const imgDel = t.closest<HTMLElement>('[data-cd-img-del]');
    if (imgDel && view.kind === 'edit') {
      readForm();
      if (imgDel.dataset.cdImgDel === 'front') delete view.card.frontImage; else delete view.card.backImage;
      renderEditor();
      return;
    }
    const photo = t.closest<HTMLImageElement>('[data-cd-photo]');
    if (photo) {
      const ov = document.createElement('div');
      ov.className = 'fixed inset-0 z-[70] bg-black/90 flex items-center justify-center p-3';
      ov.innerHTML = `<img src="${photo.src}" class="max-w-full max-h-full rounded-xl" alt="" />`;
      ov.addEventListener('click', () => ov.remove());
      document.body.appendChild(ov);
      return;
    }
    const act = t.closest<HTMLElement>('[data-cd]');
    if (!act) return;
    switch (act.dataset.cd) {
      case 'back': goBack(); break;
      case 'list': if (t === act) { view = { kind: 'list' }; render(); } break; // тап по затемнению под меню
      case 'add': view = { kind: 'add' }; render(); break;
      case 'scan': view = { kind: 'scan' }; render(); break;
      case 'photo': stopScan?.(); photoTarget = 'decode'; modal.querySelector<HTMLInputElement>('#cdPhotoInput')!.click(); break;
      case 'manual': openEditor(blankCard(), true); break;
      case 'io': renderIo(); break;
      case 'view':
        listMode = listMode === 'tiles' ? 'list' : 'tiles';
        try { localStorage.setItem('keepshop_cards_view', listMode); } catch { /* приватный режим */ }
        renderList();
        break;
      case 'import': modal.querySelector<HTMLInputElement>('#cdImportInput')!.click(); break;
      case 'export': void runExport(); break;
      case 'edit': if (view.kind === 'view') { const c = find(view.id); if (c) openEditor(c, false); } break;
      case 'fullscreen': if (view.kind === 'view') { const c = find(view.id); if (c) void showFullscreen(c); } break;
      case 'delete': {
        const id = view.kind === 'view' ? view.id : view.kind === 'edit' ? view.card.id : '';
        const list = cards();
        const idx = list.findIndex(c => c.id === id);
        if (idx < 0) break;
        const undo = deps.makeUndo('Карта восстановлена');
        const [removed] = list.splice(idx, 1);
        deps.save();
        deps.toast(`Карта «${removed.store}» удалена`, undo);
        view = { kind: 'list' };
        render();
        break;
      }
    }
  });

  return {
    open() {
      view = { kind: 'list' };
      query = '';
      document.getElementById('moreMenuDropdown')?.classList.add('hidden');
      modal.classList.remove('hidden');
      render();
    },
  };
}
