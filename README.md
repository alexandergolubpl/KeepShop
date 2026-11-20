# KeepShop

**English** · [Русский](README.ru.md)

KeepShop is a shopping-list app for Android (and the web) with a product database, price estimates, recipes, AI helpers and a loyalty-card wallet. The interface is in Russian; product search links are tuned for Polish stores (Biedronka, Lidl, Żabka, Auchan, Carrefour, Kaufland…).

Your data stays on your device unless you turn on **family sharing**: then it is stored in the shared family space in Firebase, readable only by family members. AI requests that you start yourself go to Google Gemini with your own API key.

## Features

### Shopping lists
- **Recent** (the first tab): your main, current shopping list. You can show it as compact rows or detailed cards.
  - Tap a row to mark it as taken. Taken items stay where they are.
  - Hold an item and drag it to reorder; normal swipes still scroll the list.
  - Hold an item longer, or tap its quantity, to edit it.
- **Lists**: any number of extra lists, each with its own color, sorting, collaborators and view mode.
- **Undo** for every deletion and bulk change, via a toast button or Ctrl+Z.
- **Swipe** left or right to switch sections. You can pick the transition effect: slide, 3D cube, cards, or none.

### Adding products
- **Picker** window with four tabs: Popular, Catalog (store departments plus filters such as vegetarian, vegan, keto, gluten-free, high-protein, frozen), Recent, and **From a dish**.
- **From a dish:** type a dish name and get the ingredient list.
  - 25 built-in recipes work offline.
  - Any other dish is handled by Gemini AI.
  - Quantities scale with the number of servings.
- **"Often bought together" suggestions** appear after you add an item, for example spaghetti → parmesan, minced meat, garlic. They come from four sources:
  - your purchase history (items bought on the same day);
  - your own manual links;
  - recipes;
  - typical pairs.

### Product database
- One editable catalog that is independent of your lists. It ships with ~440 products that already have departments, tags and approximate prices (`src/data/products.json`).
- You can add, edit and delete products, link related products and filter by department. AI can sort the "Other" department into proper departments.
- Every new item you add to a list is added to the database automatically.

### Prices
- Approximate prices (marked **≈**) come from four sources:
  - your price history;
  - the product database;
  - a built-in price table with word forms and synonyms;
  - Gemini AI for anything unknown.
- Price history with a chart for every product.
- **Note:** the "📍 Prices" store comparison on the map is a **simulation**. Store chains have no public price API, so its results are estimates and are marked ≈.

### Loyalty cards (inspired by Catima)
- You can add a card in three ways: **scan it with the camera**, decode the barcode from a **photo**, or type it in by hand.
- 13 barcode formats: QR, EAN-13/8, UPC-A/E, Code 128/39/93, ITF, PDF417, Aztec, Data Matrix, Codabar.
- Brand colors fill in automatically for known chains. You can store a balance, an expiry date, notes, front and back photos, and mark favorites.
- The list can be shown as rows or as color-filled tiles. Tap the barcode to open it full screen.
- **Import from Catima**: the ZIP export with photos, or `catima.csv`. Simple CSV files with store and number columns are also accepted. **Export to Catima** produces a ZIP.

### Family sharing
- One shared space for the whole family: lists, "Recent", the product database, purchase history, prices and loyalty cards are the same on every phone.
- Changes reach the other phones in about a second. Without a network the app keeps working, and changes sync automatically when the connection returns.
- To invite someone, tap "Invite to family" and send the 8-character code (valid for 7 days). The other person opens menu ⋮ → "Family sharing" and enters the code. Their previous data is backed up first, then replaced with the family's data.
- Phones sign in anonymously, so no account or password is needed. Only family members can read or change the family's data, which is enforced by Firestore security rules (`firestore.rules`).
- The owner sees all members and can remove one; anyone can leave the family, and their data stays on their phone.

### Backups
- After every change, the database is mirrored to the phone's internal storage and restored automatically if the WebView data is lost.
- Automatic backups are made daily or weekly to `Documents/KeepShop/`. That folder is visible in a file manager and survives uninstalling the app. The 10 most recent backups are kept.
- You can restore a backup with undo, or share it to Google Drive, Telegram or e-mail. Import and export use the same file format.

### Other
- Google Keep import, AI receipt parser, statistics, auto-translation of product names for local store search, dark theme, Android back button support.

## Install

Download the APK from [Releases](../../releases). On the phone, allow installing apps from this source, then open the file.

Requires Android 6.0+ (API 23+). To use the AI features, enter a free Gemini API key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey) under menu ⋮ → "🔑 Gemini AI key". The key is stored only on your device.

## Family sharing setup (for your own build)

Family sharing uses Firebase. The project config is in `src/firebase-config.ts`, and the shipped APK already points to the KeepShop project. To use your own Firebase project:

1. In the [Firebase console](https://console.firebase.google.com) create a project and add a **Web app**. Copy its `firebaseConfig` into `src/firebase-config.ts`.
2. Under **Authentication → Sign-in method**, enable **Anonymous**.
3. Create a **Firestore Database** (production mode). Then publish the rules from `firestore.rules` (Rules tab), or run `npx firebase-tools deploy --only firestore:rules`.

To test locally with two "phones", run `npx firebase-tools emulators:start --only auth,firestore` and open the app with `?emu=1`.

## Build from source

Requirements: Node.js 20+, JDK 21 and the Android SDK (platform 35, build-tools 35).

```bash
npm install
npm run dev            # dev server at http://localhost:5173
npm run build          # type check + production build to www/
npm run build:single   # the whole app as one HTML file: dist-single/keepshop_ai.html
npm run sync           # build + copy into the Android project (Capacitor)
```

To build the Android APK:

```bash
cd android
./gradlew assembleDebug      # android/app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease    # signed if android/keystore.properties exists
```

For a signed release, copy `android/keystore.properties.example` to `android/keystore.properties` and point it at your keystore. Never commit the keystore or its passwords.

## Project structure

| Path | Contents |
|---|---|
| `index.html` | markup |
| `src/app.ts` | main app logic (being split into modules) |
| `src/products.ts`, `src/data/products.json` | product database and the shipped catalog |
| `src/cards.ts`, `src/cards-io.ts` | loyalty cards, Catima import/export |
| `src/associations.ts` | "often bought together" |
| `src/price-hints.ts`, `src/ai-prices.ts` | price estimates and AI categorization |
| `src/backup.ts` | mirror, automatic backups, restore |
| `src/sync.ts`, `firestore.rules` | family sharing: Firestore sync, invites, security rules |
| `src/swipe.ts` | swipe navigation and effects |
| `src/native.ts` | Capacitor bridge: files, sharing, back button, Gemini key |
| `android/` | Capacitor Android project |

Tech stack: Vite, TypeScript, Tailwind CSS, Capacitor 7, Leaflet, Firebase (optional cloud sync), bwip-js and ZXing (barcodes), JSZip.
