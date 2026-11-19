// Сохранность данных:
//  1) зеркало базы — после каждого изменения база пишется в файл во внутренней памяти приложения
//     (Directory.Data). Если данные WebView пропадут, при запуске база восстановится из файла;
//  2) резервные копии — автоматически раз в день/неделю в Documents/KeepShop/ (видно в файловом
//     менеджере, переживает удаление приложения), хранятся последние MAX_BACKUPS;
//  3) окно «💾 Резервные копии» в меню ⋮: создать, восстановить, поделиться (Drive, Telegram, почта…).
// В браузере вместо файлов используется localStorage (последние WEB_MAX копий).
import { App } from '@capacitor/app';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { isNative } from './native';

export type BackupInterval = 'daily' | 'weekly' | 'off';
export interface BackupInfo { name: string; time: number; size: number; items: number; lists: number; where: 'documents' | 'app' | 'browser' }

interface BackupFile {
  app: 'KeepShop';
  version: 1;
  createdAt: string;
  reason: string;
  data: Record<string, unknown>;
  settings: Record<string, string>;
}

export interface BackupOptions {
  /** Снимок базы (то же, что пишет saveState). */
  getSnapshot: () => Record<string, unknown>;
  /** Заменить базу снимком (с возможностью отмены — на стороне приложения). */
  applySnapshot: (data: Record<string, unknown>, label: string) => void;
  toast: (msg: string) => void;
}

const MIRROR_FILE = 'keepshop-state.json';
const BACKUP_DIR = 'KeepShop';
const MAX_BACKUPS = 10;
const WEB_KEY = 'keepshop_backups_web';
const WEB_MAX = 5;
const INTERVAL_KEY = 'keepshop_backup_interval';
const LAST_KEY = 'keepshop_backup_last';
// Настройки устройства, которые стоит сохранять вместе с базой (ключ Gemini — нет, это секрет)
const SETTINGS_KEYS = ['keepshop_swipe_effect', 'keepshop_autotranslate_off', 'keepshop_cards_view'];
const DAY = 86_400_000;

let opts: BackupOptions | null = null;
let backupDir: { directory: Directory; where: 'documents' | 'app' } = { directory: Directory.Documents, where: 'documents' };

const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* нет места/приватный режим */ } },
};

export const getBackupInterval = (): BackupInterval => (ls.get(INTERVAL_KEY) as BackupInterval) || 'daily';
export const setBackupInterval = (v: BackupInterval) => ls.set(INTERVAL_KEY, v);

function countItems(data: Record<string, unknown>): { items: number; lists: number } {
  const lists = Array.isArray(data.lists) ? data.lists as { items?: unknown[] }[] : [];
  return { lists: lists.length, items: lists.reduce((n, l) => n + (Array.isArray(l.items) ? l.items.length : 0), 0) };
}

function collectSettings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SETTINGS_KEYS) { const v = ls.get(k); if (v !== null) out[k] = v; }
  return out;
}

function makeBackup(reason: string): BackupFile {
  return { app: 'KeepShop', version: 1, createdAt: new Date().toISOString(), reason, data: opts!.getSnapshot(), settings: collectSettings() };
}

const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};

// ---------- 1. Зеркало базы во внутренней памяти ----------
let mirrorTimer: ReturnType<typeof setTimeout> | undefined;
let pendingMirror: string | null = null;

async function flushMirror(): Promise<void> {
  clearTimeout(mirrorTimer);
  if (!isNative || pendingMirror === null) return;
  const json = pendingMirror;
  pendingMirror = null;
  try {
    await Filesystem.writeFile({ path: MIRROR_FILE, data: json, directory: Directory.Data, encoding: Encoding.UTF8 });
  } catch (e) { console.warn('KeepShop mirror write failed', e); }
}

/** Вызывать после каждого сохранения базы. Запись в файл — с задержкой, чтобы не писать на каждое нажатие. */
export function onStateSaved(json: string): void {
  if (!isNative) return;
  pendingMirror = json;
  clearTimeout(mirrorTimer);
  mirrorTimer = setTimeout(() => { void flushMirror(); }, 1500);
}

/** База из зеркала (если localStorage оказался пуст). */
export async function readMirror(): Promise<Record<string, unknown> | null> {
  if (!isNative) return null;
  try {
    const { data } = await Filesystem.readFile({ path: MIRROR_FILE, directory: Directory.Data, encoding: Encoding.UTF8 });
    const parsed = JSON.parse(String(data));
    return parsed && Array.isArray(parsed.lists) ? parsed : null;
  } catch { return null; }
}

