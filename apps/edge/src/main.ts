import 'reflect-metadata'
// Edge runs in a trusted LAN environment — intercom/camera devices use self-signed certs
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
import { NestFactory } from '@nestjs/core'
import { ValidationPipe, Logger } from '@nestjs/common'
import { AppModule } from './app.module'
import { UiAuthService } from './ui-auth/ui-auth.service'
import { createUiAuthMiddleware } from './ui-auth/ui-auth.middleware'
import { join, dirname } from 'path'
import * as fs from 'fs'
import * as express from 'express'

const logger = new Logger('Bootstrap')

/**
 * Pre-bootstrap restore handler.
 *
 * Wywołany PRZED `NestFactory.create()` — w tym momencie żaden moduł NIE ma
 * otwartego handle do sqlite. Bezpieczne miejsce na zamianę store.db plików.
 *
 * Flag-file pattern:
 *  • POST /api/system/restore zapisuje upload + tworzy `.restore-pending`
 *  • setTimeout(exit(0), 2s) → pm2 restart-uje proces
 *  • Bootstrap widzi flag → swap store.db ze stagingu → kasuje flag
 *  • Aktualny store.db idzie do `store.db.before-restore-<ts>` (defense
 *    in depth — gdyby backup był uszkodzony, można cofnąć przez pm2 stop +
 *    ręczny mv).
 *
 * Snapshots restore (opcjonalny — jeśli backup zawierał lpr-snapshots dir):
 *   staging/lpr-snapshots/* → data/lpr-snapshots/* (overwrite, nie kasuje
 *   istniejących plików których nie ma w backupie — merge semantyka).
 */
