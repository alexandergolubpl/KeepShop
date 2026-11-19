// Свайп влево/вправо по контенту — переход в соседний раздел (порядок как в нижнем меню).
// Эффект перехода выбирается в меню ⋮ → «Эффект свайпа» и хранится на устройстве.

export type SwipeEffect = 'slide' | 'cube' | 'stack' | 'none';

export const SWIPE_EFFECTS: { id: SwipeEffect; icon: string; label: string; desc: string }[] = [
  { id: 'slide', icon: '↔️', label: 'Сдвиг', desc: 'Страница едет за пальцем' },
  { id: 'cube', icon: '🧊', label: '3D-поворот', desc: 'Поворот, как грань куба' },
  { id: 'stack', icon: '🃏', label: 'Карточки', desc: 'Страница уменьшается и уезжает' },
  { id: 'none', icon: '⚡', label: 'Без анимации', desc: 'Мгновенное переключение' },
];

const STORAGE_KEY = 'keepshop_swipe_effect';
const EDGE = 24;          // px у краёв экрана — системный жест «Назад» Android
const DECIDE = 12;        // px, после которых решаем: горизонталь или вертикаль
const TRIGGER = 0.22;     // доля ширины экрана для перехода
const EASE_OUT = 'cubic-bezier(.2,.8,.2,1)';

let effect: SwipeEffect = (() => {
  try {
    const v = localStorage.getItem(STORAGE_KEY) as SwipeEffect | null;
    return v && SWIPE_EFFECTS.some(e => e.id === v) ? v : 'slide';
  } catch { return 'slide'; }
})();

export const getSwipeEffect = (): SwipeEffect => effect;
export function setSwipeEffect(v: SwipeEffect): void {
  effect = v;
  try { localStorage.setItem(STORAGE_KEY, v); } catch { /* приватный режим */ }
}

interface Frame { transform: string; opacity: string; origin: string; radius: string; shadow: string }

/** Как выглядит страница при сдвиге на долю p ширины экрана (−1…1). */
function frame(p: number, fx: SwipeEffect = effect): Frame {
  const w = window.innerWidth;
  const a = Math.abs(p);
  const base: Frame = { transform: '', opacity: '', origin: '', radius: '', shadow: '' };
  if (!p) return base;
  switch (fx) {
    case 'cube':
      return {
        ...base,
        // шарнир — край, общий с соседней «гранью»
        origin: p < 0 ? 'right center' : 'left center',
        transform: `perspective(1100px) translateX(${p * w * 0.35}px) rotateY(${p * 55}deg)`,
        opacity: String(1 - a * 0.2),
      };
    case 'stack':
      return {
        ...base,
        transform: `translateX(${p * w * 0.75}px) scale(${1 - a * 0.12})`,
        radius: '28px',
        shadow: `0 20px 50px -10px rgb(0 0 0 / ${0.25 * Math.min(1, a * 3)})`,
      };
    case 'none':
      return base;
    default:
      return { ...base, transform: `translateX(${p * w}px)` };
  }
}

