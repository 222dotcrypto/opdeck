import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Обычный Vite-конфиг для веб-фронтенда (его использует Tauri).
// Electron-версия по-прежнему собирается через electron.vite.config.ts.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  resolve: {
    alias: { '@': resolve(__dirname, 'src/renderer/src') },
    // одна копия React на всё приложение (иначе «Invalid hook call»)
    dedupe: ['react', 'react-dom']
  },
  clearScreen: false,
  server: {
    port: 5174,
    strictPort: true
  },
  build: {
    outDir: resolve(__dirname, 'dist-web'),
    emptyOutDir: true
  }
})
