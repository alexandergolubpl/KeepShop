// @ts-nocheck — перенесённый код ещё не типизирован. Он постепенно разбивается на типизированные
// модули (см. native.ts, swipe.ts, price-hints.ts); новый код пишется сразу в отдельных модулях.
// KeepShop AI — основная логика приложения.
// Перенесено из keepshop_ai.html; дальше разбивается на модули в src/.
import L from 'leaflet';
import { isNative, getGeminiKey, saveAndShare, setBackHandler } from './native';
import { hintPrice, normName } from './price-hints';
import { initSwipeNav } from './swipe';
import { estimatePricesWithAI, categorizeWithAI } from './ai-prices';
import { initProductsUi, seedProducts, upsertProduct, findProduct, guessCategory, OTHER_CATEGORY } from './products';
import { convertUnitPrice } from './price-hints';
import { initCards } from './cards';
import { initSync } from './sync';
import { shareText } from './native';
import { AssociationIndex, REASON_LABEL } from './associations';
// Поставляемая база товаров: стартовый справочник для новых установок
import bundledProducts from './data/products.json';
import { initBackups, onStateSaved, readMirror, parseBackup, restoreFromFile, createBackup, shareBackup } from './backup';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, GoogleAuthProvider, signInWithPopup, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, onSnapshot } from 'firebase/firestore';

// Global error shield
window.onerror = function(msg, src, line) {
  console.warn('KeepShop Safe Handler:', msg, line);
  return true;
};

// SafeStorage: prevents SecurityError inside Google Sites / sandboxed iframes
const SafeStorage = (() => {
  const memory = {};
  return {
    get(key) {
      try {
        return window.localStorage.getItem(key);
      } catch (e) {
        try {
          if (window.name && window.name.startsWith('KS_CACHE:')) {
            const parsed = JSON.parse(window.name.slice(9));
            return parsed[key] ?? memory[key] ?? null;
          }
        } catch (err) {}
        return memory[key] ?? null;
      }
    },
    set(key, val) {
      memory[key] = val;
      try {
        window.localStorage.setItem(key, val);
      } catch (e) {
        try {
          window.name = 'KS_CACHE:' + JSON.stringify({ [key]: val });
        } catch (err) {}
      }
    }
  };
})();

const STORAGE_KEY = 'keepshop_ai_v6_full';
// Модель Gemini для всех функций ИИ. «-latest» — алиас Google на актуальную версию,
// lite отвечает за ~1 с и имеет больший бесплатный лимит (gemini-3-flash-preview упирался в квоту).
const GEMINI_MODEL = 'gemini-flash-lite-latest';
const CURRENCIES = {
  PLN: { code: 'PLN', symbol: 'zł', before: false, rateFromPln: 1 },
  RUB: { code: 'RUB', symbol: '₽', before: false, rateFromPln: 23.5 },
  USD: { code: 'USD', symbol: '$', before: true, rateFromPln: 0.25 },
  EUR: { code: 'EUR', symbol: '€', before: true, rateFromPln: 0.23 },
  UAH: { code: 'UAH', symbol: '₴', before: false, rateFromPln: 10.2 },
  BYN: { code: 'BYN', symbol: 'Br', before: false, rateFromPln: 0.82 },
  KZT: { code: 'KZT', symbol: '₸', before: false, rateFromPln: 122 },
  GBP: { code: 'GBP', symbol: '£', before: true, rateFromPln: 0.19 }
};

const STORE_SEARCH_URLS = {
  biedronka: (q) => `https://zakupy.biedronka.pl/szukaj?q=${encodeURIComponent(q)}`,
  lidl: (q) => `https://www.lidl.pl/q/search?q=${encodeURIComponent(q)}`,
  auchan: (q) => `https://zakupy.auchan.pl/shop/search?q=${encodeURIComponent(q)}`,
  carrefour: (q) => `https://www.carrefour.pl/szukaj?q=${encodeURIComponent(q)}`,
  żabka: (q) => `https://www.google.com/search?q=site:zabka.pl+${encodeURIComponent(q)}`,
  zabka: (q) => `https://www.google.com/search?q=site:zabka.pl+${encodeURIComponent(q)}`,
  kaufland: (q) => `https://www.kaufland.pl/wyszukiwarka.html?search_value=${encodeURIComponent(q)}`,
  aldi: (q) => `https://www.aldi.pl/wyszukiwanie.html?query=${encodeURIComponent(q)}`,
  пятёрочка: (q) => `https://5ka.ru/search/?text=${encodeURIComponent(q)}`,
  пятерочка: (q) => `https://5ka.ru/search/?text=${encodeURIComponent(q)}`,
  магнит: (q) => `https://magnit.ru/search?q=${encodeURIComponent(q)}`,
  вкусвилл: (q) => `https://vkusvill.ru/search/?q=${encodeURIComponent(q)}`
};

function buildProductStoreUrl(productName, storeName = '', customUrl = '') {
  if (customUrl && /^https?:\/\//i.test(customUrl.trim())) return customUrl.trim();
  const s = (storeName || '').trim().toLowerCase();
  for (const [key, fn] of Object.entries(STORE_SEARCH_URLS)) {
    if (s.includes(key)) return fn(productName);
  }
  const query = storeName ? `${productName} ${storeName} цена` : `${productName} купить цена`;
  return `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(query)}`;
}

// ==================== AUTO-TRANSLATE PRODUCT NAMES FOR LOCAL STORE SEARCH ====================
// Перед открытием поиска в магазине название товара переводится на язык магазина
// («Молоко» -> «mleko» для Biedronka). Работает для уже сохранённых ссылок тоже:
// перехватываются клики по ссылкам на поиск магазинов.
const AutoTranslate = (() => {
  const CACHE_KEY = 'keepshop_translate_cache_v2';
  const FLAG_KEY = 'keepshop_autotranslate_off';
  // host -> язык магазина и параметр поиска
  const STORE_HOSTS = [
    { re: /(^|\.)zakupy\.biedronka\.pl$/, lang: 'pl', param: 'q' },
    { re: /(^|\.)lidl\.pl$/, lang: 'pl', param: 'q' },
    { re: /(^|\.)zakupy\.auchan\.pl$/, lang: 'pl', param: 'q' },
    { re: /(^|\.)carrefour\.pl$/, lang: 'pl', param: 'q' },
    { re: /(^|\.)kaufland\.pl$/, lang: 'pl', param: 'search_value' },
    { re: /(^|\.)aldi\.pl$/, lang: 'pl', param: 'query' },
    { re: /(^|\.)5ka\.ru$/, lang: 'ru', param: 'text' },
    { re: /(^|\.)magnit\.ru$/, lang: 'ru', param: 'q' },
    { re: /(^|\.)vkusvill\.ru$/, lang: 'ru', param: 'q' }
  ];
  const CURRENCY_LANG = { PLN: 'pl', RUB: 'ru', BYN: 'ru', KZT: 'ru', UAH: 'uk', GBP: 'en', USD: 'en' };
  // Слова, которые добавляет buildProductStoreUrl для Google-поиска
  const GOOGLE_SUFFIX = { pl: 'cena', uk: 'ціна', en: 'price', ru: 'цена' };

  let cache = {};
  try { cache = JSON.parse(SafeStorage.get(CACHE_KEY) || '{}') || {}; } catch (e) { cache = {}; }
  const pending = new Map();

  const isEnabled = () => SafeStorage.get(FLAG_KEY) !== '1';
  const setEnabled = (on) => SafeStorage.set(FLAG_KEY, on ? '0' : '1');
  const cacheKey = (text, lang) => lang + '|' + text.trim().toLowerCase();
  const saveCache = () => {
    const keys = Object.keys(cache);
    if (keys.length > 1500) keys.slice(0, keys.length - 1500).forEach(k => delete cache[k]);
    SafeStorage.set(CACHE_KEY, JSON.stringify(cache));
  };

  const fetchWithTimeout = (url, ms, opts = {}) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
  };

  const LANG_NAMES = { pl: 'польский', ru: 'русский', uk: 'украинский', en: 'английский' };
  const readGeminiKey = () => { try { return localStorage.getItem('keepshop_gemini_api_key') || ''; } catch (e) { return ''; } };

  // 1) Gemini — понимает, что это продукт («Сметана» -> «Śmietana», а не «Krem»); только если ключ уже сохранён
  // Gemini тратит общий бесплатный лимит ключа (он же нужен для чеков и рецептов),
  // поэтому зовём его только при нажатии на ссылку, а на 429 замолкаем на 15 минут.
  let geminiPausedUntil = 0;
  async function viaGemini(text, lang) {
    const key = readGeminiKey();
    if (!key || Date.now() < geminiPausedUntil) return null;
    const res = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`, 6000, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Переведи название товара для поиска в интернет-магазине супермаркета на ${LANG_NAMES[lang] || lang} язык. Пиши так, как товар называется на упаковке в местных магазинах. Сохрани бренды, проценты и вес. Ответь только переводом, без кавычек и пояснений.
Товар: ${text}` }] }],
        generationConfig: { temperature: 0 }
      })
    });
    if (res.status === 429) geminiPausedUntil = Date.now() + 15 * 60 * 1000;
    if (!res.ok) return null;
    const out = (await res.json())?.candidates?.[0]?.content?.parts?.[0]?.text?.trim().replace(/^["«']|["»']$/g, '');
    return out && out.length < 120 ? out : null;
  }

  // 2) Google Translate (без ключа)
  async function viaGoogle(text, lang) {
    const res = await fetchWithTimeout(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${lang}&dt=t&q=${encodeURIComponent(text)}`, 3500);
    if (!res.ok) return null;
    return (await res.json())?.[0]?.map(seg => seg?.[0] || '').join('').trim() || null;
  }

  // 3) MyMemory (без ключа, запасной)
  async function viaMyMemory(text, lang) {
    const src = /[іїєґ]/i.test(text) ? 'uk' : (/[а-яё]/i.test(text) ? 'ru' : 'en');
    if (src === lang) return null;
    const res = await fetchWithTimeout(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${src}|${lang}`, 3500);
    if (!res.ok) return null;
    const out = (await res.json())?.responseData?.translatedText?.trim();
    return out && !/MYMEMORY WARNING/i.test(out) ? out : null;
  }

  async function translateRemote(text, lang, urgent = false) {
    for (const fn of urgent ? [viaGemini, viaGoogle, viaMyMemory] : [viaGoogle, viaMyMemory]) {
      try {
        const out = await fn(text, lang);
        if (out) return out;
      } catch (e) {}
    }
    return null;
  }

  // Кириллица для русского магазина и латиница (бренды, польские названия) для остальных
  // уже подходят для поиска; для украинского проверяет сам переводчик
  const CYR = /[а-яёіїєґ]/i;
  function needsTranslation(text, lang) {
    return lang === 'ru' ? !/[а-яё]/i.test(text) : CYR.test(text);
  }

  // Словарь продуктов, на которых машинный перевод ошибается («Сметана» -> «Krem»).
  // Длинные фразы раньше коротких. Работает и без интернета.
  const PL_DICT = [
    ['куриное филе', 'filet z kurczaka'], ['филе индейки', 'filet z indyka'], ['куриные яйца', 'jajka'],
    ['подсолнечное масло', 'olej słonecznikowy'], ['оливковое масло', 'oliwa z oliwek'], ['сливочное масло', 'masło'],
    ['туалетная бумага', 'papier toaletowy'], ['бумажные полотенца', 'ręczniki papierowe'],
    ['средство для посуды', 'płyn do naczyń'], ['таблетки для посудомойки', 'tabletki do zmywarki'],
    ['стиральный порошок', 'proszek do prania'], ['зубная паста', 'pasta do zębów'],
    ['минеральная вода', 'woda mineralna'], ['сметана', 'śmietana'], ['сливки', 'śmietanka'],
    ['гречка', 'kasza gryczana'], ['перловка', 'kasza jęczmienna'], ['пшено', 'kasza jaglana'],
    ['овсянка', 'płatki owsiane'], ['творог', 'twaróg'], ['кефир', 'kefir'], ['ряженка', 'ryażenka'],
    ['простокваша', 'zsiadłe mleko'], ['йогурт', 'jogurt'], ['молоко', 'mleko'], ['сыр', 'ser'],
    ['яйца', 'jajka'], ['хлеб', 'chleb'], ['батон', 'bułka paryska'], ['булочки', 'bułki'],
    ['колбаса', 'kiełbasa'], ['сосиски', 'parówki'], ['ветчина', 'szynka'], ['фарш', 'mięso mielone'],
    ['курица', 'kurczak'], ['свинина', 'wieprzowina'], ['говядина', 'wołowina'], ['сельдь', 'śledź'],
    ['селёдка', 'śledź'], ['селедка', 'śledź'], ['пельмени', 'pielmieni'], ['вареники', 'pierogi'],
    ['картофель', 'ziemniaki'], ['картошка', 'ziemniaki'], ['морковь', 'marchew'], ['лук', 'cebula'],
    ['чеснок', 'czosnek'], ['капуста', 'kapusta'], ['свёкла', 'burak'], ['свекла', 'burak'],
    ['огурцы', 'ogórki'], ['помидоры', 'pomidory'], ['укроп', 'koperek'], ['петрушка', 'pietruszka'],
    ['яблоки', 'jabłka'], ['бананы', 'banany'], ['апельсины', 'pomarańcze'], ['лимон', 'cytryna'],
    ['рис', 'ryż'], ['макароны', 'makaron'], ['мука', 'mąka'], ['сахар', 'cukier'], ['соль', 'sól'],
    ['чай', 'herbata'], ['кофе', 'kawa'], ['сок', 'sok'], ['вода', 'woda'], ['пиво', 'piwo'],
    ['майонез', 'majonez'], ['кетчуп', 'ketchup'], ['горчица', 'musztarda'], ['мёд', 'miód'], ['мед', 'miód'],
    // проверено на реальных списках: без словаря переводились неверно
    ['сливочный сыр', 'serek śmietankowy'], ['пищевая плёнка', 'folia spożywcza'], ['мусорные пакеты', 'worki na śmieci'],
    ['мешки', 'worki'], ['пакеты', 'worki'], ['мандаринки', 'mandarynki'], ['мандарины', 'mandarynki'],
    ['нут', 'ciecierzyca'], ['имбирь', 'imbir'], ['булки', 'bułki'], ['булочка', 'bułka'],
    ['прокладки', 'podpaski'], ['чипсы', 'chipsy'], ['просекко', 'prosecco'], ['просеко', 'prosecco'],
    ['тряпки', 'ścierki'], ['черри', 'cherry'], ['сарделки', 'serdelki'], ['пластырь', 'plastry'],
    ['средство', 'środek'], ['плёнка', 'folia'], ['пленка', 'folia'], ['тарелка', 'talerz'],
    ['тарелки', 'talerze'], ['каша', 'kasza'], ['сухарики', 'grzanki'], ['мороженое', 'lody'],
    ['фасоль', 'fasola'], ['горошек', 'groszek'], ['кукуруза', 'kukurydza'], ['перец', 'papryka']
  ];
  const PL_DICT_SORTED = [...PL_DICT].sort((x, y) => y[0].length - x[0].length);
  const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function applyDictionary(text, lang) {
    if (lang !== 'pl') return text;
    let out = text;
    for (const [ru, pl] of PL_DICT_SORTED) {
      out = out.replace(new RegExp(`(^|[^а-яёa-z])${escRe(ru)}(?=$|[^а-яёa-z])`, 'gi'), (m, pre) => pre + pl);
    }
    return out;
  }

  // Переводит текст на lang; null, если перевод не нужен/невозможен
  function translate(text, lang, urgent = false) {
    text = (text || '').trim();
    if (!text || !lang) return Promise.resolve(null);
    if (!needsTranslation(text, lang)) return Promise.resolve(null);
    const k = cacheKey(text, lang);
    if (k in cache) return Promise.resolve(cache[k]);
    if (pending.has(k)) {
      if (urgent) promote(k);
      return pending.get(k);
    }
    // Если словарь перевёл всё — сеть не нужна. Иначе отправляем исходный текст:
    // переводчику проще с целой фразой, а Gemini и так знает продукты.
    const local = applyDictionary(text, lang);
    if (!needsTranslation(local, lang)) {
      cache[k] = local; saveCache();
      return Promise.resolve(local);
    }
    const p = limited(() => translateRemote(text, lang, urgent), urgent, k).then(out => {
      pending.delete(k);
      if (out && out.toLowerCase() !== text.toLowerCase()) { cache[k] = out; saveCache(); return out; }
      if (out) { cache[k] = null; saveCache(); }
      return null;
    });
    pending.set(k, p);
    return p;
  }

  // Разбирает ссылку поиска магазина: { url, param, query, lang, suffix }
  function parseStoreUrl(href) {
    let url;
    try { url = new URL(href); } catch (e) { return null; }
    const host = url.hostname.toLowerCase();
    const store = STORE_HOSTS.find(s => s.re.test(host));
    if (store) {
      const query = url.searchParams.get(store.param);
      return query ? { url, param: store.param, query, lang: store.lang, prefix: '', suffix: '' } : null;
    }
    if (/(^|\.)google\.[a-z.]+$/.test(host) && url.pathname === '/search') {
      const q = url.searchParams.get('q') || '';
      const site = q.match(/^site:(\S+)\s+(.+)$/);
      if (site) {
        const lang = /\.pl$/i.test(site[1]) ? 'pl' : (/\.ru$/i.test(site[1]) ? 'ru' : null);
        return lang ? { url, param: 'q', query: site[2], lang, prefix: `site:${site[1]} `, suffix: '' } : null;
      }
      // Google Shopping: «<товар> [магазин] цена» / «<товар> купить цена»
      const lang = CURRENCY_LANG[state.currency];
      if (!lang || lang === 'ru') return null;
      const m = q.match(/^(.*?)\s+(купить цена|цена)$/);
      if (!m) return null;
      return { url, param: 'q', query: m[1], lang, prefix: '', suffix: ' ' + GOOGLE_SUFFIX[lang] };
    }
    return null;
  }

  function buildUrl(info, translated) {
    const u = new URL(info.url.toString());
    u.searchParams.set(info.param, info.prefix + translated + info.suffix);
    return u.toString();
  }

  // Синхронно: ссылка с переводом, если он уже есть в кэше (иначе null)
  function cachedUrl(href) {
    const info = parseStoreUrl(href);
    if (!info) return null;
    const k = cacheKey(info.query, info.lang);
    return cache[k] ? buildUrl(info, cache[k]) : null;
  }

  async function translatedUrl(href) {
    const info = parseStoreUrl(href);
    if (!info) return null;
    const out = await translate(info.query, info.lang);
    return out ? buildUrl(info, out) : null;
  }

  // Не больше 2 сетевых переводов одновременно, иначе бесплатные сервисы отвечают 429
  let active = 0;
  const queue = [];
  // urgent (нажатая ссылка) обходит очередь фонового прогрева
  function limited(fn, urgent, key) {
    return new Promise(resolve => {
      const run = () => { active++; fn().then(resolve, () => resolve(null)).finally(() => { active--; queue.length && queue.shift()(); }); };
      run.key = key;
      if (urgent) run(); else if (active < 2) run(); else queue.push(run);
    });
  }
  function promote(key) {
    const i = queue.findIndex(r => r.key === key);
    if (i >= 0) queue.splice(i, 1)[0]();
  }

  // Фоновый прогрев: переводим ссылки, видимые на экране, чтобы клик был мгновенным
  let warmTimer = null;
  function warmLinks() {
    clearTimeout(warmTimer);
    warmTimer = setTimeout(() => {
      if (!isEnabled()) return;
      document.querySelectorAll('a[href^="http"]:not([data-ks-tr])').forEach(a => {
        const info = parseStoreUrl(a.href);
        if (!info) return;
        a.setAttribute('data-ks-tr', '1');
        translate(info.query, info.lang).then(out => {
          if (!out || !a.isConnected || !isEnabled()) return;
          a.setAttribute('data-ks-orig', a.href);
          a.href = buildUrl(info, out);
          a.title = `Поиск в магазине: «${out}»`;
        });
      });
    }, 400);
  }

  function openExternal(url, preOpened) {
    if (window.KS && window.KS.isNative) { window.location.href = url; return; }
    if (preOpened && !preOpened.closed) { preOpened.location.href = url; return; }
    window.open(url, '_blank', 'noopener');
  }

  function onClick(e) {
    if (!isEnabled() || e.defaultPrevented || e.button > 0) return;
    const a = e.target.closest?.('a[href^="http"]');
    if (!a) return;
    const info = parseStoreUrl(a.href);
    if (!info) return;
    const ready = cachedUrl(a.href);
    if (ready) { a.href = ready; return; } // перевод уже есть — обычный переход
    const k = cacheKey(info.query, info.lang);
    if (k in cache || !needsTranslation(info.query, info.lang)) return; // перевод не нужен
    e.preventDefault();
    const original = a.href;
    const isNative = window.KS && window.KS.isNative;
    // В браузере открываем окно сразу (иначе его заблокирует блокировщик всплывающих окон)
    const pre = isNative ? null : window.open('about:blank', '_blank');
    showToast(`Переводим «${info.query}» для поиска...`);
    translate(info.query, info.lang, true).then(out => {
      const url = out ? buildUrl(info, out) : original;
      if (out) { a.setAttribute('data-ks-orig', original); a.href = url; showToast(`Ищем в магазине: «${out}»`); }
      openExternal(url, pre);
    });
  }

  function init() {
    document.addEventListener('click', onClick, true);
    new MutationObserver(warmLinks).observe(document.body, { childList: true, subtree: true });
    warmLinks();
    const label = document.getElementById('autoTranslateStateLabel');
    const updateLabel = () => { if (label) label.textContent = isEnabled() ? 'Вкл' : 'Выкл'; };
    updateLabel();
    document.getElementById('menuAutoTranslateBtn')?.addEventListener('click', () => {
      setEnabled(!isEnabled());
      updateLabel();
      document.querySelectorAll('a[data-ks-tr]').forEach(a => {
        const orig = a.getAttribute('data-ks-orig');
        if (orig) { a.href = orig; a.removeAttribute('title'); a.removeAttribute('data-ks-orig'); }
        a.removeAttribute('data-ks-tr');
      });
      if (isEnabled()) warmLinks();
      showToast(isEnabled() ? 'Автоперевод для поиска в магазинах включён' : 'Автоперевод выключен — поиск по исходному названию');
    });
  }

  return { init, translate, translatedUrl, isEnabled };
})();
window.KeepShopAutoTranslate = AutoTranslate;
AutoTranslate.init();

// Store templates positioned relative to ANY selected map pin (dLat, dLng offsets)
const STORE_TEMPLATES = [
  { id: 'st-1', chain: 'Biedronka', suffix: 'Супермаркет', dLat: 0.0032, dLng: 0.0041, multiplier: 0.94, note: 'Ежедневные акции' },
  { id: 'st-2', chain: 'Lidl', suffix: 'Маркет', dLat: -0.0065, dLng: 0.0072, multiplier: 0.91, note: 'Скидки недели' },
  { id: 'st-3', chain: 'Żabka', suffix: 'Экспресс', dLat: 0.0014, dLng: -0.0018, multiplier: 1.14, note: 'Рядом с точкой' },
  { id: 'st-4', chain: 'Auchan', suffix: 'Гипермаркет', dLat: 0.0165, dLng: -0.0142, multiplier: 0.88, note: 'Низкие цены' },
  { id: 'st-5', chain: 'Carrefour', suffix: 'Express', dLat: -0.0095, dLng: -0.0085, multiplier: 1.02, note: 'Удобный выбор' },
  { id: 'st-6', chain: 'Kaufland', suffix: 'Гипермаркет', dLat: 0.0245, dLng: 0.0195, multiplier: 0.89, note: 'Большой ассортимент' },
  { id: 'st-7', chain: 'Aldi', suffix: 'Дискаунтер', dLat: -0.0142, dLng: 0.0155, multiplier: 0.92, note: 'Выгодные предложения' },
  { id: 'st-8', chain: 'Пятёрочка', suffix: 'У дома', dLat: 0.0048, dLng: -0.0052, multiplier: 0.95, note: 'Продукты' },
  { id: 'st-9', chain: 'Магнит', suffix: 'Семейный', dLat: -0.0112, dLng: -0.0135, multiplier: 0.92, note: 'Супермаркет' },
  { id: 'st-10', chain: 'ВкусВилл', suffix: 'Фермерский', dLat: 0.0085, dLng: 0.0064, multiplier: 1.09, note: 'Натуральные продукты' }
];

// Haversine distance in kilometers between two GPS points
function calcDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.max(0.1, Math.round(R * c * 10) / 10);
}

const isoDaysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString().split('T')[0];

const DEFAULT_STATE = {
  activeTab: 'lists',
  currency: 'PLN',
  newListColor: '#ffffff',
  searchQuery: '',
  frequentFilter: 'all',
  viewModes: {},
  statsPeriod: 'month',
  priceHistoryPeriod: 'month',
  selectedHistoryProduct: 'Молоко фермерское 3.2%',
  privacy: {
    requireAuth: false,
    ownerEmail: 'owner@gmail.com',
    masterToken: 'SHOP-VIP'
  },
  session: {
    unlocked: true,
    userName: 'Владелец',
    userEmail: 'owner@gmail.com',
    role: 'Владелец'
  },
  storeSearch: {
    lat: 52.2297,
    lng: 21.0122,
    locationLabel: 'Варшава (52.2297, 21.0122)',
    savedLocations: [
      { id: 'loc-1', label: 'Точка 1 (Варшава)', lat: 52.2297, lng: 21.0122 },
      { id: 'loc-2', label: 'Мокотув (Mokotów)', lat: 52.1815, lng: 21.0042 }
    ],
    radiusKm: 3,
    chainFilter: '',
    query: '',
    sortBy: 'distance',
    selectedStoreId: 'st-1',
    targetListId: 'list-1'
  },
  lists: [
    {
      id: 'list-1',
      title: 'Продукты на неделю',
      color: '#fef3c7',
      pinned: true,
      sortMode: 'manual',
      order: 0,
      collaborators: [
        { id: 'c-1', name: 'Вы (Владелец)', email: 'owner@gmail.com', role: 'Владелец', token: 'OWNER', active: true },
        { id: 'c-2', name: 'Анна', email: 'anna.family@gmail.com', role: 'Редактор', token: 'ANNA-24', active: true }
      ],
      items: [
        {
          id: 'i-1',
          name: 'Молоко фермерское 3.2%',
          qty: 2,
          unit: 'л',
          price: 4.50,
          storeName: 'Biedronka',
          productUrl: 'https://zakupy.biedronka.pl/szukaj?q=%D0%9C%D0%BE%D0%BB%D0%BE%D0%BA%D0%BE',
          cheaperAlt: { storeName: 'Auchan Гипермаркет', chain: 'Auchan', distanceKm: 2.1, price: 3.99 },
          desc: 'В стеклянной бутылке',
          checked: false,
          order: 0
        },
        {
          id: 'i-2',
          name: 'Авокадо Хасс спелое',
          qty: 3,
          unit: 'шт',
          price: 6.50,
          storeName: 'Biedronka',
          productUrl: 'https://zakupy.biedronka.pl/szukaj?q=%D0%90%D0%B2%D0%BE%D0%BA%D0%B0%D0%B4%D0%BE',
          cheaperAlt: { storeName: 'Lidl Маркет', chain: 'Lidl', distanceKm: 0.9, price: 5.49 },
          desc: 'Для тостов на завтрак',
          checked: false,
          order: 1
        },
        {
          id: 'i-3',
          name: 'Кофе в зернах Lavazza Oro',
          qty: 1,
          unit: 'уп',
          price: 64.90,
          storeName: 'Carrefour',
          productUrl: 'https://www.carrefour.pl/szukaj?q=Lavazza+Oro',
          cheaperAlt: { storeName: 'Lidl Маркет', chain: 'Lidl', distanceKm: 0.9, price: 54.99 },
          desc: '1 кг арабика',
          checked: false,
          order: 2
        },
        {
          id: 'i-4',
          name: 'Филе индейки охлажденное',
          qty: 1.2,
          unit: 'кг',
          price: 24.50,
          storeName: 'Biedronka',
          productUrl: 'https://zakupy.biedronka.pl/szukaj?q=%D0%A4%D0%B8%D0%BB%D0%B5+%D0%B8%D0%BD%D0%B4%D0%B5%D0%B9%D0%BA%D0%B8',
          cheaperAlt: null,
          desc: 'На ужин',
          checked: true,
          order: 3
        }
      ]
    },
    {
      id: 'list-2',
      title: 'Для дома и кухни',
      color: '#dbeafe',
      pinned: false,
      sortMode: 'manual',
      order: 1,
      collaborators: [
        { id: 'c-3', name: 'Вы (Владелец)', email: 'owner@gmail.com', role: 'Владелец', token: 'OWNER', active: true }
      ],
      items: [
        {
          id: 'i-5',
          name: 'Капсулы для посудомойки Finish',
          qty: 1,
          unit: 'уп',
          price: 54.0,
          storeName: 'Auchan',
          productUrl: 'https://zakupy.auchan.pl/shop/search?q=Finish',
          cheaperAlt: { storeName: 'Kaufland Гипермаркет', chain: 'Kaufland', distanceKm: 2.9, price: 47.90 },
          desc: 'Quantum All in 1 (60 шт)',
          checked: false,
          order: 0
        }
      ]
    }
  ],
  priceHistory: [
    { id: 'ph-1', productName: 'Молоко фермерское 3.2%', price: 4.20, store: 'Auchan', date: isoDaysAgo(260) },
    { id: 'ph-2', productName: 'Молоко фермерское 3.2%', price: 4.35, store: 'Lidl', date: isoDaysAgo(140) },
    { id: 'ph-3', productName: 'Молоко фермерское 3.2%', price: 4.60, store: 'Carrefour', date: isoDaysAgo(50) },
    { id: 'ph-4', productName: 'Молоко фермерское 3.2%', price: 3.99, store: 'Auchan', date: isoDaysAgo(4) },
    { id: 'ph-5', productName: 'Молоко фермерское 3.2%', price: 4.50, store: 'Biedronka', date: isoDaysAgo(0) },
    { id: 'ph-6', productName: 'Кофе в зернах Lavazza Oro', price: 59.90, store: 'Auchan', date: isoDaysAgo(120) },
    { id: 'ph-7', productName: 'Кофе в зернах Lavazza Oro', price: 54.99, store: 'Lidl', date: isoDaysAgo(5) },
    { id: 'ph-8', productName: 'Кофе в зернах Lavazza Oro', price: 64.90, store: 'Carrefour', date: isoDaysAgo(0) },
    { id: 'ph-9', productName: 'Авокадо Хасс спелое', price: 5.49, store: 'Lidl', date: isoDaysAgo(3) },
    { id: 'ph-10', productName: 'Авокадо Хасс спелое', price: 6.50, store: 'Biedronka', date: isoDaysAgo(0) }
  ],
  recent: [
    { id: 'r-1', name: 'Филе индейки охлажденное', qty: 1.2, unit: 'кг', price: 24.5, date: isoDaysAgo(0), desc: 'Biedronka' },
    { id: 'r-2', name: 'Молоко фермерское 3.2%', qty: 2, unit: 'л', price: 4.5, date: isoDaysAgo(1), desc: 'Biedronka' },
    { id: 'r-3', name: 'Сыр Пармезан выдержанный', qty: 0.3, unit: 'кг', price: 58.0, date: isoDaysAgo(2), desc: 'Lidl' },
    { id: 'r-4', name: 'Молоко фермерское 3.2%', qty: 2, unit: 'л', price: 3.99, date: isoDaysAgo(5), desc: 'Auchan' }
  ],
  favorite: [
    { id: 'f-1', name: 'Бананы Эквадор', qty: 1, unit: 'кг', price: 6.8, desc: 'Всегда к завтраку' },
    { id: 'f-2', name: 'Яйца куриные С0', qty: 1, unit: 'уп', price: 11.5, desc: '10 штук' }
  ],
  backlog: [
    { id: 'b-1', name: 'Робот-пылесос с лидаром', qty: 1, unit: 'шт', price: 1290, desc: 'Сравнить модели' }
  ]
};