function applyPendingRestoreIfAny() {
  // Resolve data dir — to ten sam path co StoreService używa (storePath z env).
  // W typowym deploy: ~/gatelynk-edge/data/store.db
  const storePath = process.env.STORE_PATH ?? join(process.cwd(), 'data', 'store.db')
  const dataDir = dirname(storePath)
  const flagPath = join(dataDir, '.restore-pending')

  if (!fs.existsSync(flagPath)) return

  logger.warn(`🔄 Restore flag detected at ${flagPath} — applying staged backup`)

  try {
    const flagJson = JSON.parse(fs.readFileSync(flagPath, 'utf-8')) as { stagingDir?: string }
    const stagingDir = flagJson.stagingDir
    if (!stagingDir || !fs.existsSync(stagingDir)) {
      throw new Error(`Staging dir ${stagingDir} missing — aborting restore`)
    }

    const stagedDb = join(stagingDir, 'store.db')
    if (!fs.existsSync(stagedDb)) {
      throw new Error(`store.db nie znalezione w stagingu ${stagedDb}`)
    }

    // 1. Backup aktualnej store.db do .before-restore-<ts> (safety net)
    if (fs.existsSync(storePath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const safetyPath = `${storePath}.before-restore-${stamp}`
      fs.copyFileSync(storePath, safetyPath)
      logger.log(`Old store.db backed up to ${safetyPath}`)
    }

    // 2. Wgraj nowe store.db
    fs.copyFileSync(stagedDb, storePath)
    logger.log(`✓ store.db replaced from staging (${fs.statSync(stagedDb).size} bytes)`)

    // 3. (Opt) snapshots — merge directory
    const stagedSnapshots = join(stagingDir, 'lpr-snapshots')
    if (fs.existsSync(stagedSnapshots)) {
      const targetSnapshots = join(dataDir, 'lpr-snapshots')
      if (!fs.existsSync(targetSnapshots)) fs.mkdirSync(targetSnapshots, { recursive: true })
      const files = fs.readdirSync(stagedSnapshots)
      let copied = 0
      for (const f of files) {
        try {
          fs.copyFileSync(join(stagedSnapshots, f), join(targetSnapshots, f))
          copied++
        } catch { /* ignore — skip files Edge can't write */ }
      }
      logger.log(`✓ ${copied} snapshots restored from staging`)
    }

    // 4. Cleanup staging + flag
    fs.rmSync(stagingDir, { recursive: true, force: true })
    fs.unlinkSync(flagPath)
    logger.log(`✓ Restore complete — booting normally`)
  } catch (err: any) {
    logger.error(`Restore failed: ${err.message} — booting with EXISTING store.db (no changes applied)`)
    // Try to keep flag for diagnosis if it wasn't ours to remove
    try { fs.renameSync(flagPath, flagPath + '.failed') } catch { /* ignore */ }
  }
}

async function bootstrap() {
  // CRITICAL: zanim NestFactory.create otworzy sqlite, sprawdź czy ktoś
  // zostawił flag-file z pending restore.
  applyPendingRestoreIfAny()

  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'warn', 'error', 'debug'],
  })

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
  app.enableCors({ origin: '*' })

  // Hikvision cameras POST ANPR events as application/xml or multipart/form-data;
  // body-parser won't touch those, so capture the raw body as a Buffer.
  app.use('/events/lpr', express.raw({ type: '*/*', limit: '10mb' }))

  // ── PR-2 (2026-07): PIN guard dla Edge UI ────────────────────────────────
  // Middleware MUSI być zarejestrowany PRZED statycznymi handlerami /ui —
  // chroni statyczne strony + wszystkie mutujące endpointy Nest (router
  // Nest montuje się dopiero w app.init()/listen(), czyli za nami).
  // Ścieżki maszynowe (Akuvox, kamery, Cloud przez Tailscale, ai-prototype)
  // są na allowliście — patrz ui-auth.middleware.ts.
  // Kill-switch: EDGE_UI_AUTH_ENABLED=false przywraca stare zachowanie.
  const uiAuth = app.get(UiAuthService)
  app.use(createUiAuthMiddleware(uiAuth))

  // ── Static UI ────────────────────────────────────────────────────────────
  // /ui          → nowy React + Vite SPA (apps/edge/web/dist) — handoff redesign
  //                (2026-05-14). SPA history-routing: dla nieznanych ścieżek
  //                pod /ui/ serwuj index.html (fallback dla wouter/React-Router).
  // /ui-legacy   → stary index.html + wizard.html (apps/edge/public). NA RAZIE
  //                zostaje bo `AddDeviceMenu` linkuje do `/ui-legacy/wizard.html`
  //                (wizard nie został jeszcze przepisany na React — TODO faza E-8).
  //                Po migracji wizarda usuwamy public/ i ten alias.
  // Jeśli `web/dist` nie istnieje (deploy bez frontend build) — fallback do
  // public/ pod /ui.
  const newUiDist = join(__dirname, '..', 'web', 'dist')
  const legacyPublic = join(__dirname, '..', 'public')
  const fs = require('fs') as typeof import('fs')
  const hasNewUi = fs.existsSync(join(newUiDist, 'index.html'))

  if (hasNewUi) {
    // FAZA 8.h.6 (2026-06-05) — AI Engine standalone page. Strona istnieje
    // tylko w public/ (Alpine.js, prosta). Alias PRZED static + SPA fallback
    // bo inaczej SPA index.html "zjadałby" route. Jeden plik, niezależny
    // od React routingu — wystarczy odświeżenie żeby refreshować stan.
    // Używamy `app.use()` z middleware bo `app.get()` na NestApp koliduje
    // z DI overload (NestJS resolver vs Express HTTP route).
    app.use('/ui/ai-engine.html', (_req: any, res: any) => {
      res.sendFile(join(legacyPublic, 'ai-engine.html'))
    })
    // Asset bundles (`/ui/assets/*`) + favicon — serwuj statycznie z dist.
    app.use('/ui', express.static(newUiDist, { index: false }))
    // SPA fallback: dowolny GET pod `/ui/*` (poza assetami) → index.html.
    // Wouter robi history-routing, React renderuje route na podstawie URL.
    // Używamy Express middleware (nie NestJS @Controller) bo to czysto static.
    app.use('/ui', (req: any, res: any, next: any) => {
      if (req.method !== 'GET') return next()
      if (req.path.match(/\.(js|css|svg|png|jpg|jpeg|woff2?|ico|map)$/)) return next()
      res.sendFile(join(newUiDist, 'index.html'))
    })
    logger.log(`UI v2 (React) z ${newUiDist}`)
  } else {
    // Fallback gdy deploy tylko backend bez frontu (np. CI bez `npm run build`)
    app.use('/ui', express.static(legacyPublic))
    logger.warn(`web/dist nie istnieje — /ui używa legacy public/ (przezbroj wcześniej Vite build)`)
  }
  // Legacy panel zawsze dostępny pod osobnym path-em (do diagnostyki gdy SPA się rozjedzie).
  app.use('/ui-legacy', express.static(legacyPublic))

  const port = process.env.PORT ?? 4000
  await app.listen(port)

  logger.log(`GateLynk Edge running on http://localhost:${port}`)
  logger.log(`Local UI panel: http://localhost:${port}/ui`)
  logger.log(`Legacy UI:      http://localhost:${port}/ui-legacy`)
  logger.log(`Build: ${process.env.npm_package_version ?? '0.1.0'}`)
}

bootstrap()
