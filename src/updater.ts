// Обновление из GitHub Releases: проверка новой версии, скачивание APK и запуск установщика Android.
// Нативная часть — android/.../ApkUpdaterPlugin.java. В браузере — просто ссылка на страницу релиза.

import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { isNative, setModalBackHandler } from './native';
import pkg from '../package.json';

interface ApkUpdater {
  getInfo(): Promise<{ versionName: string; versionCode: number }>;
  canInstall(): Promise<{ allowed: boolean }>;
  openInstallSettings(): Promise<void>;
  downloadAndInstall(o: { url: string }): Promise<{ versionName: string }>;
  addListener(e: 'progress', cb: (p: { percent: number; bytes: number }) => void): Promise<PluginListenerHandle>;
}
const Native = registerPlugin<ApkUpdater>('ApkUpdater');

export const REPO = 'alexandergolubpl/KeepShop';
const CHECKED_KEY = 'keepshop_update_checked';
const SKIP_KEY = 'keepshop_update_skip';
const CHECK_EVERY = 6 * 3_600_000;

export interface Release { version: string; tag: string; notes: string; url: string; apk: string; size: number; date: string }
export interface UpdaterHost { backup: (reason: string) => Promise<unknown>; toast: (m: string) => void }

const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } },
};
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** 1.10.0 > 1.9.2; «v» в начале не важна. */
export function newer(a: string, b: string): boolean {
  const pa = a.replace(/^v/i, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/i, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

/** Из описания релиза — русская часть (раздел «### RU»), иначе всё. */
export function releaseNotes(body: string): string {
  const ru = body.split(/^###\s*RU\s*$/m)[1];
  const text = (ru ?? body).split(/^###\s/m)[0];
  return text.replace(/\*\*/g, '').replace(/`/g, '').trim();
}

export async function currentVersion(): Promise<string> {
  if (isNative) { try { return (await Native.getInfo()).versionName; } catch { /* старая сборка без плагина */ } }
  return pkg.version;
}

export async function fetchLatest(): Promise<Release | null> {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`GitHub: HTTP ${r.status}`);
  const j = await r.json();
  const asset = (j.assets || []).find((a: { name: string }) => /\.apk$/i.test(a.name));
  if (!j.tag_name || !asset) return null;
  return {
    version: String(j.tag_name).replace(/^v/i, ''), tag: j.tag_name, notes: releaseNotes(String(j.body || '')),
    url: j.html_url, apk: asset.browser_download_url, size: asset.size || 0, date: String(j.published_at || '').slice(0, 10),
  };
}

export interface UpdaterApi { open: () => void; autoCheck: () => void }

export function initUpdater(host: UpdaterHost): UpdaterApi {
  let current = pkg.version;
  let latest: Release | null = null;
  let state: 'idle' | 'checking' | 'ready' | 'none' | 'downloading' | 'installing' | 'error' | 'permission' = 'idle';
  let percent = -1;
  let error = '';

  // ---- окно ----
  const modal = document.createElement('div');
  modal.id = 'updateModal';
  modal.className = 'modal-shell hidden fixed inset-0 z-[70] bg-black/55 flex items-end sm:items-center justify-center p-0 sm:p-4';
  modal.innerHTML = `<div class="modal-box w-full sm:max-w-md max-h-[85vh] bg-white dark:bg-zinc-900 rounded-t-3xl sm:rounded-3xl shadow-2xl flex flex-col overflow-hidden">
    <div class="shrink-0 p-4 pb-2 flex items-center gap-2">
      <h3 class="flex-1 font-extrabold text-base">⬆️ Обновление KeepShop</h3>
      <button type="button" data-close-modal="updateModal" class="w-9 h-9 rounded-xl hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-500">✕</button>
    </div>
    <div id="updateBody" class="flex-1 overflow-y-auto px-4 pb-4 text-sm"></div>
  </div>`;
  document.body.appendChild(modal);
  setModalBackHandler('updateModal', () => state === 'downloading');
  const body = modal.querySelector<HTMLElement>('#updateBody')!;
  const btn = 'w-full py-2.5 rounded-xl text-sm font-bold';
  const mb = (n: number) => (n / 1048576).toFixed(1).replace('.', ',') + ' МБ';

  function render(): void {
    const head = `<div class="text-xs text-slate-500 dark:text-zinc-400 mb-3">Установлена версия <b>${esc(current)}</b></div>`;
    if (state === 'checking' || state === 'idle') { body.innerHTML = head + '<div class="py-8 text-center text-slate-500">Проверяю GitHub…</div>'; return; }
    if (state === 'none') {
      body.innerHTML = head + `<div class="py-6 text-center"><div class="text-3xl mb-2">✅</div>У вас последняя версия${latest ? ` (${esc(latest.version)})` : ''}.</div>
        <button type="button" data-up="check" class="${btn} bg-slate-100 dark:bg-zinc-800">🔄 Проверить ещё раз</button>`;
      return;
    }
    if (state === 'error' && !latest) {
      body.innerHTML = head + `<div class="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 text-xs mb-3">${esc(error)}</div>
        <button type="button" data-up="check" class="${btn} bg-slate-100 dark:bg-zinc-800">🔄 Повторить</button>`;
      return;
    }
    const r = latest!;
    const notes = r.notes ? `<div class="mt-2 p-3 rounded-xl bg-slate-50 dark:bg-zinc-800/60 text-[13px] leading-snug whitespace-pre-line">${esc(r.notes)}</div>` : '';
    let action = '';
    if (state === 'downloading') {
      action = `<div class="mt-4"><div class="h-2 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden"><div class="h-full bg-emerald-500 transition-all" style="width:${percent < 0 ? 30 : percent}%"></div></div>
        <div class="mt-1.5 text-xs text-center text-slate-500">Скачиваю${percent >= 0 ? ` · ${percent}%` : '…'}</div></div>`;
    } else if (state === 'installing') {
      action = `<div class="mt-4 p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 text-xs">Открыт установщик Android — нажмите «Установить» / «Обновить». Данные и семья сохранятся.</div>
        <button type="button" data-up="install" class="${btn} mt-2 bg-slate-100 dark:bg-zinc-800">Открыть установщик ещё раз</button>`;
    } else if (state === 'permission') {
      action = `<div class="mt-4 p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-300 text-xs">Android просит разрешить KeepShop устанавливать приложения. Включите «Разрешить из этого источника», вернитесь и нажмите «Обновить».</div>
        <button type="button" data-up="settings" class="${btn} mt-2 bg-amber-500 text-white">Открыть настройки</button>
        <button type="button" data-up="install" class="${btn} mt-2 bg-emerald-600 text-white">⬇️ Обновить</button>`;
    } else if (isNative) {
      action = `${state === 'error' ? `<div class="mt-3 p-3 rounded-xl bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 text-xs">${esc(error)}</div>` : ''}
        <button type="button" data-up="install" class="${btn} mt-4 bg-emerald-600 hover:bg-emerald-700 text-white">⬇️ Обновить${r.size ? ` · ${mb(r.size)}` : ''}</button>
        <div class="mt-1 text-[11px] text-center text-slate-400">Перед установкой сохраню копию базы.</div>
        <div class="flex gap-2 mt-2">
          <button type="button" data-up="later" class="${btn} bg-slate-100 dark:bg-zinc-800">Позже</button>
          <button type="button" data-up="skip" class="${btn} bg-slate-100 dark:bg-zinc-800 text-slate-500">Пропустить версию</button>
        </div>`;
    } else {
      action = `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer" class="${btn} mt-4 block text-center bg-emerald-600 text-white">Открыть релиз на GitHub ↗</a>`;
    }
    body.innerHTML = head + `<div class="text-lg font-extrabold">Доступна версия ${esc(r.version)}</div>
      ${r.date ? `<div class="text-[11px] text-slate-400">${esc(r.date.split('-').reverse().join('.'))}</div>` : ''}
      ${notes}${action}
      <a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer" class="mt-3 block text-center text-[11px] text-blue-600 dark:text-blue-400">Страница релиза ↗</a>`;
  }

  async function check(silent: boolean): Promise<void> {
    state = 'checking'; error = ''; if (!silent) render();
    try {
      current = await currentVersion();
      latest = await fetchLatest();
      ls.set(CHECKED_KEY, String(Date.now()));
      state = latest && newer(latest.version, current) ? 'ready' : 'none';
    } catch (e) {
      state = 'error'; latest = null;
      error = navigator.onLine === false ? 'Нет интернета.' : `Не удалось проверить обновления: ${(e as Error).message || e}`;
    }
    if (silent) {
      if (state === 'ready' && ls.get(SKIP_KEY) !== latest!.version) { render(); modal.classList.remove('hidden'); }
      return;
    }
    render();
  }

  let listener: PluginListenerHandle | null = null;
  async function install(): Promise<void> {
    if (!latest) return;
    try {
      const { allowed } = await Native.canInstall();
      if (!allowed) { state = 'permission'; render(); return; }
    } catch (e) {
      state = 'error'; error = 'Эта сборка не умеет обновляться сама — скачайте APK со страницы релиза.'; render(); return;
    }
    try { await host.backup('before-update'); } catch { /* копия не обязательна */ }
    state = 'downloading'; percent = -1; render();
    listener?.remove();
    listener = await Native.addListener('progress', (p) => { if (p.percent !== percent) { percent = p.percent; render(); } });
    try {
      await Native.downloadAndInstall({ url: latest.apk });
      state = 'installing';
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      state = 'error';
      error = msg.startsWith('SIGNATURE:') ? msg.slice(10).trim() : `Не удалось обновить: ${msg}`;
    } finally { listener?.remove(); listener = null; render(); }
  }

  modal.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t === modal && state !== 'downloading') { modal.classList.add('hidden'); return; }
    const act = t.closest<HTMLElement>('[data-up]')?.dataset.up;
    if (act === 'check') void check(false);
    else if (act === 'install') void install();
    else if (act === 'settings') void Native.openInstallSettings();
    else if (act === 'later') modal.classList.add('hidden');
    else if (act === 'skip') { if (latest) ls.set(SKIP_KEY, latest.version); modal.classList.add('hidden'); host.toast('Напомню о следующей версии'); }
  });
  // вернулись из настроек «Установка из этого источника» — пробуем сразу
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state === 'permission' && !modal.classList.contains('hidden')) {
      void Native.canInstall().then(({ allowed }) => { if (allowed) void install(); }).catch(() => {});
    }
  });

  return {
    open() {
      document.getElementById('moreMenuDropdown')?.classList.add('hidden');
      modal.classList.remove('hidden');
      if (state === 'downloading' || state === 'installing') { render(); return; }
      void check(false);
    },
    autoCheck() {
      const last = Number(ls.get(CHECKED_KEY) || 0);
      if (Date.now() - last < CHECK_EVERY) return;
      setTimeout(() => { if (navigator.onLine !== false) void check(true); }, 12000);
    },
  };
}