let state = loadState();
const hadLocalState = !!SafeStorage.get(STORAGE_KEY);
if (fillMissingPrices()) persistState();
let db = null;
let auth = null;
let currentUid = null;
let receiptBuffer = [];
let receiptImageBase64 = null;
let receiptImageMime = 'image/jpeg';
let keepParsedBuffer = [];
let dragContext = null;

// Leaflet map instances
let leafletMap = null;
let leafletMarker = null;
let leafletCircle = null;
let leafletStoreLayer = null;

function normalizeCollaborators(list) {
  if (!Array.isArray(list.collaborators)) list.collaborators = [];
  list.collaborators = list.collaborators.map((c, idx) => ({
    id: c.id || ('c-' + idx),
    name: c.name || 'Участник',
    email: c.email || '',
    role: c.role || 'Редактор',
    token: c.token || ('INV-' + Math.random().toString(36).slice(2, 6).toUpperCase()),
    active: c.active !== false
  }));
}

// Главный список покупок (вкладка «Недавние»): обычный список с флагом isMain,
// поэтому работают подбор, синхронизация, цены, отмена и т.д.
const MAIN_LIST_ID = 'main-list';
function ensureMainList(st = state) {
  let main = st.lists.find(l => l.isMain);
  if (!main) {
    main = { id: MAIN_LIST_ID, title: 'Недавние', color: '#ffffff', pinned: false, sortMode: 'manual', viewMode: 'compact', order: -1, collaborators: [], items: [], isMain: true };
    st.lists.push(main);
    normalizeCollaborators(main);
  }
  return main;
}
const visibleLists = () => state.lists.filter(l => !l.isMain);

function loadState() {
  try {
    const raw = SafeStorage.get(STORAGE_KEY);
    const base = raw ? { ...structuredClone(DEFAULT_STATE), ...JSON.parse(raw) } : structuredClone(DEFAULT_STATE);
    base.privacy = { ...structuredClone(DEFAULT_STATE.privacy), ...(base.privacy || {}) };
    base.session = { ...structuredClone(DEFAULT_STATE.session), ...(base.session || {}) };
    base.storeSearch = { ...structuredClone(DEFAULT_STATE.storeSearch), ...(base.storeSearch || {}) };
    if (!Array.isArray(base.storeSearch.savedLocations)) {
      base.storeSearch.savedLocations = structuredClone(DEFAULT_STATE.storeSearch.savedLocations);
    }
    base.lists.forEach(normalizeCollaborators);
    ensureMainList(base);

    // Check URL invite parameters (?invite=TOKEN&email=...)
    const params = new URLSearchParams(window.location.search);
    const inviteToken = params.get('invite') || params.get('token');
    const inviteEmail = params.get('email') || '';
    if (inviteToken) {
      const validToken =
        inviteToken === base.privacy.masterToken ||
        base.lists.some(l => l.collaborators.some(c => c.active && c.token === inviteToken));
      if (validToken) {
        base.session.unlocked = true;
        base.session.userEmail = inviteEmail || 'guest@invite';
        base.session.userName = inviteEmail ? inviteEmail.split('@')[0] : 'Приглашённый';
        base.session.role = 'Редактор';
      }
    } else if (base.privacy.requireAuth && !base.session.unlocked) {
      base.session.unlocked = false;
    }
    return base;
  } catch (e) {
    return structuredClone(DEFAULT_STATE);
  }
}

// Уникальная часть id: время + случайный хвост. Нужна для семейного доступа — два телефона
// могут создать запись в одну и ту же миллисекунду, и одинаковые id перезаписали бы друг друга.
function uniqueSuffix() { return Date.now() + '-' + Math.random().toString(36).slice(2, 6); }

// Что сохраняется на устройстве (и попадает в резервные копии)
function buildSnapshot() {
  return {
    currency: state.currency,
    privacy: state.privacy,
    session: state.session,
    lists: state.lists,
    priceHistory: state.priceHistory,
    recent: state.recent,
    favorite: state.favorite,
    backlog: state.backlog,
    storeSearch: state.storeSearch,
    viewModes: state.viewModes,
    products: state.products,
    cards: state.cards
  };
}

let syncApi = null; // семейный доступ (src/sync.ts), создаётся при запуске

function persistState() {
  const json = JSON.stringify(buildSnapshot());
  SafeStorage.set(STORAGE_KEY, json);
  onStateSaved(json); // зеркало в памяти телефона (src/backup.ts)
  syncApi?.onLocalChange(); // отправка изменений семье
}

// Изменения от семьи: заменить части базы, сохранить локально и перерисовать.
// Если человек в этот момент печатает — перерисуем, когда закончит, чтобы не сбить ввод.
let renderAfterInput = false;
function applyRemoteState(patch) {
  Object.assign(state, patch);
  if (patch.lists) { state.lists.forEach(normalizeCollaborators); ensureMainList(); }
  persistState();
  rebuildPickerProducts();
  assocIndex = null;
  document.dispatchEvent(new CustomEvent('ks:cards-changed'));
  const a = document.activeElement;
  if (a && a.matches?.('input, textarea, select') && a.closest('.main-content-area')) {
    if (!renderAfterInput) {
      renderAfterInput = true;
      a.addEventListener('blur', () => { renderAfterInput = false; renderApp(); }, { once: true });
    }
  } else renderApp();
}

function saveState() {
  persistState();
  assocIndex = null; // связи пересчитаются при следующем запросе
  rebuildPickerProducts();
  renderApp();
}

// Восстановление из резервной копии / импорта. Сессию и приватность не трогаем, чтобы не заблокировать вход.
const RESTORE_KEYS = ['lists', 'priceHistory', 'recent', 'favorite', 'backlog', 'storeSearch', 'viewModes', 'currency', 'products', 'cards'];
function applySnapshot(data, label = 'копии') {
  if (!data || !Array.isArray(data.lists)) { showToast('В файле нет списков KeepShop'); return; }
  const undo = makeStateUndo(RESTORE_KEYS, 'Восстановление отменено, прежние данные возвращены');
  RESTORE_KEYS.forEach(k => { if (data[k] !== undefined) state[k] = structuredClone(data[k]); });
  state.lists.forEach(normalizeCollaborators);
  ensureMainList();
  saveState();
  const items = state.lists.reduce((n, l) => n + l.items.length, 0);
  showToast(`Восстановлено из ${label}: ${state.lists.length} списк., ${items} товаров`, undo);
}

function recordProductPrice(productName, price, store = 'Вручную', dateStr = null) {
  const cleanName = (productName || '').trim();
  const numPrice = Number(price) || 0;
  if (!cleanName || numPrice <= 0) return;
  const date = dateStr || new Date().toISOString().split('T')[0];
  const exists = state.priceHistory.some(p =>
    p.productName.toLowerCase() === cleanName.toLowerCase() &&
    p.date === date &&
    (p.store || '').toLowerCase() === (store || '').toLowerCase() &&
    Math.abs(Number(p.price) - numPrice) < 0.001
  );
  if (!exists) {
    state.priceHistory.unshift({
      id: 'ph-' + uniqueSuffix() + '-' + Math.random().toString(36).slice(2, 6),
      productName: cleanName,
      price: Math.round(numPrice * 100) / 100,
      store: store || 'Магазин',
      date
    });
  }
}

function formatMoney(value) {
  const num = Number(value) || 0;
  const cur = CURRENCIES[state.currency] || CURRENCIES.PLN;
  const decimals = num % 1 !== 0 ? 2 : 0;
  const str = num.toLocaleString('ru-RU', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return cur.before ? `${cur.symbol}${str}` : `${str} ${cur.symbol}`;
}

function escapeHTML(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let toastTimer = null;
let toastUndoHandler = null;
function showToast(message, onUndo = null) {
  const box = document.getElementById('toastBox');
  const txt = document.getElementById('toastText');
  const undoBtn = document.getElementById('toastUndoBtn');
  if (!box || !txt) return;
  txt.textContent = message;
  toastUndoHandler = typeof onUndo === 'function' ? onUndo : null;
  if (undoBtn) undoBtn.classList.toggle('hidden', !toastUndoHandler);
  box.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.classList.add('hidden');
    if (undoBtn) undoBtn.classList.add('hidden');
    toastUndoHandler = null;
  }, toastUndoHandler ? 5000 : 2800);
}

document.getElementById('toastUndoBtn')?.addEventListener('click', () => {
  const fn = toastUndoHandler;
  toastUndoHandler = null;
  clearTimeout(toastTimer);
  document.getElementById('toastBox')?.classList.add('hidden');
  document.getElementById('toastUndoBtn')?.classList.add('hidden');
  if (fn) fn();
});

// Снимок частей состояния для отмены массовых действий (импорт, чек, Keep).
// Возвращает функцию отката для showToast(message, onUndo).
function makeStateUndo(keys, doneMessage = 'Действие отменено') {
  const snap = {};
  keys.forEach(k => { snap[k] = structuredClone(state[k]); });
  return () => {
    keys.forEach(k => { state[k] = snap[k]; });
    if (keys.includes('lists')) state.lists.forEach(normalizeCollaborators);
    saveState();
    showToast(doneMessage);
  };
}

// Ctrl+Z / Cmd+Z — то же, что кнопка «Отменить» (пока уведомление на экране)
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== 'z' || !toastUndoHandler) return;
  if (e.target.closest?.('input, textarea, [contenteditable="true"]')) return; // в полях ввода — обычная отмена текста
  e.preventDefault();
  document.getElementById('toastUndoBtn')?.click();
});

function openModal(id) {
  document.getElementById('moreMenuDropdown')?.classList.add('hidden');
  if (id === 'privacyModal') {
    document.getElementById('privacyRequireAuthToggle').checked = Boolean(state.privacy.requireAuth);
    document.getElementById('privacyOwnerEmailInput').value = state.privacy.ownerEmail || '';
    document.getElementById('privacyMasterTokenLabel').textContent = state.privacy.masterToken || 'SHOP-VIP';
  }
  document.getElementById(id)?.classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id)?.classList.add('hidden');
}

// ==================== CATALOG & FREQUENT ====================
function getUnifiedCatalog() {
  const map = new Map();
  const addEntry = (item, badge) => {
    if (!item || !item.name) return;
    const key = item.name.trim().toLowerCase();
    if (!map.has(key)) {
      map.set(key, {
        name: item.name.trim(),
        qty: Number(item.qty) || 1,
        unit: item.unit || 'шт',
        price: Number(item.price) || 0,
        storeName: item.storeName || '',
        productUrl: item.productUrl || '',
        desc: item.desc || '',
        priceEstimated: !!item.priceEstimated,
        badge
      });
    }
  };
  state.lists.forEach(l => l.items.forEach(i => addEntry(i, 'В списке')));
  state.favorite.forEach(i => addEntry(i, 'Favorite'));
  state.recent.forEach(i => addEntry(i, 'Recent'));
  state.backlog.forEach(i => addEntry(i, 'Backlog'));
  (state.products || []).forEach(p => addEntry({ ...p, qty: 1 }, 'База'));
  return Array.from(map.values());
}

// Цена для нового товара: своя история цен → похожий товар из списков → справочник.
// estimated=true — ориентир «≈», а не цена конкретного магазина.
function estimateItemPrice(name, unit = '') {
  const key = normName(name);
  if (!key) return null;
  const hist = state.priceHistory
    .filter(p => normName(p.productName) === key && Number(p.price) > 0)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0];
  if (hist) return { price: Number(hist.price), unit: '', estimated: false };
  const prod = Array.isArray(state.products) ? findProduct(state.products, name) : null;
  if (prod && prod.price > 0) {
    const p = !unit || unit === prod.unit ? prod.price : convertUnitPrice(prod.price, prod.unit, unit);
    if (p) return { price: Math.round(p * 100) / 100 || p, unit: unit || prod.unit, estimated: !!prod.priceEstimated };
  }
  const catalog = getUnifiedCatalog().filter(c => c.price > 0 && !c.priceEstimated && (!unit || c.unit === unit));
  const same = catalog.find(c => normName(c.name) === key);
  if (same) return { price: same.price, unit: same.unit, estimated: false };
  // Справочник раньше «похожих»: «Сыр» не должен получить цену пармезана
  const h = hintPrice(name, unit || undefined);
  if (h) return { price: h.price, unit: h.unit, estimated: true };
  const similar = catalog.find(c => normName(c.name).startsWith(key + ' '));
  return similar ? { price: similar.price, unit: similar.unit, estimated: true } : null;
}

// Разово заполняет пустые цены (товары, добавленные до появления оценок)
function fillMissingPrices() {
  let changed = false;
  state.lists.forEach(l => l.items.forEach(it => {
    if (Number(it.price) > 0) return;          // при каждом запуске пробуем заполнить пустые цены
    const est = estimateItemPrice(it.name, it.unit);
    if (est) { it.price = est.price; it.priceEstimated = est.estimated; changed = true; }
  }));
  return changed;
}

// Товары без цены → один запрос к Gemini (src/ai-prices.ts). onlyListId — только этот список.
let aiPricesRunning = false;
async function aiEstimateMissingPrices(onlyListId = '') {
  if (aiPricesRunning) return;
  fillMissingPrices(); // сначала всё, что знает справочник
  const lists = onlyListId ? state.lists.filter(l => l.id === onlyListId) : state.lists;
  const groups = new Map();
  lists.forEach(l => l.items.forEach(it => {
    if (Number(it.price) > 0) return;
    const key = normName(it.name) + '|' + (it.unit || 'шт');
    if (!groups.has(key)) groups.set(key, { name: it.name, unit: it.unit || 'шт', items: [] });
    groups.get(key).items.push(it);
  }));
  if (!groups.size) { saveState(); showToast('У всех товаров уже есть цена'); return; }
  aiPricesRunning = true;
  showToast(`✨ ИИ оценивает цены: ${groups.size} товар(ов)…`);
  const undo = makeStateUndo(['lists'], 'Оценка цен отменена');
  try {
    const queries = [...groups.values()];
    const prices = await estimatePricesWithAI(queries.map(q => ({ name: q.name, unit: q.unit })), askGeminiWithBackoff);
    let filled = 0;
    queries.forEach((q, i) => {
      const p = prices[i];
      if (!p) return;
      q.items.forEach(it => { it.price = p; it.priceEstimated = true; it.basePrice = p; });
      filled++;
    });
    saveState();
    showToast(`Цены оценены: ${filled} из ${queries.length} (≈ ориентир)`, filled ? undo : null);
  } catch (e) {
    showToast('Не удалось оценить цены: нет ключа Gemini, интернета или исчерпан лимит');
  } finally {
    aiPricesRunning = false;
  }
}

// ==================== АССОЦИАЦИИ «С ЭТИМ ЧАСТО БЕРУТ» (src/associations.ts) ====================
let assocIndex = null;
function getAssoc() {
  if (assocIndex) return assocIndex;
  const products = state.products || [];
  const byId = new Map(products.map(p => [p.id, p]));
  const manual = [];
  products.forEach(p => (p.links || []).forEach(id => { const o = byId.get(id); if (o && p.id < o.id) manual.push([p.name, o.name]); }));
  assocIndex = new AssociationIndex({
    history: state.recent.map(r => ({ name: r.name, date: r.date })),
    lists: state.lists.map(l => l.items.map(i => i.name)),
    recipes: PICKER_RECIPES.map(r => r.items.map(i => i[0])),
    manual,
  });
  return assocIndex;
}

// Последний добавленный товар — под полем ввода показываем, что с ним обычно берут
let lastAdded = null; // { listId, name, at }
function rememberAdded(listId, name) { lastAdded = { listId, name, at: Date.now() }; }

function suggestionsHTML(list) {
  if (!lastAdded || lastAdded.listId !== list.id || Date.now() - lastAdded.at > 15 * 60 * 1000) return '';
  const inList = new Set(list.items.filter(i => !i.checked).map(i => normName(i.name)));
  const sugg = getAssoc().suggest(lastAdded.name, inList, 6);
  if (!sugg.length) return '';
  return `
    <div class="mb-3 -mt-1 flex items-center gap-1.5 overflow-x-auto no-scrollbar" data-no-swipe>
      <span class="text-[11px] text-slate-500 dark:text-zinc-400 shrink-0">🔗 К «${escapeHTML(lastAdded.name)}» берут:</span>
      ${sugg.map(s => `<button type="button" data-action="add-suggest" data-list-id="${list.id}" data-name="${escapeHTML(s.name)}" title="${REASON_LABEL[s.reason]}" class="shrink-0 px-2.5 py-1 rounded-full bg-amber-100 dark:bg-amber-500/20 hover:bg-amber-200 text-amber-900 dark:text-amber-300 text-[11px] font-bold whitespace-nowrap">+ ${escapeHTML(s.name)}</button>`).join('')}
      <button type="button" data-action="dismiss-suggest" class="shrink-0 w-6 h-6 rounded-full text-slate-400 hover:bg-black/5 text-xs" title="Скрыть">✕</button>
    </div>`;
}

function findCatalogSuggestions(query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return [];
  return getUnifiedCatalog().filter(item => item.name.toLowerCase().includes(q)).slice(0, 6);
}

function computeFrequentStats(sourceItems = null) {
  const map = new Map();
  const register = (item, weight, isPurchased, dateVal = '') => {
    if (!item || !item.name) return;
    const key = item.name.trim().toLowerCase();
    const qty = Number(item.qty) || 1;
    const price = Number(item.price) || 0;
    const spend = isPurchased ? qty * price : 0;
    if (map.has(key)) {
      const cur = map.get(key);
      cur.count += weight;
      cur.totalSpend += spend;
      if (price > 0) cur.prices.push(price);
      if (dateVal && (!cur.lastDate || dateVal > cur.lastDate)) cur.lastDate = dateVal;
    } else {
      map.set(key, {
        name: item.name.trim(),
        unit: item.unit || 'шт',
        defaultQty: qty,
        count: weight,
        totalSpend: spend,
        lastDate: dateVal || '',
        prices: price > 0 ? [price] : []
      });
    }
  };
  if (sourceItems) {
    sourceItems.forEach(i => register(i, 1, true, i.date || ''));
  } else {
    state.recent.forEach(i => register(i, 1, true, i.date || ''));
    state.lists.forEach(l => l.items.forEach(i => register(i, i.checked ? 1 : 0.5, i.checked)));
    state.favorite.forEach(i => register(i, 1, false));
  }
  return Array.from(map.values())
    .map(entry => ({
      ...entry,
      times: Math.max(1, Math.round(entry.count)),
      avgPrice: entry.prices.length ? entry.prices.reduce((a, b) => a + b, 0) / entry.prices.length : 0
    }))
    .sort((a, b) => b.times - a.times || b.totalSpend - a.totalSpend);
}

// ==================== RENDERING ====================
function renderApp() {
  const lockScreen = document.getElementById('privateLockScreen');
  if (state.privacy.requireAuth && !state.session.unlocked) {
    lockScreen?.classList.remove('hidden');
    return;
  } else {
    lockScreen?.classList.add('hidden');
  }

  document.getElementById('currentRoleBadge').textContent = `${state.session.userName} (${state.session.role})`;
  updateCurrencyUI();
  updateHeaderTotals();
  renderListsView();
  renderFrequentView();
  renderMainListView();
  renderCollectionView('recent', 'recentGrid');
  renderCollectionView('favorite', 'favoriteGrid');
  renderCollectionView('backlog', 'backlogGrid');
  renderStatisticsView();
}

function updateCurrencyUI() {
  const sel = document.getElementById('currencySelect');
  if (sel) sel.value = state.currency;
  const cur = CURRENCIES[state.currency] || CURRENCIES.PLN;
  const lbl = document.getElementById('modalPriceLabel');
  if (lbl) lbl.textContent = `Цена (${cur.symbol})`;
  const tag = document.getElementById('chartCurrencyTag');
  if (tag) tag.textContent = cur.code;
}

function updateHeaderTotals() {
  let planSum = 0;
  let checkedSum = 0;
  state.lists.forEach(l => l.items.forEach(i => {
    const s = (Number(i.qty) || 1) * (Number(i.price) || 0);
    planSum += s;
    if (i.checked) checkedSum += s;
  }));
  const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setTxt('count-lists', visibleLists().length);
  setTxt('count-frequent', computeFrequentStats().length);
  const mainL = state.lists.find(l => l.isMain);
  setTxt('count-recent', mainL ? mainL.items.filter(i => !i.checked).length : 0);
  setTxt('recentHistoryCount', state.recent.length ? '(' + state.recent.length + ')' : '');
  setTxt('count-favorite', state.favorite.length);
  setTxt('count-backlog', state.backlog.length);
  setTxt('headerBasketTotal', formatMoney(planSum));
  setTxt('headerCheckedTotal', formatMoney(checkedSum));
}

