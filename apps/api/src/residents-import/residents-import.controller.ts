// PR-5 (2026-07-05) — endpointy importu mieszkańców z CSV.
//
// Dostępne dla DWÓCH ról (design doc: „Integrator LUB building-admin"):
//   • Integrator:      POST /api/integrator/buildings/:id/residents-import/{dry-run,commit}
//   • Building Admin:  POST /api/building-admin/buildings/:id/residents-import/{dry-run,commit}
//
// Body (JSON): { csv: string } — frontend czyta plik po stronie klienta
// (FileReader) i wysyła surowy tekst. main.ts ma limit body 10 MB, service
// dodatkowo tnie na 2 MB / 2000 wierszy.
//
// Tenant-guard: integrator po Building.adminId (jak IntegratorService),
// BA po buildingIds z JWT (jak guardBuilding w BuildingAdminService).
import {
  Body,
  Controller,
  ForbiddenException,
  NotFoundException,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common'
import { IsString } from 'class-validator'
import { PrismaService } from '../prisma/prisma.service'
import { IntegratorJwtAuthGuard } from '../integrator/integrator-jwt-auth.guard'
import { BuildingAdminJwtAuthGuard } from '../building-admin/building-admin-jwt-auth.guard'
import { ResidentsImportService } from './residents-import.service'

export class ResidentsImportDto {
  @IsString() csv: string
}

@Controller()
export class ResidentsImportController {
  constructor(
    private importService: ResidentsImportService,
    private prisma: PrismaService,
  ) {}

  // ── Integrator ─────────────────────────────────────────────────────────────

  @UseGuards(IntegratorJwtAuthGuard)
  @Post('integrator/buildings/:id/residents-import/dry-run')
  async integratorDryRun(
    @Param('id') id: string,
    @Body() dto: ResidentsImportDto,
    @Request() req: any,
  ) {
    await this.guardIntegrator(+id, req.user.adminId)
    return this.importService.dryRun(+id, dto.csv)
  }

  @UseGuards(IntegratorJwtAuthGuard)
  @Post('integrator/buildings/:id/residents-import/commit')
  async integratorCommit(
    @Param('id') id: string,
    @Body() dto: ResidentsImportDto,
    @Request() req: any,
  ) {
    await this.guardIntegrator(+id, req.user.adminId)
    return this.importService.commit(+id, dto.csv)
  }

  // ── Building Admin ─────────────────────────────────────────────────────────

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('building-admin/buildings/:id/residents-import/dry-run')
  async baDryRun(
    @Param('id') id: string,
    @Body() dto: ResidentsImportDto,
    @Request() req: any,
  ) {
    this.guardBa(+id, req.user.buildingIds)
    return this.importService.dryRun(+id, dto.csv)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('building-admin/buildings/:id/residents-import/commit')
  async baCommit(
    @Param('id') id: string,
    @Body() dto: ResidentsImportDto,
    @Request() req: any,
  ) {
    this.guardBa(+id, req.user.buildingIds)
    return this.importService.commit(+id, dto.csv)
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
