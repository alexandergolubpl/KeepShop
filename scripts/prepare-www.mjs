// Собирает www/ для APK из keepshop_ai.html:
//  - CDN-библиотеки -> локальные копии из vendor/ (приложение стартует без интернета)
//  - подключает native/native-shim.js (файлы, кнопка «Назад», ключ Gemini)
//  - точечные правки под Android WebView
// Запуск: node scripts/prepare-www.mjs   (затем npx cap sync android)
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const www = join(root, 'www');
let html = readFileSync(join(root, 'keepshop_ai.html'), 'utf8');

const patches = [
  ['<script src="https://cdn.tailwindcss.com"></script>', '<script src="vendor/tailwind.js"></script>'],
  ['<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossorigin="" />', '<link rel="stylesheet" href="vendor/leaflet/leaflet.css" />'],
  ['<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin=""></script>', '<script src="vendor/leaflet/leaflet.js"></script>'],
  ['<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>', '<script src="vendor/jszip.min.js"></script>\n  <script src="native-shim.js"></script>'],
  ['"https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js"', '"./vendor/firebase/firebase-app.js"'],
  ['"https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js"', '"./vendor/firebase/firebase-auth.js"'],
  ['"https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js"', '"./vendor/firebase/firebase-firestore.js"'],
  // viewport: учитывать вырез экрана
  ['content="width=device-width, initial-scale=1.0, maximum-scale=5.0"', 'content="width=device-width, initial-scale=1.0, maximum-scale=5.0, viewport-fit=cover"'],
  // Ключ Gemini: берём сохранённый на устройстве, иначе спрашиваем
  ['const apiKey = "";', "const apiKey = (window.KS ? await window.KS.getGeminiKey() : '');\n      if (!apiKey) { showToast('Укажите ключ Gemini AI в меню ⋮'); throw new Error('Gemini key missing'); }"],
  // Сохранение файлов: в WebView <a download> не работает -> системное меню «Поделиться»
  ['function downloadBlob(blob, filename) {', 'function downloadBlob(blob, filename) {\n      if (window.KS && window.KS.isNative) { window.KS.saveAndShare(blob, filename); return; }'],
  // GPS: 4 c мало для холодного старта, плюс время на диалог разрешения
  ['{ timeout: 4000 }', '{ timeout: 20000, maximumAge: 60000, enableHighAccuracy: false }'],
];

for (const [from, to] of patches) {
  const n = html.split(from).length - 1;
  if (n === 0) throw new Error('Patch not applied (text not found): ' + from.slice(0, 80));
  html = html.split(from).join(to);
}

rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });
writeFileSync(join(www, 'index.html'), html);
cpSync(join(root, 'vendor'), join(www, 'vendor'), { recursive: true });
cpSync(join(root, 'native', 'native-shim.js'), join(www, 'native-shim.js'));
console.log('www/ prepared:', patches.length, 'patches applied');
