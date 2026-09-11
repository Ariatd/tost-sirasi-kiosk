import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Electron 'file://' üzerinden yükleyecek -> mutlak değil GÖRECELİ yollar şart.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
