import { PushMediaController } from './push-media.controller'
import { Module } from '@nestjs/common'
import { PrismaModule } from '../prisma/prisma.module'
import { IntegratorModule } from '../integrator/integrator.module'
import { BuildingAdminModule } from '../building-admin/building-admin.module'
import { ConciergeModule } from '../concierge/concierge.module'
import { ResidentModule } from '../resident/resident.module'
import { GuestsModule } from '../guests/guests.module'
import { AccessEventsModule } from '../access-events/access-events.module'
import { PushModule } from '../push/push.module'
import { LprReadsService } from './lpr-reads.service'
import {
  IntegratorLprReadsController,
  BuildingAdminLprReadsController,
  ConciergeLprReadsController,
  ResidentLprReadsController,
} from './lpr-reads.controller'

/**
 * Groups LPR-reads wiring in one place. We import the four role modules for
 * their JWT strategies (the `AuthGuard('jwt-*')` guards rely on those
 * strategies being registered in the app).
 */
@Module({
  imports: [
    PrismaModule,
    IntegratorModule,
    BuildingAdminModule,
    ConciergeModule,
    ResidentModule,
    GuestsModule,
    AccessEventsModule,
    // 2026-07-30 — push OVERSTAY do adminów budynku (przepustka wyjazdowa).
    PushModule,
  ],
  controllers: [
    PushMediaController,
    IntegratorLprReadsController,
    BuildingAdminLprReadsController,
    ConciergeLprReadsController,
    ResidentLprReadsController,
  ],
  providers: [LprReadsService],
  exports: [LprReadsService],
})
export class LprReadsModule {}
