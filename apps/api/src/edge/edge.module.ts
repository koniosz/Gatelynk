import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { JwtModule } from '@nestjs/jwt'
import { EdgeService } from './edge.service'
import { EdgeController } from './edge.controller'
import { EdgeGateway } from './edge.gateway'
import { EdgeOutboxService } from './edge-outbox.service'
import { ActivationThrottleService } from './activation-throttle.service'
import { PrismaModule } from '../prisma/prisma.module'

/**
 * Sekret JWT MUSI być wczytywany przez `ConfigService` (czyli po
 * `ConfigModule.forRoot()`). Wcześniej był `process.env.JWT_SECRET ?? 'fallback'`
 * evaluowane przy importowaniu modułu — dało to klasycznego buga: API
 * używało defaultu, zanim `.env` zostało wczytane, a wyglądało jakby było OK.
 *
 * `getOrThrow` = brak `JWT_SECRET` w env crashuje aplikację przy starcie
 * z czytelnym błędem zamiast cichego fallbacku do bezpiecznie wyglądającego
 * stringa, który de facto oznacza „każdy token przejdzie".
 */
@Module({
  imports: [
    PrismaModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        // `expiresIn` chce union typ z `ms` package (np. `'24h'`) — runtime
        // dostaje plain string, więc cast jest bezpieczny.
        signOptions: {
          expiresIn: (config.get<string>('JWT_EXPIRES_IN') ?? '24h') as `${number}${'s'|'m'|'h'|'d'|'w'|'y'}`,
        },
      }),
    }),
  ],
  providers: [EdgeService, EdgeGateway, EdgeOutboxService, ActivationThrottleService],
  controllers: [EdgeController],
  exports: [EdgeService, EdgeGateway, EdgeOutboxService],
})
export class EdgeModule {}
