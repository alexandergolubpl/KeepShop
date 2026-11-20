// Семейный доступ: общие данные на всех телефонах семьи через Firebase (Firestore).
//
// Как устроено:
//  • каждый телефон входит в Firebase анонимно (без почты и пароля);
//  • «пространство» (spaces/{sid}) — семья: владелец и участники; вступить можно по коду-приглашению;
//  • база приложения раскладывается на отдельные записи (каждый список, товар списка, товар базы,
//    карта, запись истории…). Одновременные правки разных записей не затирают друг друга;
//  • отправляются только изменённые записи; чужие изменения приходят через onSnapshot;
//  • Firestore хранит копию на телефоне: без сети всё работает, правки уйдут, когда появится связь.
import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, browserPopupRedirectResolver, signInAnonymously,
  connectAuthEmulator, GoogleAuthProvider, linkWithCredential, signInWithCredential, linkWithPopup, signInWithPopup, signOut,
  type Auth, type OAuthCredential,
} from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator,
  collection, doc, onSnapshot, writeBatch, setDoc, getDoc, updateDoc, deleteField, serverTimestamp, Timestamp,
  type Firestore, type Unsubscribe, type DocumentData,
} from 'firebase/firestore';
import { firebaseConfig } from './firebase-config';
import { isNative, setModalBackHandler } from './native';

// ---------- Раскладка базы на записи ----------
const COLS = ['lists', 'items', 'products', 'cards', 'recent', 'favorite', 'backlog', 'priceHistory', 'meta'] as const;
type Col = typeof COLS[number];
type Docs = Record<Col, Map<string, DocumentData>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AppState = any;

const safeId = (s: unknown) => String(s ?? '').replace(/\//g, '_').slice(0, 300) || '_';
/** Сравнение без учёта порядка ключей. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v as object).filter(k => (v as Record<string, unknown>)[k] !== undefined).sort()
      .map(k => JSON.stringify(k) + ':' + stable((v as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(v ?? null);
}
const emptyDocs = (): Docs => Object.fromEntries(COLS.map(c => [c, new Map()])) as Docs;

function toDocs(state: AppState): Docs {
  const d = emptyDocs();
  for (const l of state.lists || []) {
    const { items, ...meta } = l;
    d.lists.set(safeId(l.id), meta);
    (items || []).forEach((it: DocumentData) => d.items.set(safeId(l.id) + '__' + safeId(it.id), { ...it, listId: l.id }));
  }
  for (const col of ['products', 'cards', 'recent', 'favorite', 'backlog', 'priceHistory'] as const) {
    (state[col] || []).forEach((x: DocumentData) => { if (x && x.id) d[col].set(safeId(x.id), x); });
  }
  d.meta.set('settings', { currency: state.currency || 'PLN' });
  return d;
}

/** Числовая часть id (время создания) — для порядка «новые сверху». */
const idTime = (id: unknown) => Number(String(id ?? '').match(/(\d{10,})/)?.[1] || 0);
const strip = ({ listId: _l, ...rest }: DocumentData) => rest;

function fromDocs(d: Docs, cols: Set<Col>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (cols.has('lists') || cols.has('items')) {
    const byList = new Map<string, DocumentData[]>();
    d.items.forEach(it => { const k = String(it.listId); byList.set(k, [...(byList.get(k) || []), strip(it)]); });
    patch.lists = [...d.lists.values()]
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map(l => ({ ...l, items: (byList.get(String(l.id)) || []).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) }));
  }
  const byNewest = (a: DocumentData, b: DocumentData) => idTime(b.id) - idTime(a.id);
  if (cols.has('products')) patch.products = [...d.products.values()];
  if (cols.has('cards')) patch.cards = [...d.cards.values()];
  if (cols.has('recent')) patch.recent = [...d.recent.values()].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || byNewest(a, b));
  if (cols.has('favorite')) patch.favorite = [...d.favorite.values()].sort(byNewest);
  if (cols.has('backlog')) patch.backlog = [...d.backlog.values()].sort(byNewest);
  if (cols.has('priceHistory')) patch.priceHistory = [...d.priceHistory.values()].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  if (cols.has('meta')) { const s = d.meta.get('settings'); if (s?.currency) patch.currency = s.currency; }
  return patch;
}

