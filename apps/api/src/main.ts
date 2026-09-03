import { NestFactory } from '@nestjs/core'
import { ValidationPipe } from '@nestjs/common'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false })

  const express = require('express')
  app.use(express.json({ limit: '10mb' }))
  app.use(express.urlencoded({ limit: '10mb', extended: true }))

  app.setGlobalPrefix('api')
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
  app.enableCors({
    // Wszystkie subdomeny `*.gatelynk.com` (panel admina, app.gatelynk.com dla
    // guest portalu, ewentualne future) + localhost w dev + jawnie skonfigurowany
    // FRONTEND_URL (legacy/escape hatch). Dopuszczamy też `*.fly.dev` żeby móc
    // testować preview deployy bez ruszania CORS-a.
    //
    // Uwaga: bez tej regexpy `app.gatelynk.com` (Next.js z guest portalem) dostaje
    // 404 na OPTIONS preflight i fetch z portalu kończy się „Brak połączenia".
    origin: (origin, cb) => {
      const allowed: (string | RegExp | undefined)[] = [
        process.env.FRONTEND_URL,
        /^http:\/\/localhost:\d+$/,
        /^https:\/\/([a-z0-9-]+\.)?gatelynk\.com$/,
        /^https:\/\/[a-z0-9-]+\.fly\.dev$/,
      ]
      const ok = !origin || allowed.some((p) => (p instanceof RegExp ? p.test(origin) : p === origin))
      cb(null, ok)
    },
    credentials: true,
  })

  // Bind na 0.0.0.0 (nie 127.0.0.1) — Fly proxy / Docker network potrzebują
  // tego, żeby dostać się do node-a. Nest domyślnie nasłuchiwałby na localhost,
  // co skutkuje [PR01] „no known healthy instances" w logach proxy.
  const port = Number(process.env.PORT ?? 3000)
  await app.listen(port, '0.0.0.0')
  console.log(`GateLynk API running on: http://0.0.0.0:${port}/api`)
}
bootstrap()