// ---------- 2. Резервные копии ----------
async function ensureBackupDir(): Promise<void> {
  // Documents доступна на Android 11+; если запись туда запрещена — копии во внутренней памяти
  for (const candidate of [{ directory: Directory.Documents, where: 'documents' as const }, { directory: Directory.Data, where: 'app' as const }]) {
    try {
      await Filesystem.mkdir({ path: BACKUP_DIR, directory: candidate.directory, recursive: true });
    } catch (e) {
      if (!/exist/i.test(String((e as Error)?.message ?? e))) continue;
    }
    try {
      const probe = `${BACKUP_DIR}/.probe`;
      await Filesystem.writeFile({ path: probe, data: '1', directory: candidate.directory, encoding: Encoding.UTF8 });
      await Filesystem.deleteFile({ path: probe, directory: candidate.directory });
      backupDir = candidate;
      return;
    } catch { /* пробуем следующий вариант */ }
  }
  throw new Error('Нет доступа к памяти для резервных копий');
}

export async function createBackup(reason = 'manual'): Promise<BackupInfo> {
  const file = makeBackup(reason);
  const json = JSON.stringify(file);
  const { items, lists } = countItems(file.data);
  const name = `keepshop-${stamp()}.json`;
  if (isNative) {
    await ensureBackupDir();
    await Filesystem.writeFile({ path: `${BACKUP_DIR}/${name}`, data: json, directory: backupDir.directory, encoding: Encoding.UTF8 });
    await pruneBackups();
  } else {
    const all = webBackups();
    all.unshift({ name, json });
    ls.set(WEB_KEY, JSON.stringify(all.slice(0, WEB_MAX)));
  }
  ls.set(LAST_KEY, String(Date.now()));
  return { name, time: Date.now(), size: json.length, items, lists, where: isNative ? backupDir.where : 'browser' };
}

function webBackups(): { name: string; json: string }[] {
  try { return JSON.parse(ls.get(WEB_KEY) || '[]'); } catch { return []; }
}

async function pruneBackups(): Promise<void> {
  const list = await listBackups();
  for (const b of list.slice(MAX_BACKUPS)) {
    try { await Filesystem.deleteFile({ path: `${BACKUP_DIR}/${b.name}`, directory: backupDir.directory }); } catch { /* уже удалён */ }
  }
}

async function readBackup(name: string): Promise<BackupFile> {
  let json: string;
  if (isNative) {
    const { data } = await Filesystem.readFile({ path: `${BACKUP_DIR}/${name}`, directory: backupDir.directory, encoding: Encoding.UTF8 });
    json = String(data);
  } else {
    const found = webBackups().find(b => b.name === name);
    if (!found) throw new Error('Копия не найдена');
    json = found.json;
  }
  return parseBackup(json);
}

/** Разбор файла копии; принимает и старый экспорт JSON (просто объект базы). */
export function parseBackup(json: string): BackupFile {
  const parsed = JSON.parse(json);
  if (parsed?.app === 'KeepShop' && parsed.data) return parsed as BackupFile;
  if (parsed && Array.isArray(parsed.lists)) return { app: 'KeepShop', version: 1, createdAt: '', reason: 'import', data: parsed, settings: {} };
  throw new Error('Это не резервная копия KeepShop');
}

export async function listBackups(): Promise<BackupInfo[]> {
  if (!isNative) {
    return webBackups().map(b => {
      const f = (() => { try { return parseBackup(b.json); } catch { return null; } })();
      return { name: b.name, time: f?.createdAt ? Date.parse(f.createdAt) : 0, size: b.json.length, ...(f ? countItems(f.data) : { items: 0, lists: 0 }), where: 'browser' as const };
    });
  }
  try { await ensureBackupDir(); } catch { return []; }
  let files: { name: string; size: number; mtime?: number }[] = [];
  try {
    const res = await Filesystem.readdir({ path: BACKUP_DIR, directory: backupDir.directory });
    files = res.files.filter(f => /^keepshop-.*\.json$/.test(f.name)).map(f => ({ name: f.name, size: f.size, mtime: f.mtime }));
  } catch { return []; }
  files.sort((a, b) => b.name.localeCompare(a.name)); // имя содержит дату — новые сверху
  const out: BackupInfo[] = [];
  for (const f of files) {
    let counts = { items: 0, lists: 0 };
    try { counts = countItems((await readBackup(f.name)).data); } catch { /* повреждённый файл */ }
    const m = f.name.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
    const time = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : (f.mtime || 0);
    out.push({ name: f.name, time, size: f.size, ...counts, where: backupDir.where });
  }
  return out;
}