// ---------- Состояние подключения ----------
interface SyncConfig { spaceId?: string; myName?: string }
const CFG_KEY = 'keepshop_sync';
const loadCfg = (): SyncConfig => { try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch { return {}; } };
const saveCfg = (c: SyncConfig) => { try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch { /* приватный режим */ } };

export type SyncStatus = 'off' | 'connecting' | 'synced' | 'pending' | 'offline' | 'error';
interface Member { name: string; role: string; joinedAt?: number }

export interface SyncHost {
  getState: () => AppState;
  /** Заменить части базы данными семьи; сохранить локально и перерисовать (без повторной отправки). */
  applyRemote: (patch: Record<string, unknown>) => void;
  toast: (msg: string) => void;
  /** Резервная копия перед заменой данных (при вступлении в семью). */
  backup: (reason: string) => Promise<unknown>;
  /** Поделиться текстом (код приглашения). */
  shareText: (text: string) => void;
}

const USE_EMULATOR = new URLSearchParams(location.search).has('emu');
let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;

function firebase(): { auth: Auth; db: Firestore } {
  if (!app) {
    app = initializeApp(firebaseConfig, 'keepshop');
    auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence], popupRedirectResolver: browserPopupRedirectResolver });
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
      ignoreUndefinedProperties: true,
    });
    // Для разработки: ?emu=1 — локальный эмулятор Firebase
    if (USE_EMULATOR) {
      connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
      connectFirestoreEmulator(db, '127.0.0.1', 8080);
    }
  }
  return { auth: auth!, db: db! };
}

async function ensureUser(): Promise<string> {
  const { auth } = firebase();
  await auth.authStateReady();
  if (auth.currentUser) return auth.currentUser.uid;
  const cred = await signInAnonymously(auth);
  return cred.user.uid;
}

/**
 * Учётные данные Google.
 * APK: нативное системное окно выбора аккаунта (@capacitor-firebase/authentication, skipNativeAuth) → idToken.
 * Эмулятор: поддельный токен (эмулятор Firebase принимает JSON вместо подписанного токена).
 * Браузер: null — используется всплывающее окно Google.
 */
async function googleCredential(): Promise<OAuthCredential | null> {
  if (USE_EMULATOR) {
    const sub = localStorage.getItem('ks_emu_google_sub') || 'test-user';
    return GoogleAuthProvider.credential(JSON.stringify({ sub, email: sub + '@example.com', email_verified: true, name: sub }));
  }
  if (!isNative) return null;
  const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');
  const res = await FirebaseAuthentication.signInWithGoogle();
  const idToken = res.credential?.idToken;
  if (!idToken) throw new Error('Google не вернул токен входа');
  return GoogleAuthProvider.credential(idToken, res.credential?.accessToken);
}

/**
 * Вход через Google. Если сейчас анонимный вход — аккаунт привязывается к нему (uid не меняется,
 * членство в семье сохраняется). Если этот Google-аккаунт уже использовался — входим в него.
 */
