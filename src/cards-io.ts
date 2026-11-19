// Импорт/экспорт дисконтных карт в формате Catima (https://catima.app).
// Экспорт Catima — ZIP с catima.csv (формат v2) и фото карт card_<id>_front.png / _back.png.
// Формат catima.csv v2:
//   2                          ← версия
//   <пустая строка>
//   _id                        ← таблица групп (имя группы = id)
//   …
//   <пустая строка>
//   _id,store,note,validfrom,expiry,balance,balancetype,cardid,barcodeid,barcodetype,barcodeencoding,headercolor,starstatus,lastused,archive
//   …
//   <пустая строка>
//   cardId,groupId             ← связи карта—группа
// v1 — только таблица карт. Также понимаем простой CSV других приложений (магазин + номер).
import type { BarcodeType, LoyaltyCard } from './cards';

// ---------- CSV ----------
/** RFC 4180: кавычки, "" внутри кавычек, переводы строк внутри полей. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  // Excel в польской/русской локали сохраняет CSV через «;»
  const sample = s.split('\n').slice(0, 5).join('\n');
  const delim = (sample.match(/;/g) || []).length > (sample.match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\r') { /* \r\n */ }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const csvCell = (v: string | number) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csvRow = (cells: (string | number)[]) => cells.map(csvCell).join(',');

// ---------- Соответствия форматов ----------
const CATIMA_TO_TYPE: Record<string, BarcodeType> = {
  QR_CODE: 'qr_code', EAN_13: 'ean_13', EAN_8: 'ean_8', UPC_A: 'upc_a', UPC_E: 'upc_e', CODE_128: 'code_128',
  CODE_39: 'code_39', CODE_93: 'code_93', ITF: 'itf', PDF_417: 'pdf417', AZTEC: 'aztec', DATA_MATRIX: 'data_matrix', CODABAR: 'codabar',
};
const TYPE_TO_CATIMA = Object.fromEntries(Object.entries(CATIMA_TO_TYPE).map(([k, v]) => [v, k])) as Record<BarcodeType, string>;

/** Catima хранит цвет как знаковый ARGB int (например −16776961). */
function argbToHex(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n) || v === '') return '';
  return '#' + ((n >>> 0) & 0xffffff).toString(16).padStart(6, '0');
}
function hexToArgb(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  return m ? ((0xff000000 | parseInt(m[1], 16)) | 0) : -16777216;
}
/** Дата: миллисекунды (Catima) или строка YYYY-MM-DD / DD.MM.YYYY. */
function toIsoDate(v: string): string {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^\d{9,}$/.test(s)) {
    const n = Number(s);
    // Catima хранит дату как момент времени в местном часовом поясе — берём местную дату, не UTC
    const d = new Date(n < 1e11 ? n * 1000 : n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{2})[./](\d{2})[./](\d{4})$/.exec(s);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

const HEADER_ALIASES: Record<string, string[]> = {
  store: ['store', 'name', 'магазин', 'название', 'shop', 'merchant'],
  cardid: ['cardid', 'card id', 'number', 'cardnumber', 'card number', 'номер', 'номер карты', 'code'],
  barcodeid: ['barcodeid', 'barcode id', 'barcode value'],
  barcodetype: ['barcodetype', 'barcode type', 'format', 'тип', 'формат'],
  note: ['note', 'notes', 'заметка', 'комментарий'],
  expiry: ['expiry', 'expires', 'expiration', 'действует до', 'срок'],
  balance: ['balance', 'баланс', 'points', 'баллы'],
  balancetype: ['balancetype', 'currency'],
  headercolor: ['headercolor', 'color', 'colour', 'цвет'],
  starstatus: ['starstatus', 'starred', 'favorite', 'избранная'],
  lastused: ['lastused', 'last used'],
  archive: ['archive', 'archived'],
  _id: ['_id', 'id'],
};

function headerIndex(header: string[]): Record<string, number> {
  const norm = header.map(h => h.trim().toLowerCase());
  const idx: Record<string, number> = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const i = norm.findIndex(h => aliases.includes(h));
    if (i >= 0) idx[key] = i;
  }
  return idx;
}

export interface ImportedCard { card: LoyaltyCard; catimaId: string; archived: boolean }

