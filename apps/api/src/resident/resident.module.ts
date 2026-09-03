import { Module } from '@nestjs/common'
import { PassportModule } from '@nestjs/passport'
import { AuthModule } from '../auth/auth.module'
import { PrismaModule } from '../prisma/prisma.module'
import { PushModule } from '../push/push.module'
import { EdgeModule } from '../edge/edge.module'
import { AccessEventsModule } from '../access-events/access-events.module'
import { GuestPortalModule } from '../guest-portal/guest-portal.module'
import { InvitationsModule } from '../invitations/invitations.module'
import { ResidentService } from './resident.service'
import { ResidentController } from './resident.controller'
import { ResidentJwtStrategy } from './resident-jwt.strategy'
import { ResidentAssistantController } from './resident-assistant.controller'
import { ResidentAssistantService } from './resident-assistant.service'
import { CourierVisitService } from './courier-visit.service'
import { IntercomCallController } from './intercom-call.controller'
import { IntercomPhonebookController } from './intercom-phonebook.controller'
import { IntercomCallService } from './intercom-call.service'
import { TurnCredentialsService } from './turn-credentials.service'
import { ResidentSmartLockService } from './resident-smart-lock.service'
import { DailyBriefService } from './daily-brief.service'

@Module({
  // GuestPortalModule — approvals drzwi lokalu (2026-07-08): ResidentController
  // woła listPendingApprovals/approveRequest/denyRequest z GuestPortalService.
  // InvitationsModule — Domownicy (2026-08-09): ResidentController woła
  // HouseholdInvitationsService.overview/create/cancel.
  imports: [PassportModule, AuthModule, PrismaModule, PushModule, EdgeModule, AccessEventsModule, GuestPortalModule, InvitationsModule],
  providers: [ResidentService, ResidentJwtStrategy, ResidentAssistantService, CourierVisitService, IntercomCallService, TurnCredentialsService, ResidentSmartLockService, DailyBriefService],
  controllers: [ResidentController, ResidentAssistantController, IntercomCallController, IntercomPhonebookController],
  // CourierVisitService potrzebne na zewnątrz: EdgeGateway woła `recordNewVisit`
  // gdy Edge zgłosi `COURIER_VISIT_NEW`, BA service czyta `listForBuilding`.
  // IntercomCallService — EdgeGateway woła handleInvite/handleEnded/bufferSignal
  // gdy Edge zgłosi INTERCOM_CALL_* (2026-06-13, docs/intercom-akuvox-call.md).
  exports: [CourierVisitService, IntercomCallService],
})
export class ResidentModule {}
