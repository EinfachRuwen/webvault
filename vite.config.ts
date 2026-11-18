import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: false,
    // Zwei Einstiegsseiten: die App und die statische Datenschutzerklärung (/datenschutz/, ohne JavaScript).
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        datenschutz: resolve(import.meta.dirname, 'datenschutz/index.html'),
      },
    },
  },
  test: { environment: 'node', testTimeout: 60_000 },
});
