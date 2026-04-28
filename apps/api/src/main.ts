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
    origin: (origin, cb) => {
      // Allow localhost on any port in dev + configured FRONTEND_URL in prod
      const allowed = [process.env.FRONTEND_URL, /^http:\/\/localhost:\d+$/]
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
