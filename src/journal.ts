// Журнал семьи и уведомления.
//  • События получаются из самих изменений синхронизации (src/sync.ts): что добавлено, взято,
//    возвращено, убрано, изменено; списки, карты, участники, приглашения. Перестановки не пишутся,
//    массовые действия сворачиваются в одну запись.
//  • Журнал хранится в spaces/{sid}/log — общий для всей семьи.
//  • Уведомления: плашка в приложении, 🔔 со счётчиком непрочитанного, сводка «пока вас не было»,
//    системное уведомление Android, если приложение свёрнуто (но ещё работает в фоне).
import { isNative, setModalBackHandler } from './native';

export type LogKind = 'add' | 'check' | 'uncheck' | 'remove' | 'edit' | 'list' | 'card' | 'member' | 'invite';
export interface LogEntry {
  id?: string;
  ms: number;
  uid: string;
  name: string;
  kind: LogKind;
  text: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = Record<string, any>;
export interface Op { col: string; id: string; prev: Data | null; next: Data | null }

const KIND_ICON: Record<LogKind, string> = {
  add: '➕', check: '✅', uncheck: '↩️', remove: '🗑️', edit: '✏️', list: '📝', card: '💳', member: '👤', invite: '✉️',
};

/** 1 товар, 2 товара, 5 товаров */
export const plural = (n: number, one: string, few: string, many: string) =>
  n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many;

/** «Молоко, Хлеб и ещё 3» */
function names(list: string[], max = 3): string {
  const q = list.map(n => `«${n}»`);
  return q.length <= max ? q.join(', ') : `${q.slice(0, max).join(', ')} и ещё ${q.length - max}`;
}

/** Изменения синхронизации → записи журнала (без пола: «Аня · взято: Молоко»). */
export function describeOps(ops: Op[], listTitle: (id: string) => string): Omit<LogEntry, 'ms' | 'uid' | 'name'>[] {
  const out: Omit<LogEntry, 'ms' | 'uid' | 'name'>[] = [];
  const byList = (kind: string) => new Map<string, string[]>();
  const added = byList('add'), checked = byList('check'), unchecked = byList('uncheck'), removed = byList('remove'), edited = byList('edit');
  const push = (m: Map<string, string[]>, listId: string, n: string) => m.set(listId, [...(m.get(listId) || []), n]);

  for (const op of ops) {
    if (op.col === 'items') {
      const p = op.prev, n = op.next;
      const listId = String((n || p)?.listId ?? '');
      const name = String((n || p)?.name ?? '');
      if (!p && n) push(added, listId, name);
      else if (p && !n) push(removed, listId, name);
      else if (p && n) {
        if (!p.checked && n.checked) push(checked, listId, name);
        else if (p.checked && !n.checked) push(unchecked, listId, name);
        else if (p.name !== n.name || p.qty !== n.qty || p.unit !== n.unit || Math.abs((p.price || 0) - (n.price || 0)) > 0.001) push(edited, listId, name);
      }
    } else if (op.col === 'lists') {
      const p = op.prev, n = op.next;
      if (!p && n) out.push({ kind: 'list', text: `новый список «${n.title}»` });
      else if (p && !n) out.push({ kind: 'list', text: `удалён список «${p.title}»` });
      else if (p && n && p.title !== n.title) out.push({ kind: 'list', text: `список «${p.title}» → «${n.title}»` });
    } else if (op.col === 'cards') {
      const p = op.prev, n = op.next;
      if (!p && n) out.push({ kind: 'card', text: `новая карта «${n.store}»` });
      else if (p && !n) out.push({ kind: 'card', text: `удалена карта «${p.store}»` });
      else if (p && n && (p.store !== n.store || p.cardId !== n.cardId || p.balance !== n.balance || p.expiry !== n.expiry || p.note !== n.note)) {
        out.push({ kind: 'card', text: `изменена карта «${n.store}»` });
      }
    }
  }
  const where = (listId: string) => `в «${listTitle(listId)}»`;
  added.forEach((l, id) => out.push({ kind: 'add', text: l.length > 3 ? `добавлено ${l.length} ${plural(l.length, 'товар', 'товара', 'товаров')} ${where(id)}: ${names(l, 2)}` : `добавлено ${names(l)} ${where(id)}` }));
  checked.forEach((l) => out.push({ kind: 'check', text: `взято: ${names(l)}` }));
  unchecked.forEach((l) => out.push({ kind: 'uncheck', text: `снова нужно: ${names(l)}` }));
  removed.forEach((l, id) => out.push({ kind: 'remove', text: l.length > 3 ? `убрано ${l.length} ${plural(l.length, 'товар', 'товара', 'товаров')} из «${listTitle(id)}»` : `убрано: ${names(l)}` }));
  edited.forEach((l) => out.push({ kind: 'edit', text: `изменено: ${names(l)}` }));
  return out;
}

// ==================== Интерфейс ====================
const SEEN_KEY = 'keepshop_journal_seen';
const NOTIFY_KEY = 'keepshop_journal_notify';
const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } },
};

