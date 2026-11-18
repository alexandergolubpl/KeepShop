// KeepShop native shim: подключается только в APK-сборке (scripts/prepare-www.mjs).
// Даёт HTML-приложению то, чего нет во встроенном WebView: сохранение файлов,
// кнопку «Назад», хранение ключа Gemini.
(function () {
  const Cap = window.Capacitor;
  const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
  const P = (Cap && Cap.Plugins) || {};
  const KEY_STORAGE = 'keepshop_gemini_api_key';

  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) {} }

  function toast(msg) {
    const box = document.getElementById('toastBox');
    const txt = document.getElementById('toastText');
    const undoBtn = document.getElementById('toastUndoBtn');
    if (!box || !txt) return;
    txt.textContent = msg;
    if (undoBtn) undoBtn.classList.add('hidden');
    box.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => box.classList.add('hidden'), 2800);
  }

  // ---------- Ключ Gemini ----------
  let keyDialogResolve = null;
  function buildKeyDialog() {
    if (document.getElementById('ksGeminiKeyModal')) return;
    const wrap = document.createElement('div');
    wrap.id = 'ksGeminiKeyModal';
    wrap.className = 'modal-shell hidden fixed inset-0 z-[60] bg-black/55 flex items-center justify-center p-4';
    wrap.innerHTML = `
      <div class="w-full max-w-md bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl p-5 space-y-3 text-sm">
        <div class="flex items-center justify-between gap-2">
          <h3 class="font-extrabold text-base">🔑 Ключ Gemini AI</h3>
          <button type="button" data-close-modal="ksGeminiKeyModal" class="p-2 rounded-xl hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-500">✕</button>
        </div>
        <p class="text-xs text-slate-500 dark:text-zinc-400">Распознавание чеков и автозаполнение товаров работают через Google Gemini.
          Бесплатный ключ можно получить на <a href="https://aistudio.google.com/apikey" target="_blank" class="text-blue-600 underline">aistudio.google.com/apikey</a>.
          Ключ хранится только на этом телефоне.</p>
        <input id="ksGeminiKeyInput" type="password" autocomplete="off" placeholder="AIza..." class="w-full px-3 py-2.5 rounded-xl bg-slate-100 dark:bg-zinc-800 outline-none font-mono text-xs" />
        <div class="flex justify-between gap-2">
          <button type="button" id="ksGeminiKeyClear" class="px-3 py-2 rounded-xl text-xs font-semibold text-red-500">Удалить ключ</button>
          <button type="button" id="ksGeminiKeySave" class="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold">Сохранить</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const input = wrap.querySelector('#ksGeminiKeyInput');
    const finish = (val) => {
      wrap.classList.add('hidden');
      if (keyDialogResolve) { keyDialogResolve(val); keyDialogResolve = null; }
    };
    wrap.querySelector('[data-close-modal]').addEventListener('click', (e) => { e.stopPropagation(); finish(lsGet(KEY_STORAGE)); });
    wrap.querySelector('#ksGeminiKeySave').addEventListener('click', () => {
      const v = input.value.trim();
      lsSet(KEY_STORAGE, v);
      toast(v ? 'Ключ Gemini сохранён' : 'Ключ не указан');
      finish(v);
    });
    wrap.querySelector('#ksGeminiKeyClear').addEventListener('click', () => {
      lsSet(KEY_STORAGE, '');
      input.value = '';
      toast('Ключ удалён');
      finish('');
    });
  }

  function editGeminiKey() {
    buildKeyDialog();
    document.getElementById('moreMenuDropdown')?.classList.add('hidden');
    const wrap = document.getElementById('ksGeminiKeyModal');
    wrap.querySelector('#ksGeminiKeyInput').value = lsGet(KEY_STORAGE);
    wrap.classList.remove('hidden');
    return new Promise((res) => { keyDialogResolve = res; });
  }

  async function getGeminiKey() {
    const k = lsGet(KEY_STORAGE);
    if (k) return k;
    return editGeminiKey();
  }

  // ---------- Сохранение / «Поделиться» файлов ----------
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  async function saveAndShare(blob, filename) {
    try {
      const data = await blobToBase64(blob);
      const { uri } = await P.Filesystem.writeFile({ path: filename, data, directory: 'CACHE' });
      await P.Share.share({ title: filename, url: uri, dialogTitle: 'Сохранить или отправить ' + filename });
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (!/cancel/i.test(msg)) toast('Не удалось сохранить файл: ' + msg);
    }
  }

  // ---------- Кнопка «Назад» ----------
  function setupBackButton() {
    if (!P.App) return;
    P.App.addListener('backButton', () => {
      const open = Array.from(document.querySelectorAll('.modal-shell')).filter((m) => !m.classList.contains('hidden'));
      if (open.length) {
        const top = open[open.length - 1];
        const closer = top.querySelector('[data-close-modal]');
        closer ? closer.click() : top.classList.add('hidden');
        return;
      }
      const menu = document.getElementById('moreMenuDropdown');
      if (menu && !menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
      const search = document.getElementById('inlineSearchOverlay');
      if (search && !search.classList.contains('hidden')) { document.getElementById('closeSearchBtn')?.click(); return; }
      P.App.minimizeApp ? P.App.minimizeApp() : P.App.exitApp();
    });
  }

  function setupUi() {
    buildKeyDialog();
    // Пункт меню «Ключ Gemini AI»
    const menu = document.getElementById('moreMenuDropdown');
    const anchor = menu?.querySelector('[data-open-modal="dataApkModal"]');
    if (anchor && !document.getElementById('ksGeminiKeyMenuBtn')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'ksGeminiKeyMenuBtn';
      btn.className = anchor.className;
      btn.innerHTML = '<span>🔑</span><span>Ключ Gemini AI</span>';
      btn.addEventListener('click', () => editGeminiKey());
      anchor.insertAdjacentElement('afterend', btn);
    }
    if (isNative) {
      // Генератор ZIP-проекта APK внутри самого APK не нужен
      const zipBtn = document.getElementById('downloadZipApkBtn');
      if (zipBtn) (zipBtn.closest('div.rounded-2xl') || zipBtn).style.display = 'none';
      setupBackButton();
    }
  }

  window.KS = { isNative, getGeminiKey, editGeminiKey, saveAndShare };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupUi);
  else setupUi();
})();