function getSortedItems(list) {
  const items = [...list.items];
  const mode = list.sortMode || 'manual';
  if (mode === 'alpha') return items.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  if (mode === 'price') return items.sort((a, b) => (b.qty * b.price) - (a.qty * a.price));
  if (mode === 'unchecked') return items.sort((a, b) => Number(a.checked) - Number(b.checked) || (a.order ?? 0) - (b.order ?? 0));
  return items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

// ==================== ЕДИНЫЙ ВИД ТОВАРА: КАРТОЧКА И СТРОКА ====================
// Один и тот же каркас во всех разделах: «Недавние», «Списки», «Частые», «Избранное», «Отложено», история.
const UI = {
  card: 'bg-white dark:bg-zinc-900 p-3.5 rounded-2xl border border-slate-200 dark:border-zinc-800 flex flex-col justify-between gap-2.5',
  chip: 'px-2.5 py-1.5 rounded-xl bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-xs font-bold',
  chipAdd: 'px-2.5 py-1.5 rounded-xl bg-amber-100 dark:bg-amber-500/20 hover:bg-amber-200 dark:hover:bg-amber-500/30 text-amber-900 dark:text-amber-300 text-xs font-bold',
  linkBtn: 'text-xs text-slate-400 hover:text-rose-500 px-1',
  iconBtn: 'w-7 h-7 rounded-lg hover:bg-slate-100 dark:hover:bg-zinc-800 text-xs text-slate-500 dark:text-zinc-400 disabled:opacity-25',
  qtyChip: 'shrink-0 min-w-[2.75rem] text-center px-1 py-0.5 rounded-md bg-black/5 dark:bg-white/10 text-[10px] font-semibold tabular-nums',
  rowAdd: 'w-[22px] h-[22px] shrink-0 rounded-md bg-amber-100 dark:bg-amber-500/20 hover:bg-amber-200 text-amber-800 dark:text-amber-300 font-extrabold text-sm leading-none flex items-center justify-center',
};
const priceText = (sum, estimated) => sum > 0 ? (estimated ? '≈' : '') + formatMoney(sum) : '—';

/** Каркас карточки товара. */
function itemCardShell({ attrs = '', cls = '', lead = '', title, total, meta, body = '', actions, trailing = '', done = false }) {
  return `
    <div ${attrs} class="${UI.card} ${cls} ${done ? 'opacity-70' : ''}">
      <div>
        <div class="flex items-start gap-2">
          ${lead}
          <div class="flex-1 min-w-0">
            <div class="flex items-start justify-between gap-2">
              <h4 class="font-bold text-sm leading-snug break-words line-clamp-2 ${done ? 'line-through text-slate-400' : ''}">${title}</h4>
              <span class="text-xs font-extrabold text-amber-600 dark:text-amber-400 shrink-0">${total}</span>
            </div>
            <div class="text-[11px] text-slate-400 dark:text-zinc-500 mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">${meta}</div>
          </div>
        </div>
        ${body}
      </div>
      <div class="flex items-center justify-between gap-1.5 pt-2 border-t border-slate-100 dark:border-zinc-800">
        <div class="flex flex-wrap items-center gap-1.5">${actions}</div>
        <div class="flex items-center gap-0.5 shrink-0">${trailing}</div>
      </div>
    </div>`;
}

/** Каркас строки товара (компактный вид). lead — чекбокс или «+». */
function itemRowShell({ attrs = '', lead, title, titleAttr = '', note = '', price, priceCls = '', qty, done = false }) {
  return `
    <div ${attrs} class="ks-row flex items-center gap-2 pl-2 pr-1.5 h-9 cursor-pointer ${done ? 'opacity-55' : ''}">
      ${lead}
      <span class="flex-1 min-w-0 truncate text-[13px] font-medium ${done ? 'line-through text-slate-400' : ''}" ${titleAttr}>${title}</span>
      ${note ? `<span class="shrink-0 text-[10px] text-slate-400 dark:text-zinc-500">${note}</span>` : ''}
      <span class="shrink-0 text-[11px] font-bold tabular-nums ${priceCls}">${price}</span>
      ${qty}
    </div>`;
}

function renderItemCardHTML(list, item, itemIdx, totalCount, isReadOnly) {
  const isFav = state.favorite.some(f => f.name.toLowerCase() === item.name.toLowerCase());
  const alt = item.cheaperAlt;
  const savingsPerUnit = alt && Number(item.price) > Number(alt.price) ? (Number(item.price) - Number(alt.price)) : 0;
  const storeHref = buildProductStoreUrl(item.name, item.storeName, item.productUrl);
  const ids = `data-list-id="${list.id}" data-item-id="${item.id}"`;
  const est = item.priceEstimated ? '≈' : '';
  return itemCardShell({
    attrs: `${ids} ${!isReadOnly ? 'data-lp-edit="lists"' : ''} draggable="${!isReadOnly}"`,
    cls: 'list-item-card',
    done: item.checked,
    lead: `
      ${!isReadOnly ? `<span data-touch-item-handle="${item.id}" data-list-id="${list.id}" class="mt-0.5 text-slate-300 dark:text-zinc-600 cursor-grab select-none text-xs shrink-0 touch-none" title="Перетащить">⋮⋮</span>` : ''}
      <button type="button" data-action="toggle-check" ${ids} class="mt-0.5 w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 text-xs ${item.checked ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-slate-300 dark:border-zinc-600'}">${item.checked ? '✓' : ''}</button>`,
    title: escapeHTML(item.name),
    total: est + formatMoney(item.qty * item.price),
    meta: `<span>${item.qty} ${escapeHTML(item.unit)} × ${est}${formatMoney(item.price)}</span>
      <a href="${escapeHTML(storeHref)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center px-1.5 py-px rounded-md bg-blue-50 dark:bg-blue-950/60 hover:bg-blue-100 text-blue-700 dark:text-blue-300 text-[10px] font-bold max-w-full truncate">🔗 ${escapeHTML(item.storeName || 'В магазин')} ↗</a>`,
    body: `
      ${item.desc ? `<div class="text-[11px] text-slate-500 dark:text-zinc-400 mt-1.5 break-words">${escapeHTML(item.desc)}</div>` : ''}
      ${savingsPerUnit > 0.01 ? `
        <div class="mt-2 flex flex-wrap items-center justify-between gap-1.5 px-2.5 py-1.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800/80 text-[11px]">
          <div class="text-emerald-900 dark:text-emerald-300 break-words">
            <span class="font-bold">Дешевле в ${escapeHTML(alt.chain || alt.storeName)} (${alt.distanceKm} км):</span>
            <span class="font-extrabold">${formatMoney(alt.price)}</span>
            <span class="text-emerald-600 font-bold">(−${formatMoney(savingsPerUnit * item.qty)})</span>
          </div>
          <button type="button" data-action="apply-cheaper-alt" ${ids} class="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold shrink-0">Применить</button>
        </div>` : ''}`,
    actions: `
      <div class="inline-flex items-center rounded-xl bg-slate-100 dark:bg-zinc-800 p-0.5">
        <button type="button" data-action="qty-dec" ${ids} class="w-7 h-7 rounded-lg hover:bg-white dark:hover:bg-zinc-700 font-bold text-xs">−</button>
        <span class="px-1.5 text-xs font-bold tabular-nums">${item.qty} ${escapeHTML(item.unit)}</span>
        <button type="button" data-action="qty-inc" ${ids} class="w-7 h-7 rounded-lg hover:bg-white dark:hover:bg-zinc-700 font-bold text-xs">+</button>
      </div>
      <button type="button" data-action="open-price-history" data-product-name="${escapeHTML(item.name)}" class="${UI.chip}" title="История цен">📈</button>
      ${!isReadOnly ? `<button type="button" data-action="edit-item" ${ids} class="${UI.chip}" title="Изменить (или долгий тап по товару)">✏️</button>` : ''}
      <button type="button" data-action="toggle-fav" ${ids} class="${UI.chip} ${isFav ? 'text-amber-500' : 'text-slate-400'}" title="${isFav ? 'Убрать из избранного' : 'В избранное'}">★</button>`,
    trailing: !isReadOnly ? `
      <button type="button" data-action="move-item-up" ${ids} ${itemIdx === 0 ? 'disabled' : ''} class="${UI.iconBtn} hidden sm:inline-block" title="Выше">↑</button>
      <button type="button" data-action="move-item-down" ${ids} ${itemIdx === totalCount - 1 ? 'disabled' : ''} class="${UI.iconBtn} hidden sm:inline-block" title="Ниже">↓</button>
      <button type="button" data-action="delete-item" ${ids} class="${UI.linkBtn}">Удалить</button>` : '',
  });
}

/** Карточка и строка товара разделов-коллекций (Избранное, Отложено, История). */
function collectionCardHTML(section, item) {
  const qty = Number(item.qty) || 1, price = Number(item.price) || 0;
  const ids = `data-section="${section}" data-item-id="${item.id}"`;
  return itemCardShell({
    attrs: `data-lp-edit="${section}" data-item-id="${item.id}"`,
    cls: 'lp-card',
    title: escapeHTML(item.name),
    total: formatMoney(qty * price),
    meta: `<span>${qty} ${escapeHTML(item.unit || 'шт')} × ${formatMoney(price)}</span>${item.date ? `<span>• ${item.date}</span>` : ''}`,
    body: item.desc ? `<div class="text-[11px] text-slate-500 dark:text-zinc-400 mt-1.5 break-words line-clamp-2">${escapeHTML(item.desc)}</div>` : '',
    actions: `
      <button type="button" data-action="push-collection" ${ids} class="${UI.chipAdd}">+ В список</button>
      <button type="button" data-action="open-price-history" data-product-name="${escapeHTML(item.name)}" class="${UI.chip}" title="История цен">📈</button>
      <button type="button" data-action="edit-collection" ${ids} class="${UI.chip}" title="Изменить">✏️</button>`,
    trailing: `<button type="button" data-action="delete-collection" ${ids} class="${UI.linkBtn}">Удалить</button>`,
  });
}

function collectionRowHTML(section, item) {
  const qty = Number(item.qty) || 1, price = Number(item.price) || 0;
  const ids = `data-section="${section}" data-item-id="${item.id}"`;
  const shortDate = item.date ? String(item.date).slice(5).split('-').reverse().join('.') : '';
  return itemRowShell({
    attrs: `data-lp-edit="${section}" data-item-id="${item.id}"`,
    lead: `<button type="button" data-action="push-collection" ${ids} class="${UI.rowAdd}" title="Добавить в «Недавние»">+</button>`,
    title: escapeHTML(item.name),
    titleAttr: `title="${escapeHTML(item.desc || item.name)}"`,
    note: shortDate,
    price: priceText(qty * price),
    priceCls: qty * price > 0 ? '' : 'text-slate-300 dark:text-zinc-600',
    qty: `<button type="button" data-action="edit-collection" ${ids} class="${UI.qtyChip} hover:bg-black/10" title="Изменить">${qty} ${escapeHTML(item.unit || 'шт')}</button>`,
  });
}

/** Карточка и строка «Частых» — тот же вид, что в «Избранном». */
function frequentCardHTML(item) {
  const push = `data-action="push-frequent" data-name="${escapeHTML(item.name)}" data-qty="${item.defaultQty}" data-unit="${escapeHTML(item.unit)}" data-price="${item.avgPrice}"`;
  return itemCardShell({
    title: escapeHTML(item.name),
    total: formatMoney(item.defaultQty * item.avgPrice),
    meta: `<span>${item.defaultQty} ${escapeHTML(item.unit)} × ${formatMoney(item.avgPrice)} (ср.)</span>${item.lastDate ? `<span>• ${item.lastDate}</span>` : ''}`,
    actions: `
      <button type="button" ${push} class="${UI.chipAdd}">+ В список</button>
      <button type="button" data-action="open-price-history" data-product-name="${escapeHTML(item.name)}" class="${UI.chip}" title="История цен">📈</button>`,
    trailing: `<span class="px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-300 text-[11px] font-extrabold" title="Сколько раз куплено · всего ${formatMoney(item.totalSpend)}">×${item.times}</span>`,
  });
}

function frequentRowHTML(item) {
  const push = `data-action="push-frequent" data-name="${escapeHTML(item.name)}" data-qty="${item.defaultQty}" data-unit="${escapeHTML(item.unit)}" data-price="${item.avgPrice}"`;
  const sum = item.defaultQty * item.avgPrice;
  return itemRowShell({
    lead: `<button type="button" ${push} class="${UI.rowAdd}" title="Добавить в «Недавние»">+</button>`,
    title: escapeHTML(item.name),
    note: '×' + item.times,
    price: priceText(sum),
    priceCls: sum > 0 ? '' : 'text-slate-300 dark:text-zinc-600',
    qty: `<span class="${UI.qtyChip}">${item.defaultQty} ${escapeHTML(item.unit)}</span>`,
  });
}

// Вид разделов-коллекций: строки (по умолчанию) или карточки, отдельно для каждого раздела
const CARDS_GRID = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3';
const sectionCompact = (section) => (state.viewModes?.[section] || 'compact') !== 'cards';
function fillViewToggleSlot(section) {
  const slot = document.querySelector(`[data-view-toggle-slot="${section}"]`);
  if (slot) slot.innerHTML = viewToggleHTML(`data-view-section="${section}"`, sectionCompact(section));
}

// Переключатель вида списка — одинаковый в «Недавних» и «Списках»
function viewToggleHTML(target, compact, extraClass = '') {
  // target — список (переключает list.viewMode) или строка атрибутов раздела (data-view-section="…")
  const targetAttr = typeof target === 'string' ? target : `data-list-id="${target.id}"`;
  const next = compact ? 'cards' : 'compact';
  return `<button type="button" data-action="set-list-view" data-view="${next}" ${targetAttr} title="${compact ? 'Показать карточками' : 'Показать строками'}" class="px-2.5 py-1 rounded-xl bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15 text-[11px] font-bold whitespace-nowrap ${extraClass}">${compact ? '▦ Карточки' : '☰ Строки'}</button>`;
}

function renderItemRowHTML(list, item, isReadOnly) {
  const sum = (Number(item.qty) || 1) * (Number(item.price) || 0);
  const ids = `data-list-id="${list.id}" data-item-id="${item.id}"`;
  return itemRowShell({
    attrs: `data-row-item="${item.id}" ${ids} data-action="toggle-check" ${isReadOnly ? '' : 'data-row-drag="1"'}`,
    done: item.checked,
    lead: `<span class="w-[18px] h-[18px] rounded-[5px] border-2 flex items-center justify-center shrink-0 text-[11px] leading-none font-bold ${item.checked ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-slate-300 dark:border-zinc-600'}">${item.checked ? '✓' : ''}</span>`,
    title: escapeHTML(item.name),
    titleAttr: `title="${escapeHTML(item.desc || item.name)}"`,
    price: priceText(sum, item.priceEstimated),
    priceCls: sum > 0 ? (item.priceEstimated ? 'text-slate-500 dark:text-zinc-400' : '') : 'text-slate-300 dark:text-zinc-600',
    qty: isReadOnly
      ? `<span class="${UI.qtyChip}">${item.qty} ${escapeHTML(item.unit)}</span>`
      : `<button type="button" data-action="edit-item" ${ids} title="Изменить товар" class="${UI.qtyChip} hover:bg-black/10">${item.qty} ${escapeHTML(item.unit)}</button>`,
  });
}

function renderMainListView() {
  const box = document.getElementById('mainListView');
  if (!box) return;
  const list = ensureMainList();
  const isReadOnly = state.session.role === 'Только просмотр';
  const items = getSortedItems(list);
  const taken = items.filter(i => i.checked);
  const sum = (arr) => arr.reduce((s, i) => s + (Number(i.qty) || 1) * (Number(i.price) || 0), 0);
  const pct = items.length ? Math.round(taken.length / items.length * 100) : 0;
  const compact = list.viewMode !== 'cards';
  box.innerHTML = `
    <div class="bg-white dark:bg-zinc-900 rounded-3xl border border-slate-200 dark:border-zinc-800 p-3 sm:p-5 shadow-xs">
      <div class="flex items-center justify-between gap-2 mb-2">
        <h2 class="text-lg sm:text-xl font-extrabold whitespace-nowrap">🕘 Недавние</h2>
        <div class="flex items-center gap-2 shrink-0">
          ${viewToggleHTML(list, compact)}
        </div>
      </div>
      <div class="flex items-center gap-2 mb-3">
        <div class="flex-1 h-1.5 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
          <div class="h-full bg-emerald-500 rounded-full transition-all" style="width: ${pct}%"></div>
        </div>
        <span class="text-[11px] font-bold text-slate-500 dark:text-zinc-400 shrink-0">взято ${taken.length} из ${items.length}</span>
      </div>
      ${!isReadOnly ? `
        <div class="relative mb-3">
          <div class="flex items-center gap-1.5 bg-slate-50 dark:bg-zinc-950/80 border border-black/10 dark:border-white/10 rounded-xl px-2.5 h-11">
            <span class="text-amber-500 font-bold shrink-0">+</span>
            <input type="text" data-quick-input="${list.id}" autocomplete="off" placeholder="Добавить товар…" class="w-full bg-transparent text-sm outline-none" />
            <button type="button" data-action="quick-add-submit" data-list-id="${list.id}" class="px-3 py-1.5 rounded-lg bg-amber-500 text-white text-xs font-bold shrink-0">ОК</button>
          </div>
          <div id="quick-ac-${list.id}" class="hidden absolute left-0 right-0 top-full mt-1 z-30 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 rounded-xl shadow-xl max-h-48 overflow-y-auto divide-y divide-slate-100 dark:divide-zinc-800"></div>
        </div>` : ''}
      ${!isReadOnly ? suggestionsHTML(list) : ''}
      ${items.length && !compact ? `
        <div class="space-y-2.5">
          ${items.map((item, i) => renderItemCardHTML(list, item, i, items.length, isReadOnly)).join('')}
        </div>
      ` : items.length ? `
        <div class="ks-rows" data-row-group>
          ${items.map(item => renderItemRowHTML(list, item, isReadOnly)).join('')}
        </div>
        ${!isReadOnly ? '<div class="mt-2 text-[10px] text-slate-400 dark:text-zinc-500 text-center">Тап — взял · держите и тяните — порядок · кол-во — изменить</div>' : ''}
      ` : `
        <div class="text-center py-8 text-sm text-slate-500 dark:text-zinc-400">Список пуст.<br>Впишите товар выше или подберите из каталога 👇</div>
      `}
      <div class="mt-3 pt-3 border-t border-black/5 dark:border-white/5 flex flex-wrap items-center justify-between gap-2">
        ${!isReadOnly ? `
          <div class="flex flex-wrap items-center gap-1.5">
            <button type="button" data-action="open-picker" data-list-id="${list.id}" class="px-3 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold">🧺 Подобрать</button>
            ${items.length ? `<button type="button" data-action="load-store-prices-list" data-list-id="${list.id}" class="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold" title="Ориентировочные цены по сетям рядом">📍 Цены</button>` : ''}
            <button type="button" data-action="open-picker" data-pk-tab="recipe" data-list-id="${list.id}" class="px-3 py-1.5 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 text-amber-800 dark:text-amber-300 text-xs font-bold">🍲 Из блюда</button>
            ${items.some(i => !(Number(i.price) > 0)) ? `<button type="button" data-action="ai-prices" data-list-id="${list.id}" class="px-3 py-1.5 rounded-xl bg-violet-600 hover:bg-violet-700 text-white text-xs font-bold" title="Оценить цены товаров без цены через Gemini">✨ Оценить цены (${items.filter(i => !(Number(i.price) > 0)).length})</button>` : ''}
        ${taken.length ? `<button type="button" data-action="clear-checked" data-list-id="${list.id}" class="px-3 py-1.5 rounded-xl bg-black/5 dark:bg-white/10 hover:bg-black/10 text-xs font-bold">🧹 Убрать взятые (${taken.length})</button>` : ''}
          </div>` : ''}
        <div class="text-right ml-auto">
          <div class="text-[10px] text-slate-500 dark:text-zinc-400">Взято: ${formatMoney(sum(taken))}</div>
          <div class="text-sm font-extrabold">Итого: ${items.some(i => i.priceEstimated) ? '≈' : ''}${formatMoney(sum(items))}</div>
        </div>
      </div>
    </div>`;
}

function renderListsView() {
  const grid = document.getElementById('listsGrid');
  if (!grid) return;
  const q = state.searchQuery.trim().toLowerCase();
  const isReadOnly = state.session.role === 'Только просмотр';

  const sortedLists = visibleLists()
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || (a.order ?? 0) - (b.order ?? 0))
    .filter(list => !q || list.title.toLowerCase().includes(q) || list.items.some(i => i.name.toLowerCase().includes(q) || (i.desc && i.desc.toLowerCase().includes(q)) || (i.storeName && i.storeName.toLowerCase().includes(q))));

  if (!sortedLists.length) {
    grid.innerHTML = `<div class="col-span-full text-center py-10 bg-white dark:bg-zinc-900 rounded-3xl border border-dashed border-slate-300 dark:border-zinc-800 text-xs sm:text-sm text-slate-500">Списки покупок не найдены</div>`;
    return;
  }

  const cardColors = ['#ffffff', '#fef3c7', '#dcfce7', '#dbeafe', '#f3e8ff', '#ffe4e6'];

  grid.innerHTML = sortedLists.map((list, idx) => {
    normalizeCollaborators(list);
    const isDark = document.documentElement.classList.contains('dark');
    const bgStyle = !isDark && list.color && list.color !== '#ffffff' ? `style="background-color: ${list.color}"` : '';
    const listSum = list.items.reduce((s, i) => s + (Number(i.qty) || 1) * (Number(i.price) || 0), 0);
    const checkedSum = list.items.filter(i => i.checked).reduce((s, i) => s + (Number(i.qty) || 1) * (Number(i.price) || 0), 0);
    const allItems = getSortedItems(list);
    const activeItems = allItems.filter(i => !i.checked);
    const purchasedItems = allItems.filter(i => i.checked);
    const progressPct = list.items.length ? Math.round((purchasedItems.length / list.items.length) * 100) : 0;
    const compact = list.viewMode !== 'cards';

    return `
      <article ${bgStyle} data-list-id="${list.id}" draggable="${!isReadOnly}" class="list-card bg-white dark:bg-zinc-900 rounded-3xl border ${list.pinned ? 'border-amber-400 dark:border-amber-500/70' : 'border-slate-200 dark:border-zinc-800'} p-3.5 sm:p-5 shadow-xs w-full">
        <!-- Header: Drag Handle + Editable Title + Controls -->
        <div class="flex items-center justify-between gap-2 mb-2">
          <div class="flex items-center gap-1.5 min-w-0 flex-1">
            <span data-touch-list-handle="${list.id}" class="cursor-grab text-slate-400 select-none shrink-0 touch-none" title="Перетащить список">⋮⋮</span>
            <input type="text" data-edit-list-title="${list.id}" value="${escapeHTML(list.title)}" ${isReadOnly ? 'readonly' : ''} class="font-extrabold text-base sm:text-lg bg-transparent outline-none focus:bg-black/5 dark:focus:bg-white/5 rounded-lg px-1 -mx-1 w-full truncate" />
          </div>
          <div class="flex items-center gap-0.5 shrink-0">
            <button type="button" data-action="pin-list" data-list-id="${list.id}" class="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 text-xs ${list.pinned ? 'text-amber-600' : 'text-slate-400'}" title="Закрепить">📌</button>
            <button type="button" data-action="move-list-up" data-list-id="${list.id}" ${idx === 0 ? 'disabled' : ''} class="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 text-xs disabled:opacity-30" title="Выше">↑</button>
            <button type="button" data-action="move-list-down" data-list-id="${list.id}" ${idx === sortedLists.length - 1 ? 'disabled' : ''} class="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 text-xs disabled:opacity-30" title="Ниже">↓</button>
            ${!isReadOnly ? `<button type="button" data-action="delete-list" data-list-id="${list.id}" class="p-1.5 rounded-lg hover:bg-rose-500/15 text-xs text-slate-400 hover:text-rose-500" title="Удалить">🗑</button>` : ''}
          </div>
        </div>

        <!-- Progress Bar & Card Color Dots -->
        <div class="flex items-center justify-between gap-2 mb-2.5">
          <div class="flex-1 flex items-center gap-2">
            <div class="flex-1 h-1.5 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
              <div class="h-full bg-emerald-500 rounded-full transition-all" style="width: ${progressPct}%"></div>
            </div>
            <span class="text-[10px] font-bold text-slate-500 dark:text-zinc-400 shrink-0">${purchasedItems.length}/${list.items.length}</span>
          </div>
          ${!isReadOnly ? `
            <div class="flex items-center gap-1 shrink-0">
              ${cardColors.map(c => `<button type="button" data-action="set-list-color" data-list-id="${list.id}" data-color="${c}" class="w-3.5 h-3.5 rounded-full border ${list.color === c ? 'border-zinc-900 scale-110' : 'border-black/20'}" style="background-color: ${c}"></button>`).join('')}
            </div>
          ` : ''}
        </div>

        <!-- Action Chips -->
        <div class="flex flex-wrap items-center gap-1.5 mb-3">
          <button type="button" data-action="load-store-prices-list" data-list-id="${list.id}" class="px-2.5 py-1 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-bold">
            📍 Цены
          </button>
          <button type="button" data-action="collab-list" data-list-id="${list.id}" class="px-2.5 py-1 rounded-xl bg-blue-600/10 hover:bg-blue-600/20 text-blue-700 dark:text-blue-300 text-[11px] font-bold">
            👥 Участники (${list.collaborators.length})
          </button>
          ${viewToggleHTML(list, compact, 'ml-auto')}
          <select data-action="sort-list" data-list-id="${list.id}" class="h-6 px-2 rounded-xl bg-black/5 dark:bg-white/10 text-[11px] font-semibold outline-none">
            <option value="manual" ${list.sortMode === 'manual' ? 'selected' : ''}>Вручную</option>
            <option value="unchecked" ${list.sortMode === 'unchecked' ? 'selected' : ''}>Активные</option>
            <option value="alpha" ${list.sortMode === 'alpha' ? 'selected' : ''}>А–Я</option>
            <option value="price" ${list.sortMode === 'price' ? 'selected' : ''}>Цена</option>
          </select>
        </div>

        <!-- Quick Add Input with Autocomplete -->
        ${!isReadOnly ? `
          <div class="relative mb-3">
            <div class="flex items-center gap-1.5 bg-white/95 dark:bg-zinc-950/80 border border-black/10 dark:border-white/10 rounded-xl px-2.5 h-10">
              <span class="text-amber-500 font-bold shrink-0">+</span>
              <input type="text" data-quick-input="${list.id}" autocomplete="off" placeholder="Добавить товар..." class="w-full bg-transparent text-xs sm:text-sm outline-none" />
              <button type="button" data-action="quick-add-submit" data-list-id="${list.id}" class="px-2.5 py-1 rounded-lg bg-amber-500 text-white text-[11px] font-bold shrink-0">ОК</button>
            </div>
            <div id="quick-ac-${list.id}" class="hidden absolute left-0 right-0 top-full mt-1 z-30 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 rounded-xl shadow-xl max-h-48 overflow-y-auto divide-y divide-slate-100 dark:divide-zinc-800"></div>
          </div>
        ` : ''}
        ${!isReadOnly ? suggestionsHTML(list) : ''}

        <!-- Active Items -->
        ${compact ? `
          <div class="ks-rows" data-row-group>
            ${allItems.map(item => renderItemRowHTML(list, item, isReadOnly)).join('')}
          </div>
          ${allItems.length && !isReadOnly ? '<div class="mt-1.5 text-[10px] text-slate-400 dark:text-zinc-500 text-center">Тап — взял · держите и тяните — порядок · кол-во — изменить</div>' : ''}
        ` : `
        <div class="space-y-2.5">
          ${allItems.map((item, idx2) => renderItemCardHTML(list, item, idx2, allItems.length, isReadOnly)).join('')}
        </div>`}


        <!-- Footer -->
        <div class="mt-3.5 pt-3 border-t border-black/5 dark:border-white/5 flex flex-wrap items-center justify-between gap-2">
          ${!isReadOnly ? `
            <div class="flex flex-wrap items-center gap-1.5">
              <button type="button" data-action="open-picker" data-list-id="${list.id}" class="px-3 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold shrink-0">
                🧺 Подобрать
              </button>
              <button type="button" data-action="open-picker" data-pk-tab="recipe" data-list-id="${list.id}" class="px-3 py-1.5 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 text-amber-800 dark:text-amber-300 text-xs font-bold shrink-0">
                🍲 Из блюда
              </button>
              <button type="button" data-action="open-add-modal" data-list-id="${list.id}" class="px-2.5 py-1.5 rounded-xl bg-black/5 dark:bg-white/10 hover:bg-black/10 text-xs font-bold shrink-0" title="Добавить товар вручную, с ценой и ИИ-подсказкой">
                ✏️ Вручную
              </button>
            </div>
          ` : `<span class="text-[11px] text-slate-400">Только просмотр</span>`}
          <div class="text-right ml-auto">
            <div class="text-[10px] text-slate-500 dark:text-zinc-400">Куплено: ${formatMoney(checkedSum)}</div>
            <div class="text-sm font-extrabold">Итого: ${formatMoney(listSum)}</div>
          </div>
        </div>
      </article>
    `;
  }).join('');
}

// ==================== STORE PRICES & INTERACTIVE LEAFLET MAP ====================
function initOrUpdateStoreMap() {
  const lat = Number(state.storeSearch.lat) || 52.2297;
  const lng = Number(state.storeSearch.lng) || 21.0122;
  const radiusMeters = (Number(state.storeSearch.radiusKm) || 3) * 1000;

  if (!L) {
    document.getElementById('storeLocationMap').innerHTML = `<div class="p-4 text-xs text-slate-500">Карта загружается... Используйте поле поиска адреса или координат выше.</div>`;
    return;
  }

  if (!leafletMap) {
    leafletMap = L.map('storeLocationMap', { zoomControl: true }).setView([lat, lng], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap'
    }).addTo(leafletMap);

    leafletMarker = L.marker([lat, lng], { draggable: true }).addTo(leafletMap);
    leafletCircle = L.circle([lat, lng], {
      radius: radiusMeters,
      color: '#2563eb',
      fillColor: '#3b82f6',
      fillOpacity: 0.14,
      weight: 2
    }).addTo(leafletMap);
    leafletStoreLayer = L.layerGroup().addTo(leafletMap);

    // Click ANY point on map to move search center
    leafletMap.on('click', (e) => {
      setCustomMapLocation(e.latlng.lat, e.latlng.lng, '', true);
    });

    // Drag marker to any point
    leafletMarker.on('dragend', () => {
      const pos = leafletMarker.getLatLng();
      setCustomMapLocation(pos.lat, pos.lng, '', true);
    });
  } else {
    leafletMap.setView([lat, lng], leafletMap.getZoom());
    leafletMarker.setLatLng([lat, lng]);
    leafletCircle.setLatLng([lat, lng]);
    leafletCircle.setRadius(radiusMeters);
  }

  // Render store pins on map within radius
  if (leafletStoreLayer) {
    leafletStoreLayer.clearLayers();
    getFilteredStores().forEach(st => {
      const m = L.circleMarker([st.lat, st.lng], {
        radius: st.id === state.storeSearch.selectedStoreId ? 8 : 6,
        color: st.id === state.storeSearch.selectedStoreId ? '#059669' : '#d97706',
        fillColor: st.id === state.storeSearch.selectedStoreId ? '#10b981' : '#f59e0b',
        fillOpacity: 0.9,
        weight: 2
      });
      m.bindTooltip(`${st.chain} (${st.distanceKm} км)`);
      m.on('click', () => {
        state.storeSearch.selectedStoreId = st.id;
        renderNearbyStoresList();
        initOrUpdateStoreMap();
      });
      m.addTo(leafletStoreLayer);
    });
  }

  setTimeout(() => { if (leafletMap) leafletMap.invalidateSize(); }, 80);
}