function apply(el: HTMLElement, f: Frame, transition = 'none'): void {
  el.style.transition = transition;
  el.style.transformOrigin = f.origin;
  el.style.transform = f.transform;
  el.style.opacity = f.opacity;
  el.style.borderRadius = f.radius;
  el.style.boxShadow = f.shadow;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const nextFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

/** Анимация ухода текущей страницы и прихода новой (dir: 1 — вперёд, −1 — назад). */
async function playTransition(main: HTMLElement, dir: 1 | -1, swap: () => void, fx: SwipeEffect = effect): Promise<void> {
  if (fx === 'none') { swap(); return; }
  const out = fx === 'slide' ? 0.45 : 0.6;
  apply(main, frame(-dir * out, fx), `transform .14s ease-in, opacity .14s ease-in, box-shadow .14s, border-radius .14s`);
  await sleep(140);
  swap();
  apply(main, frame(dir * out, fx));
  await nextFrame();
  apply(main, frame(0, fx), `transform .26s ${EASE_OUT}, opacity .26s ${EASE_OUT}, box-shadow .26s, border-radius .26s`);
  await sleep(270);
  apply(main, frame(0, fx));
}

export interface SwipeNavOptions {
  getActiveTab: () => string;
  goToTab: (tab: string) => void;
}

export function initSwipeNav({ getActiveTab, goToTab }: SwipeNavOptions): void {
  const main = document.querySelector<HTMLElement>('.main-content-area');
  if (!main) return;
  type Gesture = { x0: number; y0: number; t0: number; dx: number; mode: 'h' | 'v' | null };
  let g: Gesture | null = null;

  const tabs = () => [...document.querySelectorAll<HTMLElement>('.mobile-bottom-nav [data-tab]')].map(b => b.dataset.tab!);
  const anyModalOpen = () => [...document.querySelectorAll('.modal-shell')].some(m => !m.classList.contains('hidden'));
  const blocked = (t: Element): boolean => {
    if (t.closest('input, textarea, select, .leaflet-container, #storeLocationMap, .modal-shell, [data-no-swipe], .ks-lifted')) return true;
    for (let el: Element | null = t; el && el !== main; el = el.parentElement) {
      if (el.scrollWidth > el.clientWidth + 2 && /(auto|scroll)/.test(getComputedStyle(el).overflowX)) return true;
    }
    return false;
  };
  const reset = () => {
    if (g?.mode === 'h') apply(main, frame(0), `transform .22s ${EASE_OUT}, opacity .22s, box-shadow .22s, border-radius .22s`);
    g = null;
  };

  main.addEventListener('touchstart', (e) => {
    g = null;
    if (e.touches.length !== 1 || anyModalOpen()) return;
    const t = e.touches[0];
    if (t.clientX < EDGE || t.clientX > window.innerWidth - EDGE || blocked(e.target as Element)) return;
    g = { x0: t.clientX, y0: t.clientY, t0: Date.now(), dx: 0, mode: null };
  }, { passive: true });

  main.addEventListener('touchmove', (e) => {
    if (!g) return;
    if (document.querySelector('.ks-lifted')) { reset(); return; }   // идёт перетаскивание строки
    const t = e.touches[0];
    const dx = t.clientX - g.x0, dy = t.clientY - g.y0;
    if (!g.mode) {
      if (Math.abs(dx) < DECIDE && Math.abs(dy) < DECIDE) return;
      g.mode = Math.abs(dx) > Math.abs(dy) * 1.4 ? 'h' : 'v';
    }
    if (g.mode !== 'h') return;
    if (e.cancelable) e.preventDefault();
    const list = tabs(), i = list.indexOf(getActiveTab());
    const atEnd = (dx > 0 && i <= 0) || (dx < 0 && i >= list.length - 1);
    g.dx = dx;
    // у первого/последнего раздела — «резиновое» сопротивление
    const p = Math.max(-1, Math.min(1, (atEnd ? dx * 0.2 : dx) / window.innerWidth));
    apply(main, frame(p));
  }, { passive: false });

  main.addEventListener('touchend', () => {
    if (!g || g.mode !== 'h') { g = null; return; }
    const { dx, t0 } = g;
    g = null;
    const fast = Math.abs(dx) > 50 && Date.now() - t0 < 300;
    const list = tabs(), i = list.indexOf(getActiveTab());
    const next = (Math.abs(dx) > window.innerWidth * TRIGGER || fast) ? i + (dx < 0 ? 1 : -1) : i;
    if (next === i || next < 0 || next >= list.length) {
      apply(main, frame(0), `transform .22s ${EASE_OUT}, opacity .22s, box-shadow .22s, border-radius .22s`);
      return;
    }
    try { navigator.vibrate?.(8); } catch { /* нет вибро */ }
    void playTransition(main, dx < 0 ? 1 : -1, () => { goToTab(list[next]); window.scrollTo(0, 0); });
  });
  main.addEventListener('touchcancel', reset);

  setupEffectMenu(main);
}

// ---------- Выбор эффекта в меню ⋮ ----------
function setupEffectMenu(main: HTMLElement): void {
  const anchor = document.getElementById('menuThemeToggleBtn');
  if (!anchor || document.getElementById('menuSwipeEffectBtn')) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'menuSwipeEffectBtn';
  btn.className = anchor.className;
  const label = () => SWIPE_EFFECTS.find(e => e.id === effect)!.label;
  btn.innerHTML = `<span>🎞️</span><span>Эффект свайпа: <b id="swipeEffectLabel">${label()}</b></span>`;
  anchor.insertAdjacentElement('afterend', btn);

  const modal = document.createElement('div');
  modal.id = 'swipeEffectModal';
  modal.className = 'modal-shell hidden fixed inset-0 z-[60] bg-black/55 flex items-end sm:items-center justify-center p-0 sm:p-4';
  document.body.appendChild(modal);

  const render = () => {
    modal.innerHTML = `
      <div class="modal-box w-full sm:max-w-md bg-white dark:bg-zinc-900 rounded-t-3xl sm:rounded-3xl shadow-2xl p-4 space-y-3">
        <div class="flex items-center justify-between">
          <h3 class="font-extrabold text-base">🎞️ Эффект свайпа</h3>
          <button type="button" data-close-modal="swipeEffectModal" class="w-9 h-9 rounded-xl hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-500">✕</button>
        </div>
        <p class="text-xs text-slate-500 dark:text-zinc-400">Листайте влево-вправо по экрану, чтобы переходить между разделами. Нажмите на вариант — покажу, как он выглядит.</p>
        <div class="grid grid-cols-2 gap-2">
          ${SWIPE_EFFECTS.map(e => `
            <button type="button" data-swipe-effect="${e.id}" class="text-left p-3 rounded-2xl border-2 transition ${e.id === effect ? 'border-amber-500 bg-amber-50 dark:bg-amber-500/10' : 'border-slate-200 dark:border-zinc-700 hover:border-amber-300'}">
              <div class="text-xl leading-none mb-1.5">${e.icon}</div>
              <div class="text-sm font-extrabold">${e.label}</div>
              <div class="text-[11px] text-slate-500 dark:text-zinc-400 leading-snug">${e.desc}</div>
            </button>`).join('')}
        </div>
      </div>`;
  };

  btn.addEventListener('click', () => {
    document.getElementById('moreMenuDropdown')?.classList.add('hidden');
    render();
    modal.classList.remove('hidden');
  });
  modal.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    if (target === modal || target.closest('[data-close-modal]')) { modal.classList.add('hidden'); return; }
    const opt = target.closest<HTMLElement>('[data-swipe-effect]');
    if (!opt) return;
    setSwipeEffect(opt.dataset.swipeEffect as SwipeEffect);
    document.getElementById('swipeEffectLabel')!.textContent = label();
    render();
    // Предпросмотр: страница под окном «уходит» и возвращается выбранным эффектом
    modal.style.background = 'transparent';
    await playTransition(main, 1, () => {});
    modal.style.background = '';
  });
}
