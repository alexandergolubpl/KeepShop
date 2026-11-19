import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// npm run build         → www/ для Capacitor (APK) и обычного хостинга
// npm run build:single  → dist-single/keepshop_ai.html: всё приложение одним файлом
export default defineConfig(({ mode }) => {
  const single = mode === 'single';
  return {
    // Относительные пути: сборка открывается и из Capacitor, и из подпапки сайта
    base: './',
    plugins: single ? [viteSingleFile()] : [],
    build: {
      outDir: single ? 'dist-single' : 'www',   // www — webDir Capacitor
      emptyOutDir: true,
      target: 'es2022',
      chunkSizeWarningLimit: 1500,
    },
    server: { port: 5173, host: true },
  };
});
