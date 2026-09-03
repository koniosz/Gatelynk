// PR-6 (2026-07-05) — zaproszenia mieszkańców dla Integratora i BA.
//
// Design doc (Faza 6): moduł invitations istniał tylko za guardem `jwt`
// (legacy superadmin). Tu dokładamy te same operacje w kontekście:
//   • Integrator:      /api/integrator/buildings/:id/resident-invitations*
//   • Building Admin:  /api/building-admin/buildings/:id/resident-invitations*
//
// Operacje:
//   GET  …/resident-invitations            → lista mieszkańców ze statusem
//                                            (active/invited/expired/no_email/not_invited)
//   POST …/resident-invitations/bulk-send  → wyślij do wszystkich bez konta
//   POST …/resident-invitations/:residentId/resend → ponów pojedynczo
//
// Tenant-guard identyczny jak ResidentsImportController.
import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { IntegratorJwtAuthGuard } from '../integrator/integrator-jwt-auth.guard'
import { BuildingAdminJwtAuthGuard } from '../building-admin/building-admin-jwt-auth.guard'
import { InvitationsService } from './invitations.service'

@Controller()
export class InvitationsAdminController {
  constructor(
    private invitationsService: InvitationsService,
    private prisma: PrismaService,
  ) {}

  // ── Integrator ─────────────────────────────────────────────────────────────

  @UseGuards(IntegratorJwtAuthGuard)
  @Get('integrator/buildings/:id/resident-invitations')
  async integratorList(@Param('id') id: string, @Request() req: any) {
    await this.guardIntegrator(+id, req.user.adminId)
    return this.invitationsService.listResidentStatuses(+id)
  }

  @UseGuards(IntegratorJwtAuthGuard)
  @Post('integrator/buildings/:id/resident-invitations/bulk-send')
  async integratorBulkSend(@Param('id') id: string, @Request() req: any) {
    await this.guardIntegrator(+id, req.user.adminId)
    return this.invitationsService.bulkSend(+id)
  }

  @UseGuards(IntegratorJwtAuthGuard)
  @Post('integrator/buildings/:id/resident-invitations/:residentId/resend')
  async integratorResend(
    @Param('id') id: string,
    @Param('residentId') residentId: string,
    @Request() req: any,
  ) {
    await this.guardIntegrator(+id, req.user.adminId)
    return this.invitationsService.resendForResident(+id, +residentId)
  }

  // ── Building Admin ─────────────────────────────────────────────────────────

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('building-admin/buildings/:id/resident-invitations')
  baList(@Param('id') id: string, @Request() req: any) {
    this.guardBa(+id, req.user.buildingIds)
    return this.invitationsService.listResidentStatuses(+id)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('building-admin/buildings/:id/resident-invitations/bulk-send')
  baBulkSend(@Param('id') id: string, @Request() req: any) {
    this.guardBa(+id, req.user.buildingIds)
    return this.invitationsService.bulkSend(+id)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('building-admin/buildings/:id/resident-invitations/:residentId/resend')
  baResend(
    @Param('id') id: string,
    @Param('residentId') residentId: string,
    @Request() req: any,
  ) {
    this.guardBa(+id, req.user.buildingIds)
    return this.invitationsService.resendForResident(+id, +residentId)
  }

  // ── Tenant guards ──────────────────────────────────────────────────────────

  private async guardIntegrator(buildingId: number, adminId: number) {
    const building = await this.prisma.building.findFirst({
      where: { id: buildingId, adminId, isArchived: false },
      select: { id: true },
    })
    if (!building) throw new NotFoundException('Budynek nie istnieje')
  }

  private guardBa(buildingId: number, buildingIds: number[] | undefined) {
    if (!Array.isArray(buildingIds) || !buildingIds.includes(buildingId)) {
      throw new ForbiddenException()
    }
  }
}