async function setCustomMapLocation(lat, lng, explicitLabel = '', reverseGeocode = false) {
  const cleanLat = Math.round(lat * 10000) / 10000;
  const cleanLng = Math.round(lng * 10000) / 10000;
  state.storeSearch.lat = cleanLat;
  state.storeSearch.lng = cleanLng;
  state.storeSearch.locationLabel = explicitLabel || `Точка (${cleanLat}, ${cleanLng})`;

  document.getElementById('gpsCoordsText').textContent = `Точка: ${state.storeSearch.locationLabel}`;
  renderNearbyStoresList();
  initOrUpdateStoreMap();

  if (reverseGeocode && !explicitLabel) {
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${cleanLat}&lon=${cleanLng}&accept-language=ru`);
      if (res.ok) {
        const data = await res.json();
        const road = data.address?.road || data.address?.suburb || data.address?.city_district || data.address?.city || '';
        const house = data.address?.house_number ? `, ${data.address.house_number}` : '';
        if (road) {
          state.storeSearch.locationLabel = `${road}${house} (${cleanLat}, ${cleanLng})`;
          document.getElementById('gpsCoordsText').textContent = `Точка: ${state.storeSearch.locationLabel}`;
        }
      }
    } catch (e) {}
  }
}

function renderSavedLocationsDropdown() {
  const sel = document.getElementById('savedLocationsSelect');
  if (!sel) return;
  sel.innerHTML = `<option value="">— Выбрать сохранённую точку —</option>` +
    state.storeSearch.savedLocations.map(loc =>
      `<option value="${loc.id}">${escapeHTML(loc.label)}</option>`
    ).join('');
}

function openStorePricesModal(preselectedListId = '') {
  const sel = document.getElementById('storeTargetListSelect');
  if (sel) {
    sel.innerHTML = state.lists.map(l => `<option value="${l.id}">${escapeHTML(l.title)} (${l.items.length} поз.)</option>`).join('')
      + `<option value="__ALL__">Все списки (${state.lists.length})</option>`;
    if (preselectedListId && state.lists.some(l => l.id === preselectedListId)) sel.value = preselectedListId;
  }
  renderSavedLocationsDropdown();
  document.getElementById('storeRadiusSlider').value = state.storeSearch.radiusKm;
  document.getElementById('radiusValueLabel').textContent = `${state.storeSearch.radiusKm} км`;
  document.getElementById('gpsCoordsText').textContent = `Точка: ${state.storeSearch.locationLabel}`;
  document.getElementById('storeComparisonResultBox').classList.add('hidden');
  document.getElementById('applyCheapestEverywhereBtn').classList.add('hidden');
  renderNearbyStoresList();
  openModal('storePricesModal');
  setTimeout(() => initOrUpdateStoreMap(), 70);
}

function getStoresAroundChosenPoint() {
  const baseLat = Number(state.storeSearch.lat) || 52.2297;
  const baseLng = Number(state.storeSearch.lng) || 21.0122;
  return STORE_TEMPLATES.map(tpl => {
    const sLat = Math.round((baseLat + tpl.dLat) * 10000) / 10000;
    const sLng = Math.round((baseLng + tpl.dLng) * 10000) / 10000;
    const dist = calcDistanceKm(baseLat, baseLng, sLat, sLng);
    return {
      id: tpl.id,
      name: `${tpl.chain} (${tpl.suffix})`,
      chain: tpl.chain,
      lat: sLat,
      lng: sLng,
      distanceKm: dist,
      multiplier: tpl.multiplier,
      address: `${dist} км от выбранной точки • ${tpl.note}`
    };
  });
}

function getFilteredStores() {
  const radius = Number(state.storeSearch.radiusKm) || 3;
  const chain = (state.storeSearch.chainFilter || '').toLowerCase();
  const q = (state.storeSearch.query || '').trim().toLowerCase();
  const sortBy = state.storeSearch.sortBy || 'distance';

  let stores = getStoresAroundChosenPoint().filter(s => s.distanceKm <= radius);
  if (chain) stores = stores.filter(s => s.chain.toLowerCase() === chain);
  if (q) {
    stores = stores.filter(s => s.name.toLowerCase().includes(q) || s.chain.toLowerCase().includes(q));
    if (!stores.length) {
      stores = [{
        id: 'custom-st',
        name: state.storeSearch.query.trim(),
        chain: state.storeSearch.query.trim(),
        lat: Number(state.storeSearch.lat),
        lng: Number(state.storeSearch.lng),
        distanceKm: 0.5,
        multiplier: 0.96,
        address: 'Пользовательский магазин рядом с точкой'
      }];
    }
  }
  if (sortBy === 'distance') stores.sort((a, b) => a.distanceKm - b.distanceKm);
  if (sortBy === 'priceLevel') stores.sort((a, b) => a.multiplier - b.multiplier);
  if (sortBy === 'name') stores.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return stores;
}

function renderNearbyStoresList() {
  const grid = document.getElementById('nearbyStoresGrid');
  if (!grid) return;
  const stores = getFilteredStores();
  if (!stores.length) {
    grid.innerHTML = `<div class="col-span-full text-center py-5 text-xs text-slate-400">В радиусе ${state.storeSearch.radiusKm} км от выбранной точки нет магазинов. Увеличьте радиус!</div>`;
    return;
  }
  if (!stores.some(s => s.id === state.storeSearch.selectedStoreId)) state.storeSearch.selectedStoreId = stores[0].id;

  grid.innerHTML = stores.map(st => {
    const selected = st.id === state.storeSearch.selectedStoreId;
    return `
      <button type="button" data-select-store="${st.id}" class="text-left p-2.5 rounded-2xl border transition-all ${selected ? 'border-emerald-500 bg-emerald-50/70 dark:bg-emerald-950/30 ring-1 ring-emerald-500' : 'border-slate-200 dark:border-zinc-800'}">
        <div class="flex items-center justify-between gap-2">
          <span class="font-bold text-xs truncate">${escapeHTML(st.name)}</span>
          <span class="text-xs font-extrabold text-blue-600 shrink-0">${st.distanceKm} км</span>
        </div>
        <div class="text-[11px] text-slate-500 truncate mt-0.5">${escapeHTML(st.address)}</div>
      </button>
    `;
  }).join('');
}

// ВНИМАНИЕ: это имитация, а не реальные цены магазинов (API цен сетей нет).
// Цена = базовая цена товара × коэффициент сети × небольшой разброс. База фиксируется
// при первом расчёте (item.basePrice), иначе каждое нажатие «Цены» умножало бы уже изменённую цену.
function computeStorePriceForProduct(item, store) {
  const rate = (CURRENCIES[state.currency] || CURRENCIES.PLN).rateFromPln;
  if (!(Number(item.basePrice) > 0)) {
    item.basePrice = Number(item.price) > 0 ? Number(item.price) : (estimateItemPrice(item.name, item.unit)?.price || 0);
  }
  const basePln = Number(item.basePrice) > 0 ? Number(item.basePrice) : (8.5 + (item.name.length % 12) * 1.4) * rate;
  const hash = Array.from(item.name + store.chain).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const jitter = 0.93 + ((hash % 15) / 100);
  return Math.max(0.5, Math.round(basePln * store.multiplier * jitter * 100) / 100);
}

function executeStorePriceFetch() {
  const storesInRadius = getFilteredStores();
  const primaryStore = storesInRadius.find(s => s.id === state.storeSearch.selectedStoreId) || storesInRadius[0];
  if (!primaryStore) return;

  const targetVal = document.getElementById('storeTargetListSelect').value;
  const targetLists = targetVal === '__ALL__' ? state.lists : state.lists.filter(l => l.id === targetVal);
  const allNearby = getStoresAroundChosenPoint().filter(s => s.distanceKm <= Number(state.storeSearch.radiusKm || 3));
  const competitors = allNearby.filter(s => s.id !== primaryStore.id);

  const previewRows = [];
  let totalSavings = 0;

  targetLists.forEach(list => {
    list.items.forEach(item => {
      const primaryPrice = computeStorePriceForProduct(item, primaryStore);
      item.price = primaryPrice;
      item.priceEstimated = true; // имитация цены сети — ориентир, не реальная цена
      item.storeName = primaryStore.chain;
      item.productUrl = buildProductStoreUrl(item.name, primaryStore.chain);
      // имитация — в историю реальных цен не пишем

      let bestCheaper = null;
      competitors.forEach(comp => {
        const compPrice = computeStorePriceForProduct(item, comp);
        recordProductPrice(item.name, compPrice, comp.chain);
        if (compPrice < primaryPrice - 0.05 && (!bestCheaper || compPrice < bestCheaper.price)) {
          bestCheaper = { storeName: comp.name, chain: comp.chain, distanceKm: comp.distanceKm, price: compPrice };
        }
      });
      item.cheaperAlt = bestCheaper;
      if (bestCheaper) totalSavings += (primaryPrice - bestCheaper.price) * (Number(item.qty) || 1);
      previewRows.push({ name: item.name, primaryStore: primaryStore.chain, primaryPrice, cheaperAlt: bestCheaper });
    });
  });

  saveState();
  document.getElementById('storeComparisonResultBox').classList.remove('hidden');
  document.getElementById('storeComparisonHeadline').textContent = `${primaryStore.chain} (${previewRows.length} поз.)`;
  document.getElementById('storeSavingsBadge').textContent = `2-я цена дешевле: −${formatMoney(totalSavings)}`;
  if (totalSavings > 0.05) document.getElementById('applyCheapestEverywhereBtn').classList.remove('hidden');

  document.getElementById('storeComparisonRows').innerHTML = previewRows.map(r => `
    <div class="p-2 rounded-xl bg-white dark:bg-zinc-900 flex flex-wrap items-center justify-between gap-1 text-xs">
      <span class="font-bold truncate">${escapeHTML(r.name)}</span>
      <div class="flex flex-wrap items-center gap-1.5">
        <span>${escapeHTML(r.primaryStore)}: <b>${formatMoney(r.primaryPrice)}</b></span>
        ${r.cheaperAlt ? `<span class="px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/50 text-emerald-800 dark:text-emerald-300 font-bold">Дешевле: ${escapeHTML(r.cheaperAlt.chain)} (${r.cheaperAlt.distanceKm} км) — ${formatMoney(r.cheaperAlt.price)}</span>` : ''}
      </div>
    </div>
  `).join('');
  showToast(`Цены из ${primaryStore.chain} загружены!`);
}

// ==================== COLLABORATORS ====================
function renderCollabMembers(list) {
  normalizeCollaborators(list);
  document.getElementById('collabListSubtitle').textContent = `«${list.title}» • Участников: ${list.collaborators.length}`;
  document.getElementById('collabMembersContainer').innerHTML = list.collaborators.map((m, idx) => `
    <div class="p-3 rounded-2xl bg-slate-50 dark:bg-zinc-800/80 border border-slate-200 dark:border-zinc-700 space-y-2">
      <div class="flex items-center gap-2">
        <span class="w-7 h-7 rounded-full bg-blue-600 text-white text-xs font-extrabold flex items-center justify-center shrink-0">${escapeHTML((m.name || 'У')[0].toUpperCase())}</span>
        <input type="text" data-collab-field="name" data-collab-idx="${idx}" value="${escapeHTML(m.name)}" placeholder="Имя" class="flex-1 h-8 px-2.5 rounded-lg bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 text-xs font-bold outline-none" />
        ${idx > 0 ? `<button type="button" data-remove-collab="${idx}" class="p-1.5 rounded-lg text-rose-500 text-xs font-bold shrink-0" title="Удалить участника">🗑</button>` : `<span class="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-100 text-amber-800 shrink-0">Вы</span>`}
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input type="email" data-collab-field="email" data-collab-idx="${idx}" value="${escapeHTML(m.email)}" placeholder="Email" class="h-8 px-2.5 rounded-lg bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 text-xs outline-none" />
        <div class="flex items-center gap-1.5">
          <select data-collab-field="role" data-collab-idx="${idx}" class="flex-1 h-8 px-2 rounded-lg bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 text-xs font-semibold outline-none">
            <option value="Владелец" ${m.role === 'Владелец' ? 'selected' : ''}>Владелец</option>
            <option value="Редактор" ${m.role === 'Редактор' ? 'selected' : ''}>Редактор</option>
            <option value="Только просмотр" ${m.role === 'Только просмотр' ? 'selected' : ''}>Только просмотр</option>
          </select>
          <button type="button" data-copy-member-invite="${idx}" class="h-8 px-2 rounded-lg bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 text-[10px] font-bold shrink-0" title="Копировать ссылку доступа">
            🔑 Ссылка
          </button>
        </div>
      </div>
    </div>
  `).join('');
}

// ==================== PRICE HISTORY CHART ====================
function filterPriceEntriesByPeriod(entries, period, customFrom = '', customTo = '') {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  return entries.filter(e => {
    const d = new Date(e.date || todayStr);
    const diffDays = Math.floor((now - d) / 86400000);
    if (period === 'day') return diffDays <= 1;
    if (period === 'week') return diffDays <= 7;
    if (period === 'month') return diffDays <= 31;
    if (period === 'halfyear') return diffDays <= 183;
    if (period === 'year') return diffDays <= 365;
    if (period === 'custom') {
      if (customFrom && e.date < customFrom) return false;
      if (customTo && e.date > customTo) return false;
      return true;
    }
    return true;
  });
}

function buildProductPriceHistoryHTML(productName, contextPrefix) {
  const allForProduct = state.priceHistory
    .filter(p => p.productName.toLowerCase() === productName.toLowerCase())
    .sort((a, b) => a.date.localeCompare(b.date));

  const period = state.priceHistoryPeriod || 'month';
  const customFrom = document.getElementById(`${contextPrefix}-ph-from`)?.value || isoDaysAgo(90);
  const customTo = document.getElementById(`${contextPrefix}-ph-to`)?.value || isoDaysAgo(0);
  let entries = filterPriceEntriesByPeriod(allForProduct, period, customFrom, customTo);
  if (!entries.length && allForProduct.length && period !== 'custom') entries = allForProduct.slice(-6);

  const prices = entries.map(e => Number(e.price) || 0);
  const minPrice = prices.length ? Math.min(...prices) : 0;
  const maxPrice = prices.length ? Math.max(...prices) : 0;
  const avgPrice = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
  const firstP = prices[0] || 0;
  const lastP = prices[prices.length - 1] || 0;
  const deltaPct = firstP > 0 ? Math.round(((lastP - firstP) / firstP) * 100) : 0;

  let svgChart = `<div class="text-xs text-slate-400 py-6 text-center">Нет записей за выбранный период</div>`;
  if (entries.length >= 1) {
    const w = 500, h = 140, padX = 28, padY = 22;
    const span = (maxPrice - minPrice) || Math.max(1, maxPrice * 0.2);
    const pts = entries.map((e, i) => {
      const x = entries.length === 1 ? w / 2 : padX + (i / (entries.length - 1)) * (w - padX * 2);
      const norm = (Number(e.price) - minPrice) / span;
      const y = h - padY - norm * (h - padY * 2);
      return { x, y, e };
    });
    const poly = pts.map(p => `${p.x},${p.y}`).join(' ');
    svgChart = `
      <svg viewBox="0 0 ${w} ${h}" class="w-full h-36">
        <polyline fill="none" stroke="#10b981" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="${poly}" />
        ${pts.map(p => `
          <g>
            <circle cx="${p.x}" cy="${p.y}" r="4.5" fill="#10b981" stroke="#ffffff" stroke-width="2" />
            <text x="${p.x}" y="${p.y - 8}" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">${formatMoney(p.e.price)}</text>
            <text x="${p.x}" y="${h - 4}" text-anchor="middle" font-size="9" fill="#94a3b8">${p.e.date.slice(5)}</text>
          </g>
        `).join('')}
      </svg>
    `;
  }

  const periods = [
    { id: 'day', label: 'День' },
    { id: 'week', label: 'Неделя' },
    { id: 'month', label: 'Месяц' },
    { id: 'halfyear', label: 'Полгода' },
    { id: 'year', label: 'Год' },
    { id: 'custom', label: 'Свой период' }
  ];

  return `
    <div class="space-y-3.5">
      <div class="flex items-center gap-1 bg-slate-100 dark:bg-zinc-800 p-1 rounded-xl overflow-x-auto no-scrollbar max-w-full">
        ${periods.map(p => `
          <button type="button" data-ph-period="${p.id}" data-ph-ctx="${contextPrefix}" class="shrink-0 px-2.5 py-1 rounded-lg text-xs ${period === p.id ? 'font-bold bg-emerald-600 text-white' : 'font-medium text-slate-600 dark:text-zinc-300'}">${p.label}</button>
        `).join('')}
      </div>

      ${period === 'custom' ? `
        <div class="flex flex-wrap items-center gap-2 text-xs p-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800">
          <label class="flex items-center gap-1 font-semibold">От: <input type="date" id="${contextPrefix}-ph-from" data-ph-date-ctx="${contextPrefix}" value="${customFrom}" class="px-2 py-1 rounded bg-white dark:bg-zinc-900" /></label>
          <label class="flex items-center gap-1 font-semibold">До: <input type="date" id="${contextPrefix}-ph-to" data-ph-date-ctx="${contextPrefix}" value="${customTo}" class="px-2 py-1 rounded bg-white dark:bg-zinc-900" /></label>
        </div>
      ` : ''}

      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div class="p-2.5 rounded-2xl bg-emerald-50/70 dark:bg-emerald-950/30">
          <div class="text-[10px] text-emerald-700 dark:text-emerald-400">Мин. цена</div>
          <div class="text-sm sm:text-base font-extrabold">${formatMoney(minPrice)}</div>
        </div>
        <div class="p-2.5 rounded-2xl bg-slate-50 dark:bg-zinc-800/70">
          <div class="text-[10px] text-slate-400">Средняя</div>
          <div class="text-sm sm:text-base font-extrabold">${formatMoney(avgPrice)}</div>
        </div>
        <div class="p-2.5 rounded-2xl bg-slate-50 dark:bg-zinc-800/70">
          <div class="text-[10px] text-slate-400">Макс. цена</div>
          <div class="text-sm sm:text-base font-extrabold">${formatMoney(maxPrice)}</div>
        </div>
        <div class="p-2.5 rounded-2xl bg-slate-50 dark:bg-zinc-800/70">
          <div class="text-[10px] text-slate-400">Изменение</div>
          <div class="text-sm sm:text-base font-extrabold ${deltaPct > 0 ? 'text-rose-500' : 'text-emerald-600'}">${deltaPct > 0 ? '+' : ''}${deltaPct}%</div>
        </div>
      </div>

      <div class="p-3 rounded-2xl bg-slate-50 dark:bg-zinc-800/50 border border-slate-200/70 dark:border-zinc-800">
        ${svgChart}
      </div>

      <div class="space-y-1 max-h-40 overflow-y-auto">
        ${[...entries].reverse().map(e => `
          <div class="flex items-center justify-between px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-zinc-800/70 text-xs">
            <div class="flex items-center gap-2 truncate">
              <span class="font-mono text-slate-400">${e.date}</span>
              <span class="font-bold truncate">🏪 ${escapeHTML(e.store)}</span>
            </div>
            <span class="font-extrabold shrink-0">${formatMoney(e.price)}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function openProductPriceHistoryModal(productName) {
  state.selectedHistoryProduct = productName;
  document.getElementById('priceModalProductTitle').textContent = productName;
  document.getElementById('modalPriceHistoryContent').innerHTML = buildProductPriceHistoryHTML(productName, 'modal');
  openModal('productPriceHistoryModal');
}

function renderFrequentView() {
  const grid = document.getElementById('frequentGrid');
  if (!grid) return;
  fillViewToggleSlot('frequent');
  const q = state.searchQuery.trim().toLowerCase();
  let list = computeFrequentStats();
  if (state.frequentFilter === 'regular') list = list.filter(i => i.times >= 2);
  if (state.frequentFilter === 'spend') list = [...list].sort((a, b) => b.totalSpend - a.totalSpend);
  if (q) list = list.filter(i => i.name.toLowerCase().includes(q));
  const compact = sectionCompact('frequent');
  if (!list.length) {
    grid.className = CARDS_GRID;
    grid.innerHTML = `<div class="col-span-full text-center py-10 bg-white dark:bg-zinc-900 rounded-2xl text-xs text-slate-400">Нет данных о частых покупках</div>`;
    return;
  }
  grid.className = compact ? 'ks-rows' : CARDS_GRID;
  grid.innerHTML = list.map(item => compact ? frequentRowHTML(item) : frequentCardHTML(item)).join('');
}

function renderCollectionView(section, gridId) {
  const grid = document.getElementById(gridId);
  if (!grid) return;
  fillViewToggleSlot(section);
  const q = state.searchQuery.trim().toLowerCase();
  const items = (state[section] || []).filter(i => !q || i.name.toLowerCase().includes(q));
  const compact = sectionCompact(section);
  if (!items.length) {
    grid.className = CARDS_GRID;
    grid.innerHTML = `<div class="col-span-full text-center py-10 bg-white dark:bg-zinc-900 rounded-2xl text-xs text-slate-400">Раздел пуст</div>`;
    return;
  }
  grid.className = compact ? 'ks-rows' : CARDS_GRID;
  grid.innerHTML = items.map(item => compact ? collectionRowHTML(section, item) : collectionCardHTML(section, item)).join('');
}

function renderStatisticsView() {
  const period = state.statsPeriod;
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  const filtered = state.recent.filter(item => {
    const d = new Date(item.date || todayStr);
    const day = d.getDay();
    const diffDays = Math.floor((now - d) / 86400000);
    if (period === 'day') return item.date === todayStr;
    if (period === 'weekdays') return day >= 1 && day <= 5;
    if (period === 'weekend') return day === 0 || day === 6;
    if (period === 'week') return diffDays <= 7;
    if (period === 'month') return diffDays <= 31;
    if (period === 'year') return diffDays <= 365;
    if (period === 'custom') {
      const from = document.getElementById('statsDateFrom')?.value;
      const to = document.getElementById('statsDateTo')?.value;
      if (from && item.date < from) return false;
      if (to && item.date > to) return false;
      return true;
    }
    return true;
  });

  const totalSpent = filtered.reduce((s, i) => s + (Number(i.qty) || 1) * (Number(i.price) || 0), 0);
  const totalQty = filtered.reduce((s, i) => s + (Number(i.qty) || 1), 0);
  const avg = filtered.length ? totalSpent / filtered.length : 0;

  let wdSum = 0, weSum = 0;
  state.recent.forEach(i => {
    const dw = new Date(i.date || todayStr).getDay();
    const val = (Number(i.qty) || 1) * (Number(i.price) || 0);
    if (dw === 0 || dw === 6) weSum += val;
    else wdSum += val;
  });
  const wdPct = Math.round((wdSum / (wdSum + weSum || 1)) * 100);

  document.getElementById('kpiTotalSpent').textContent = formatMoney(totalSpent);
  document.getElementById('kpiItemsPurchased').textContent = Math.round(totalQty * 10) / 10;
  document.getElementById('kpiAvgItem').textContent = formatMoney(avg);
  document.getElementById('kpiWeekdaySplit').textContent = `${wdPct}% / ${100 - wdPct}%`;

  const chart = document.getElementById('weekdayBarChart');
  const dayNames = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  const dayTotals = Array(7).fill(0);
  filtered.forEach(i => { dayTotals[new Date(i.date || todayStr).getDay()] += (Number(i.qty) || 1) * (Number(i.price) || 0); });
  const maxBar = Math.max(...dayTotals, 10);
  chart.innerHTML = [1, 2, 3, 4, 5, 6, 0].map(idx => {
    const val = dayTotals[idx];
    const hPct = Math.max(8, Math.round((val / maxBar) * 100));
    return `
      <div class="flex-1 flex flex-col items-center justify-end h-full gap-1">
        <span class="text-[9px] font-bold text-slate-400">${val > 0 ? Math.round(val) : ''}</span>
        <div class="w-full max-w-[28px] rounded-t-lg ${idx === 0 || idx === 6 ? 'bg-amber-500' : 'bg-emerald-500'}" style="height: ${hPct}%"></div>
        <span class="text-[11px] font-bold text-slate-500">${dayNames[idx]}</span>
      </div>
    `;
  }).join('');

  const topFreq = computeFrequentStats(filtered.length ? filtered : null).slice(0, 5);
  const maxF = Math.max(...topFreq.map(x => x.times), 1);
  document.getElementById('statsFrequentList').innerHTML = topFreq.map(f => `
    <div class="space-y-1">
      <div class="flex items-center justify-between text-xs">
        <span class="font-bold truncate pr-2">${escapeHTML(f.name)}</span>
        <span class="px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-300 font-extrabold shrink-0">×${f.times}</span>
      </div>
      <div class="w-full h-1.5 rounded-full bg-slate-100 dark:bg-zinc-800 overflow-hidden">
        <div class="h-full bg-amber-500 rounded-full" style="width: ${Math.max(15, Math.round((f.times / maxF) * 100))}%"></div>
      </div>
    </div>
  `).join('');

  const topSpend = [...filtered].sort((a, b) => (b.qty * b.price) - (a.qty * a.price)).slice(0, 5);
  document.getElementById('statsTopSpendList').innerHTML = topSpend.map(i => `
    <div class="flex items-center justify-between p-2 rounded-xl bg-slate-50 dark:bg-zinc-800/70 text-xs">
      <span class="font-bold truncate pr-2">${escapeHTML(i.name)}</span>
      <span class="font-extrabold shrink-0">${formatMoney(i.qty * i.price)}</span>
    </div>
  `).join('');

  const prodSel = document.getElementById('embeddedProductSelect');
  const uniqueProducts = Array.from(new Set(state.priceHistory.map(p => p.productName)));
  if (prodSel && uniqueProducts.length) {
    if (!uniqueProducts.includes(state.selectedHistoryProduct)) state.selectedHistoryProduct = uniqueProducts[0];
    prodSel.innerHTML = uniqueProducts.map(name => `<option value="${escapeHTML(name)}" ${name === state.selectedHistoryProduct ? 'selected' : ''}>${escapeHTML(name)}</option>`).join('');
    document.getElementById('embeddedPriceHistoryContainer').innerHTML = buildProductPriceHistoryHTML(state.selectedHistoryProduct, 'embedded');
  }
}

// ==================== GEMINI AI WITH EXPONENTIAL BACKOFF ====================
async function askGeminiWithBackoff(payload) {
  const apiKey = await getGeminiKey();
  if (!apiKey) { showToast('Укажите ключ Gemini AI в меню ⋮'); throw new Error('Gemini key missing'); }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const delays = [1000, 2000, 4000];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000)
      });
      if (res.ok) return await res.json();
      if (res.status === 400 || res.status === 403 || res.status === 404) break; // неверный ключ/модель — повтор не поможет
      if (attempt < delays.length) await new Promise(r => setTimeout(r, delays[attempt]));
    } catch (err) {
      if (attempt < delays.length) await new Promise(r => setTimeout(r, delays[attempt]));
    }
  }
  throw new Error('Gemini unavailable');
}

function parseLinesToItems(rawText) {
  const catalog = getUnifiedCatalog();
  return rawText.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
    const checked = /^(\[x\]|☑|✓)/i.test(line);
    let clean = line.replace(/^(\[\s*\]|\[x\]|☐|☑|✓|-|\*|\d+\.)\s*/i, '').trim();
    let price = 0;
    const pm = clean.match(/[-=:]\s*(\d+[.,]?\d*)\s*(?:zł|pln|₽|rub|\$|€|₴|br|₸|£)?$/i);
    if (pm) { price = parseFloat(pm[1].replace(',', '.')) || 0; clean = clean.slice(0, pm.index).trim(); }
    let qty = 1, unit = 'шт';
    const qm = clean.match(/(\d+[.,]?\d*)\s*(кг|г|л|мл|шт|уп)\b/i);
    if (qm) { qty = parseFloat(qm[1].replace(',', '.')) || 1; unit = qm[2].toLowerCase(); clean = clean.replace(qm[0], '').trim(); }
    const name = clean || 'Товар';
    const inDb = catalog.find(c => c.name.toLowerCase() === name.toLowerCase());
    return { name, qty, unit, price: price || inDb?.price || 0, desc: inDb?.desc || '', checked, isNew: !inDb };
  });
}

// ==================== CLOUD SYNC (FIREBASE AUTH & FIRESTORE) ====================
async function initCloud() {
  try {
    if (typeof __firebase_config === 'undefined') return;
    const app = initializeApp(JSON.parse(__firebase_config));
    auth = getAuth(app);
    db = getFirestore(app);
    const appId = typeof __app_id !== 'undefined' ? __app_id : 'keepshop-ai-default';

    // RULE 3: Authenticate FIRST before any Firestore listener
    if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
      await signInWithCustomToken(auth, __initial_auth_token);
    } else {
      await signInAnonymously(auth);
    }

    onAuthStateChanged(auth, (user) => {
      if (!user) return;
      currentUid = user.uid;
      if (!user.isAnonymous && user.email) {
        state.session.unlocked = true;
        state.session.userEmail = user.email;
        state.session.userName = user.displayName || user.email.split('@')[0];
        state.session.role = user.email.toLowerCase() === (state.privacy.ownerEmail || '').toLowerCase() ? 'Владелец' : 'Редактор';
        renderApp();
      }
      // RULE 1: Strict path /artifacts/{appId}/public/data/{collectionName}/{docId}
      const ref = doc(db, 'artifacts', appId, 'public', 'data', 'keepshop_boards', 'main_shared_board');
      onSnapshot(ref, (snap) => {
        if (snap.exists()) {
          const d = snap.data();
          if (d.lists) state.lists = JSON.parse(d.lists);
          if (d.priceHistory) state.priceHistory = JSON.parse(d.priceHistory);
          if (d.recent) state.recent = JSON.parse(d.recent);
          if (d.favorite) state.favorite = JSON.parse(d.favorite);
          if (d.backlog) state.backlog = JSON.parse(d.backlog);
          state.lists.forEach(normalizeCollaborators);
          renderApp();
        } else {
          syncToFirestore();
        }
      }, (err) => {
        console.warn('Firestore snapshot warning:', err);
      });
    });
  } catch (e) {}
}

async function syncToFirestore() {
  if (!db || !currentUid) return;
  try {
    const appId = typeof __app_id !== 'undefined' ? __app_id : 'keepshop-ai-default';
    const ref = doc(db, 'artifacts', appId, 'public', 'data', 'keepshop_boards', 'main_shared_board');
    await setDoc(ref, {
      lists: JSON.stringify(state.lists),
      priceHistory: JSON.stringify(state.priceHistory),
      recent: JSON.stringify(state.recent),
      favorite: JSON.stringify(state.favorite),
      backlog: JSON.stringify(state.backlog),
      updatedAt: new Date().toISOString()
    }, { merge: true });
  } catch (e) {}
}

// ==================== NAVIGATION & ITEM EDITOR ====================
function switchActiveTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.app-view').forEach(el => el.classList.add('hidden'));
  document.getElementById(`view-${tab}`)?.classList.remove('hidden');

  document.querySelectorAll('#topNavTabs .tab-trigger').forEach(btn => {
    const active = btn.dataset.tab === tab;
    btn.className = active
      ? 'tab-trigger px-3 py-1.5 rounded-xl text-xs font-bold bg-amber-500 text-white shadow-xs flex items-center gap-1.5'
      : 'tab-trigger px-3 py-1.5 rounded-xl text-xs font-medium text-slate-600 dark:text-zinc-300 hover:bg-slate-200/70 dark:hover:bg-zinc-800 flex items-center gap-1.5';
  });

  document.querySelectorAll('.mobile-tab-btn').forEach(btn => {
    const active = btn.dataset.tab === tab;
    btn.className = active
      ? 'mobile-tab-btn py-1.5 rounded-xl flex flex-col items-center justify-center gap-0.5 text-[10px] font-bold text-amber-600 dark:text-amber-400 bg-amber-500/10 truncate'
      : 'mobile-tab-btn py-1.5 rounded-xl flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium text-slate-500 dark:text-zinc-400 truncate';
  });

  if (tab === 'stats') renderStatisticsView();
  if (tab === 'frequent') renderFrequentView();
}

function openItemEditor(section, listId = '', itemId = '') {
  document.getElementById('modalTargetSection').value = section;
  document.getElementById('modalTargetListId').value = listId;
  document.getElementById('modalEditItemId').value = itemId;
  document.getElementById('modalAutocompleteBox').classList.add('hidden');

  let existing = null;
  if (itemId) {
    if (section === 'lists') existing = state.lists.find(l => l.id === listId)?.items.find(i => i.id === itemId);
    else existing = (state[section] || []).find(i => i.id === itemId);
  }

  document.getElementById('itemModalHeading').textContent = existing ? 'Редактировать товар' : 'Добавить товар';
  document.getElementById('modalItemName').value = existing?.name || '';
  document.getElementById('modalItemQty').value = existing?.qty || 1;
  document.getElementById('modalItemUnit').value = existing?.unit || 'шт';
  document.getElementById('modalItemPrice').value = existing?.price || 0;
  document.getElementById('modalItemStore').value = existing?.storeName || '';
  document.getElementById('modalItemProductUrl').value = existing?.productUrl || '';
  document.getElementById('modalItemDesc').value = existing?.desc || '';
  openModal('itemModal');
}

function addQuickItemToList(listId, rawName, fromSuggestion = false) {
  const name = rawName.trim();
  if (!name) return;
  const list = state.lists.find(l => l.id === listId);
  if (!list) return;
  const match = getUnifiedCatalog().find(c => c.name.toLowerCase() === name.toLowerCase());
  const storeName = match?.storeName || '';
  const est = match?.price ? null : estimateItemPrice(name, match?.unit || '');
  const price = match?.price || est?.price || 0;
  list.items.unshift({
    id: 'i-' + uniqueSuffix(),
    name: match ? match.name : name,
    qty: match ? match.qty : 1,
    unit: match ? match.unit : (est?.unit || 'шт'),
    price,
    priceEstimated: !!est?.estimated || (!!match?.price && !!match?.priceEstimated),
    storeName,
    productUrl: buildProductStoreUrl(name, storeName, match?.productUrl || ''),
    cheaperAlt: null,
    desc: match?.desc || '',
    checked: false,
    order: 0
  });
  list.items.forEach((it, idx) => it.order = idx);
  if (price > 0 && !est?.estimated && !match?.priceEstimated) recordProductPrice(name, price, storeName || 'База');
  if (!fromSuggestion) rememberAdded(listId, match ? match.name : name);
  upsertProduct(state.products || (state.products = []), list.items[0]);
  saveState();
  showToast(`Добавлено: ${name}`);
}

// ==================== ADD-PRODUCTS PICKER (Популярное / Каталог / Недавние / Из блюда) ====================
const PICKER_TAGS = [
  { id: 'veg', label: 'Вегетарианское', icon: '🥗' },
  { id: 'vegan', label: 'Веганское', icon: '🌱' },
  { id: 'keto', label: 'Кето', icon: '🥑' },
  { id: 'gf', label: 'Без глютена', icon: '🌾' },
  { id: 'protein', label: 'Много белка', icon: '💪' },
  { id: 'frozen', label: 'Заморозка', icon: '❄️' }
];

// Товар: [название, единица, теги]. Теги категории наследуются, «-тег» убирает унаследованный.
// veg — вегетарианское, vegan, keto, gf — без глютена, protein, frozen
const PICKER_CATALOG = [
  { id: 'produce', group: 'food', label: 'Овощи и фрукты', icon: '🥦', tone: 'bg-emerald-50 dark:bg-emerald-950/30', tags: 'veg vegan gf', items: [
    ['Помидоры', 'кг', 'keto'], ['Огурцы', 'кг', 'keto'], ['Картофель', 'кг'], ['Лук', 'кг'], ['Морковь', 'кг'], ['Чеснок', 'шт', 'keto'],
    ['Капуста', 'шт', 'keto'], ['Перец болгарский', 'кг', 'keto'], ['Кабачки', 'кг', 'keto'], ['Брокколи', 'шт', 'keto'], ['Свёкла', 'кг'],
    ['Грибы', 'кг', 'keto'], ['Салат', 'шт', 'keto'], ['Зелень', 'уп', 'keto'], ['Помидоры черри', 'уп', 'keto'], ['Яблоки', 'кг'], ['Бананы', 'кг'],
    ['Апельсины', 'кг'], ['Лимоны', 'шт'], ['Авокадо', 'шт', 'keto'], ['Виноград', 'кг'], ['Ягоды', 'уп']
  ] },
  { id: 'bakery', group: 'food', label: 'Хлеб и выпечка', icon: '🥖', tone: 'bg-orange-50 dark:bg-orange-950/30', tags: 'veg vegan', items: [
    ['Хлеб', 'шт'], ['Батон', 'шт'], ['Булочки', 'уп'], ['Лаваш', 'шт'], ['Тортильи', 'уп'], ['Круассаны', 'уп', '-vegan'], ['Хлебцы', 'уп']
  ] },
  { id: 'baking', group: 'food', label: 'Для выпечки', icon: '🧁', tone: 'bg-rose-50 dark:bg-rose-950/30', tags: 'veg vegan gf', items: [
    ['Мука', 'кг', '-gf'], ['Сахар', 'кг'], ['Дрожжи', 'уп'], ['Разрыхлитель', 'уп'], ['Ванильный сахар', 'уп'], ['Какао', 'уп'],
    ['Шоколад для выпечки', 'шт'], ['Сода', 'уп'], ['Крахмал', 'уп']
  ] },
  { id: 'dairy', group: 'food', label: 'Молочное и яйца', icon: '🧀', tone: 'bg-yellow-50 dark:bg-yellow-950/30', tags: 'veg gf', items: [
    ['Молоко', 'л'], ['Кефир', 'л'], ['Йогурт', 'шт', 'protein'], ['Сметана', 'шт', 'keto'], ['Творог', 'уп', 'protein keto'], ['Сливки', 'шт', 'keto'],
    ['Масло сливочное', 'шт', 'keto'], ['Сыр', 'уп', 'keto protein'], ['Моцарелла', 'шт', 'keto'], ['Пармезан', 'шт', 'keto protein'],
    ['Фета', 'шт', 'keto'], ['Сыр творожный', 'шт', 'keto'], ['Яйца', 'уп', 'protein keto']
  ] },
  { id: 'grains', group: 'food', label: 'Крупы и макароны', icon: '🍝', tone: 'bg-amber-50 dark:bg-amber-950/30', tags: 'veg vegan', items: [
    ['Рис', 'кг', 'gf'], ['Гречка', 'кг', 'gf'], ['Макароны', 'уп'], ['Спагетти', 'уп'], ['Овсянка', 'уп'], ['Булгур', 'уп'],
    ['Киноа', 'уп', 'gf protein'], ['Чечевица', 'уп', 'gf protein'], ['Нут', 'уп', 'gf protein'], ['Фасоль', 'уп', 'gf protein']
  ] },
  { id: 'ready', group: 'food', label: 'Готовая еда', icon: '🥟', tone: 'bg-sky-50 dark:bg-sky-950/30', tags: '', items: [
    ['Пельмени', 'уп', 'frozen'], ['Вареники', 'уп', 'frozen veg'], ['Пицца', 'шт', 'frozen'], ['Лазанья', 'шт'], ['Хумус', 'шт', 'veg vegan gf protein'],
    ['Суп готовый', 'шт'], ['Салат готовый', 'шт', 'veg']
  ] },
  { id: 'fish', group: 'food', label: 'Рыба и морепродукты', icon: '🐟', tone: 'bg-blue-50 dark:bg-blue-950/30', tags: 'gf protein keto', items: [
    ['Лосось', 'кг'], ['Треска', 'кг'], ['Креветки', 'уп', 'frozen'], ['Сельдь', 'шт'], ['Скумбрия', 'шт'], ['Кальмары', 'уп', 'frozen'],
    ['Крабовые палочки', 'уп', '-keto -gf']
  ] },
  { id: 'frozen', group: 'food', label: 'Заморозка', icon: '🧊', tone: 'bg-cyan-50 dark:bg-cyan-950/30', tags: 'frozen', items: [
    ['Овощи замороженные', 'уп', 'veg vegan gf'], ['Ягоды замороженные', 'уп', 'veg vegan gf'], ['Мороженое', 'шт', 'veg gf'],
    ['Картофель фри', 'уп', 'veg vegan gf'], ['Наггетсы', 'уп', 'protein']
  ] },
  { id: 'canned', group: 'food', label: 'Консервы и соусы', icon: '🥫', tone: 'bg-red-50 dark:bg-red-950/30', tags: 'veg vegan gf', items: [
    ['Томатная паста', 'шт'], ['Томаты консервированные', 'шт'], ['Кукуруза консервированная', 'шт'], ['Горошек консервированный', 'шт'],
    ['Фасоль консервированная', 'шт', 'protein'], ['Огурцы маринованные', 'шт'], ['Тунец консервированный', 'шт', '-veg -vegan protein keto'],
    ['Оливки', 'шт', 'keto'], ['Кетчуп', 'шт'], ['Майонез', 'шт', '-vegan keto'], ['Горчица', 'шт', 'keto'], ['Соевый соус', 'шт', '-gf']
  ] },
  { id: 'meat', group: 'food', label: 'Мясо и птица', icon: '🍗', tone: 'bg-pink-50 dark:bg-pink-950/30', tags: 'gf protein keto', items: [
    ['Куриное филе', 'кг'], ['Куриные бёдра', 'кг'], ['Фарш', 'кг'], ['Свинина', 'кг'], ['Говядина', 'кг'], ['Индейка', 'кг'],
    ['Бекон', 'уп'], ['Колбаса', 'шт'], ['Сосиски', 'уп'], ['Ветчина', 'уп']
  ] },
  { id: 'spices', group: 'food', label: 'Специи и масло', icon: '🧂', tone: 'bg-stone-100 dark:bg-stone-900/40', tags: 'veg vegan gf', items: [
    ['Соль', 'шт'], ['Перец чёрный', 'шт'], ['Паприка', 'шт'], ['Лавровый лист', 'шт'], ['Масло подсолнечное', 'л', 'keto'],
    ['Масло оливковое', 'л', 'keto'], ['Уксус', 'шт'], ['Мёд', 'шт', '-vegan']
  ] },
  { id: 'drinks', group: 'food', label: 'Напитки', icon: '🧃', tone: 'bg-lime-50 dark:bg-lime-950/30', tags: 'veg vegan gf', items: [
    ['Вода', 'л'], ['Сок', 'л'], ['Чай', 'уп'], ['Кофе', 'уп'], ['Газировка', 'л'], ['Пиво', 'л', '-gf'], ['Вино', 'шт']
  ] },
  { id: 'snacks', group: 'food', label: 'Сладости и снеки', icon: '🍫', tone: 'bg-fuchsia-50 dark:bg-fuchsia-950/30', tags: 'veg', items: [
    ['Шоколад', 'шт', 'gf'], ['Печенье', 'уп'], ['Чипсы', 'уп', 'vegan gf'], ['Орехи', 'уп', 'vegan gf keto protein'],
    ['Сухофрукты', 'уп', 'vegan gf'], ['Конфеты', 'уп'], ['Мюсли', 'уп']
  ] },
  { id: 'household', group: 'home', label: 'Бытовая химия', icon: '🧽', tone: 'bg-violet-50 dark:bg-violet-950/30', tags: '', items: [
    ['Средство для посуды', 'шт'], ['Таблетки для посудомойки', 'уп'], ['Стиральный порошок', 'уп'], ['Губки', 'уп'], ['Мусорные пакеты', 'уп'],
    ['Бумажные полотенца', 'уп'], ['Туалетная бумага', 'уп'], ['Фольга', 'шт'], ['Пищевая плёнка', 'шт']
  ] },
  { id: 'hygiene', group: 'home', label: 'Гигиена', icon: '🧴', tone: 'bg-teal-50 dark:bg-teal-950/30', tags: '', items: [
    ['Зубная паста', 'шт'], ['Зубная щётка', 'шт'], ['Шампунь', 'шт'], ['Гель для душа', 'шт'], ['Мыло', 'шт'], ['Дезодорант', 'шт'], ['Ватные диски', 'уп']
  ] },
  { id: 'pets', group: 'home', label: 'Для животных', icon: '🐾', tone: 'bg-orange-50 dark:bg-orange-950/30', tags: '', items: [
    ['Корм для кошек', 'уп'], ['Корм для собак', 'уп'], ['Наполнитель', 'уп']
  ] }
];

// «Прочее» — для товаров, которым не нашёлся отдел
PICKER_CATALOG.push({ id: 'other', group: 'home', label: OTHER_CATEGORY.label, icon: OTHER_CATEGORY.icon, tone: 'bg-slate-50 dark:bg-zinc-800/40', tags: '', items: [] });
const PICKER_CAT_BY_ID = new Map(PICKER_CATALOG.map(c => [c.id, c]));

// Встроенный каталог (для первичного заполнения базы товаров): { name, unit, cat: id, tags: [] }
const BUILTIN_PRODUCTS = (() => {
  const out = [];
  PICKER_CATALOG.forEach(cat => cat.items.forEach(([name, unit, extra = '']) => {
    const tags = new Set(cat.tags.split(' ').filter(Boolean));
    extra.split(' ').filter(Boolean).forEach(t => t.startsWith('-') ? tags.delete(t.slice(1)) : tags.add(t));
    out.push({ name, unit, tags: [...tags], cat: cat.id });
  }));
  return out;
})();

// Плоский справочник для окна подбора — строится из базы товаров (src/products.ts): { name, unit, tags:Set, cat }
const PICKER_PRODUCTS = [];
const pickerKey = (name) => String(name || '').trim().toLowerCase().replace(/ё/g, 'е');
const PICKER_BY_NAME = new Map();
function rebuildPickerProducts() {
  PICKER_PRODUCTS.length = 0;
  PICKER_BY_NAME.clear();
  (state.products || []).forEach(p => {
    const entry = { name: p.name, unit: p.unit, tags: new Set(p.tags || []), cat: PICKER_CAT_BY_ID.get(p.cat) || PICKER_CAT_BY_ID.get('other'), product: p };
    PICKER_PRODUCTS.push(entry);
    PICKER_BY_NAME.set(pickerKey(p.name), entry);
  });
}
// Иконки отдельных продуктов (иначе берётся иконка категории)
const PICKER_EMOJI = {
  'помидоры': '🍅', 'помидоры черри': '🍅', 'огурцы': '🥒', 'огурцы маринованные': '🥒', 'картофель': '🥔', 'лук': '🧅', 'лук красный': '🧅',
  'морковь': '🥕', 'чеснок': '🧄', 'капуста': '🥬', 'капуста квашеная': '🥬', 'салат': '🥬', 'перец болгарский': '🫑', 'брокколи': '🥦',
  'грибы': '🍄', 'зелень': '🌿', 'базилик': '🌿', 'кабачки': '🥒', 'свекла': '🟣', 'кукуруза консервированная': '🌽', 'яблоки': '🍎',
  'бананы': '🍌', 'апельсины': '🍊', 'лимоны': '🍋', 'авокадо': '🥑', 'виноград': '🍇', 'ягоды': '🫐', 'ягоды замороженные': '🫐',
  'хлеб': '🍞', 'батон': '🥖', 'круассаны': '🥐', 'лаваш': '🫓', 'тортильи': '🫓', 'булочки': '🥯', 'молоко': '🥛', 'кефир': '🥛',
  'йогурт': '🥣', 'сыр': '🧀', 'моцарелла': '🧀', 'пармезан': '🧀', 'фета': '🧀', 'масло сливочное': '🧈', 'яйца': '🥚', 'рис': '🍚',
  'рис для ризотто': '🍚', 'макароны': '🍝', 'спагетти': '🍝', 'листы для лазаньи': '🍝', 'фасоль': '🫘', 'фасоль консервированная': '🫘',
  'нут': '🫘', 'чечевица': '🫘', 'пельмени': '🥟', 'вареники': '🥟', 'пицца': '🍕', 'лосось': '🐟', 'треска': '🐟', 'сельдь': '🐟',
  'скумбрия': '🐟', 'креветки': '🦐', 'кальмары': '🦑', 'тунец консервированный': '🐟', 'куриное филе': '🍗', 'куриные бедра': '🍗',
  'фарш': '🥩', 'свинина': '🥩', 'говядина': '🥩', 'индейка': '🦃', 'бекон': '🥓', 'колбаса': '🌭', 'сосиски': '🌭', 'ветчина': '🍖',
  'соль': '🧂', 'мед': '🍯', 'масло подсолнечное': '🫗', 'масло оливковое': '🫒', 'оливки': '🫒', 'вода': '💧', 'сок': '🧃', 'чай': '🍵',
  'кофе': '☕', 'пиво': '🍺', 'вино': '🍷', 'вино белое': '🥂', 'газировка': '🥤', 'шоколад': '🍫', 'шоколад для выпечки': '🍫',
  'печенье': '🍪', 'чипсы': '🍟', 'картофель фри': '🍟', 'орехи': '🥜', 'конфеты': '🍬', 'мороженое': '🍦', 'мука': '🌾', 'сахар': '🍬',
  'кетчуп': '🥫', 'майонез': '🥫', 'горчица': '🌭', 'туалетная бумага': '🧻', 'бумажные полотенца': '🧻', 'губки': '🧽', 'мыло': '🧼',
  'зубная паста': '🪥', 'зубная щетка': '🪥', 'корм для кошек': '🐈', 'корм для собак': '🐕', 'имбирь': '🫚', 'кокосовое молоко': '🥥'
};
// «Бананы Эквадор» -> 🍌, «Филе индейки охлаждённое» -> 🦃: ищем ключ (или его основу) с начала слова, длинные ключи первыми
const PICKER_EMOJI_KEYS = Object.keys(PICKER_EMOJI).sort((x, y) => y.length - x.length)
  .map(key => ({ key, re: new RegExp('(^|[\\s(«"-])' + (key.length > 4 ? key.slice(0, -1) : key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }));
function pickerIconFor(name) {
  const k = pickerKey(name);
  if (PICKER_EMOJI[k]) return PICKER_EMOJI[k];
  const hit = PICKER_EMOJI_KEYS.find(e => e.re.test(k));
  if (hit) return PICKER_EMOJI[hit.key];
  const exact = PICKER_BY_NAME.get(k);
  if (exact) return exact.cat.icon;
  const partial = PICKER_PRODUCTS.find(p => k.includes(pickerKey(p.name)) || pickerKey(p.name).includes(k));
  return partial ? partial.cat.icon : '🛒';
}

const PICKER_DEFAULT_POPULAR = ['Молоко', 'Хлеб', 'Яйца', 'Бананы', 'Помидоры', 'Огурцы', 'Сыр', 'Куриное филе', 'Картофель', 'Лук',
  'Масло сливочное', 'Йогурт', 'Яблоки', 'Вода', 'Кофе', 'Туалетная бумага', 'Макароны', 'Рис', 'Сметана', 'Творог'];

// База рецептов на 4 порции (работает без ИИ). keys — варианты названия блюда.
const PICKER_RECIPES = [
  { name: 'Борщ', keys: ['борщ'], items: [['Свёкла', 2, 'шт'], ['Капуста', 0.5, 'шт'], ['Картофель', 0.5, 'кг'], ['Морковь', 1, 'шт'], ['Лук', 1, 'шт'], ['Говядина', 0.5, 'кг'], ['Томатная паста', 1, 'шт'], ['Чеснок', 1, 'шт'], ['Сметана', 1, 'шт'], ['Зелень', 1, 'уп'], ['Лавровый лист', 1, 'шт']] },
  { name: 'Щи', keys: ['щи'], items: [['Капуста', 0.5, 'шт'], ['Картофель', 0.4, 'кг'], ['Морковь', 1, 'шт'], ['Лук', 1, 'шт'], ['Говядина', 0.5, 'кг'], ['Томатная паста', 1, 'шт'], ['Зелень', 1, 'уп'], ['Сметана', 1, 'шт']] },
  { name: 'Солянка', keys: ['солянка'], items: [['Колбаса', 1, 'шт'], ['Ветчина', 1, 'уп'], ['Сосиски', 1, 'уп'], ['Огурцы маринованные', 1, 'шт'], ['Оливки', 1, 'шт'], ['Томатная паста', 1, 'шт'], ['Лук', 1, 'шт'], ['Лимоны', 1, 'шт'], ['Сметана', 1, 'шт']] },
  { name: 'Уха', keys: ['уха', 'рыбный суп'], items: [['Лосось', 0.5, 'кг'], ['Картофель', 0.5, 'кг'], ['Морковь', 1, 'шт'], ['Лук', 1, 'шт'], ['Зелень', 1, 'уп'], ['Лавровый лист', 1, 'шт'], ['Перец чёрный', 1, 'шт']] },
  { name: 'Окрошка', keys: ['окрошка'], items: [['Картофель', 0.5, 'кг'], ['Огурцы', 0.4, 'кг'], ['Редис', 1, 'уп'], ['Яйца', 4, 'шт'], ['Колбаса', 1, 'шт'], ['Зелень', 1, 'уп'], ['Кефир', 1, 'л'], ['Сметана', 1, 'шт']] },
  { name: 'Плов', keys: ['плов'], items: [['Рис', 0.5, 'кг'], ['Говядина', 0.6, 'кг'], ['Морковь', 0.5, 'кг'], ['Лук', 2, 'шт'], ['Чеснок', 1, 'шт'], ['Масло подсолнечное', 0.1, 'л'], ['Специи для плова', 1, 'уп']] },
  { name: 'Паста карбонара', keys: ['карбонара'], items: [['Спагетти', 1, 'уп'], ['Бекон', 1, 'уп'], ['Яйца', 4, 'шт'], ['Пармезан', 1, 'шт'], ['Перец чёрный', 1, 'шт']] },
  { name: 'Паста болоньезе', keys: ['болоньезе', 'болоньеза', 'болонез'], items: [['Спагетти', 1, 'уп'], ['Фарш', 0.5, 'кг'], ['Томаты консервированные', 2, 'шт'], ['Лук', 1, 'шт'], ['Морковь', 1, 'шт'], ['Чеснок', 1, 'шт'], ['Пармезан', 1, 'шт']] },
  { name: 'Лазанья', keys: ['лазанья', 'лазания'], items: [['Листы для лазаньи', 1, 'уп'], ['Фарш', 0.5, 'кг'], ['Томаты консервированные', 2, 'шт'], ['Лук', 1, 'шт'], ['Морковь', 1, 'шт'], ['Молоко', 0.5, 'л'], ['Мука', 0.1, 'кг'], ['Масло сливочное', 1, 'шт'], ['Сыр', 1, 'уп']] },
  { name: 'Ризотто с грибами', keys: ['ризотто'], items: [['Рис для ризотто', 0.3, 'кг'], ['Грибы', 0.3, 'кг'], ['Лук', 1, 'шт'], ['Бульон', 1, 'уп'], ['Вино белое', 1, 'шт'], ['Пармезан', 1, 'шт'], ['Масло сливочное', 1, 'шт']] },
  { name: 'Пицца Маргарита', keys: ['пицца', 'маргарита'], items: [['Мука', 0.4, 'кг'], ['Дрожжи', 1, 'уп'], ['Томаты консервированные', 1, 'шт'], ['Моцарелла', 2, 'шт'], ['Базилик', 1, 'уп'], ['Масло оливковое', 0.05, 'л']] },
  { name: 'Салат Оливье', keys: ['оливье'], items: [['Картофель', 0.5, 'кг'], ['Морковь', 2, 'шт'], ['Яйца', 4, 'шт'], ['Колбаса', 1, 'шт'], ['Огурцы маринованные', 1, 'шт'], ['Горошек консервированный', 1, 'шт'], ['Майонез', 1, 'шт'], ['Лук', 1, 'шт']] },
  { name: 'Салат Цезарь', keys: ['цезарь'], items: [['Куриное филе', 0.4, 'кг'], ['Салат', 1, 'шт'], ['Помидоры черри', 1, 'уп'], ['Пармезан', 1, 'шт'], ['Батон', 1, 'шт'], ['Чеснок', 1, 'шт'], ['Соус Цезарь', 1, 'шт']] },
  { name: 'Греческий салат', keys: ['греческий'], items: [['Помидоры', 0.5, 'кг'], ['Огурцы', 0.4, 'кг'], ['Перец болгарский', 1, 'шт'], ['Лук красный', 1, 'шт'], ['Фета', 1, 'шт'], ['Оливки', 1, 'шт'], ['Масло оливковое', 0.05, 'л']] },
  { name: 'Винегрет', keys: ['винегрет'], items: [['Свёкла', 2, 'шт'], ['Картофель', 0.4, 'кг'], ['Морковь', 2, 'шт'], ['Огурцы маринованные', 1, 'шт'], ['Капуста квашеная', 1, 'уп'], ['Горошек консервированный', 1, 'шт'], ['Масло подсолнечное', 0.05, 'л'], ['Лук', 1, 'шт']] },
  { name: 'Блины', keys: ['блины', 'блинчики'], items: [['Мука', 0.3, 'кг'], ['Молоко', 0.5, 'л'], ['Яйца', 2, 'шт'], ['Сахар', 0.05, 'кг'], ['Масло подсолнечное', 0.05, 'л'], ['Соль', 1, 'шт']] },
  { name: 'Сырники', keys: ['сырники'], items: [['Творог', 0.5, 'кг'], ['Яйца', 2, 'шт'], ['Мука', 0.1, 'кг'], ['Сахар', 0.05, 'кг'], ['Сметана', 1, 'шт']] },
  { name: 'Драники', keys: ['драники', 'деруны', 'картофельные оладьи'], items: [['Картофель', 1, 'кг'], ['Лук', 1, 'шт'], ['Яйца', 2, 'шт'], ['Мука', 0.05, 'кг'], ['Сметана', 1, 'шт'], ['Масло подсолнечное', 0.1, 'л']] },
  { name: 'Омлет', keys: ['омлет', 'яичница'], items: [['Яйца', 6, 'шт'], ['Молоко', 0.1, 'л'], ['Сыр', 1, 'уп'], ['Зелень', 1, 'уп'], ['Масло сливочное', 1, 'шт']] },
  { name: 'Шакшука', keys: ['шакшука'], items: [['Яйца', 4, 'шт'], ['Томаты консервированные', 2, 'шт'], ['Перец болгарский', 1, 'шт'], ['Лук', 1, 'шт'], ['Чеснок', 1, 'шт'], ['Паприка', 1, 'шт'], ['Зелень', 1, 'уп']] },
  { name: 'Гуляш', keys: ['гуляш'], items: [['Говядина', 0.6, 'кг'], ['Лук', 2, 'шт'], ['Паприка', 1, 'шт'], ['Томатная паста', 1, 'шт'], ['Картофель', 0.5, 'кг'], ['Морковь', 1, 'шт']] },
  { name: 'Котлеты', keys: ['котлеты', 'тефтели'], items: [['Фарш', 0.6, 'кг'], ['Лук', 1, 'шт'], ['Яйца', 1, 'шт'], ['Батон', 1, 'шт'], ['Молоко', 0.1, 'л'], ['Сухари панировочные', 1, 'уп']] },
  { name: 'Курица карри', keys: ['карри'], items: [['Куриное филе', 0.6, 'кг'], ['Рис', 0.3, 'кг'], ['Кокосовое молоко', 1, 'шт'], ['Паста карри', 1, 'шт'], ['Лук', 1, 'шт'], ['Чеснок', 1, 'шт'], ['Имбирь', 1, 'шт']] },
  { name: 'Пельмени домашние', keys: ['пельмени'], items: [['Мука', 0.5, 'кг'], ['Фарш', 0.5, 'кг'], ['Лук', 1, 'шт'], ['Яйца', 1, 'шт'], ['Сметана', 1, 'шт']] },
  { name: 'Овсяная каша', keys: ['овсянка', 'овсяная каша', 'каша'], items: [['Овсянка', 1, 'уп'], ['Молоко', 1, 'л'], ['Масло сливочное', 1, 'шт'], ['Ягоды', 1, 'уп'], ['Мёд', 1, 'шт']] }
];
const PICKER_DISH_CHIPS = ['Борщ', 'Плов', 'Карбонара', 'Оливье', 'Блины', 'Цезарь', 'Шакшука', 'Лазанья', 'Сырники', 'Гуляш'];

const picker = {
  listId: '', tab: 'popular', category: null, tag: null, query: '',
  selected: new Map(), // key -> { name, qty, unit, desc }
  recipe: { dish: '', servings: 4, title: '', items: [], baseItems: [], baseServings: 4, source: '', loading: false, error: '' }
};

function pickerTargetList() {
  return state.lists.find(l => l.id === picker.listId) || state.lists[0] || null;
}
function pickerInListKeys() {
  const list = pickerTargetList();
  return new Set((list?.items || []).filter(i => !i.checked).map(i => pickerKey(i.name)));
}

function openPicker(listId, tab = 'popular') {
  picker.listId = listId || ensureMainList().id;
  picker.tab = tab;
  picker.category = null;
  picker.tag = null;
  picker.query = '';
  picker.selected.clear();
  const search = document.getElementById('pickerSearchInput');
  if (search) search.value = '';
  const sel = document.getElementById('pickerListSelect');
  if (sel) {
    sel.innerHTML = state.lists.length
      ? state.lists.map(l => `<option class="text-zinc-900" value="${escapeHTML(l.id)}" ${l.id === picker.listId ? 'selected' : ''}>${escapeHTML(l.title)}</option>`).join('')
      : '<option class="text-zinc-900" value="">Новый список «Покупки»</option>';
  }
  renderPicker();
  openModal('addPickerModal');
  if (tab === 'recipe') setTimeout(() => document.getElementById('pickerDishInput')?.focus(), 50);
}

function pickerTile(p, inList, extra = '') {
  const key = pickerKey(p.name);
  const on = picker.selected.has(key);
  return `
    <button type="button" data-pk-toggle="${escapeHTML(p.name)}" data-pk-unit="${escapeHTML(p.unit || 'шт')}" data-pk-qty="${Number(p.qty) || 1}"
      class="relative text-left p-2.5 rounded-2xl border-2 transition active:scale-[0.98] flex items-center gap-2 min-h-[52px] ${on
        ? 'border-amber-500 bg-amber-50 dark:bg-amber-500/15'
        : 'border-transparent bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200/80 dark:hover:bg-zinc-700'}">
      <span class="text-xl leading-none shrink-0">${p.icon || pickerIconFor(p.name)}</span>
      <span class="flex-1 min-w-0">
        <span class="block text-xs sm:text-sm font-bold leading-tight break-words">${escapeHTML(p.name)}</span>
        ${extra || inList ? `<span class="block text-[10px] text-slate-500 dark:text-zinc-400 truncate">${inList ? 'уже в списке' : ''}${extra && inList ? ' · ' : ''}${extra}</span>` : ''}
      </span>
      <span class="w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-xs font-extrabold ${on ? 'bg-amber-500 text-white' : 'bg-white dark:bg-zinc-900 text-slate-400'}">${on ? '✓' : '+'}</span>
    </button>`;
}
const pickerGrid = (html) => `<div class="grid grid-cols-2 gap-2">${html}</div>`;
const pickerHeading = (text) => `<div class="text-[11px] font-extrabold uppercase tracking-wide text-slate-500 dark:text-zinc-400 px-1">${text}</div>`;
const pickerEmpty = (text) => `<div class="text-center text-sm text-slate-500 dark:text-zinc-400 py-10 px-4">${text}</div>`;

function renderPickerSearch(inList) {
  const q = pickerKey(picker.query);
  const seen = new Set();
  const results = [];
  const push = (p) => { const k = pickerKey(p.name); if (!seen.has(k) && k.includes(q)) { seen.add(k); results.push(p); } };
  getUnifiedCatalog().forEach(push);
  PICKER_PRODUCTS.forEach(push);
  const exact = results.some(r => pickerKey(r.name) === q);
  const custom = exact ? '' : pickerTile({ name: picker.query.trim(), unit: 'шт', icon: '➕' }, false, 'свой товар');
  return pickerHeading('Результаты поиска') + pickerGrid(custom + results.slice(0, 40).map(p => pickerTile(p, inList.has(pickerKey(p.name)))).join(''));
}

function renderPickerPopular(inList) {
  const stats = computeFrequentStats().slice(0, 24);
  let html = '';
  if (stats.length) {
    html += pickerHeading('Вы часто покупаете') + pickerGrid(stats.map(s =>
      pickerTile({ name: s.name, unit: s.unit, qty: s.defaultQty }, inList.has(pickerKey(s.name)), `${s.times}×${s.avgPrice ? ' · ~' + formatMoney(s.avgPrice) : ''}`)).join(''));
  }
  const shown = new Set(stats.map(s => pickerKey(s.name)));
  const defaults = PICKER_DEFAULT_POPULAR.filter(n => !shown.has(pickerKey(n))).map(n => PICKER_BY_NAME.get(pickerKey(n)) || { name: n, unit: 'шт' });
  if (defaults.length) html += pickerHeading('Популярное у всех') + pickerGrid(defaults.map(p => pickerTile(p, inList.has(pickerKey(p.name)))).join(''));
  return html;
}

function renderPickerCatalog(inList) {
  if (picker.category) {
    const cat = PICKER_CATALOG.find(c => c.id === picker.category);
    if (!cat) { picker.category = null; return renderPickerCatalog(inList); }
    const items = PICKER_PRODUCTS.filter(p => p.cat === cat);
    return `<div class="flex items-center gap-2 px-1"><span class="text-2xl">${cat.icon}</span><span class="text-base font-extrabold">${escapeHTML(cat.label)}</span></div>`
      + pickerGrid(items.map(p => pickerTile(p, inList.has(pickerKey(p.name)))).join(''));
  }
  if (picker.tag) {
    const tag = PICKER_TAGS.find(t => t.id === picker.tag);
    const items = PICKER_PRODUCTS.filter(p => p.tags.has(picker.tag));
    return `<div class="flex items-center gap-2 px-1"><span class="text-2xl">${tag?.icon || ''}</span><span class="text-base font-extrabold">${escapeHTML(tag?.label || '')}</span></div>`
      + pickerGrid(items.map(p => pickerTile(p, inList.has(pickerKey(p.name)))).join(''));
  }
  const chips = PICKER_TAGS.map(t => `
    <button type="button" data-pk-tag="${t.id}" class="flex items-center gap-2.5 px-3 py-2.5 rounded-2xl bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200/80 dark:hover:bg-zinc-700 text-left text-xs sm:text-sm font-bold">
      <span class="text-lg leading-none">${t.icon}</span><span class="truncate">${t.label}</span>
    </button>`).join('');
  const tiles = (group) => PICKER_CATALOG.filter(c => c.group === group).map(c => `
    <button type="button" data-pk-cat="${c.id}" class="aspect-square sm:aspect-auto sm:h-28 p-2 rounded-2xl ${c.tone} hover:brightness-95 active:scale-[0.98] flex flex-col items-center justify-center gap-1.5 text-center">
      <span class="text-3xl sm:text-4xl leading-none">${c.icon}</span>
      <span class="text-[11px] sm:text-xs font-bold leading-tight line-clamp-2">${c.label}</span>
    </button>`).join('');
  return `<div class="grid grid-cols-2 gap-2">${chips}</div>`
    + pickerHeading('Еда') + `<div class="grid grid-cols-3 gap-2">${tiles('food')}</div>`
    + pickerHeading('Для дома') + `<div class="grid grid-cols-3 gap-2">${tiles('home')}</div>`;
}

function renderPickerRecent(inList) {
  const map = new Map();
  [...state.recent].sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).forEach(i => {
    const k = pickerKey(i.name);
    if (i.name && !map.has(k)) map.set(k, { name: i.name, unit: i.unit, qty: i.qty, date: i.date });
  });
  state.lists.forEach(l => l.items.filter(i => i.checked).forEach(i => {
    const k = pickerKey(i.name);
    if (i.name && !map.has(k)) map.set(k, { name: i.name, unit: i.unit, qty: i.qty, date: '' });
  }));
  const items = [...map.values()].slice(0, 60);
  if (!items.length) return pickerEmpty('Здесь появятся купленные товары — отмечайте их в списках или добавляйте чеки.');
  const fmt = (d) => { try { return d ? new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : 'куплено'; } catch (e) { return ''; } };
  return pickerHeading('Недавно купленные') + pickerGrid(items.map(p => pickerTile(p, inList.has(pickerKey(p.name)), fmt(p.date))).join(''));
}

function renderPickerRecipe(inList) {
  const r = picker.recipe;
  const chips = PICKER_DISH_CHIPS.map(d => `<button type="button" data-pk-dish="${escapeHTML(d)}" class="px-3 py-1.5 rounded-full bg-slate-100 dark:bg-zinc-800 hover:bg-amber-100 dark:hover:bg-amber-500/20 text-xs font-semibold shrink-0">${escapeHTML(d)}</button>`).join('');
  let html = `
    <div class="space-y-2.5">
      <div class="flex gap-2">
        <input type="text" id="pickerDishInput" value="${escapeHTML(r.dish)}" autocomplete="off" placeholder="Блюдо: борщ, паста, торт Наполеон…" class="flex-1 min-w-0 h-11 px-3 rounded-xl bg-slate-100 dark:bg-zinc-800 text-sm font-semibold outline-none focus:ring-2 focus:ring-amber-400" />
        <button type="button" id="pickerDishGoBtn" class="h-11 px-4 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-sm font-extrabold shrink-0">Подобрать</button>
      </div>
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-semibold text-slate-500 dark:text-zinc-400">Порций</span>
        <div class="flex items-center gap-1 bg-slate-100 dark:bg-zinc-800 rounded-xl p-1">
          <button type="button" data-pk-servings="-1" class="w-8 h-8 rounded-lg hover:bg-white dark:hover:bg-zinc-700 font-extrabold">−</button>
          <span class="w-8 text-center font-extrabold text-sm">${r.servings}</span>
          <button type="button" data-pk-servings="1" class="w-8 h-8 rounded-lg hover:bg-white dark:hover:bg-zinc-700 font-extrabold">+</button>
        </div>
      </div>
      <div class="flex gap-1.5 overflow-x-auto no-scrollbar pb-1">${chips}</div>
    </div>`;
  if (r.loading) return html + `<div class="py-10 text-center text-sm text-slate-500"><span class="inline-block animate-spin mr-2">⏳</span>Составляем список продуктов…</div>`;
  if (r.error) html += `<div class="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-300 text-xs font-semibold">${escapeHTML(r.error)}</div>`;
  if (!r.items.length) return html + (r.error ? '' : pickerEmpty('Введите блюдо — предложим продукты, которые нужно купить. Уже имеющиеся в списке не отмечаются.'));
  const allOn = r.items.every(it => picker.selected.has(pickerKey(it.name)));
  html += `
    <div class="flex items-center justify-between gap-2 px-1">
      <div class="min-w-0">
        <div class="text-base font-extrabold truncate">${escapeHTML(r.title)}</div>
        <div class="text-[11px] text-slate-500 dark:text-zinc-400">${r.servings} порц. · ${r.items.length} продуктов · ${r.source === 'ai' ? 'составлено ИИ' : 'база рецептов'}</div>
      </div>
      <button type="button" id="pickerRecipeAllBtn" class="text-xs font-bold text-amber-600 hover:underline shrink-0">${allOn ? 'Снять все' : 'Выбрать все'}</button>
    </div>`;
  html += `<div class="space-y-1.5">${r.items.map(it => {
    const key = pickerKey(it.name);
    const on = picker.selected.has(key);
    return `
      <button type="button" data-pk-toggle="${escapeHTML(it.name)}" data-pk-unit="${escapeHTML(it.unit)}" data-pk-qty="${it.qty}" data-pk-desc="${escapeHTML('Для: ' + r.title)}"
        class="w-full flex items-center gap-3 p-2.5 rounded-xl border-2 text-left ${on ? 'border-amber-500 bg-amber-50 dark:bg-amber-500/15' : 'border-transparent bg-slate-100 dark:bg-zinc-800'}">
        <span class="w-6 h-6 rounded-lg shrink-0 flex items-center justify-center text-xs font-extrabold ${on ? 'bg-amber-500 text-white' : 'bg-white dark:bg-zinc-900 text-slate-300'}">${on ? '✓' : ''}</span>
        <span class="text-lg leading-none shrink-0">${pickerIconFor(it.name)}</span>
        <span class="flex-1 min-w-0 text-sm font-bold break-words">${escapeHTML(it.name)}${inList.has(key) ? ' <span class="text-[10px] font-semibold text-slate-500">· уже в списке</span>' : ''}</span>
        <span class="text-xs font-semibold text-slate-500 dark:text-zinc-400 shrink-0">${it.qty} ${escapeHTML(it.unit)}</span>
      </button>`;
  }).join('')}</div>`;
  return html;
}

function renderPicker() {
  document.querySelectorAll('#pickerTabs .picker-tab').forEach(btn => {
    const active = btn.dataset.pkTab === picker.tab;
    btn.classList.toggle('border-white', active);
    btn.classList.toggle('border-transparent', !active);
    btn.classList.toggle('opacity-75', !active);
  });
  const drilled = picker.tab === 'catalog' && (picker.category || picker.tag) && !picker.query;
  document.getElementById('pickerBackBtn')?.classList.toggle('hidden', !drilled);
  document.getElementById('pickerSearchWrap')?.classList.toggle('hidden', picker.tab === 'recipe');
  const inList = pickerInListKeys();
  let html;
  if (picker.query.trim() && picker.tab !== 'recipe') html = renderPickerSearch(inList);
  else if (picker.tab === 'catalog') html = renderPickerCatalog(inList);
  else if (picker.tab === 'recent') html = renderPickerRecent(inList);
  else if (picker.tab === 'recipe') html = renderPickerRecipe(inList);
  else html = renderPickerPopular(inList);
  const body = document.getElementById('pickerBody');
  if (body) body.innerHTML = html;
  const n = picker.selected.size;
  const label = document.getElementById('pickerDoneLabel');
  if (label) label.textContent = n ? `Добавить ${n}` : 'Готово';
}

function pickerGoBack() {
  if (picker.tab === 'catalog' && (picker.category || picker.tag) && !picker.query) {
    picker.category = null;
    picker.tag = null;
    renderPicker();
    document.getElementById('pickerBody').scrollTop = 0;
    return true;
  }
  return false;
}
setBackHandler(pickerGoBack); // кнопка «Назад» Android (native.ts)

function scaleRecipeQty(qty, unit, factor) {
  const v = qty * factor;
  if (unit === 'г' || unit === 'мл') return Math.max(10, Math.round(v / 10) * 10);
  if (unit === 'кг' || unit === 'л') return Math.max(0.05, Math.round(v * 20) / 20);
  if (unit === 'уп') return Math.max(1, Math.ceil(v - 0.25));
  // штуки: половинки только для «полкочана», иначе целые (1.5 луковицы -> 2)
  if (qty < 1) return Math.max(0.5, Math.round(v * 2) / 2);
  return Math.max(1, Math.ceil(v - 0.2));
}

function findLocalRecipe(dish) {
  const q = pickerKey(dish);
  if (!q) return null;
  return PICKER_RECIPES.find(r => r.keys.some(k => q.includes(pickerKey(k)) || (q.length >= 4 && pickerKey(k).includes(q)))) || null;
}

// Пересчёт количеств под выбранное число порций (без повторного запроса к ИИ)
function rescalePickerRecipe() {
  const r = picker.recipe;
  const f = r.servings / (r.baseServings || 4);
  r.items = r.baseItems.map(it => ({ ...it, qty: f === 1 ? it.qty : scaleRecipeQty(it.qty, it.unit, f) }));
  r.items.forEach(it => {
    const sel = picker.selected.get(pickerKey(it.name));
    if (sel && sel.fromRecipe) sel.qty = it.qty;
  });
}

async function runPickerRecipe(dishRaw, preferAi = false) {
  const dish = (dishRaw || '').trim();
  const r = picker.recipe;
  r.dish = dish;
  r.error = '';
  if (!dish) { r.items = []; r.baseItems = []; renderPicker(); return; }
  const applyItems = (title, baseItems, baseServings, source) => {
    r.title = title;
    r.source = source;
    r.baseItems = baseItems;
    r.baseServings = baseServings;
    rescalePickerRecipe();
    const inList = pickerInListKeys();
    // старые отметки рецепта снимаем, новые продукты отмечаем (кроме уже имеющихся в списке)
    [...picker.selected.entries()].forEach(([k, v]) => { if (v.fromRecipe) picker.selected.delete(k); });
    r.items.forEach(it => {
      const k = pickerKey(it.name);
      if (!inList.has(k)) picker.selected.set(k, { name: it.name, qty: it.qty, unit: it.unit, desc: 'Для: ' + title, fromRecipe: true });
    });
  };
  const local = !preferAi && findLocalRecipe(dish);
  if (local) {
    applyItems(local.name, local.items.map(([name, qty, unit]) => ({ name, unit, qty })), 4, 'local');
    renderPicker();
    return;
  }
  r.loading = true;
  renderPicker();
  try {
    const res = await askGeminiWithBackoff({
      contents: [{ parts: [{ text: `Составь список продуктов для покупки, чтобы приготовить блюдо «${dish}» на ${r.servings} порц. `
        + `Верни JSON: {"dish":"Название блюда","ingredients":[{"name":"Свёкла","qty":2,"unit":"шт"}]}. `
        + `Единицы только: шт, кг, г, л, мл, уп. Названия — как товар в магазине, по-русски, коротко, без способа нарезки. `
        + `Не включай воду. Если это не блюдо или напиток — верни {"dish":"","ingredients":[]}.` }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
    });
    const data = JSON.parse(res?.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
    const units = ['шт', 'кг', 'г', 'л', 'мл', 'уп'];
    const items = (Array.isArray(data.ingredients) ? data.ingredients : [])
      .filter(i => i && i.name)
      .map(i => ({ name: String(i.name).trim().replace(/^./, c => c.toUpperCase()), qty: Number(i.qty) > 0 ? Math.round(Number(i.qty) * 100) / 100 : 1, unit: units.includes(i.unit) ? i.unit : 'шт' }))
      .slice(0, 30);
    if (!items.length) {
      r.items = [];
      r.baseItems = [];
      r.error = `Не удалось разобрать «${dish}» как блюдо. Попробуйте уточнить название.`;
    } else {
      applyItems(String(data.dish || dish).trim() || dish, items, r.servings, 'ai');
    }
  } catch (e) {
    r.items = [];
    r.baseItems = [];
    const near = PICKER_RECIPES.map(x => x.name).slice(0, 6).join(', ');
    r.error = `Блюда нет во встроенной базе, а ИИ сейчас не ответил: нет ключа Gemini (меню ⋮), нет интернета или исчерпан бесплатный лимит ключа — попробуйте позже. Без ИИ доступны: ${near} и др.`;
  }
  r.loading = false;
  renderPicker();
}

function commitPicker() {
  if (!picker.selected.size) { closeModal('addPickerModal'); return; }
  const undo = makeStateUndo(['lists', 'priceHistory'], 'Добавление отменено');
  let list = pickerTargetList();
  if (!list) {
    list = { id: 'list-' + uniqueSuffix(), title: 'Покупки', color: '#ffffff', pinned: false, sortMode: 'manual', order: 0, collaborators: [], items: [] };
    normalizeCollaborators(list);
    state.lists.unshift(list);
  }
  const catalog = getUnifiedCatalog();
  const existing = new Set(list.items.filter(i => !i.checked).map(i => pickerKey(i.name)));
  let added = 0, skipped = 0;
  [...picker.selected.values()].reverse().forEach(sel => {
    const k = pickerKey(sel.name);
    if (existing.has(k)) { skipped++; return; }
    const match = catalog.find(c => pickerKey(c.name) === k);
    const storeName = match?.storeName || '';
    const unit = sel.unit || match?.unit || 'шт';
    const est = match?.price ? null : estimateItemPrice(sel.name, unit);
    list.items.unshift({
      id: 'pk-' + uniqueSuffix() + '-' + added,
      name: sel.name,
      qty: Number(sel.qty) || match?.qty || 1,
      unit,
      price: match?.price || est?.price || 0,
      priceEstimated: !!est?.estimated || (!!match?.price && !!match?.priceEstimated),
      storeName,
      productUrl: buildProductStoreUrl(sel.name, storeName, match?.productUrl || ''),
      cheaperAlt: null,
      desc: sel.desc || match?.desc || '',
      checked: false,
      order: 0
    });
    existing.add(k);
    added++;
  });
  list.items.forEach((it, idx) => { it.order = idx; });
  list.items.slice(0, added).forEach(it => upsertProduct(state.products || (state.products = []), it));
  if (added) rememberAdded(list.id, list.items[0].name);
  picker.selected.clear();
  saveState();
  closeModal('addPickerModal');
  showToast(`В «${list.title}» добавлено: ${added}${skipped ? ` (уже были: ${skipped})` : ''}`, added ? undo : null);
}

(function bindPicker() {
  const modal = document.getElementById('addPickerModal');
  if (!modal) return;
  modal.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('[data-pk-tab]');
    if (tabBtn) {
      picker.tab = tabBtn.dataset.pkTab;
      picker.category = null;
      picker.tag = null;
      renderPicker();
      document.getElementById('pickerBody').scrollTop = 0;
      if (picker.tab === 'recipe') setTimeout(() => document.getElementById('pickerDishInput')?.focus(), 50);
      return;
    }
    const tog = e.target.closest('[data-pk-toggle]');
    if (tog) {
      const name = tog.dataset.pkToggle;
      const k = pickerKey(name);
      if (picker.selected.has(k)) picker.selected.delete(k);
      else picker.selected.set(k, { name, qty: Number(tog.dataset.pkQty) || 1, unit: tog.dataset.pkUnit || 'шт', desc: tog.dataset.pkDesc || '', fromRecipe: !!tog.dataset.pkDesc });
      const scroll = document.getElementById('pickerBody').scrollTop;
      renderPicker();
      document.getElementById('pickerBody').scrollTop = scroll;
      return;
    }
    const cat = e.target.closest('[data-pk-cat]');
    if (cat) { picker.category = cat.dataset.pkCat; renderPicker(); document.getElementById('pickerBody').scrollTop = 0; return; }
    const tag = e.target.closest('[data-pk-tag]');
    if (tag) { picker.tag = tag.dataset.pkTag; renderPicker(); document.getElementById('pickerBody').scrollTop = 0; return; }
    const dishChip = e.target.closest('[data-pk-dish]');
    if (dishChip) { runPickerRecipe(dishChip.dataset.pkDish); return; }
    const serv = e.target.closest('[data-pk-servings]');
    if (serv) {
      picker.recipe.servings = Math.min(20, Math.max(1, picker.recipe.servings + Number(serv.dataset.pkServings)));
      if (picker.recipe.baseItems.length) rescalePickerRecipe();
      renderPicker();
      return;
    }
    if (e.target.closest('#pickerDishGoBtn')) { runPickerRecipe(document.getElementById('pickerDishInput')?.value); return; }
    if (e.target.closest('#pickerRecipeAllBtn')) {
      const r = picker.recipe;
      const allOn = r.items.every(it => picker.selected.has(pickerKey(it.name)));
      r.items.forEach(it => {
        const k = pickerKey(it.name);
        if (allOn) picker.selected.delete(k);
        else picker.selected.set(k, { name: it.name, qty: it.qty, unit: it.unit, desc: 'Для: ' + r.title, fromRecipe: true });
      });
      renderPicker();
      return;
    }
    if (e.target.closest('#pickerBackBtn')) { pickerGoBack(); return; }
    if (e.target.closest('#pickerDoneBtn')) { commitPicker(); return; }
  });
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'pickerDishInput') { e.preventDefault(); runPickerRecipe(e.target.value); }
    if (e.key === 'Enter' && e.target.id === 'pickerSearchInput') {
      e.preventDefault();
      const q = e.target.value.trim();
      if (!q) return;
      const k = pickerKey(q);
      if (!picker.selected.has(k)) {
        const known = PICKER_BY_NAME.get(k);
        picker.selected.set(k, { name: known?.name || q, qty: 1, unit: known?.unit || 'шт', desc: '' });
      }
      e.target.value = '';
      picker.query = '';
      renderPicker();
      showToast(`Отмечено: ${q}`);
    }
  });
  document.getElementById('pickerSearchInput')?.addEventListener('input', (e) => { picker.query = e.target.value; renderPicker(); });
  modal.addEventListener('input', (e) => { if (e.target.id === 'pickerDishInput') picker.recipe.dish = e.target.value; });
  document.getElementById('pickerListSelect')?.addEventListener('change', (e) => { picker.listId = e.target.value; renderPicker(); });
})();

function copyTextSafe(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
}

// ==================== GLOBAL CLICK DELEGATION ====================
document.addEventListener('click', (e) => {
  if (!e.target.closest('#moreMenuToggleBtn') && !e.target.closest('#moreMenuDropdown')) {
    document.getElementById('moreMenuDropdown')?.classList.add('hidden');
  }

  const openModalBtn = e.target.closest('[data-open-modal]');
  if (openModalBtn) {
    const mId = openModalBtn.dataset.openModal;
    if (mId === 'receiptModal') document.getElementById('receiptDateField').value = new Date().toISOString().split('T')[0];
    openModal(mId);
    return;
  }

  const closeModalBtn = e.target.closest('[data-close-modal]');
  if (closeModalBtn) { closeModal(closeModalBtn.dataset.closeModal); return; }

  if (e.target.classList.contains('modal-shell')) { e.target.classList.add('hidden'); return; }

  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) { switchActiveTab(tabBtn.dataset.tab); return; }

  const swatch = e.target.closest('.color-swatch');
  if (swatch) {
    state.newListColor = swatch.dataset.color;
    document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('border-2', 'border-amber-500'));
    swatch.classList.add('border-2', 'border-amber-500');
    return;
  }

  const radiusPreset = e.target.closest('[data-radius-preset]');
  if (radiusPreset) {
    const val = parseFloat(radiusPreset.dataset.radiusPreset);
    state.storeSearch.radiusKm = val;
    document.getElementById('storeRadiusSlider').value = val;
    document.getElementById('radiusValueLabel').textContent = `${val} км`;
    renderNearbyStoresList();
    initOrUpdateStoreMap();
    return;
  }

  const chainChip = e.target.closest('[data-chain]');
  if (chainChip) {
    state.storeSearch.chainFilter = chainChip.dataset.chain;
    document.querySelectorAll('.chain-chip').forEach(c => {
      c.className = c.dataset.chain === state.storeSearch.chainFilter
        ? 'chain-chip shrink-0 px-2.5 py-1 rounded-full bg-emerald-600 text-white text-xs font-bold'
        : 'chain-chip shrink-0 px-2.5 py-1 rounded-full bg-slate-100 dark:bg-zinc-800 text-xs font-semibold';
    });
    renderNearbyStoresList();
    initOrUpdateStoreMap();
    return;
  }

  const storeCard = e.target.closest('[data-select-store]');
  if (storeCard) {
    state.storeSearch.selectedStoreId = storeCard.dataset.selectStore;
    renderNearbyStoresList();
    initOrUpdateStoreMap();
    return;
  }

  const phPeriodBtn = e.target.closest('[data-ph-period]');
  if (phPeriodBtn) {
    state.priceHistoryPeriod = phPeriodBtn.dataset.phPeriod;
    const ctx = phPeriodBtn.dataset.phCtx;
    if (ctx === 'modal') document.getElementById('modalPriceHistoryContent').innerHTML = buildProductPriceHistoryHTML(state.selectedHistoryProduct, 'modal');
    else document.getElementById('embeddedPriceHistoryContainer').innerHTML = buildProductPriceHistoryHTML(state.selectedHistoryProduct, 'embedded');
    return;
  }

  const remCollabBtn = e.target.closest('[data-remove-collab]');
  if (remCollabBtn) {
    const list = state.lists.find(l => l.id === document.getElementById('collabTargetListId').value);
    const idx = parseInt(remCollabBtn.dataset.removeCollab, 10);
    if (list && idx > 0 && list.collaborators[idx]) {
      const targetListId = list.id;
      const removed = structuredClone(list.collaborators[idx]);
      list.collaborators.splice(idx, 1);
      renderCollabMembers(list);
      saveState();
      showToast(`Участник «${removed.name}» удалён`, () => {
        const targetList = state.lists.find(l => l.id === targetListId);
        if (!targetList) return;
        if (!targetList.collaborators.some(c => c.id === removed.id)) {
          targetList.collaborators.splice(Math.min(idx, targetList.collaborators.length), 0, removed);
          if (document.getElementById('collabTargetListId')?.value === targetListId) renderCollabMembers(targetList);
          saveState();
          showToast('Участник восстановлен');
        }
      });
    }
    return;
  }

  const copyMemberInvite = e.target.closest('[data-copy-member-invite]');
  if (copyMemberInvite) {
    const list = state.lists.find(l => l.id === document.getElementById('collabTargetListId').value);
    const idx = parseInt(copyMemberInvite.dataset.copyMemberInvite, 10);
    const m = list?.collaborators[idx];
    if (m) {
      const url = new URL(window.location.href);
      url.searchParams.set('invite', m.token);
      if (m.email) url.searchParams.set('email', m.email);
      copyTextSafe(url.toString());
      showToast(`Ссылка доступа для ${m.name} скопирована!`);
    }
    return;
  }

  const freqPill = e.target.closest('[data-freq-filter]');
  if (freqPill) {
    state.frequentFilter = freqPill.dataset.freqFilter;
    document.querySelectorAll('.freq-filter-pill').forEach(p => {
      p.className = p.dataset.freqFilter === state.frequentFilter
        ? 'freq-filter-pill px-3 py-1.5 rounded-lg text-xs font-bold bg-amber-500 text-white shrink-0'
        : 'freq-filter-pill px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 dark:text-zinc-300 shrink-0';
    });
    renderFrequentView();
    return;
  }

  const periodPill = e.target.closest('[data-period]');
  if (periodPill) {
    state.statsPeriod = periodPill.dataset.period;
    document.querySelectorAll('.stats-period-pill').forEach(p => {
      p.className = p.dataset.period === state.statsPeriod
        ? 'stats-period-pill shrink-0 px-2.5 py-1.5 rounded-lg text-xs font-bold bg-amber-500 text-white'
        : 'stats-period-pill shrink-0 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-600 dark:text-zinc-300';
    });
    const customBox = document.getElementById('statsCustomDateBox');
    if (state.statsPeriod === 'custom') {
      customBox.classList.remove('hidden');
      if (!document.getElementById('statsDateFrom').value) {
        document.getElementById('statsDateFrom').value = isoDaysAgo(7);
        document.getElementById('statsDateTo').value = isoDaysAgo(0);
      }
    } else customBox.classList.add('hidden');
    renderStatisticsView();
    return;
  }

  const acChoice = e.target.closest('[data-ac-pick]');
  if (acChoice) {
    const ctx = acChoice.dataset.acCtx;
    const name = acChoice.dataset.name;
    const qty = parseFloat(acChoice.dataset.qty) || 1;
    const unit = acChoice.dataset.unit || 'шт';
    const price = parseFloat(acChoice.dataset.price) || 0;
    const storeName = acChoice.dataset.store || '';
    const desc = acChoice.dataset.desc || '';
    if (ctx === 'modal') {
      document.getElementById('modalItemName').value = name;
      document.getElementById('modalItemQty').value = qty;
      document.getElementById('modalItemUnit').value = unit;
      document.getElementById('modalItemPrice').value = price;
      document.getElementById('modalItemStore').value = storeName;
      document.getElementById('modalItemProductUrl').value = buildProductStoreUrl(name, storeName);
      document.getElementById('modalItemDesc').value = desc;
      document.getElementById('modalAutocompleteBox').classList.add('hidden');
    } else {
      const list = state.lists.find(l => l.id === acChoice.dataset.listId);
      if (list) {
        list.items.unshift({ id: 'i-' + uniqueSuffix(), name, qty, unit, price, storeName, productUrl: buildProductStoreUrl(name, storeName), cheaperAlt: null, desc, checked: false, order: 0 });
        saveState();
        showToast(`Добавлено: ${name}`);
      }
    }
    return;
  }

  const actBtn = e.target.closest('[data-action]');
  if (!actBtn) return;
  const action = actBtn.dataset.action;
  const listId = actBtn.dataset.listId;
  const itemId = actBtn.dataset.itemId;
  const list = state.lists.find(l => l.id === listId);

  if (action === 'open-picker') openPicker(listId, actBtn.dataset.pkTab || 'popular');
  else if (action === 'load-store-prices-list') openStorePricesModal(listId);
  else if (action === 'open-price-history') openProductPriceHistoryModal(actBtn.dataset.productName);
  else if (action === 'set-list-color' && list) {
    list.color = actBtn.dataset.color || '#ffffff';
    saveState();
  } else if (action === 'apply-cheaper-alt' && list) {
    const item = list.items.find(i => i.id === itemId);
    if (item && item.cheaperAlt) {
      const before = { price: item.price, storeName: item.storeName, productUrl: item.productUrl, cheaperAlt: structuredClone(item.cheaperAlt) };
      const historyBefore = structuredClone(state.priceHistory);
      item.price = item.cheaperAlt.price; item.priceEstimated = true;
      item.storeName = item.cheaperAlt.chain || item.cheaperAlt.storeName;
      item.productUrl = buildProductStoreUrl(item.name, item.storeName);
      item.cheaperAlt = null; // цена «дешевле» — тоже имитация, в историю не пишем
      saveState();
      showToast(`Переключено на ${item.storeName}!`, () => {
        const target = state.lists.find(l => l.id === list.id)?.items.find(i => i.id === item.id);
        if (target) Object.assign(target, before);
        state.priceHistory = historyBefore;
        saveState();
        showToast('Возвращена прежняя цена и магазин');
      });
    }
  } else if (action === 'quick-add-submit' && listId) {
    const inp = document.querySelector(`[data-quick-input="${listId}"]`);
    if (inp) { addQuickItemToList(listId, inp.value); inp.value = ''; }
  } else if (action === 'open-add-modal' && listId) openItemEditor('lists', listId);
  else if (action === 'edit-item' && listId && itemId) openItemEditor('lists', listId, itemId);
  else if (action === 'edit-collection' && itemId && actBtn.dataset.section) openItemEditor(actBtn.dataset.section, '', itemId);
  else if (action === 'pin-list' && list) { list.pinned = !list.pinned; saveState(); }
  else if (action === 'add-suggest' && listId) { addQuickItemToList(listId, actBtn.dataset.name || '', true); }
  else if (action === 'dismiss-suggest') { lastAdded = null; renderApp(); }
  else if (action === 'ai-prices') { document.getElementById('moreMenuDropdown')?.classList.add('hidden'); void aiEstimateMissingPrices(listId || ''); }
  else if (action === 'clear-checked' && list) {
    const n = list.items.filter(i => i.checked).length;
    if (n) {
      const undo = makeStateUndo(['lists'], 'Товары возвращены в список');
      list.items = list.items.filter(i => !i.checked);
      saveState();
      showToast('Убрано взятых: ' + n, undo);
    }
  }
  else if (action === 'set-list-view' && actBtn.dataset.viewSection) {
    state.viewModes = { ...(state.viewModes || {}), [actBtn.dataset.viewSection]: actBtn.dataset.view === 'cards' ? 'cards' : 'compact' };
    saveState();
  }
  else if (action === 'set-list-view' && list) { list.viewMode = actBtn.dataset.view === 'cards' ? 'cards' : 'compact'; saveState(); }
  else if (action === 'toggle-list-view' && list) { list.viewMode = list.viewMode === 'cards' ? 'compact' : 'cards'; saveState(); }
  else if (action === 'delete-list' && listId) {
    const idx = state.lists.findIndex(l => l.id === listId);
    if (idx >= 0) {
      const deletedList = structuredClone(state.lists[idx]);
      state.lists.splice(idx, 1);
      saveState();
      showToast(`Список «${deletedList.title}» удалён`, () => {
        if (!state.lists.some(l => l.id === deletedList.id)) {
          state.lists.splice(Math.min(idx, state.lists.length), 0, deletedList);
          saveState();
          showToast('Список восстановлен');
        }
      });
    }
  }
  else if ((action === 'move-list-up' || action === 'move-list-down') && listId) {
    const dir = action === 'move-list-up' ? -1 : 1;
    const sorted = visibleLists().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const idx = sorted.findIndex(l => l.id === listId);
    if (idx + dir >= 0 && idx + dir < sorted.length) {
      [sorted[idx], sorted[idx + dir]] = [sorted[idx + dir], sorted[idx]];
      sorted.forEach((l, i) => l.order = i);
      saveState();
    }
  } else if (action === 'collab-list' && list) {
    document.getElementById('collabTargetListId').value = list.id;
    renderCollabMembers(list);
    openModal('collabModal');
  } else if (action === 'toggle-check' && list) {
    const item = list.items.find(i => i.id === itemId);
    if (item) {
      item.checked = !item.checked;
      if (item.checked) {
        state.recent.unshift({ id: 'r-' + uniqueSuffix(), name: item.name, qty: item.qty, unit: item.unit, price: item.price, date: new Date().toISOString().split('T')[0], desc: item.storeName || list.title });
        if (!item.priceEstimated) recordProductPrice(item.name, item.price, item.storeName || list.title);
      }
      saveState();
    }
  } else if ((action === 'qty-inc' || action === 'qty-dec') && list) {
    const item = list.items.find(i => i.id === itemId);
    if (item) {
      const step = item.unit === 'кг' || item.unit === 'л' ? 0.5 : 1;
      item.qty = Math.max(0.1, Math.round((item.qty + (action === 'qty-inc' ? step : -step)) * 10) / 10);
      saveState();
    }
  } else if ((action === 'move-item-up' || action === 'move-item-down') && list) {
    const dir = action === 'move-item-up' ? -1 : 1;
    list.sortMode = 'manual';
    const sorted = getSortedItems(list);
    const idx = sorted.findIndex(i => i.id === itemId);
    if (idx + dir >= 0 && idx + dir < sorted.length) {
      [sorted[idx], sorted[idx + dir]] = [sorted[idx + dir], sorted[idx]];
      sorted.forEach((it, i) => it.order = i);
      list.items = sorted;
      saveState();
    }
  } else if (action === 'toggle-fav' && list) {
    const item = list.items.find(i => i.id === itemId);
    if (item) {
      const existsIdx = state.favorite.findIndex(f => f.name.toLowerCase() === item.name.toLowerCase());
      if (existsIdx >= 0) {
        const removed = state.favorite.splice(existsIdx, 1)[0];
        saveState();
        showToast(`«${removed.name}» убрано из избранного`, () => {
          if (!state.favorite.some(f => f.id === removed.id)) {
            state.favorite.splice(Math.min(existsIdx, state.favorite.length), 0, removed);
            saveState();
            showToast('Возвращено в избранное');
          }
        });
      } else {
        state.favorite.unshift({ id: 'f-' + uniqueSuffix(), name: item.name, qty: item.qty, unit: item.unit, price: item.price, desc: item.desc || '' });
        saveState();
      }
    }
  } else if (action === 'delete-item' && list) {
    const idx = list.items.findIndex(i => i.id === itemId);
    if (idx >= 0) {
      const deletedItem = structuredClone(list.items[idx]);
      list.items.splice(idx, 1);
      saveState();
      showToast(`Удалено: ${deletedItem.name}`, () => {
        const targetList = state.lists.find(l => l.id === listId);
        if (targetList && !targetList.items.some(i => i.id === deletedItem.id)) {
          targetList.items.splice(Math.min(idx, targetList.items.length), 0, deletedItem);
          saveState();
          showToast('Товар восстановлен');
        }
      });
    }
  } else if (action === 'push-frequent') {
    ensureMainList().items.unshift({ id: 'i-' + uniqueSuffix(), name: actBtn.dataset.name, qty: parseFloat(actBtn.dataset.qty) || 1, unit: actBtn.dataset.unit || 'шт', price: Math.round((parseFloat(actBtn.dataset.price) || 0) * 100) / 100, storeName: '', productUrl: buildProductStoreUrl(actBtn.dataset.name), cheaperAlt: null, desc: '', checked: false, order: 0 });
    saveState();
    showToast('Добавлено в «Недавние»');
  } else if (action === 'push-collection') {
    const item = (state[actBtn.dataset.section] || []).find(i => i.id === itemId);
    if (item) {
      ensureMainList().items.unshift({ id: 'i-' + uniqueSuffix(), name: item.name, qty: item.qty || 1, unit: item.unit || 'шт', price: item.price || 0, storeName: '', productUrl: buildProductStoreUrl(item.name), cheaperAlt: null, desc: item.desc || '', checked: false, order: 0 });
      saveState();
      showToast('Добавлено в «Недавние»');
    }
  } else if (action === 'delete-collection') {
    const sec = actBtn.dataset.section;
    const arr = state[sec] || [];
    const idx = arr.findIndex(i => i.id === itemId);
    if (idx >= 0) {
      const deleted = structuredClone(arr[idx]);
      arr.splice(idx, 1);
      saveState();
      showToast(`Удалено: ${deleted.name}`, () => {
        state[sec] = state[sec] || [];
        if (!state[sec].some(i => i.id === deleted.id)) {
          state[sec].splice(Math.min(idx, state[sec].length), 0, deleted);
          saveState();
          showToast('Удаление отменено');
        }
      });
    }
  }
});

// ==================== INPUT & CHANGE HANDLERS ====================
document.addEventListener('input', (e) => {
  if (e.target.id === 'globalSearchInput') {
    state.searchQuery = e.target.value;
    document.getElementById('searchActiveIndicator')?.classList.toggle('hidden', !state.searchQuery.trim());
    renderApp();
  }
  if (e.target.id === 'storeRadiusSlider') {
    state.storeSearch.radiusKm = parseFloat(e.target.value);
    document.getElementById('radiusValueLabel').textContent = `${state.storeSearch.radiusKm} км`;
    renderNearbyStoresList();
    initOrUpdateStoreMap();
  }
  if (e.target.id === 'storeNameSearchInput') {
    state.storeSearch.query = e.target.value;
    renderNearbyStoresList();
    initOrUpdateStoreMap();
  }
  if (e.target.matches('[data-collab-field]')) {
    const list = state.lists.find(l => l.id === document.getElementById('collabTargetListId').value);
    const idx = parseInt(e.target.dataset.collabIdx, 10);
    if (list && list.collaborators[idx]) {
      list.collaborators[idx][e.target.dataset.collabField] = e.target.value;
      saveState();
    }
  }
  if (e.target.id === 'modalItemName') {
    const box = document.getElementById('modalAutocompleteBox');
    const matches = findCatalogSuggestions(e.target.value);
    if (!matches.length) { box.classList.add('hidden'); return; }
    box.innerHTML = matches.map(m => `
      <button type="button" data-ac-pick="1" data-ac-ctx="modal" data-name="${escapeHTML(m.name)}" data-qty="${m.qty}" data-unit="${escapeHTML(m.unit)}" data-price="${m.price}" data-store="${escapeHTML(m.storeName)}" data-desc="${escapeHTML(m.desc)}" class="w-full text-left px-3 py-2 hover:bg-amber-50 dark:hover:bg-zinc-800 flex items-center justify-between text-xs">
        <span class="font-bold truncate">${escapeHTML(m.name)}</span>
        <span class="font-bold shrink-0">${formatMoney(m.price)}</span>
      </button>
    `).join('');
    box.classList.remove('hidden');
  }
  if (e.target.matches('[data-quick-input]')) {
    const listId = e.target.dataset.quickInput;
    const box = document.getElementById(`quick-ac-${listId}`);
    const matches = findCatalogSuggestions(e.target.value);
    if (!box) return;
    if (!matches.length) { box.classList.add('hidden'); return; }
    box.innerHTML = matches.map(m => `
      <button type="button" data-ac-pick="1" data-ac-ctx="card" data-list-id="${listId}" data-name="${escapeHTML(m.name)}" data-qty="${m.qty}" data-unit="${escapeHTML(m.unit)}" data-price="${m.price}" data-store="${escapeHTML(m.storeName)}" data-desc="${escapeHTML(m.desc)}" class="w-full text-left px-3 py-2 hover:bg-amber-50 dark:hover:bg-zinc-800 flex items-center justify-between text-xs">
        <span class="font-bold truncate">${escapeHTML(m.name)}</span>
        <span class="shrink-0">${formatMoney(m.price)}</span>
      </button>
    `).join('');
    box.classList.remove('hidden');
  }
});

document.addEventListener('change', (e) => {
  if (e.target.matches('[data-edit-list-title]')) {
    const list = state.lists.find(l => l.id === e.target.dataset.editListTitle);
    const val = e.target.value.trim();
    if (list && val) { list.title = val; saveState(); }
  }
  if (e.target.matches('[data-action="sort-list"]')) {
    const list = state.lists.find(l => l.id === e.target.dataset.listId);
    if (list) { list.sortMode = e.target.value; saveState(); }
  }
  if (e.target.id === 'currencySelect') { state.currency = e.target.value; saveState(); }
  if (e.target.id === 'storeSortSelect') { state.storeSearch.sortBy = e.target.value; renderNearbyStoresList(); }
  if (e.target.id === 'savedLocationsSelect') {
    const loc = state.storeSearch.savedLocations.find(x => x.id === e.target.value);
    if (loc) setCustomMapLocation(loc.lat, loc.lng, loc.label, false);
  }
  if (e.target.id === 'embeddedProductSelect') {
    state.selectedHistoryProduct = e.target.value;
    document.getElementById('embeddedPriceHistoryContainer').innerHTML = buildProductPriceHistoryHTML(state.selectedHistoryProduct, 'embedded');
  }
  if (e.target.matches('[data-ph-date-ctx]')) {
    const ctx = e.target.dataset.phDateCtx;
    if (ctx === 'modal') document.getElementById('modalPriceHistoryContent').innerHTML = buildProductPriceHistoryHTML(state.selectedHistoryProduct, 'modal');
    else document.getElementById('embeddedPriceHistoryContainer').innerHTML = buildProductPriceHistoryHTML(state.selectedHistoryProduct, 'embedded');
  }
  if (e.target.id === 'privacyRequireAuthToggle') {
    state.privacy.requireAuth = e.target.checked;
    saveState();
    showToast(e.target.checked ? 'Приватный экран входа включён' : 'Вход без пароля разрешён');
  }
  if (e.target.id === 'privacyOwnerEmailInput') {
    state.privacy.ownerEmail = e.target.value.trim();
    saveState();
  }
  if (e.target.id === 'statsDateFrom' || e.target.id === 'statsDateTo') renderStatisticsView();
  if (e.target.id === 'receiptPhotoInput') {
    const file = e.target.files?.[0];
    if (!file) return;
    document.getElementById('receiptPhotoLabel').textContent = file.name;
    receiptImageMime = file.type || 'image/jpeg';
    const reader = new FileReader();
    reader.onload = (ev) => { receiptImageBase64 = String(ev.target.result).split(',')[1]; };
    reader.readAsDataURL(file);
  }
  if (e.target.id === 'keepTakeoutInput') {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = String(ev.target.result || '');
      document.getElementById('keepNoteTextarea').value = text;
      renderKeepPreview(parseLinesToItems(text));
    };
    reader.readAsText(file);
  }
  if (e.target.id === 'importBackupInput') {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        // тот же формат, что у резервных копий (src/backup.ts); старые экспорты тоже читаются
        restoreFromFile(parseBackup(String(ev.target.result || '')), 'файла');
        closeModal('dataApkModal');
      } catch (err) { showToast('Ошибка чтения файла: ' + (err?.message || err)); }
    };
    reader.readAsText(file);
  }
});

// ==================== MAP ADDRESS SEARCH & SAVED PINS ====================
async function searchAddressOrCoords() {
  const q = document.getElementById('mapAddressSearchInput').value.trim();
  if (!q) return;

  // Direct coordinates support ("52.2297, 21.0122")
  const coordMatch = q.match(/^(-?\d{1,2}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)$/);
  if (coordMatch) {
    const lat = parseFloat(coordMatch[1]);
    const lng = parseFloat(coordMatch[2]);
    setCustomMapLocation(lat, lng, `Координаты (${lat}, ${lng})`, true);
    showToast('Точка перемещена по координатам');
    return;
  }

  showToast('Ищем адрес на карте...');
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}&accept-language=ru`);
    if (res.ok) {
      const results = await res.json();
      if (results && results.length) {
        const lat = parseFloat(results[0].lat);
        const lng = parseFloat(results[0].lon);
        const shortName = results[0].display_name.split(',').slice(0, 3).join(',');
        setCustomMapLocation(lat, lng, shortName, false);
        showToast(`Найдено: ${shortName}`);
        return;
      }
    }
  } catch (e) {}
  showToast('Адрес не найден. Кликните в любую точку на карте!');
}

