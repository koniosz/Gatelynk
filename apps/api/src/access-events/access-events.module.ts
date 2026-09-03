import { Module } from '@nestjs/common'
import { PrismaModule } from '../prisma/prisma.module'
import { AccessEventsService } from './access-events.service'

/**
 * Faza 3 Villa Natura — moduł audytu wejść.
 *
 * Wystawia tylko serwis (do DI w innych modułach: LprReads, GuestsValidation,
 * AccessPoints). REST endpointy żyją po stronie kontrolerów per-rola
 * (resident/concierge/building-admin), żeby nie duplikować JWT guard-ów.
 */
@Module({
  imports: [PrismaModule],
  providers: [AccessEventsService],
  exports: [AccessEventsService],
})
export class AccessEventsModule {}
