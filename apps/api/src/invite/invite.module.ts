import { Module } from '@nestjs/common'
import { PrismaModule } from '../prisma/prisma.module'
import { PushModule } from '../push/push.module'
import { GuestPortalModule } from '../guest-portal/guest-portal.module'
import { InviteController } from './invite.controller'
import { InviteService } from './invite.service'

/**
 * InviteModule — nowe endpointy `/api/invite/*` dla strony zaproszenia
 * `apps/web/src/app/i/[token]/`. Spec w `docs/design/guest-invite-2026-05-11/`.
 *
 * Wrapper nad GuestPortalModule (reużywamy walidacje, dispatch do Edge,
 * audit log). Dodaje: lazy-fetch PIN, report-abuse flow, transformację
 * payloadu na shape `Invite` zgodny ze spec frontend-u.
 */
@Module({
  imports: [PrismaModule, PushModule, GuestPortalModule],
  controllers: [InviteController],
  providers: [InviteService],
})
export class InviteModule {}
