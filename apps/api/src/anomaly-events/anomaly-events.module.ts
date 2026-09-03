import { Module } from '@nestjs/common'
import { PassportModule } from '@nestjs/passport'
import { PrismaModule } from '../prisma/prisma.module'
import { PushModule } from '../push/push.module'
import { AnomalyEventsService } from './anomaly-events.service'
import { AnomalyEventsBaController } from './anomaly-events-ba.controller'
import { AnomalyEventsConciergeController } from './anomaly-events-concierge.controller'
import { AnomalyEventsResidentController } from './anomaly-events-resident.controller'

/**
 * Anomaly events — fall detection (i przyszłe: fire, intruder).
 *
 * Service jest exportowany żeby `EdgeGateway` mógł go zinjectować lazy
 * (przez ModuleRef, podobnie jak LprReadsService/GuestsValidationService).
 *
 * Guard-y (BuildingAdminJwtAuthGuard, ConciergeJwtAuthGuard, jwt-resident)
 * korzystają z Passport strategy globalnie zarejestrowanej w odpowiednich
 * modułach (BuildingAdminModule/ConciergeModule/ResidentModule) — które są
 * już zaimportowane w AppModule. Nie importujemy ich tutaj żeby uniknąć
 * cyklu (te moduły importują EdgeModule, do którego dołączymy lazy resolver).
 */
@Module({
  imports: [PassportModule, PrismaModule, PushModule],
  providers: [AnomalyEventsService],
  controllers: [
    AnomalyEventsBaController,
    AnomalyEventsConciergeController,
    AnomalyEventsResidentController,
  ],
  exports: [AnomalyEventsService],
})
export class AnomalyEventsModule {}
