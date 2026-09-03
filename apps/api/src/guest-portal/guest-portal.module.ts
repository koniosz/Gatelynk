import { Module } from '@nestjs/common'
import { PrismaModule } from '../prisma/prisma.module'
import { EdgeModule } from '../edge/edge.module'
import { PushModule } from '../push/push.module'
import { AccessEventsModule } from '../access-events/access-events.module'
import { GuestPortalController } from './guest-portal.controller'
import { GuestPortalService } from './guest-portal.service'

/**
 * GuestPortalModule — public-facing portal dla gości (bezkontaktowy dostęp).
 *
 * Nie importuje GuestsModule — operuje bezpośrednio na tabeli `guests` przez
 * raw SQL (PrismaService) i `EdgeGateway` z EdgeModule. To zostawia
 * GuestsModule (resident/concierge admin paths) bez circular dependency.
 *
 * PushModule dołączony żeby przy first-use (gość kliknie w portal) wysłać
 * powiadomienie do mieszkańca-gospodarza („🚪 Gość X otworzył wjazd").
 */
@Module({
  imports: [PrismaModule, EdgeModule, PushModule, AccessEventsModule],
  controllers: [GuestPortalController],
  providers: [GuestPortalService],
  // `GuestPortalService` exportowany — InviteModule (Faza Guest Invite v2,
  // 2026-05-11) buduje endpointy `/api/invite/*` jako wrapper z transformacją
  // payloadu na model `Invite` ze spec. Reużywa walidacji, rate-limitu i
  // dispatch-u do Edge z guest-portalu.
  exports: [GuestPortalService],
})
export class GuestPortalModule {}
