// Нативная часть: то, чего нет во встроенном WebView, — сохранение файлов,
// кнопка «Назад» Android, хранение ключа Gemini. В браузере работает как обычный сайт.
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

export const isNative = Capacitor.isNativePlatform();
const KEY_STORAGE = 'keepshop_gemini_api_key';

function lsGet(k: string): string {
  try { return localStorage.getItem(k) || ''; } catch { return ''; }
}
function lsSet(k: string, v: string): void {
  try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* приватный режим */ }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string): void {
  const box = document.getElementById('toastBox');
  const txt = document.getElementById('toastText');
  if (!box || !txt) return;
  txt.textContent = msg;
  document.getElementById('toastUndoBtn')?.classList.add('hidden');
  box.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.add('hidden'), 2800);
}

// ---------- Ключ Gemini ----------
let keyDialogResolve: ((key: string) => void) | null = null;

function buildKeyDialog(): HTMLElement {
  const existing = document.getElementById('ksGeminiKeyModal');
  if (existing) return existing;
  const wrap = document.createElement('div');
  wrap.id = 'ksGeminiKeyModal';
  wrap.className = 'modal-shell hidden fixed inset-0 z-[60] bg-black/55 flex items-center justify-center p-4';
  wrap.innerHTML = `
    <div class="w-full max-w-md bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl p-5 space-y-3 text-sm">
      <div class="flex items-center justify-between gap-2">
        <h3 class="font-extrabold text-base">🔑 Ключ Gemini AI</h3>
        <button type="button" data-close-modal="ksGeminiKeyModal" class="p-2 rounded-xl hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-500">✕</button>
      </div>
      <p class="text-xs text-slate-500 dark:text-zinc-400">Распознавание чеков, автозаполнение товаров и рецепты работают через Google Gemini.
        Бесплатный ключ можно получить на <a href="https://aistudio.google.com/apikey" target="_blank" class="text-blue-600 underline">aistudio.google.com/apikey</a>.
        Ключ хранится только на этом устройстве.</p>
      <input id="ksGeminiKeyInput" type="password" autocomplete="off" placeholder="AIza..." class="w-full px-3 py-2.5 rounded-xl bg-slate-100 dark:bg-zinc-800 outline-none font-mono text-xs" />
      <div class="flex justify-between gap-2">
        <button type="button" id="ksGeminiKeyClear" class="px-3 py-2 rounded-xl text-xs font-semibold text-red-500">Удалить ключ</button>
        <button type="button" id="ksGeminiKeySave" class="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold">Сохранить</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const input = wrap.querySelector<HTMLInputElement>('#ksGeminiKeyInput')!;
  const finish = (val: string) => {
    wrap.classList.add('hidden');
    keyDialogResolve?.(val);
    keyDialogResolve = null;
  };
  wrap.querySelector('[data-close-modal]')!.addEventListener('click', (e) => { e.stopPropagation(); finish(lsGet(KEY_STORAGE)); });
  wrap.querySelector('#ksGeminiKeySave')!.addEventListener('click', () => {
    const v = input.value.trim();
    lsSet(KEY_STORAGE, v);
    toast(v ? 'Ключ Gemini сохранён' : 'Ключ не указан');
    finish(v);
  });
  wrap.querySelector('#ksGeminiKeyClear')!.addEventListener('click', () => {
    lsSet(KEY_STORAGE, '');
    input.value = '';
    toast('Ключ удалён');
    finish('');
  });
  return wrap;
}

export function editGeminiKey(): Promise<string> {
  const wrap = buildKeyDialog();
  document.getElementById('moreMenuDropdown')?.classList.add('hidden');
  wrap.querySelector<HTMLInputElement>('#ksGeminiKeyInput')!.value = lsGet(KEY_STORAGE);
  wrap.classList.remove('hidden');
  return new Promise((res) => { keyDialogResolve = res; });
}

export async function getGeminiKey(): Promise<string> {
  return lsGet(KEY_STORAGE) || editGeminiKey();
}

// ---------- Сохранение / «Поделиться» файлов (в WebView <a download> не работает) ----------
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

export async function saveAndShare(blob: Blob, filename: string): Promise<void> {
  try {
    const data = await blobToBase64(blob);
    const { uri } = await Filesystem.writeFile({ path: filename, data, directory: Directory.Cache });
    await Share.share({ title: filename, url: uri, dialogTitle: 'Сохранить или отправить ' + filename });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (!/cancel/i.test(msg)) toast('Не удалось сохранить файл: ' + msg);
  }
}

/** Поделиться текстом: системное меню в APK, Web Share в браузере, иначе — в буфер обмена. */
export async function shareText(text: string, toastFn: (m: string) => void = toast): Promise<void> {
  try {
    if (isNative) { await Share.share({ text, dialogTitle: 'Отправить' }); return; }
    if (navigator.share) { await navigator.share({ text }); return; }
    await navigator.clipboard.writeText(text);
    toastFn('Скопировано в буфер обмена');
  } catch (e) {
    if (!/cancel|abort/i.test(String((e as Error)?.message ?? e))) toastFn('Не удалось отправить: ' + ((e as Error)?.message || e));
  }
}

// ---------- Кнопка «Назад» ----------
const backHandlers = new Map<string, () => boolean>();
/** Окно (по id) может перехватить «Назад»: выйти из категории, из редактора и т.п. true — обработано. */
export function setModalBackHandler(modalId: string, fn: () => boolean): void { backHandlers.set(modalId, fn); }
/** Совместимость: обработчик окна подбора. */
export function setBackHandler(fn: (() => boolean) | null): void {
  if (fn) backHandlers.set('addPickerModal', fn); else backHandlers.delete('addPickerModal');
}

function setupBackButton(): void {
  App.addListener('backButton', () => {
    const open = [...document.querySelectorAll<HTMLElement>('.modal-shell')].filter((m) => !m.classList.contains('hidden'));
    if (open.length) {
      const top = open[open.length - 1];
      if (backHandlers.get(top.id)?.()) return;
      const closer = top.querySelector<HTMLElement>('[data-close-modal]');
      if (closer) closer.click(); else top.classList.add('hidden');
      return;
    }
    const menu = document.getElementById('moreMenuDropdown');
    if (menu && !menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
    const search = document.getElementById('inlineSearchOverlay');
    if (search && !search.classList.contains('hidden')) { document.getElementById('closeSearchBtn')?.click(); return; }
    App.minimizeApp();
  });
}

export function setupNativeUi(): void {
  buildKeyDialog();
  // Пункт меню «Ключ Gemini AI»
  const anchor = document.getElementById('moreMenuDropdown')?.querySelector<HTMLElement>('[data-open-modal="dataApkModal"]');
  if (anchor && !document.getElementById('ksGeminiKeyMenuBtn')) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'ksGeminiKeyMenuBtn';
    btn.className = anchor.className;
    btn.innerHTML = '<span>🔑</span><span>Ключ Gemini AI</span>';
    btn.addEventListener('click', () => { void editGeminiKey(); });
    anchor.insertAdjacentElement('afterend', btn);
  }
  if (isNative) {
    // Генератор ZIP-проекта APK внутри самого APK не нужен
    const zipBtn = document.getElementById('downloadZipApkBtn');
    if (zipBtn) (zipBtn.closest<HTMLElement>('div.rounded-2xl') || zipBtn).style.display = 'none';
    setupBackButton();
  }
}
