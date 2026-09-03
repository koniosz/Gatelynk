import { Module } from '@nestjs/common'
import { PrismaModule } from '../prisma/prisma.module'
import { EdgeModule } from '../edge/edge.module'
import { PushModule } from '../push/push.module'
import { AccessEventsModule } from '../access-events/access-events.module'
import { GuestsExpiryService } from './guests-expiry.service'
import { GuestsValidationService } from './guests-validation.service'
import { GuestsEdgeController } from './guests-edge.controller'

/**
 * GuestsModule — Faza 2B/3 Villa Natura.
 *
 * Zbiera w jednym miejscu cross-cutting funkcjonalność dotyczącą gości:
 *   - Cron (`GuestsExpiryService`) — flip ACTIVE → EXPIRED + plate cleanup.
 *   - Walidacja PIN/plate + audit `usedAt` + push do mieszkańca
 *     (`GuestsValidationService`).
 *   - Endpoint `/api/edge/validate-pin` dla Edge (`GuestsEdgeController`).
 *
 * CRUD samego zaproszenia (POST/PATCH/DELETE) został w odpowiednich modułach
 * roli (`resident`, `concierge`, `building-admin`) — żadnego ruszania.
 *
 * Eksportujemy `GuestsValidationService`, bo `LprReadsService` woła
 * `matchPlate(...)` po zapisie eventu LPR_READ.
 */
@Module({
  imports: [PrismaModule, EdgeModule, PushModule, AccessEventsModule],
  providers: [GuestsExpiryService, GuestsValidationService],
  controllers: [GuestsEdgeController],
  exports: [GuestsValidationService],
})
export class GuestsModule {}