document.getElementById('searchMapAddressBtn')?.addEventListener('click', searchAddressOrCoords);
document.getElementById('mapAddressSearchInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') searchAddressOrCoords();
});

document.getElementById('saveCurrentPinBtn')?.addEventListener('click', () => {
  document.getElementById('savePinFormBox').classList.remove('hidden');
  document.getElementById('newPinLabelInput').focus();
});
document.getElementById('cancelSavePinBtn')?.addEventListener('click', () => {
  document.getElementById('savePinFormBox').classList.add('hidden');
});
document.getElementById('confirmSavePinBtn')?.addEventListener('click', () => {
  const label = document.getElementById('newPinLabelInput').value.trim() || `Точка (${state.storeSearch.lat}, ${state.storeSearch.lng})`;
  state.storeSearch.savedLocations.unshift({
    id: 'loc-' + uniqueSuffix(),
    label,
    lat: state.storeSearch.lat,
    lng: state.storeSearch.lng
  });
  document.getElementById('newPinLabelInput').value = '';
  document.getElementById('savePinFormBox').classList.add('hidden');
  renderSavedLocationsDropdown();
  saveState();
  showToast(`Точка «${label}» сохранена!`);
});

document.getElementById('detectGpsBtn')?.addEventListener('click', () => {
  const lbl = document.getElementById('gpsCoordsText');
  lbl.textContent = 'Определяем ваше GPS...';
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCustomMapLocation(pos.coords.latitude, pos.coords.longitude, '', true);
        showToast('GPS-позиция определена!');
      },
      () => {
        lbl.textContent = `Точка: ${state.storeSearch.locationLabel}`;
        showToast('GPS недоступно — выберите любую точку кликом по карте');
      },
      { timeout: 20000, maximumAge: 60000, enableHighAccuracy: false }
    );
  }
});

