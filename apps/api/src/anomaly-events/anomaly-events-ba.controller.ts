import { Body, Controller, ForbiddenException, Get, Param, Patch, Query, Request, Res, UseGuards } from '@nestjs/common'
import type { Response } from 'express'
import { BuildingAdminJwtAuthGuard } from '../building-admin/building-admin-jwt-auth.guard'
import { AnomalyEventsService } from './anomaly-events.service'

/**
 * BA endpointy dla anomaly-events:
 *   GET   /api/building-admin/buildings/:id/anomaly-events
 *   PATCH /api/building-admin/anomaly-events/:eventId/resolve
 *   PATCH /api/building-admin/anomaly-events/:eventId/false-positive
 *
 * Guard: jwt-building-admin + sprawdzenie `req.user.buildingIds` żeby admin
 * jednego budynku nie czytał drugiego.
 */
@Controller('building-admin')
export class AnomalyEventsBaController {
  constructor(private readonly svc: AnomalyEventsService) {}

  @Get('buildings/:id/anomaly-events')
  @UseGuards(BuildingAdminJwtAuthGuard)
  async list(
    @Param('id') id: string,
    @Request() req: any,
    @Query('since_hours') sinceHoursRaw?: string,
    @Query('limit') limitRaw?: string,
    @Query('unresolved') unresolvedRaw?: string,
  ) {
    const buildingId = +id
    if (!req.user.buildingIds?.includes(buildingId)) {
      throw new ForbiddenException()
    }
    return this.svc.listForBuilding(buildingId, {
      sinceHours: sinceHoursRaw ? +sinceHoursRaw : undefined,
      limit: limitRaw ? +limitRaw : undefined,
      unresolvedOnly: unresolvedRaw === '1' || unresolvedRaw === 'true',
    })
  }

  @Patch('anomaly-events/:eventId/resolve')
  @UseGuards(BuildingAdminJwtAuthGuard)
  async resolve(@Param('eventId') eventId: string, @Request() req: any) {
    return this.svc.resolve(eventId, 'BA', req.user.sub, req.user.buildingIds ?? [])
  }

  @Patch('anomaly-events/:eventId/false-positive')
  @UseGuards(BuildingAdminJwtAuthGuard)
  async falsePositive(@Param('eventId') eventId: string, @Request() req: any) {
    return this.svc.markFalsePositive(eventId, 'BA', req.user.sub, req.user.buildingIds ?? [])
  }

  // Proxy do Edge JPEG (Cloud pull-through, bez bezpośredniego dostępu LAN).
  @Get('anomaly-events/:eventId/image')
  @UseGuards(BuildingAdminJwtAuthGuard)
  async image(@Param('eventId') eventId: string, @Request() req: any, @Res() res: Response) {
    return this.svc.streamImage(eventId, req.user.buildingIds ?? [], res)
  }
}