/** Разбор catima.csv (v1/v2) или простого CSV. */
export function parseCardsCsv(text: string): ImportedCard[] {
  const rows = parseCsv(text);
  // заголовок таблицы карт — строка, где есть «магазин» и «номер»
  const hi = rows.findIndex(r => { const ix = headerIndex(r); return ix.store !== undefined && ix.cardid !== undefined; });
  if (hi < 0) throw new Error('Не найдены колонки «store/магазин» и «cardid/номер»');
  const ix = headerIndex(rows[hi]);
  // связи карта—группа (v2): названия групп добавим в заметку
  const groupsByCard = new Map<string, string[]>();
  const li = rows.findIndex((r, i) => i > hi && r.length >= 2 && r[0].trim() === 'cardId' && r[1].trim() === 'groupId');
  if (li > 0) for (const r of rows.slice(li + 1)) {
    if (r.length < 2 || !r[0]) continue;
    groupsByCard.set(r[0], [...(groupsByCard.get(r[0]) || []), r[1]]);
  }
  const out: ImportedCard[] = [];
  const end = li > 0 ? li : rows.length;
  for (let ri = hi + 1; ri < end; ri++) {
    const r = rows[ri];
    if (r.length === 1 && r[0].trim() === '') break; // пустая строка — конец таблицы карт
    const get = (k: string) => (ix[k] !== undefined ? (r[ix[k]] ?? '') : '').trim();
    const store = get('store');
    if (!store) continue;
    const typeRaw = get('barcodetype').toUpperCase().replace(/[\s-]/g, '_');
    const type: BarcodeType = typeRaw ? (CATIMA_TO_TYPE[typeRaw] || CATIMA_TO_TYPE[typeRaw.replace('PDF417', 'PDF_417')] || 'code_128') : (ix.barcodetype !== undefined ? 'none' : 'code_128');
    const balanceNum = get('balance');
    const balanceType = get('balancetype');
    const balance = balanceNum && Number(balanceNum) !== 0 ? `${balanceNum}${balanceType ? ' ' + balanceType : ''}` : '';
    const groups = groupsByCard.get(get('_id')) || [];
    const note = [get('note'), groups.length ? 'Группа: ' + groups.join(', ') : ''].filter(Boolean).join('\n');
    const colorRaw = get('headercolor');
    const color = colorRaw.startsWith('#') ? colorRaw : argbToHex(colorRaw);
    const lastUsedRaw = Number(get('lastused'));
    const cardId = get('cardid');
    const barcodeValue = get('barcodeid');
    out.push({
      catimaId: get('_id'),
      archived: get('archive') === '1',
      card: {
        id: 'card-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        store, cardId, barcodeType: type,
        ...(barcodeValue && barcodeValue !== cardId ? { barcodeValue } : {}),
        color: color || '#2563eb', note, balance, expiry: toIsoDate(get('expiry')),
        starred: get('starstatus') === '1' || /^(true|yes|да)$/i.test(get('starstatus')),
        createdAt: Date.now(),
        ...(lastUsedRaw > 0 ? { lastUsed: lastUsedRaw < 1e11 ? lastUsedRaw * 1000 : lastUsedRaw } : {}),
      },
    });
  }
  return out;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(blob); });
}

/** Импорт файла: .zip (экспорт Catima с фото) или .csv. */
export async function importCardsFile(file: File, compress: (b: Blob) => Promise<string>): Promise<ImportedCard[]> {
  const isZip = /\.zip$/i.test(file.name) || file.type.includes('zip');
  if (!isZip) return parseCardsCsv(await file.text());
  const { default: JSZip } = await import('jszip');
  let zip: InstanceType<typeof JSZip>;
  try { zip = await JSZip.loadAsync(await file.arrayBuffer()); } catch { throw new Error('Не удалось открыть ZIP'); }
  const csvEntry = Object.values(zip.files).find(f => !f.dir && /(^|\/)catima\.csv$/i.test(f.name)) || Object.values(zip.files).find(f => !f.dir && /\.csv$/i.test(f.name));
  if (!csvEntry) throw new Error('В архиве нет catima.csv');
  let csv: string;
  try { csv = await csvEntry.async('string'); } catch { throw new Error('Архив защищён паролем — экспортируйте из Catima без пароля'); }
  const cards = parseCardsCsv(csv);
  for (const ic of cards) {
    for (const side of ['front', 'back'] as const) {
      const img = Object.values(zip.files).find(f => !f.dir && new RegExp(`(^|/)card_${ic.catimaId}_${side}\\.(png|jpe?g|webp)$`, 'i').test(f.name));
      if (!img) continue;
      try {
        const blob = await img.async('blob');
        const url = await compress(blob).catch(() => blobToDataUrl(blob));
        if (side === 'front') ic.card.frontImage = url; else ic.card.backImage = url;
      } catch { /* битое фото — пропускаем */ }
    }
  }
  return cards;
}

function dataUrlToBytes(url: string): Uint8Array {
  const b64 = url.split(',')[1] || '';
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** ZIP в формате экспорта Catima: открывается в Catima (Импорт → Catima). */
export async function exportCatimaZip(cards: LoyaltyCard[]): Promise<Blob> {
  const { default: JSZip } = await import('jszip');
  const lines: string[] = ['2', '', '_id', ''];
  lines.push(csvRow(['_id', 'store', 'note', 'validfrom', 'expiry', 'balance', 'balancetype', 'cardid', 'barcodeid', 'barcodetype', 'barcodeencoding', 'headercolor', 'starstatus', 'lastused', 'archive']));
  const zip = new JSZip();
  cards.forEach((c, i) => {
    const id = i + 1;
    const num = c.balance.replace(',', '.').match(/-?\d+(\.\d+)?/);
    const balance = num ? num[0] : '0';
    const balanceType = /zł|pln/i.test(c.balance) ? 'PLN' : /€|eur/i.test(c.balance) ? 'EUR' : /\$|usd/i.test(c.balance) ? 'USD' : '';
    const note = c.balance && !num ? [c.note, 'Баланс: ' + c.balance].filter(Boolean).join('\n') : c.note;
    lines.push(csvRow([
      id, c.store, note, '', c.expiry ? String(Date.parse(c.expiry + 'T00:00:00')) : '', balance, balanceType,
      c.cardId, c.barcodeValue || '', c.barcodeType === 'none' ? '' : (TYPE_TO_CATIMA[c.barcodeType] || 'CODE_128'), '',
      hexToArgb(c.color), c.starred ? 1 : 0, c.lastUsed ? Math.round(c.lastUsed / 1000) : 0, 0,
    ]));
    if (c.frontImage) zip.file(`card_${id}_front.png`, dataUrlToBytes(c.frontImage));
    if (c.backImage) zip.file(`card_${id}_back.png`, dataUrlToBytes(c.backImage));
  });
  lines.push('', 'cardId,groupId', '');
  zip.file('catima.csv', lines.join('\n'));
  return zip.generateAsync({ type: 'blob' });
}