export interface JournalUi {
  /** Снимок журнала (новые сверху). initial — первый снимок после подключения. */
  update: (entries: LogEntry[], myUid: string, initial: boolean) => void;
  /** Новые записи от других участников (для уведомлений). */
  notifyNew: (entries: LogEntry[]) => void;
  setEnabled: (inFamily: boolean) => void;
  open: () => void;
}

export function initJournal(): JournalUi {
  let entries: LogEntry[] = [];
  let me = '';
  let inFamily = false;
  let notifPermission: 'unknown' | 'granted' | 'denied' = 'unknown';
  const notifyOn = () => ls.get(NOTIFY_KEY) !== 'off';
  const seen = () => Number(ls.get(SEEN_KEY) || 0);
  const unread = () => entries.filter(e => e.uid !== me && e.ms > seen()).length;

  // ---- 🔔 в шапке (рядом с именем) ----
  const anchor = document.getElementById('currentRoleBadge');
  const bell = document.createElement('button');
  bell.type = 'button';
  bell.id = 'journalBtn';
  bell.className = 'hidden relative ml-1 px-1 rounded-md hover:bg-slate-100 dark:hover:bg-zinc-800 text-[11px] leading-4 shrink-0';
  bell.title = 'Журнал семьи';
  bell.innerHTML = '🔔<span id="journalBadge" class="hidden absolute -top-1.5 -right-1.5 min-w-[15px] h-[15px] px-0.5 rounded-full bg-rose-500 text-white text-[9px] font-bold leading-[15px] text-center"></span>';
  anchor?.insertAdjacentElement('afterend', bell);
  bell.addEventListener('click', (e) => { e.stopPropagation(); open(); });

  function renderBadge(): void {
    bell.classList.toggle('hidden', !inFamily);
    const n = unread();
    const b = bell.querySelector<HTMLElement>('#journalBadge')!;
    b.textContent = n > 99 ? '99+' : String(n);
    b.classList.toggle('hidden', !n);
  }

  // ---- плашки уведомлений ----
  const stack = document.createElement('div');
  stack.className = 'fixed top-2 inset-x-2 sm:left-auto sm:right-4 sm:w-96 z-[80] space-y-2 pointer-events-none';
  stack.style.paddingTop = 'env(safe-area-inset-top, 0px)';
  document.body.appendChild(stack);

  function banner(e: LogEntry): void {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'pointer-events-auto w-full text-left flex items-start gap-2 p-3 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 shadow-xl transition duration-300 opacity-0 -translate-y-2';
    el.innerHTML = `<span class="text-lg leading-none">${KIND_ICON[e.kind] || '🔔'}</span>
      <span class="flex-1 min-w-0 text-sm"><b>${esc(e.name)}</b> · ${esc(e.text)}</span>`;
    el.addEventListener('click', () => { el.remove(); open(); });
    stack.prepend(el);
    requestAnimationFrame(() => el.classList.remove('opacity-0', '-translate-y-2'));
    while (stack.children.length > 3) stack.lastElementChild?.remove();
    setTimeout(() => { el.classList.add('opacity-0'); setTimeout(() => el.remove(), 300); }, 4500);
  }

  // ---- системные уведомления Android (когда приложение свёрнуто) ----
  async function systemNotify(list: LogEntry[]): Promise<void> {
    if (!isNative || notifPermission === 'denied') return;
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      if (notifPermission === 'unknown') {
        const p = await LocalNotifications.checkPermissions();
        notifPermission = p.display === 'granted' ? 'granted' : p.display === 'denied' ? 'denied' : 'unknown';
        if (notifPermission !== 'granted') return; // разрешение спрашиваем при открытом приложении (см. askPermission)
      }
      const title = list.length === 1 ? `KeepShop · ${list[0].name}` : `KeepShop · ${list.length} изменения`;
      const body = list.length === 1 ? list[0].text : list.slice(0, 4).map(e => `${e.name}: ${e.text}`).join('\n');
      await LocalNotifications.schedule({ notifications: [{ id: Math.floor(Date.now() % 2_000_000_000), title, body, largeBody: body }] });
    } catch (err) { console.warn('KeepShop notify', err); }
  }

  async function askPermission(): Promise<void> {
    if (!isNative) return;
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      const p = await LocalNotifications.requestPermissions();
      notifPermission = p.display === 'granted' ? 'granted' : 'denied';
    } catch { /* нет плагина */ }
  }

  // ---- окно журнала ----
  const modal = document.createElement('div');
  modal.id = 'journalModal';
  modal.className = 'modal-shell hidden fixed inset-0 z-[60] bg-black/55 flex items-end sm:items-center justify-center p-0 sm:p-4';
  modal.innerHTML = `<div class="modal-box w-full sm:max-w-md h-[88vh] sm:h-[80vh] bg-white dark:bg-zinc-900 rounded-t-3xl sm:rounded-3xl shadow-2xl flex flex-col overflow-hidden">
    <div class="shrink-0 p-4 pb-2 flex items-center gap-2">
      <h3 class="flex-1 font-extrabold text-base">📜 Журнал семьи</h3>
      <button type="button" data-close-modal="journalModal" class="w-9 h-9 rounded-xl hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-500">✕</button>
    </div>
    <label class="shrink-0 mx-4 mb-2 flex items-center gap-2 text-xs text-slate-600 dark:text-zinc-300">
      <input type="checkbox" id="journalNotify" class="w-4 h-4 accent-amber-500" /> Уведомлять о действиях семьи
    </label>
    <div id="journalList" class="flex-1 overflow-y-auto px-4 pb-6"></div>
  </div>`;
  document.body.appendChild(modal);
  setModalBackHandler('journalModal', () => false);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
  modal.querySelector<HTMLInputElement>('#journalNotify')!.addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked;
    ls.set(NOTIFY_KEY, on ? 'on' : 'off');
    if (on) void askPermission();
  });

  function dayLabel(ms: number): string {
    const d = new Date(ms), today = new Date();
    const y = new Date(); y.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Сегодня';
    if (d.toDateString() === y.toDateString()) return 'Вчера';
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  }

  function renderList(): void {
    const el = modal.querySelector<HTMLElement>('#journalList')!;
    modal.querySelector<HTMLInputElement>('#journalNotify')!.checked = notifyOn();
    if (!entries.length) { el.innerHTML = '<div class="text-center text-sm text-slate-400 py-12">Пока пусто. Здесь появятся действия всех участников семьи.</div>'; return; }
    const lastSeen = seen();
    let day = '';
    el.innerHTML = entries.map(e => {
      const d = dayLabel(e.ms);
      const head = d !== day ? `<div class="sticky top-0 bg-white/95 dark:bg-zinc-900/95 py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-400">${d}</div>` : '';
      day = d;
      const isNew = e.uid !== me && e.ms > lastSeen;
      return `${head}<div class="flex items-start gap-2.5 py-2 border-b border-slate-100 dark:border-zinc-800">
        <span class="w-8 h-8 rounded-full ${e.uid === me ? 'bg-slate-300 dark:bg-zinc-700' : 'bg-amber-500'} text-white text-xs font-extrabold flex items-center justify-center shrink-0">${esc((e.name || '?')[0].toUpperCase())}</span>
        <div class="flex-1 min-w-0 text-sm">
          <div><b>${esc(e.name)}${e.uid === me ? ' <span class="font-normal text-slate-400">(вы)</span>' : ''}</b> · ${KIND_ICON[e.kind] || ''} ${esc(e.text)}</div>
          <div class="text-[11px] text-slate-400">${new Date(e.ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</div>
        </div>
        ${isNew ? '<span class="mt-1.5 w-2 h-2 rounded-full bg-rose-500 shrink-0" title="новое"></span>' : ''}
      </div>`;
    }).join('');
  }

  function open(): void {
    document.getElementById('moreMenuDropdown')?.classList.add('hidden');
    renderList();
    modal.classList.remove('hidden');
    // отмечаем прочитанным (точки «новое» остаются видны до следующего открытия)
    const newest = entries.reduce((m, e) => Math.max(m, e.ms), 0);
    if (newest > seen()) ls.set(SEEN_KEY, String(newest));
    renderBadge();
    if (notifyOn() && notifPermission === 'unknown') void askPermission();
  }

  let summaryShown = false;
  return {
    update(list, myUid, initial) {
      entries = list;
      me = myUid;
      if (!seen()) ls.set(SEEN_KEY, String(Date.now())); // первое подключение: старое не считаем непрочитанным
      renderBadge();
      if (!modal.classList.contains('hidden')) renderList();
      if (initial && !summaryShown) {
        summaryShown = true;
        const fresh = list.filter(e => e.uid !== me && e.ms > seen());
        if (fresh.length) {
          const who = [...new Set(fresh.map(e => e.name))].slice(0, 3).join(', ');
          banner({ ms: Date.now(), uid: '', name: 'Пока вас не было', kind: 'edit', text: `${fresh.length} ${plural(fresh.length, 'изменение', 'изменения', 'изменений')} от: ${who}` });
        }
      }
    },
    notifyNew(list) {
      if (!list.length || !notifyOn()) return;
      if (document.visibilityState === 'hidden') { void systemNotify(list); return; }
      list.slice(0, 3).reverse().forEach(banner);
      try { navigator.vibrate?.(30); } catch { /* нет вибро */ }
    },
    setEnabled(on) { inFamily = on; renderBadge(); if (!on) entries = []; },
    open,
  };
}