// ==================== LOCK SCREEN & PRIVACY ====================
document.getElementById('unlockByCredentialsBtn')?.addEventListener('click', () => {
  const email = document.getElementById('lockEmailInput').value.trim().toLowerCase();
  const code = document.getElementById('lockInviteCodeInput').value.trim();
  const msgEl = document.getElementById('lockFeedbackMsg');

  const isOwner = email && email === (state.privacy.ownerEmail || '').toLowerCase();
  const matchedCollab = state.lists
    .flatMap(l => l.collaborators)
    .find(c => c.active && ((email && c.email.toLowerCase() === email) || (code && c.token === code)));
  const validMasterCode = code && code === state.privacy.masterToken;

  if (isOwner || matchedCollab || validMasterCode) {
    state.session.unlocked = true;
    state.session.userEmail = email || matchedCollab?.email || state.privacy.ownerEmail;
    state.session.userName = isOwner ? 'Владелец' : (matchedCollab?.name || 'Участник');
    state.session.role = isOwner ? 'Владелец' : (matchedCollab?.role || 'Редактор');
    msgEl.classList.add('hidden');
    saveState();
    showToast(`Добро пожаловать, ${state.session.userName}!`);
  } else {
    msgEl.textContent = 'Доступ запрещён. Укажите email владельца или действующий токен приглашения.';
    msgEl.classList.remove('hidden');
  }
});