export async function restoreBackup(name: string): Promise<void> {
  const file = await readBackup(name);
  restoreFromFile(file, name);
}

export function restoreFromFile(file: BackupFile, label: string): void {
  for (const [k, v] of Object.entries(file.settings || {})) if (SETTINGS_KEYS.includes(k)) ls.set(k, v);
  opts!.applySnapshot(file.data, label);
}

export async function shareBackup(name: string): Promise<void> {
  if (!isNative) {
    const found = webBackups().find(b => b.name === name);
    if (!found) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([found.json], { type: 'application/json' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    return;
  }
  const { uri } = await Filesystem.getUri({ path: `${BACKUP_DIR}/${name}`, directory: backupDir.directory });
  await Share.share({ title: name, url: uri, dialogTitle: 'Сохранить копию на Drive, в Telegram, почту…' });
}

async function deleteBackup(name: string): Promise<void> {
  if (isNative) await Filesystem.deleteFile({ path: `${BACKUP_DIR}/${name}`, directory: backupDir.directory });
  else ls.set(WEB_KEY, JSON.stringify(webBackups().filter(b => b.name !== name)));
}

/** Автокопия, если с прошлой прошло больше выбранного интервала. */
export async function maybeAutoBackup(): Promise<void> {
  const interval = getBackupInterval();
  if (interval === 'off' || !opts) return;
  const last = Number(ls.get(LAST_KEY) || 0);
  if (Date.now() - last < (interval === 'weekly' ? 7 * DAY : DAY)) return;
  const data = opts.getSnapshot();
  if (!countItems(data).items) return; // пустую базу не сохраняем
  try { await createBackup('auto'); } catch (e) { console.warn('KeepShop auto-backup failed', e); }
}

// ---------- 3. Окно «Резервные копии» ----------
const fmtSize = (n: number) => n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' МБ' : Math.max(1, Math.round(n / 1024)) + ' КБ';
const fmtTime = (t: number) => t ? new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function whereText(): string {
  if (!isNative) return 'в этом браузере (последние 5). Чтобы сохранить файл, нажмите ⤴ у копии.';
  return backupDir.where === 'documents'
    ? 'в памяти телефона: <b>Documents/KeepShop</b> — видно в файловом менеджере и сохраняется даже после удаления приложения.'
    : 'во внутренней памяти приложения. Чтобы копия пережила удаление приложения — отправьте её на Drive или в Telegram (⤴).';
}

async function renderModal(modal: HTMLElement): Promise<void> {
  const interval = getBackupInterval();
  const last = Number(ls.get(LAST_KEY) || 0);
  modal.querySelector('#bkBody')!.innerHTML = '<div class="text-center text-xs text-slate-400 py-6">Загрузка…</div>';
  const list = await listBackups();
  const opt = (v: BackupInterval, label: string) =>
    `<button type="button" data-bk-interval="${v}" class="px-3 py-1.5 rounded-lg text-xs font-bold ${interval === v ? 'bg-white dark:bg-zinc-700 shadow-xs' : 'text-slate-500 dark:text-zinc-400'}">${label}</button>`;
  modal.querySelector('#bkBody')!.innerHTML = `
    <p class="text-xs text-slate-500 dark:text-zinc-400">База сохраняется в приложении и дублируется в памяти телефона после каждого изменения. Резервные копии хранятся ${whereText()}</p>
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="inline-flex p-0.5 rounded-xl bg-black/5 dark:bg-white/10">${opt('daily', 'Ежедневно')}${opt('weekly', 'Раз в неделю')}${opt('off', 'Выкл')}</div>
      <span class="text-[11px] text-slate-400">последняя: ${fmtTime(last)}</span>
    </div>
    <div class="grid grid-cols-2 gap-2">
      <button type="button" data-bk="create" class="py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold">💾 Создать копию</button>
      <label class="py-2.5 rounded-xl bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 text-xs font-bold text-center cursor-pointer">📂 Из файла…
        <input type="file" accept="application/json,.json" data-bk-file class="hidden" />
      </label>
    </div>
    <div class="space-y-1.5 max-h-[45vh] overflow-y-auto">
      ${list.length ? list.map((b, i) => `
        <div class="flex items-center gap-2 p-2.5 rounded-xl border border-slate-200 dark:border-zinc-800">
          <div class="flex-1 min-w-0">
            <div class="text-xs font-bold">${fmtTime(b.time)} ${i === 0 ? '<span class="ml-1 px-1.5 py-px rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 text-[10px]">новая</span>' : ''}</div>
            <div class="text-[11px] text-slate-400">${b.lists} списк. · ${b.items} товаров · ${fmtSize(b.size)}</div>
          </div>
          <button type="button" data-bk="restore" data-name="${esc(b.name)}" class="px-2.5 py-1.5 rounded-lg bg-amber-100 dark:bg-amber-500/20 text-amber-900 dark:text-amber-300 text-[11px] font-bold">Восстановить</button>
          <button type="button" data-bk="share" data-name="${esc(b.name)}" class="w-8 h-8 rounded-lg bg-slate-100 dark:bg-zinc-800 text-xs" title="Поделиться / сохранить на Drive">⤴</button>
          <button type="button" data-bk="delete" data-name="${esc(b.name)}" class="w-8 h-8 rounded-lg text-xs text-slate-400 hover:text-rose-500" title="Удалить копию">✕</button>
        </div>`).join('') : '<div class="text-center text-xs text-slate-400 py-6">Копий пока нет</div>'}
    </div>`;
}

function setupModal(): void {
  const anchor = document.getElementById('menuThemeToggleBtn');
  if (!anchor || document.getElementById('menuBackupBtn')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'menuBackupBtn';
  btn.className = anchor.className;
  btn.innerHTML = '<span>💾</span><span>Резервные копии</span>';
  anchor.insertAdjacentElement('beforebegin', btn);

  const modal = document.createElement('div');
  modal.id = 'backupModal';
  modal.className = 'modal-shell hidden fixed inset-0 z-[60] bg-black/55 flex items-end sm:items-center justify-center p-0 sm:p-4';
  modal.innerHTML = `
    <div class="modal-box w-full sm:max-w-md bg-white dark:bg-zinc-900 rounded-t-3xl sm:rounded-3xl shadow-2xl p-4 space-y-3">
      <div class="flex items-center justify-between">
        <h3 class="font-extrabold text-base">💾 Резервные копии</h3>
        <button type="button" data-close-modal="backupModal" class="w-9 h-9 rounded-xl hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-500">✕</button>
      </div>
      <div id="bkBody" class="space-y-3"></div>
    </div>`;
  document.body.appendChild(modal);

  btn.addEventListener('click', () => {
    document.getElementById('moreMenuDropdown')?.classList.add('hidden');
    modal.classList.remove('hidden');
    void renderModal(modal);
  });

  modal.addEventListener('change', async (e) => {
    const input = (e.target as HTMLElement).closest<HTMLInputElement>('[data-bk-file]');
    const file = input?.files?.[0];
    if (!file) return;
    try {
      restoreFromFile(parseBackup(await file.text()), file.name);
      modal.classList.add('hidden');
    } catch (err) { opts!.toast('Не удалось прочитать файл: ' + ((err as Error).message || err)); }
    input!.value = '';
  });

  modal.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    if (t === modal) { modal.classList.add('hidden'); return; }
    const iv = t.closest<HTMLElement>('[data-bk-interval]');
    if (iv) { setBackupInterval(iv.dataset.bkInterval as BackupInterval); void renderModal(modal); return; }
    const act = t.closest<HTMLElement>('[data-bk]');
    if (!act) return;
    const name = act.dataset.name || '';
    try {
      if (act.dataset.bk === 'create') {
        const info = await createBackup('manual');
        opts!.toast(`Копия создана: ${info.items} товаров`);
      } else if (act.dataset.bk === 'restore') {
        await restoreBackup(name);
        modal.classList.add('hidden');
        return;
      } else if (act.dataset.bk === 'share') {
        await shareBackup(name);
      } else if (act.dataset.bk === 'delete') {
        await deleteBackup(name);
      }
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (!/cancel/i.test(msg)) opts!.toast('Ошибка: ' + msg);
    }
    void renderModal(modal);
  });
}

export function initBackups(options: BackupOptions): void {
  opts = options;
  setupModal();
  if (isNative) {
    // при сворачивании — сразу дописать зеркало; при возврате — проверить, не пора ли сделать копию
    void App.addListener('pause', () => { void flushMirror(); });
    void App.addListener('resume', () => { void maybeAutoBackup(); });
  } else {
    window.addEventListener('pagehide', () => { void flushMirror(); });
  }
  setTimeout(() => { void maybeAutoBackup(); }, 4000);
}
