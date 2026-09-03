/**
 * Vite config dla GateLynk Edge SPA.
 *
 * Production: build do `dist/`, Express w `apps/edge/src/main.ts` serwuje
 * `dist/` przez ścieżkę `/ui` (zastępuje stary `public/index.html`, który
 * zostaje w `/ui-legacy/`).
 *
 * Dev: Vite na :5173 z proxy do Edge backendu na :4000 — pełen API
 * (devices, logs, events, status) routowany przez Vite żeby uniknąć CORS.
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  // Wszystkie assety prefixowane `/ui/` — Express servuje SPA pod tym path-em
  base: '/ui/',
  resolve: {
    alias: {
      // Bezpośredni import katalogu driverów z monorepo bez instalowania jako
      // workspace dep (apps/edge/web NIE jest w pnpm-workspace.yaml). Wskazujemy
      // na ŹRÓDŁA TS żeby tsc + Vite tree-shake działały — wszystkie typy są
      // dostępne bez konieczności `pnpm build` w `packages/device-drivers`.
      '@gatelynk/device-drivers': path.resolve(
        __dirname, '../../../packages/device-drivers/src/index.ts',
      ),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Source maps OFF na produkcji — Edge to LAN-only, instalator nie potrzebuje,
    // a oszczędza ~50% rozmiaru bundle.
    sourcemap: false,
    // Manual chunks — wydziel React/Wouter/Lucide żeby cache działał osobno.
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'router': ['wouter'],
          'icons': ['lucide-react'],
        },
      },
    },
  },
  server: {
    port: 5173,
    // Proxy do Edge backendu (NestJS na :4000) — Vite forwarduje API
    // requesty, dev mode jak na produkcji.
    proxy: {
      '/devices':  'http://localhost:4000',
      '/logs':     'http://localhost:4000',
      '/events':   'http://localhost:4000',
      '/status':   'http://localhost:4000',
      '/activation': 'http://localhost:4000',
      '/tunnel':   'http://localhost:4000',
      '/api':      'http://localhost:4000',
    },
  },
})
