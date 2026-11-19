/// <reference types="vite/client" />

// Переменные, которые подставляет среда хостинга (Firebase-конфиг для облачной синхронизации).
declare const __firebase_config: string | undefined;
declare const __app_id: string | undefined;
declare const __initial_auth_token: string | undefined;

interface Window {
  KeepShopAutoTranslate?: unknown;
}
