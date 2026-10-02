import { Body, Controller, ForbiddenException, Get, Param, Patch, Query, Request, Res, UseGuards, BadRequestException } from '@nestjs/common'
import type { Response } from 'express'
import { AuthGuard } from '@nestjs/passport'
import { AnomalyEventsService } from './anomaly-events.service'
import { PrismaService } from '../prisma/prisma.service'
import {
  hasPermission,
  normalizePermissions,
  featKey,
  FEATURE_DISABLED_CODE,
  FEATURE_DISABLED_MESSAGE,
} from '../buildings/feature-permissions.constants'

/**
 * Resident endpointy:
 *   GET   /api/resident/anomaly-events
 *   PATCH /api/resident/profile/notify-anomalies  { enabled: boolean }
 *
 * Resident widzi feed swojego budynku (read-only — nie może resolve/false-positive).
 * Toggle `notifyAnomalies` to świadomy opt-in z poziomu iOS Profile.
 */
@Controller('resident')
export class AnomalyEventsResidentController {
  constructor(
    private readonly svc: AnomalyEventsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('anomaly-events')
  @UseGuards(AuthGuard('jwt-resident'))
  async list(
    @Request() req: any,
    @Query('since_hours') sinceHoursRaw?: string,
    @Query('limit') limitRaw?: string,
  ) {
    // FAZA e (2026-06-02) — guard `feat_fall_detection`.
    await this.requireFallDetection(req.user.buildingId)
    return this.svc.listForBuilding(req.user.buildingId, {
      sinceHours: sinceHoursRaw ? +sinceHoursRaw : undefined,
      limit: limitRaw ? +limitRaw : undefined,
      // Resident widzi tylko nieobsłużone (mniej szumu) — historię może
      // przejrzeć poprzez `?since_hours=168` jeśli zechce.
      unresolvedOnly: false,
    })
  }

  private async requireFallDetection(buildingId: number) {
    const rows = await this.prisma.$queryRaw<{ featurePermissions: unknown }[]>`
      SELECT "featurePermissions" FROM "buildings" WHERE id = ${buildingId} LIMIT 1
    `
    const perms = normalizePermissions(rows[0]?.featurePermissions)
    if (!hasPermission(perms, 'resident', featKey('fall_detection'))) {
      throw new ForbiddenException({
        message: FEATURE_DISABLED_MESSAGE,
        code: FEATURE_DISABLED_CODE,
        feature: 'fall_detection',
      })
    }
  }

  /**
   * Opt-in dla powiadomień o zagrożeniach (upadek osoby, w przyszłości pożar/intruz).
   * Domyślnie OFF — UI musi pokazać disclaimer "nie jest substytutem 112,
   * możliwe fałszywe alarmy" przed pierwszym włączeniem.
   */
  @Patch('profile/notify-anomalies')
  @UseGuards(AuthGuard('jwt-resident'))
  async updateOptIn(@Request() req: any, @Body() body: { enabled: boolean }) {
    const enabled = body?.enabled === true
    await this.prisma.$executeRaw`
      UPDATE "residents"
         SET "notifyAnomalies" = ${enabled}
       WHERE id = ${req.user.residentId}
    `
    return { ok: true, notifyAnomalies: enabled }
  }

  /**
   * 2026-10-02 — powiadomienie o przyjeździe śmieciarki. Wybór mieszkańca ma
   * pierwszeństwo nad ustawieniem administratora (buildings.wasteTruckNotifyAll).
   */
  @Patch('profile/notify-waste-truck')
  @UseGuards(AuthGuard('jwt-resident'))
  async updateWasteTruck(@Request() req: any, @Body() body: { enabled: boolean }) {
    if (typeof body?.enabled !== 'boolean') {
      throw new BadRequestException('enabled musi być true/false')
    }
    await this.prisma.$executeRaw`
      UPDATE "residents"
         SET "notifyWasteTruck" = ${body.enabled}
       WHERE id = ${req.user.residentId}
    `
    return { ok: true, notifyWasteTruck: body.enabled }
  }

  // Mieszkaniec może pobrać JPEG anomalii ze swojego budynku (read-only).
  @Get('anomaly-events/:eventId/image')
  @UseGuards(AuthGuard('jwt-resident'))
  async image(@Param('eventId') eventId: string, @Request() req: any, @Res() res: Response) {
    return this.svc.streamImage(eventId, [req.user.buildingId], res)
  }
}