async function signInWithGoogle(): Promise<{ uid: string; switched: boolean }> {
  const { auth } = firebase();
  await auth.authStateReady();
  const before = auth.currentUser;
  const cred = await googleCredential();
  try {
    if (before?.isAnonymous) {
      if (cred) await linkWithCredential(before, cred); else await linkWithPopup(before, new GoogleAuthProvider());
    } else if (cred) await signInWithCredential(auth, cred);
    else await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (e) {
    const code = (e as { code?: string })?.code || '';
    if (!/credential-already-in-use|email-already-in-use/.test(code)) throw e;
    // аккаунт уже есть (вход на другом телефоне) — переключаемся на него
    const existing = cred || GoogleAuthProvider.credentialFromError(e as never);
    if (!existing) throw e;
    await signInWithCredential(auth, existing);
  }
  const uid = auth.currentUser!.uid;
  return { uid, switched: !!before && before.uid !== uid };
}

function currentAccount(): { google: boolean; email: string } {
  const u = auth?.currentUser;
  const g = u?.providerData.find(p => p.providerId === 'google.com');
  return { google: !!g, email: g?.email || u?.email || '' };
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}
const normCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const fmtCode = (c: string) => c.slice(0, 4) + '-' + c.slice(4);

// ==================== Движок синхронизации ====================
export function initSync(host: SyncHost): { onLocalChange: () => void; open: () => void; status: () => SyncStatus } {
  let cfg = loadCfg();
  let status: SyncStatus = cfg.spaceId ? 'connecting' : 'off';
  let unsubs: Unsubscribe[] = [];
  let remote = emptyDocs();
  let synced = new Map<Col, Map<string, string>>(COLS.map(c => [c, new Map()]));
  let received = new Set<Col>();
  let ready = false;
  let uploadTimer: ReturnType<typeof setTimeout> | undefined;
  let changedCols = new Set<Col>();
  let applyQueued = false;
  let members: Record<string, Member> = {};
  let spaceName = '';
  let myUid = '';
  let lastError = '';
  const pending = new Map<Col, boolean>();
  // наши недавние записи, которых ещё нет в облачной копии: col → id → значение (null — удаление)
  const expected = new Map<Col, Map<string, string | null>>(COLS.map(c => [c, new Map()]));
  let expectedSince = 0;
  const hasExpected = () => [...expected.values()].some(m => m.size > 0);
  const fromCache = new Map<Col, boolean>();

  function setStatus(s: SyncStatus): void {
    status = s;
    const dot = document.getElementById('cloudSyncDot');
    if (dot) {
      dot.classList.remove('bg-emerald-500', 'bg-amber-500', 'bg-slate-400', 'bg-rose-500', 'animate-pulse');
      dot.classList.add(...({
        off: ['bg-slate-400'], connecting: ['bg-amber-500', 'animate-pulse'], synced: ['bg-emerald-500'],
        pending: ['bg-amber-500'], offline: ['bg-slate-400'], error: ['bg-rose-500'],
      } as Record<SyncStatus, string[]>)[s]);
      dot.title = STATUS_TEXT[s];
    }
    if (!modal.classList.contains('hidden')) renderPanel();
  }
  function recomputeStatus(): void {
    if (!cfg.spaceId) return setStatus('off');
    if (!ready) return setStatus('connecting');
    if ([...pending.values()].some(Boolean)) return setStatus(navigator.onLine ? 'pending' : 'offline');
    if ([...fromCache.values()].some(Boolean) && !navigator.onLine) return setStatus('offline');
    setStatus('synced');
  }
  window.addEventListener('online', recomputeStatus);
  window.addEventListener('offline', recomputeStatus);

  // ---- Отправка локальных изменений ----
  function uploadNow(): void {
    clearTimeout(uploadTimer);
    uploadTimer = undefined;
    if (!cfg.spaceId || !ready || !db) return;
    const local = toDocs(host.getState());
    const ops: { col: Col; id: string; data: DocumentData | null }[] = [];
    for (const col of COLS) {
      const prev = synced.get(col)!;
      local[col].forEach((data, id) => { const s = stable(data); if (prev.get(id) !== s) { ops.push({ col, id, data }); prev.set(id, s); } });
      [...prev.keys()].forEach(id => { if (!local[col].has(id)) { ops.push({ col, id, data: null }); prev.delete(id); } });
    }
    if (!ops.length) return;
    const sid = cfg.spaceId;
    expectedSince = Date.now();
    for (let i = 0; i < ops.length; i += 450) {
      const batch = writeBatch(db);
      for (const op of ops.slice(i, i + 450)) {
        const ref = doc(db, 'spaces', sid, op.col, op.id);
        if (op.data) batch.set(ref, op.data); else batch.delete(ref);
        expected.get(op.col)!.set(op.id, op.data ? stable(op.data) : null);
      }
      // без await: запись сразу попадает в локальный кэш, на сервер уйдёт при наличии сети
      batch.commit().catch(e => { lastError = String(e?.message || e); setStatus('error'); });
    }
  }

  function onLocalChange(): void {
    if (!cfg.spaceId || !ready) return;
    clearTimeout(uploadTimer);
    uploadTimer = setTimeout(uploadNow, 400);
  }

  // ---- Приём изменений ----
  // Применение чужих изменений. Пока на телефоне есть неотправленные правки, применять нельзя:
  // база собралась бы из облачной копии без них, и правки потерялись бы (а затем ушли бы как удаления).
  // Поэтому сначала отправляем свои правки, а применяем чуть позже — когда облачная копия их уже содержит.
  function scheduleApply(delay = 30): void {
    if (applyQueued) return;
    applyQueued = true;
    setTimeout(() => {
      applyQueued = false;
      if (!ready || !changedCols.size) return;
      if (uploadTimer) { uploadNow(); scheduleApply(150); return; }
      // ждём, пока облачная копия покажет наши последние записи (не дольше 3 с)
      if (hasExpected() && Date.now() - expectedSince < 3000) { scheduleApply(80); return; }
      expected.forEach(m => m.clear());
      const cols = changedCols;
      changedCols = new Set();
      // списки собираются из lists + items, поэтому обновляются вместе
      if (cols.has('lists') || cols.has('items')) { cols.add('lists'); cols.add('items'); }
      host.applyRemote(fromDocs(remote, cols));
      // база телефона по этим разделам теперь совпадает с облаком — это новая точка согласования
      cols.forEach(col => {
        const s = new Map<string, string>();
        remote[col].forEach((data, id) => s.set(id, stable(data)));
        synced.set(col, s);
      });
      // после применения (например, создан главный список) — отправить то, чего нет в облаке
      onLocalChange();
    }, delay);
  }

  function listen(sid: string): void {
    stopListening();
    const { db } = firebase();
    unsubs.push(onSnapshot(doc(db, 'spaces', sid), (snap) => {
      if (!snap.exists()) return;
      const d = snap.data();
      members = d.members || {};
      spaceName = d.name || 'Семья';
      if (myUid && !members[myUid]) {
        // нас удалили из пространства
        host.toast('Вы больше не участник семейного пространства. Данные остались на телефоне.');
        leaveLocal();
        return;
      }
      if (!modal.classList.contains('hidden')) renderPanel();
    }, (e) => { lastError = String(e?.message || e); setStatus('error'); }));

    for (const col of COLS) {
      unsubs.push(onSnapshot(collection(db, 'spaces', sid, col), { includeMetadataChanges: true }, (snap) => {
        pending.set(col, snap.metadata.hasPendingWrites);
        fromCache.set(col, snap.metadata.fromCache);
        const changes = snap.docChanges();
        const firstTime = !received.has(col);
        received.add(col);
        // Облачная копия обновляется по КАЖДОМУ снимку (в нём уже есть и наши неотправленные записи),
        // иначе сборка списков из устаревших товаров теряла бы товары.
        if (firstTime || changes.length) {
          const m = new Map<string, DocumentData>();
          const s = new Map<string, string>();
          snap.docs.forEach(d => { const data = d.data(); m.set(d.id, data); s.set(d.id, stable(data)); });
          remote[col] = m;
          const exp = expected.get(col)!;
          exp.forEach((v, id) => { if (v === null ? !s.has(id) : s.get(id) === v) exp.delete(id); });
          // ВАЖНО: synced здесь не трогаем. synced — что было в базе телефона при последнем согласовании;
          // по нему считаются удаления. Чужие записи из облака, ещё не применённые к базе, — не удаления.
        }
        // применяем к базе приложения, только если пришло чужое (или первое) изменение
        const foreign = firstTime || changes.some(c => !c.doc.metadata.hasPendingWrites);
        if (foreign) changedCols.add(col);
        if (received.size === COLS.length) {
          if (!ready) ready = true;
          if (changedCols.size) scheduleApply();
        }
        recomputeStatus();
      }, (e) => { lastError = String(e?.message || e); setStatus('error'); }));
    }
  }

  function stopListening(): void {
    unsubs.forEach(u => u());
    unsubs = [];
    remote = emptyDocs();
    synced = new Map(COLS.map(c => [c, new Map()]));
    received = new Set();
    ready = false;
    changedCols = new Set();
    expected.forEach(m => m.clear());
    pending.clear();
    fromCache.clear();
  }

  function leaveLocal(): void {
    stopListening();
    cfg = { myName: cfg.myName };
    saveCfg(cfg);
    members = {};
    recomputeStatus();
    if (!modal.classList.contains('hidden')) renderPanel();
  }

  // ---- Действия ----
  async function createSpace(name: string, myName: string): Promise<void> {
    myUid = await ensureUser();
    const { db } = firebase();
    const ref = doc(collection(db, 'spaces'));
    await setDoc(ref, { name: name || 'Семья', owner: myUid, createdAt: serverTimestamp(), members: { [myUid]: { name: myName, role: 'owner', joinedAt: Date.now() } } });
    cfg = { spaceId: ref.id, myName };
    saveCfg(cfg);
    void rememberSpace(ref.id);
    // мы — источник данных: отправляем всё, затем слушаем
    stopListening();
    ready = true;
    uploadNow();
    listen(ref.id);
  }

  async function joinSpace(codeRaw: string, myName: string): Promise<void> {
    const code = normCode(codeRaw);
    if (code.length !== 8) throw new Error('Код — 8 символов, например K7QM-3XPA');
    myUid = await ensureUser();
    const { db } = firebase();
    const inv = await getDoc(doc(db, 'invites', code));
    if (!inv.exists()) throw new Error('Приглашение не найдено. Проверьте код');
    const { spaceId, expiresAt } = inv.data();
    if ((expiresAt?.toMillis?.() ?? 0) < Date.now()) throw new Error('Срок приглашения истёк — попросите новый код');
    await updateDoc(doc(db, 'spaces', spaceId), { [`members.${myUid}`]: { name: myName, role: 'editor', joinedAt: Date.now(), invite: code } });
    await host.backup('before-family-join').catch(() => null);
    cfg = { spaceId, myName };
    saveCfg(cfg);
    void rememberSpace(spaceId);
    listen(spaceId); // первые снимки заменят локальные данные данными семьи
  }

  async function createInvite(): Promise<string> {
    const { db } = firebase();
    const code = newInviteCode();
    await setDoc(doc(db, 'invites', code), {
      spaceId: cfg.spaceId, createdBy: myUid, createdAt: serverTimestamp(),
      expiresAt: Timestamp.fromMillis(Date.now() + 7 * 86_400_000),
    });
    return code;
  }

  async function leaveSpace(): Promise<void> {
    const { db } = firebase();
    try { await updateDoc(doc(db, 'spaces', cfg.spaceId!), { [`members.${myUid}`]: deleteField() }); } catch { /* без сети — выйдем локально */ }
    void rememberSpace(null);
    leaveLocal();
  }

  /** users/{uid}.spaceId — по нему семья восстанавливается после переустановки (при входе через Google). */
  async function rememberSpace(spaceId: string | null): Promise<void> {
    if (!myUid) return;
    try { await setDoc(doc(firebase().db, 'users', myUid), { spaceId, updatedAt: serverTimestamp() }, { merge: true }); }
    catch (e) { console.warn('KeepShop: users doc', e); }
  }

  async function googleSignIn(): Promise<string> {
    const wasInFamily = !!cfg.spaceId && !!members[myUid];
    const { uid, switched } = await signInWithGoogle();
    myUid = uid;
    const { db } = firebase();
    const acc = currentAccount();
    if (cfg.spaceId && !switched) {
      // тот же пользователь: отметим аккаунт в списке участников и запомним семью
      try { await updateDoc(doc(db, 'spaces', cfg.spaceId), { [`members.${uid}.email`]: acc.email }); } catch { /* не критично */ }
      await rememberSpace(cfg.spaceId);
      return `Аккаунт Google ${acc.email} привязан. Семья сохранится при переустановке`;
    }
    // новый телефон / переустановка / другой аккаунт — ищем его семью
    let linked: string | null = null;
    try { const u = await getDoc(doc(db, 'users', uid)); linked = u.exists() ? (u.data().spaceId || null) : null; } catch { linked = null; }
    if (linked) {
      const sp = await getDoc(doc(db, 'spaces', linked)).catch(() => null);
      if (sp?.exists() && sp.data().members?.[uid]) {
        if (linked !== cfg.spaceId) {
          await host.backup('before-family-restore').catch(() => null);
          cfg = { spaceId: linked, myName: sp.data().members[uid].name || cfg.myName };
          saveCfg(cfg);
          listen(linked);
        }
        return `Вход выполнен: ${acc.email}. Семья «${sp.data().name || 'Семья'}» подключена`;
      }
    }
    if (wasInFamily) {
      // этот Google-аккаунт не состоит в текущей семье
      leaveLocal();
      return `Аккаунт ${acc.email} не состоит в этой семье. Попросите новый код и присоединитесь им`;
    }
    return `Вход выполнен: ${acc.email}. Создайте семью или присоединитесь по коду`;
  }

  async function googleSignOut(): Promise<void> {
    const { auth } = firebase();
    if (isNative && !USE_EMULATOR) {
      try { const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication'); await FirebaseAuthentication.signOut(); } catch { /* не критично */ }
    }
    await signOut(auth);
    myUid = '';
    leaveLocal(); // данные остаются на телефоне; повторный вход через Google вернёт семью
  }

  async function removeMember(uid: string): Promise<void> {
    const { db } = firebase();
    await updateDoc(doc(db, 'spaces', cfg.spaceId!), { [`members.${uid}`]: deleteField() });
  }

  // ==================== Окно «Семейный доступ» ====================
  const STATUS_TEXT: Record<SyncStatus, string> = {
    off: 'Не подключено', connecting: 'Подключение…', synced: 'Синхронизировано ✓',
    pending: 'Отправка изменений…', offline: 'Нет сети — изменения сохранятся и уйдут позже', error: 'Ошибка синхронизации',
  };
  const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  let busy = false;
  let shownCode = '';

  const modal = document.createElement('div');
  modal.id = 'syncModal';
  modal.className = 'modal-shell hidden fixed inset-0 z-[60] bg-black/55 flex items-end sm:items-center justify-center p-0 sm:p-4';
  modal.innerHTML = `<div class="modal-box w-full sm:max-w-md bg-white dark:bg-zinc-900 rounded-t-3xl sm:rounded-3xl shadow-2xl p-4 space-y-3 max-h-[92vh] overflow-y-auto">
    <div class="flex items-center justify-between">
      <h3 class="font-extrabold text-base">👨‍👩‍👧 Семейный доступ</h3>
      <button type="button" data-close-modal="syncModal" class="w-9 h-9 rounded-xl hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-500">✕</button>
    </div>
    <div id="syncBody" class="space-y-3 text-sm"></div>
  </div>`;
  document.body.appendChild(modal);
  setModalBackHandler('syncModal', () => false);
  const body = modal.querySelector<HTMLElement>('#syncBody')!;
  const field = 'w-full h-10 px-3 rounded-xl bg-slate-100 dark:bg-zinc-800 text-sm outline-none';
  const btn = 'w-full py-2.5 rounded-xl text-sm font-bold';

  const G_LOGO = '<svg viewBox="0 0 48 48" class="w-5 h-5 shrink-0"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

  function accountBlock(): string {
    const acc = currentAccount();
    if (acc.google) {
      return `<div class="flex items-center gap-2 p-2.5 rounded-2xl border border-slate-200 dark:border-zinc-800">
        ${G_LOGO}<div class="flex-1 min-w-0"><div class="text-[11px] text-slate-400">Аккаунт Google</div><div class="font-semibold truncate">${esc(acc.email)}</div></div>
        <button type="button" data-sync="signout" class="px-2.5 py-1.5 rounded-lg text-xs font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-zinc-800">Выйти</button>
      </div>`;
    }
    return `<div class="p-2.5 rounded-2xl border border-slate-200 dark:border-zinc-800 space-y-2">
      <p class="text-[11px] text-slate-500 dark:text-zinc-400">${cfg.spaceId
        ? 'Вы в семье без аккаунта. Войдите через Google, чтобы не потерять доступ при переустановке приложения или смене телефона.'
        : 'Уже были в семье? Войдите через Google — семья подключится сама.'}</p>
      <button type="button" data-sync="google" class="${btn} flex items-center justify-center gap-2 bg-white dark:bg-zinc-800 border border-slate-300 dark:border-zinc-700 text-zinc-800 dark:text-zinc-100 hover:bg-slate-50">${G_LOGO}<span>Войти через Google</span></button>
    </div>`;
  }

  function renderPanel(): void {
    if (!cfg.spaceId) {
      body.innerHTML = accountBlock() + `
        <p class="text-xs text-slate-500 dark:text-zinc-400">Общие списки, «Недавние», база товаров, история, цены и дисконтные карты — одни и те же на телефонах всей семьи. Изменения приходят за пару секунд, без интернета всё работает и синхронизируется позже.</p>
        <label class="block text-xs font-bold text-slate-500">Ваше имя (его увидят остальные)
          <input id="syncMyName" value="${esc(cfg.myName || '')}" placeholder="Например, Саша" class="${field} mt-1" /></label>
        <div class="p-3 rounded-2xl bg-amber-50 dark:bg-amber-500/10 space-y-2">
          <div class="font-bold">Создать семейное пространство</div>
          <input id="syncSpaceName" placeholder="Название, например «Семья»" class="${field}" />
          <button type="button" data-sync="create" class="${btn} bg-amber-500 hover:bg-amber-600 text-white">Создать и загрузить мои данные</button>
        </div>
        <div class="p-3 rounded-2xl bg-indigo-50 dark:bg-indigo-500/10 space-y-2">
          <div class="font-bold">Присоединиться по коду</div>
          <input id="syncCode" placeholder="Код, например K7QM-3XPA" autocomplete="off" class="${field} font-mono uppercase tracking-widest" />
          <button type="button" data-sync="join" class="${btn} bg-indigo-600 hover:bg-indigo-700 text-white">Присоединиться</button>
          <p class="text-[11px] text-slate-500 dark:text-zinc-400">Данные на этом телефоне заменятся данными семьи. Перед этим автоматически создастся резервная копия.</p>
        </div>
        ${lastError ? `<p class="text-xs text-rose-500">${esc(lastError)}</p>` : ''}`;
      return;
    }
    const list = Object.entries(members).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
    const isOwner = members[myUid]?.role === 'owner';
    body.innerHTML = `
      <div class="p-3 rounded-2xl bg-slate-50 dark:bg-zinc-800/60">
        <div class="font-extrabold">${esc(spaceName || 'Семья')}</div>
        <div class="text-xs mt-0.5 ${status === 'error' ? 'text-rose-500' : status === 'synced' ? 'text-emerald-600' : 'text-slate-500'}">${STATUS_TEXT[status]}${status === 'error' && lastError ? ': ' + esc(lastError) : ''}</div>
      </div>
      ${accountBlock()}
      <div>
        <div class="text-xs font-bold text-slate-500 mb-1">Участники (${list.length})</div>
        <div class="space-y-1">${list.map(([uid, m]) => `
          <div class="flex items-center gap-2 p-2 rounded-xl border border-slate-200 dark:border-zinc-800">
            <span class="w-8 h-8 rounded-full bg-amber-500 text-white font-extrabold flex items-center justify-center shrink-0">${esc((m.name || '?')[0].toUpperCase())}</span>
            <span class="flex-1 min-w-0"><span class="block truncate font-semibold">${esc(m.name || 'Без имени')}${uid === myUid ? ' <span class="text-slate-400 font-normal">(вы)</span>' : ''}</span>${(m as Member & { email?: string }).email ? `<span class="block truncate text-[11px] text-slate-400">${esc((m as Member & { email?: string }).email!)}</span>` : ''}</span>
            <span class="text-[11px] text-slate-400">${m.role === 'owner' ? 'владелец' : 'участник'}</span>
            ${isOwner && uid !== myUid ? `<button type="button" data-sync-remove="${uid}" class="w-7 h-7 rounded-lg text-slate-400 hover:text-rose-500" title="Удалить из семьи">✕</button>` : ''}
          </div>`).join('') || '<div class="text-xs text-slate-400">Загрузка…</div>'}</div>
      </div>
      ${shownCode ? `
        <div class="p-3 rounded-2xl bg-indigo-50 dark:bg-indigo-500/10 text-center space-y-2">
          <div class="text-xs text-slate-500">Код приглашения (действует 7 дней)</div>
          <div class="font-mono text-2xl font-extrabold tracking-widest">${fmtCode(shownCode)}</div>
          <button type="button" data-sync="share" class="${btn} bg-indigo-600 hover:bg-indigo-700 text-white">📤 Отправить код</button>
          <p class="text-[11px] text-slate-500">Второй человек: KeepShop → ⋮ → «Семейный доступ» → «Присоединиться по коду».</p>
        </div>` : `<button type="button" data-sync="invite" class="${btn} bg-amber-500 hover:bg-amber-600 text-white">➕ Пригласить в семью</button>`}
      <button type="button" data-sync="leave" class="${btn} text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40">Выйти из семейного пространства</button>
      <p class="text-[11px] text-slate-400">После выхода данные останутся на этом телефоне, но перестанут синхронизироваться.</p>`;
  }

  modal.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    if (t === modal) { modal.classList.add('hidden'); return; }
    const rm = t.closest<HTMLElement>('[data-sync-remove]');
    const act = t.closest<HTMLElement>('[data-sync]')?.dataset.sync;
    if ((!rm && !act) || busy) return;
    // значения полей читаем сразу: setStatus() ниже перерисовывает окно
    const myName = (body.querySelector<HTMLInputElement>('#syncMyName')?.value || cfg.myName || '').trim();
    const spaceNameInput = (body.querySelector<HTMLInputElement>('#syncSpaceName')?.value || '').trim();
    const codeInput = body.querySelector<HTMLInputElement>('#syncCode')?.value || '';
    busy = true;
    lastError = '';
    try {
      if (rm) {
        const name = members[rm.dataset.syncRemove!]?.name || 'участника';
        if (confirm(`Удалить ${name} из семьи? Данные на его телефоне останутся, но перестанут синхронизироваться.`)) await removeMember(rm.dataset.syncRemove!);
      } else if (act === 'create') {
        if (!myName) throw new Error('Укажите ваше имя');
        setStatus('connecting');
        await createSpace(spaceNameInput, myName);
        host.toast('Семейное пространство создано. Пригласите близких кодом');
      } else if (act === 'join') {
        if (!myName) throw new Error('Укажите ваше имя');
        setStatus('connecting');
        await joinSpace(codeInput, myName);
        host.toast('Вы присоединились к семье. Данные загружаются…');
      } else if (act === 'invite') {
        shownCode = await createInvite();
      } else if (act === 'share') {
        host.shareText(`Присоединяйся к нашим общим покупкам в KeepShop!\nКод приглашения: ${fmtCode(shownCode)}\n(⋮ → «Семейный доступ» → «Присоединиться по коду», действует 7 дней)`);
      } else if (act === 'google') {
        setStatus(cfg.spaceId ? status : 'connecting');
        host.toast(await googleSignIn());
      } else if (act === 'signout') {
        if (confirm('Выйти из аккаунта Google? Данные останутся на телефоне, синхронизация остановится. Войдите снова — и семья вернётся.')) {
          await googleSignOut();
          host.toast('Вы вышли из аккаунта');
        }
      } else if (act === 'leave') {
        if (confirm('Выйти из семейного пространства? Данные останутся на этом телефоне.')) { await leaveSpace(); shownCode = ''; host.toast('Вы вышли из семейного пространства'); }
      }
    } catch (err) {
      const msg = String((err as Error)?.message || err);
      lastError = /canceled|cancelled|popup-closed|12501/i.test(msg) ? ''
        : /DEVELOPER_ERROR|\b10\b.*Google|developer console/i.test(msg) ? 'Вход Google не настроен: в Firebase не добавлен отпечаток SHA-1 этого приложения'
        : /admin-restricted|operation-not-allowed/i.test(msg)
        ? 'В Firebase не включён анонимный вход (Authentication → Sign-in method → Anonymous)'
        : /permission|insufficient/i.test(msg) ? 'Нет доступа: проверьте код или правила Firestore'
        : /offline|unavailable|network/i.test(msg) ? 'Нет связи с сервером — нужен интернет' : msg;
      if (cfg.spaceId) setStatus('error'); else recomputeStatus();
    } finally {
      busy = false;
      renderPanel();
    }
  });

  // уже в семье — подключаемся при запуске
  if (cfg.spaceId) {
    void ensureUser().then(uid => { myUid = uid; listen(cfg.spaceId!); }).catch(e => { lastError = String(e?.message || e); setStatus('error'); });
  }
  setStatus(status);

  return {
    onLocalChange,
    status: () => status,
    open() {
      document.getElementById('moreMenuDropdown')?.classList.add('hidden');
      lastError = lastError && cfg.spaceId ? lastError : '';
      modal.classList.remove('hidden');
      renderPanel();
    },
  };
}