document.getElementById('demoOwnerQuickUnlockBtn')?.addEventListener('click', () => {
  state.session.unlocked = true;
  state.session.userName = 'Владелец';
  state.session.role = 'Владелец';
  saveState();
});

document.getElementById('lockAppNowBtn')?.addEventListener('click', () => {
  state.privacy.requireAuth = true;
  state.session.unlocked = false;
  document.getElementById('moreMenuDropdown')?.classList.add('hidden');
  saveState();
});

document.getElementById('regenerateTokenBtn')?.addEventListener('click', () => {
  const oldToken = state.privacy.masterToken;
  state.privacy.masterToken = 'SHOP-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  document.getElementById('privacyMasterTokenLabel').textContent = state.privacy.masterToken;
  saveState();
  showToast('Новый токен приглашения создан, старый отозван', () => {
    state.privacy.masterToken = oldToken;
    document.getElementById('privacyMasterTokenLabel').textContent = oldToken;
    saveState();
    showToast('Старый токен снова действует');
  });
});

document.getElementById('copyFullInviteUrlBtn')?.addEventListener('click', () => {
  const url = new URL(window.location.href);
  url.searchParams.set('invite', state.privacy.masterToken);
  copyTextSafe(url.toString());
  showToast('Приватная ссылка с токеном скопирована!');
});

const handleGoogleAuth = async () => {
  if (!auth) {
    state.session.unlocked = true;
    saveState();
    showToast('Вход выполнен');
    return;
  }
  try {
    const res = await signInWithPopup(auth, new GoogleAuthProvider());
    const email = res.user?.email || '';
    state.session.unlocked = true;
    state.session.userEmail = email;
    state.session.userName = res.user?.displayName || email.split('@')[0];
    state.session.role = email.toLowerCase() === (state.privacy.ownerEmail || '').toLowerCase() ? 'Владелец' : 'Редактор';
    saveState();
    closeModal('privacyModal');
    showToast('Вход через Google выполнен!');
  } catch (e) {
    showToast('Используйте вход по email или токену');
  }
};
document.getElementById('lockGoogleSignInBtn')?.addEventListener('click', handleGoogleAuth);
document.getElementById('connectGoogleAccountBtn')?.addEventListener('click', handleGoogleAuth);

// ==================== HEADER & MODAL BUTTONS ====================
document.getElementById('moreMenuToggleBtn')?.addEventListener('click', () => {
  document.getElementById('moreMenuDropdown')?.classList.toggle('hidden');
});

document.getElementById('menuThemeToggleBtn')?.addEventListener('click', () => {
  document.documentElement.classList.toggle('dark');
  document.getElementById('moreMenuDropdown')?.classList.add('hidden');
  renderListsView();
});

document.getElementById('openSearchBtn')?.addEventListener('click', () => {
  document.getElementById('inlineSearchOverlay')?.classList.remove('hidden');
  document.getElementById('globalSearchInput')?.focus();
});

document.getElementById('closeSearchBtn')?.addEventListener('click', () => {
  document.getElementById('inlineSearchOverlay')?.classList.add('hidden');
  document.getElementById('globalSearchInput').value = '';
  state.searchQuery = '';
  document.getElementById('searchActiveIndicator')?.classList.add('hidden');
  renderApp();
});

document.getElementById('headerStorePricesBtn')?.addEventListener('click', () => openStorePricesModal());
document.getElementById('fetchStorePricesBtn')?.addEventListener('click', executeStorePriceFetch);

document.getElementById('applyCheapestEverywhereBtn')?.addEventListener('click', () => {
  state.lists.forEach(list => list.items.forEach(item => {
    if (item.cheaperAlt && item.cheaperAlt.price < item.price) {
      item.price = item.cheaperAlt.price; item.priceEstimated = true;
      item.storeName = item.cheaperAlt.chain || item.cheaperAlt.storeName;
      item.productUrl = buildProductStoreUrl(item.name, item.storeName);
      item.cheaperAlt = null; // цена «дешевле» — тоже имитация, в историю не пишем
    }
  }));
  saveState();
  closeModal('storePricesModal');
  showToast('Самые выгодные цены применены ко всем позициям!');
});

document.getElementById('addCollabMemberBtn')?.addEventListener('click', () => {
  const list = state.lists.find(l => l.id === document.getElementById('collabTargetListId').value);
  const name = document.getElementById('collabNewNameInput').value.trim();
  const email = document.getElementById('collabNewEmailInput').value.trim();
  const role = document.getElementById('collabNewRoleSelect').value;
  if (!list || (!name && !email)) return;
  normalizeCollaborators(list);
  list.collaborators.push({
    id: 'c-' + uniqueSuffix(),
    name: name || email.split('@')[0],
    email,
    role,
    token: 'INV-' + Math.random().toString(36).slice(2, 6).toUpperCase(),
    active: true
  });
  document.getElementById('collabNewNameInput').value = '';
  document.getElementById('collabNewEmailInput').value = '';
  renderCollabMembers(list);
  saveState();
  showToast('Участник добавлен!');
});

document.getElementById('copyInviteLinkBtn')?.addEventListener('click', () => {
  const url = new URL(window.location.href);
  url.searchParams.set('invite', state.privacy.masterToken);
  copyTextSafe(url.toString());
  showToast('Ссылка-приглашение скопирована!');
});

document.getElementById('shareListAsTextBtn')?.addEventListener('click', () => {
  const list = state.lists.find(l => l.id === document.getElementById('collabTargetListId').value);
  if (!list) return;
  const lines = list.items.map(i => `${i.checked ? '☑' : '☐'} ${i.name} — ${i.qty} ${i.unit} (${formatMoney(i.qty * i.price)})`).join('\n');
  copyTextSafe(`🛒 ${list.title}\n${lines}`);
  showToast('Список скопирован в буфер обмена!');
});

document.getElementById('createListBtn')?.addEventListener('click', () => {
  const inp = document.getElementById('newListTitleInput');
  const title = (inp?.value || '').trim() || `Список #${state.lists.length + 1}`;
  const nl = { id: 'list-' + uniqueSuffix(), title, color: state.newListColor || '#ffffff', pinned: false, sortMode: 'manual', order: 0, collaborators: [], items: [] };
  normalizeCollaborators(nl);
  state.lists.unshift(nl);
  if (inp) inp.value = '';
  saveState();
});

