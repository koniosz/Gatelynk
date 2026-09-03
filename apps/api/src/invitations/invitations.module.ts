import { Module } from '@nestjs/common'
import { PassportModule } from '@nestjs/passport'
import { InvitationsService } from './invitations.service'
import { InvitationsController } from './invitations.controller'
import { InvitationsAdminController } from './invitations-admin.controller'
import { HouseholdInvitationsService } from './household-invitations.service'
import { HouseholdInvitationsController } from './household-invitations.controller'

@Module({
  imports: [PassportModule],
  providers: [InvitationsService, HouseholdInvitationsService],
  controllers: [InvitationsController, InvitationsAdminController, HouseholdInvitationsController],
  // HouseholdInvitationsService eksportowany dla ResidentModule —
  // endpointy mieszkańca (/resident/household/*) żyją w ResidentController.
  exports: [InvitationsService, HouseholdInvitationsService],
})
export class InvitationsModule {}