document.getElementById('saveItemModalBtn')?.addEventListener('click', () => {
  const section = document.getElementById('modalTargetSection').value;
  const listId = document.getElementById('modalTargetListId').value;
  const editId = document.getElementById('modalEditItemId').value;
  const name = document.getElementById('modalItemName').value.trim();
  if (!name) { showToast('Введите название товара'); return; }

  const price = parseFloat(document.getElementById('modalItemPrice').value) || 0;
  const storeName = document.getElementById('modalItemStore').value.trim();
  const rawUrl = document.getElementById('modalItemProductUrl').value.trim();

  const payload = {
    id: editId || ('item-' + uniqueSuffix()),
    name,
    qty: parseFloat(document.getElementById('modalItemQty').value) || 1,
    unit: document.getElementById('modalItemUnit').value || 'шт',
    price,
    storeName,
    productUrl: buildProductStoreUrl(name, storeName, rawUrl),
    cheaperAlt: null,
    desc: document.getElementById('modalItemDesc').value.trim(),
    checked: false,
    order: 0
  };

  // Ориентировочную цену «≈», которую не меняли, в историю цен не пишем
  const prevItem = editId && section === 'lists' ? state.lists.find(l => l.id === listId)?.items.find(i => i.id === editId) : null;
  const keptEstimate = !!prevItem?.priceEstimated && Math.abs((Number(prevItem.price) || 0) - price) < 0.001;
  if (price > 0 && !keptEstimate) recordProductPrice(name, price, storeName || 'Вручную');

  if (section === 'lists') {
    const list = state.lists.find(l => l.id === listId);
    if (list) {
      if (editId) {
        const idx = list.items.findIndex(i => i.id === editId);
        if (idx >= 0) {
          const prev = list.items[idx];
          const sameProduct = prev.name === payload.name && (prev.storeName || '') === payload.storeName;
          const priceEstimated = !!prev.priceEstimated && Math.abs((Number(prev.price) || 0) - payload.price) < 0.001;
          list.items[idx] = { ...prev, ...payload, priceEstimated, checked: !!prev.checked, order: prev.order ?? 0, cheaperAlt: sameProduct ? (prev.cheaperAlt || null) : null };
        }
      } else {
        list.items.unshift(payload);
      }
    }
  } else {
    state[section] = state[section] || [];
    const cIdx = editId ? state[section].findIndex(i => i.id === editId) : -1;
    if (cIdx >= 0) {
      const { checked, order, ...rest } = payload;
      state[section][cIdx] = { ...state[section][cIdx], ...rest };
    } else state[section].unshift(payload);
  }
  upsertProduct(state.products || (state.products = []), { name, unit: payload.unit, price, priceEstimated: keptEstimate });
  saveState();
  closeModal('itemModal');
  showToast('Товар сохранён');
});

document.getElementById('aiAutoSearchBtn')?.addEventListener('click', async () => {
  const name = document.getElementById('modalItemName').value.trim();
  if (!name) { showToast('Сначала введите название товара'); return; }
  const store = document.getElementById('modalItemStore').value.trim();
  document.getElementById('modalItemProductUrl').value = buildProductStoreUrl(name, store);
  const spinner = document.getElementById('aiAutoSearchSpinner');
  spinner?.classList.remove('hidden');
  try {
    const res = await askGeminiWithBackoff({
      contents: [{ parts: [{ text: `Краткое описание товара "${name}" и средняя розничная цена в валюте ${state.currency}. Верни JSON: {"desc":"...","price":10.5,"store":"Biedronka"}` }] }],
      generationConfig: { responseMimeType: 'application/json' }
    });
    const data = JSON.parse(res?.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
    if (data.desc) document.getElementById('modalItemDesc').value = data.desc;
    if (data.price && Number(document.getElementById('modalItemPrice').value) === 0) document.getElementById('modalItemPrice').value = data.price;
    if (data.store && !store) {
      document.getElementById('modalItemStore').value = data.store;
      document.getElementById('modalItemProductUrl').value = buildProductStoreUrl(name, data.store);
    }
  } catch (e) {}
  spinner?.classList.add('hidden');
  showToast('Ссылка и данные товара заполнены!');
});

// ==================== RECEIPT & GOOGLE KEEP PARSERS ====================
function renderReceiptPreview(items) {
  receiptBuffer = items;
  document.getElementById('receiptPreviewBox').classList.remove('hidden');
  document.getElementById('applyReceiptItemsBtn').classList.remove('hidden');
  let sum = 0;
  document.getElementById('receiptPreviewItems').innerHTML = items.map(it => {
    const s = (Number(it.qty) || 1) * (Number(it.price) || 0);
    sum += s;
    return `<div class="flex justify-between py-1"><span>${escapeHTML(it.name)} (${it.qty} ${it.unit || 'шт'})</span><b>${formatMoney(s)}</b></div>`;
  }).join('');
  document.getElementById('receiptPreviewTotal').textContent = formatMoney(sum);
}

document.getElementById('runReceiptParseBtn')?.addEventListener('click', async () => {
  const txt = document.getElementById('receiptRawText').value.trim();
  if (!txt && !receiptImageBase64) { showToast('Загрузите фото или вставьте текст чека'); return; }
  showToast('Распознаём чек...');
  try {
    const parts = [{ text: `Извлеки товары из чека в JSON массив: [{"name":"...","qty":1,"unit":"шт","price":10.5}]. Валюта: ${state.currency}. ${txt}` }];
    if (receiptImageBase64) parts.push({ inlineData: { mimeType: receiptImageMime, data: receiptImageBase64 } });
    const res = await askGeminiWithBackoff({ contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json' } });
    const parsed = JSON.parse(res?.candidates?.[0]?.content?.parts?.[0]?.text || '[]');
    if (Array.isArray(parsed) && parsed.length) { renderReceiptPreview(parsed); return; }
  } catch (e) {}
  if (txt) renderReceiptPreview(parseLinesToItems(txt));
});

document.getElementById('applyReceiptItemsBtn')?.addEventListener('click', () => {
  const dest = document.getElementById('receiptDestSelect').value;
  const dateVal = document.getElementById('receiptDateField').value || new Date().toISOString().split('T')[0];
  const storeVal = document.getElementById('receiptStoreName').value.trim() || 'Чек';
  const undoReceipt = makeStateUndo(['lists', 'recent', 'priceHistory'], 'Добавление чека отменено');
  receiptBuffer.forEach((it, idx) => {
    recordProductPrice(it.name, Number(it.price) || 0, storeVal, dateVal);
    if (dest === 'list') {
      if (!state.lists.length) state.lists.push({ id: 'list-' + uniqueSuffix(), title: 'Из чека', color: '#fef3c7', pinned: false, sortMode: 'manual', order: 0, collaborators: [], items: [] });
      state.lists[0].items.unshift({ id: 'rc-' + uniqueSuffix() + idx, name: it.name, qty: Number(it.qty) || 1, unit: it.unit || 'шт', price: Number(it.price) || 0, storeName: storeVal, productUrl: buildProductStoreUrl(it.name, storeVal), cheaperAlt: null, desc: 'Из чека', checked: false, order: idx });
    } else {
      state.recent.unshift({ id: 'rec-' + uniqueSuffix() + idx, name: it.name, qty: Number(it.qty) || 1, unit: it.unit || 'шт', price: Number(it.price) || 0, date: dateVal, desc: storeVal });
    }
  });
  saveState();
  closeModal('receiptModal');
  showToast('Чек сохранён в историю цен и статистику!', undoReceipt);
});

function renderKeepPreview(items) {
  keepParsedBuffer = items;
  document.getElementById('keepItemsCounter').textContent = items.length;
  document.getElementById('keepParsedSection').classList.remove('hidden');
  document.getElementById('keepParsedList').innerHTML = items.map((it, idx) => `
    <label class="flex items-center justify-between gap-2 p-2 rounded-xl bg-slate-50 dark:bg-zinc-800/70 text-xs">
      <div class="flex items-center gap-2 min-w-0">
        <input type="checkbox" data-keep-check="${idx}" checked class="w-4 h-4 accent-emerald-600 shrink-0" />
        <span class="font-bold truncate">${escapeHTML(it.name)}</span>
        <span class="px-1.5 py-0.2 rounded text-[10px] font-bold shrink-0 ${it.isNew ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'}">${it.isNew ? 'Новый' : 'В базе'}</span>
      </div>
      <span class="shrink-0 font-bold">${formatMoney(it.price)}</span>
    </label>
  `).join('');
}

document.getElementById('fillKeepDemoBtn')?.addEventListener('click', () => {
  document.getElementById('keepNoteTitle').value = 'Покупки из Google Keep';
  document.getElementById('keepNoteTextarea').value = `[ ] Молоко фермерское 3.2% 2 л - 4.50\n[ ] Сыр Моцарелла 2 шт - 14.00\n[ ] Яблоки Лигол 1.5 кг - 6.00`;
  renderKeepPreview(parseLinesToItems(document.getElementById('keepNoteTextarea').value));
});

document.getElementById('parseKeepLocalBtn')?.addEventListener('click', () => {
  const txt = document.getElementById('keepNoteTextarea').value.trim();
  if (txt) renderKeepPreview(parseLinesToItems(txt));
});

document.getElementById('parseKeepAiBtn')?.addEventListener('click', async () => {
  const txt = document.getElementById('keepNoteTextarea').value.trim();
  if (!txt) return;
  try {
    const res = await askGeminiWithBackoff({
      contents: [{ parts: [{ text: `Распарси список покупок из Google Keep в JSON массив: [{"name":"...","qty":1,"unit":"шт","price":0,"checked":false}]. Текст:\n${txt}` }] }],
      generationConfig: { responseMimeType: 'application/json' }
    });
    const arr = JSON.parse(res?.candidates?.[0]?.content?.parts?.[0]?.text || '[]');
    const catalog = getUnifiedCatalog();
    renderKeepPreview(arr.map(x => ({ ...x, isNew: !catalog.some(c => c.name.toLowerCase() === (x.name || '').toLowerCase()) })));
  } catch (e) { renderKeepPreview(parseLinesToItems(txt)); }
});

document.getElementById('commitKeepImportBtn')?.addEventListener('click', () => {
  const selected = keepParsedBuffer.filter((_, idx) => document.querySelector(`[data-keep-check="${idx}"]`)?.checked);
  if (!selected.length) return;
  const saveToFav = document.getElementById('keepSaveNewToFavorite')?.checked;
  const title = document.getElementById('keepNoteTitle').value.trim() || 'Заметка Google Keep';
  const undoKeep = makeStateUndo(['lists', 'favorite'], 'Импорт из Google Keep отменён');
  const nl = {
    id: 'list-' + uniqueSuffix(),
    title,
    color: '#fef3c7',
    pinned: false,
    sortMode: 'manual',
    order: 0,
    collaborators: [],
    items: selected.map((it, idx) => {
      if (saveToFav && it.isNew) {
        state.favorite.unshift({ id: 'fv-' + uniqueSuffix() + idx, name: it.name, qty: Number(it.qty) || 1, unit: it.unit || 'шт', price: Number(it.price) || 0, desc: 'Из Google Keep' });
      }
      return {
        id: 'kp-' + uniqueSuffix() + idx,
        name: it.name,
        qty: Number(it.qty) || 1,
        unit: it.unit || 'шт',
        price: Number(it.price) || 0,
        storeName: '',
        productUrl: buildProductStoreUrl(it.name),
        cheaperAlt: null,
        desc: 'Из Google Keep',
        checked: Boolean(it.checked),
        order: idx
      };
    })
  };
  normalizeCollaborators(nl);
  state.lists.unshift(nl);
  saveState();
  closeModal('keepModal');
  showToast('Импортировано из Google Keep!', undoKeep);
});

// ==================== EXPORT & ZIP ANDROID APK ARCHIVE ====================
function downloadBlob(blob, filename) {
  if (isNative) { saveAndShare(blob, filename); return; }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.getElementById('exportJsonBtn')?.addEventListener('click', async () => {
  try {
    const info = await createBackup('export');
    await shareBackup(info.name);
  } catch (err) {
    if (!/cancel/i.test(String(err?.message || err))) showToast('Не удалось экспортировать: ' + (err?.message || err));
  }
});

document.getElementById('exportCsvBtn')?.addEventListener('click', () => {
  const rows = [['Список', 'Название', 'Кол-во', 'Ед.', 'Цена', 'Магазин', 'Ссылка', 'Статус']];
  state.lists.forEach(l => l.items.forEach(i => rows.push([
    `"${l.title}"`, `"${i.name}"`, i.qty, i.unit, i.price, `"${i.storeName || ''}"`, `"${i.productUrl || ''}"`, i.checked ? 'Куплено' : 'Активно'
  ])));
  downloadBlob(new Blob(['\uFEFF' + rows.map(r => r.join(',')).join('\n')], { type: 'text/csv;charset=utf-8;' }), 'keepshop-items.csv');
});

document.getElementById('downloadZipApkBtn')?.addEventListener('click', async () => {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file('www/index.html', '<!DOCTYPE html>\n' + document.documentElement.outerHTML);
  zip.file('www/manifest.json', JSON.stringify({
    name: 'KeepShop AI',
    short_name: 'KeepShop',
    start_url: './index.html',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#f59e0b'
  }, null, 2));
  zip.file('package.json', JSON.stringify({
    name: 'keepshop-ai-android',
    version: '1.0.0',
    scripts: {
      'cap:sync': 'npx cap sync android',
      'apk:debug': 'cd android && ./gradlew assembleDebug'
    },
    dependencies: {
      '@capacitor/core': '^6.0.0',
      '@capacitor/android': '^6.0.0'
    },
    devDependencies: {
      '@capacitor/cli': '^6.0.0'
    }
  }, null, 2));
  zip.file('capacitor.config.json', JSON.stringify({
    appId: 'com.keepshop.ai',
    appName: 'KeepShop AI',
    webDir: 'www',
    bundledWebRuntime: false
  }, null, 2));
  zip.file('BUILD_APK.md', '# Сборка Android APK\n1. npm install\n2. npx cap add android\n3. npx cap sync android\n4. cd android && ./gradlew assembleDebug\nФайл APK: android/app/build/outputs/apk/debug/app-debug.apk');
  downloadBlob(await zip.generateAsync({ type: 'blob' }), 'KeepShop-AI-Android-Project.zip');
  showToast('ZIP-архив проекта для Android APK скачан!');
});

document.getElementById('addFavoriteQuickBtn')?.addEventListener('click', () => openItemEditor('favorite'));
document.getElementById('addBacklogQuickBtn')?.addEventListener('click', () => openItemEditor('backlog'));
document.getElementById('clearRecentBtn')?.addEventListener('click', () => {
  if (!state.recent.length) return;
  const backup = structuredClone(state.recent);
  state.recent = [];
  saveState();
  showToast('История недавних очищена', () => {
    state.recent = backup;
    saveState();
    showToast('История восстановлена');
  });
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    document.getElementById('inlineSearchOverlay')?.classList.remove('hidden');
    document.getElementById('globalSearchInput')?.focus();
  }
  if (e.key === 'Enter' && e.target.id === 'newListTitleInput') document.getElementById('createListBtn')?.click();
  if (e.key === 'Enter' && e.target.matches('[data-quick-input]')) {
    addQuickItemToList(e.target.dataset.quickInput, e.target.value);
    e.target.value = '';
  }
});

// ==================== DRAG & DROP (DESKTOP MOUSE + MOBILE TOUCH) ====================
function reorderItemsInList(listId, fromItemId, toItemId) {
  if (!listId || !fromItemId || !toItemId || fromItemId === toItemId) return;
  const list = state.lists.find(l => l.id === listId);
  if (!list) return;
  list.sortMode = 'manual';
  const items = getSortedItems(list);
  const from = items.findIndex(i => i.id === fromItemId);
  const to = items.findIndex(i => i.id === toItemId);
  if (from >= 0 && to >= 0) {
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
    items.forEach((it, i) => it.order = i);
    list.items = items;
    saveState();
  }
}

function reorderLists(fromListId, toListId) {
  if (!fromListId || !toListId || fromListId === toListId) return;
  const sorted = visibleLists().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const from = sorted.findIndex(l => l.id === fromListId);
  const to = sorted.findIndex(l => l.id === toListId);
  if (from >= 0 && to >= 0) {
    const [moved] = sorted.splice(from, 1);
    sorted.splice(to, 0, moved);
    sorted.forEach((l, i) => l.order = i);
    saveState();
  }
}

// Mouse Drag & Drop
document.addEventListener('dragstart', (e) => {
  const itemEl = e.target.closest('.list-item-card');
  if (itemEl) {
    dragContext = { type: 'item', listId: itemEl.dataset.listId, itemId: itemEl.dataset.itemId };
    itemEl.classList.add('dragging-card');
    return;
  }
  const cardEl = e.target.closest('.list-card');
  if (cardEl) {
    dragContext = { type: 'list', listId: cardEl.dataset.listId };
    cardEl.classList.add('dragging-card');
  }
});
document.addEventListener('dragend', () => {
  document.querySelectorAll('.dragging-card').forEach(el => el.classList.remove('dragging-card'));
  dragContext = null;
});
document.addEventListener('dragover', (e) => { if (dragContext) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  if (!dragContext) return;
  if (dragContext.type === 'item') {
    const target = e.target.closest('.list-item-card');
    if (target && target.dataset.listId === dragContext.listId) {
      reorderItemsInList(dragContext.listId, dragContext.itemId, target.dataset.itemId);
    }
  } else if (dragContext.type === 'list') {
    const target = e.target.closest('.list-card');
    if (target) reorderLists(dragContext.listId, target.dataset.listId);
  }
  dragContext = null;
});

// Mobile Touch Drag & Drop via ⋮⋮ handles
let touchDragState = null;
document.addEventListener('touchstart', (e) => {
  const itemHandle = e.target.closest('[data-touch-item-handle]');
  if (itemHandle) {
    touchDragState = { type: 'item', listId: itemHandle.dataset.listId, itemId: itemHandle.dataset.touchItemHandle };
    itemHandle.closest('.list-item-card')?.classList.add('dragging-card');
    return;
  }
  const listHandle = e.target.closest('[data-touch-list-handle]');
  if (listHandle) {
    touchDragState = { type: 'list', listId: listHandle.dataset.touchListHandle };
    listHandle.closest('.list-card')?.classList.add('dragging-card');
  }
}, { passive: true });

document.addEventListener('touchend', (e) => {
  if (!touchDragState) return;
  document.querySelectorAll('.dragging-card').forEach(el => el.classList.remove('dragging-card'));
  const touch = e.changedTouches?.[0];
  if (touch) {
    const targetEl = document.elementFromPoint(touch.clientX, touch.clientY);
    if (touchDragState.type === 'item') {
      const targetCard = targetEl?.closest('.list-item-card');
      if (targetCard && targetCard.dataset.listId === touchDragState.listId) {
        reorderItemsInList(touchDragState.listId, touchDragState.itemId, targetCard.dataset.itemId);
      }
    } else if (touchDragState.type === 'list') {
      const targetList = targetEl?.closest('.list-card');
      if (targetList) reorderLists(touchDragState.listId, targetList.dataset.listId);
    }
  }
  touchDragState = null;
});

// Долгий тап по товару → редактирование
(() => {
  let lp = null;
  let suppressClickUntil = 0;
  const cancel = () => { if (lp) { clearTimeout(lp.timer); lp.card.classList.remove('lp-pressing'); lp = null; } };
  document.addEventListener('pointerdown', (e) => {
    cancel();
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const card = e.target.closest('[data-lp-edit]');
    if (!card || e.target.closest('button, a, input, select, textarea, label, [data-touch-item-handle]')) return;
    const section = card.dataset.lpEdit;
    const itemId = card.dataset.itemId;
    const listId = card.dataset.listId || '';
    card.classList.add('lp-pressing');
    lp = {
      card, x: e.clientX, y: e.clientY,
      timer: setTimeout(() => {
        card.classList.remove('lp-pressing');
        lp = null;
        suppressClickUntil = Date.now() + 600;
        try { navigator.vibrate?.(20); } catch (_) {}
        openItemEditor(section, listId, itemId);
      }, 500)
    };
  });
  document.addEventListener('pointermove', (e) => {
    if (lp && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) cancel();
  });
  ['pointerup', 'pointercancel', 'dragstart'].forEach(t => document.addEventListener(t, cancel));
  window.addEventListener('scroll', cancel, true);
  // Не даём системному меню / выделению текста перебить долгий тап
  document.addEventListener('contextmenu', (e) => { if (e.target.closest('[data-lp-edit]')) e.preventDefault(); });
  document.addEventListener('click', (e) => {
    if (Date.now() < suppressClickUntil) { e.stopPropagation(); e.preventDefault(); suppressClickUntil = 0; }
  }, true);
})();

// Компактные строки: удержание → перетаскивание, обычное движение пальцем → скролл
(() => {
  const LIFT_MS = 260;      // столько держать палец, чтобы «поднять» строку
  const EDIT_MS = 900;      // держать неподвижно дольше — откроется редактор
  const SLOP = 8;           // px: движение до подъёма = скролл
  let d = null;
  let suppressClickUntil = 0;

  const pageY = (clientY) => clientY + window.scrollY;
  function reset() {
    if (!d) return;
    clearTimeout(d.liftTimer); clearTimeout(d.editTimer); cancelAnimationFrame(d.raf);
    d.rows?.forEach(r => { r.el.style.transform = ''; r.el.classList.remove('ks-shift'); });
    d.row.classList.remove('ks-lifted', 'ks-pressing');
    d = null;
  }
  function start(row, x, y, kind) {
    reset();
    d = { row, kind, x0: x, y0: y, x, y, lifted: false, moved: false };
    row.classList.add('ks-pressing');
    d.liftTimer = setTimeout(lift, LIFT_MS);
  }
  function lift() {
    if (!d) return;
    const group = d.row.closest('[data-row-group]');
    const els = group ? [...group.querySelectorAll(':scope > .ks-row')] : [d.row];
    d.rows = els.map(el => { const r = el.getBoundingClientRect(); return { el, id: el.dataset.itemId, top: r.top + window.scrollY, h: r.height }; });
    d.from = els.indexOf(d.row);
    d.gap = d.rows.length > 1 ? Math.max(0, d.rows[1].top - d.rows[0].top - d.rows[0].h) : 6;
    d.startPageY = pageY(d.y);
    d.to = d.from;
    d.lifted = true;
    d.row.classList.remove('ks-pressing');
    d.row.classList.add('ks-lifted');
    d.rows.forEach(r => { if (r.el !== d.row) r.el.classList.add('ks-shift'); });
    try { navigator.vibrate?.(15); } catch (_) {}
    d.editTimer = setTimeout(() => {
      if (!d || d.moved) return;
      const { row } = d;
      reset();
      suppressClickUntil = Date.now() + 700;
      try { navigator.vibrate?.(25); } catch (_) {}
      openItemEditor('lists', row.dataset.listId, row.dataset.itemId);
    }, EDIT_MS - LIFT_MS);
    tick();
  }
  function layout() {
    const dy = pageY(d.y) - d.startPageY;
    d.row.style.transform = 'translateY(' + dy + 'px)';
    const me = d.rows[d.from];
    const center = me.top + me.h / 2 + dy;
    const step = me.h + d.gap;
    let to = d.from;
    d.rows.forEach((r, i) => {
      if (i === d.from) return;
      const c = r.top + r.h / 2;
      let shift = 0;
      if (i > d.from && center > c) { shift = -step; to++; }
      else if (i < d.from && center < c) { shift = step; to--; }
      r.el.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
    });
    d.to = to;
  }
  function tick() {
    if (!d || !d.lifted) return;
    // Автопрокрутка у краёв экрана
    const edgeTop = 70, edgeBottom = window.innerHeight - (window.innerWidth < 768 ? 120 : 60);
    let v = 0;
    if (d.moved && d.y < edgeTop) v = -Math.min(16, (edgeTop - d.y) / 3 + 2);
    else if (d.moved && d.y > edgeBottom) v = Math.min(16, (d.y - edgeBottom) / 3 + 2);
    if (v) window.scrollBy(0, v);
    if (d.moved) layout();
    d.raf = requestAnimationFrame(tick);
  }
  function move(x, y) {
    if (!d) return false;
    d.x = x; d.y = y;
    if (!d.lifted) {
      if (Math.hypot(x - d.x0, y - d.y0) > SLOP) reset(); // это скролл, не перетаскивание
      return false;
    }
    if (!d.moved && Math.hypot(x - d.x0, y - d.y0) > 4) { d.moved = true; clearTimeout(d.editTimer); }
    return true;
  }
  function end() {
    if (!d) return;
    if (d.lifted) {
      suppressClickUntil = Date.now() + 500;
      const { rows, from, to, row } = d;
      reset();
      if (to !== from && rows[to]) reorderItemsInList(row.dataset.listId, row.dataset.itemId, rows[to].id);
      return;
    }
    reset();
  }
  const rowFrom = (t) => (t.closest && !t.closest('button')) ? t.closest('[data-row-drag]') : null;

  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { reset(); return; }
    const row = rowFrom(e.target);
    if (row) start(row, e.touches[0].clientX, e.touches[0].clientY, 'touch');
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (d && d.kind === 'touch' && move(e.touches[0].clientX, e.touches[0].clientY) && e.cancelable) e.preventDefault();
  }, { passive: false });
  document.addEventListener('touchend', () => { if (d?.kind === 'touch') end(); });
  document.addEventListener('touchcancel', () => { if (d?.kind === 'touch') reset(); });

  // Мышь (десктоп)
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    const row = rowFrom(e.target);
    if (row) start(row, e.clientX, e.clientY, 'mouse');
  });
  document.addEventListener('pointermove', (e) => { if (d?.kind === 'mouse') move(e.clientX, e.clientY); });
  document.addEventListener('pointerup', () => { if (d?.kind === 'mouse') end(); });
  // Не даём родительской карточке списка начать HTML5-перетаскивание
  window.addEventListener('dragstart', (e) => { if (d) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  document.addEventListener('contextmenu', (e) => { if (e.target.closest('.ks-row')) e.preventDefault(); });
  window.addEventListener('click', (e) => {
    if (Date.now() < suppressClickUntil && e.target.closest('.ks-row, .modal-shell')) { e.stopPropagation(); e.preventDefault(); suppressClickUntil = 0; }
  }, true);
})();

// Свайп между разделами (src/swipe.ts)
initSwipeNav({ getActiveTab: () => state.activeTab, goToTab: (tab) => switchActiveTab(tab) });

// Boot Application
state.activeTab = 'recent';
renderApp();
switchActiveTab('recent');
if (!Array.isArray(state.products) || !state.products.length) {
  const userItems = [...state.lists.flatMap(l => l.items), ...state.favorite, ...state.backlog, ...state.recent];
  state.products = seedProducts(BUILTIN_PRODUCTS, userItems, bundledProducts);
  persistState();
}
// «Прочее» → повторная попытка определить отдел (справочник синонимов мог пополниться)
{
  let recat = 0;
  state.products.forEach(p => {
    if (p.cat !== 'other') return;
    const c = guessCategory(p.name, state.products.filter(x => x !== p));
    if (c !== 'other') { p.cat = c; recat++; }
  });
  if (recat) persistState();
}
rebuildPickerProducts();
const productsUi = initProductsUi({
  associations: (name) => getAssoc().suggest(name, new Set(), 8).map(s => ({ name: s.name, reason: REASON_LABEL[s.reason] })),
  aiCategorize: (names) => categorizeWithAI(names, PICKER_CATALOG.map(c => ({ id: c.id, label: c.label })), askGeminiWithBackoff),
  getProducts: () => state.products,
  categories: () => PICKER_CATALOG.map(c => ({ id: c.id, label: c.label, icon: c.icon, group: c.group })),
  tags: PICKER_TAGS,
  iconFor: (name) => pickerIconFor(name),
  formatMoney: (n) => formatMoney(n),
  save: () => saveState(),
  makeUndo: (label) => makeStateUndo(['products'], label),
  toast: (m, undo) => showToast(m, undo || null),
  addToMain: (p) => {
    const est = estimateItemPrice(p.name, p.unit);
    ensureMainList().items.unshift({ id: 'i-' + uniqueSuffix(), name: p.name, qty: 1, unit: p.unit, price: est?.price || 0, priceEstimated: !!est?.estimated, storeName: '', productUrl: buildProductStoreUrl(p.name), cheaperAlt: null, desc: '', checked: false, order: 0 });
    ensureMainList().items.forEach((it, i) => it.order = i);
    saveState();
    showToast(`«${p.name}» добавлен в «Недавние»`);
  },
  onChanged: () => { if (!document.getElementById('addPickerModal')?.classList.contains('hidden')) renderPicker(); },
});
document.getElementById('menuProductsBtn')?.addEventListener('click', () => productsUi.open());
document.getElementById('pickerOpenBaseBtn')?.addEventListener('click', () => productsUi.open(picker.tab === 'catalog' && picker.category ? picker.category : undefined));
const cardsUi = initCards({
  getCards: () => (Array.isArray(state.cards) ? state.cards : (state.cards = [])),
  save: () => persistState(),
  makeUndo: (label) => {
    const undo = makeStateUndo(['cards'], label);
    return () => { undo(); document.dispatchEvent(new CustomEvent('ks:cards-changed')); };
  },
  toast: (m, undo) => showToast(m, undo || null),
  saveFile: (blob, name) => downloadBlob(blob, name),
});
document.getElementById('headerCardsBtn')?.addEventListener('click', () => cardsUi.open());
syncApi = initSync({
  getState: () => state,
  applyRemote: (patch) => applyRemoteState(patch),
  toast: (m) => showToast(m),
  backup: (reason) => createBackup(reason),
  shareText: (text) => shareText(text, (m) => showToast(m)),
});
document.getElementById('menuSyncBtn')?.addEventListener('click', () => syncApi.open());
initBackups({ getSnapshot: buildSnapshot, applySnapshot: (data, label) => applySnapshot(data, label), toast: (m) => showToast(m) });
if (!hadLocalState) {
  // данные WebView пропали (очистка кэша и т.п.) — берём базу из памяти телефона
  readMirror().then(data => { if (data) applySnapshot(data, 'памяти телефона'); });
}
