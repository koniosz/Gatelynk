import { Controller, Get, Param, Patch, Query, Request, Res, UseGuards } from '@nestjs/common'
import type { Response } from 'express'
import { ConciergeJwtAuthGuard } from '../concierge/concierge-jwt-auth.guard'
import { AnomalyEventsService } from './anomaly-events.service'

/**
 * Concierge endpointy:
 *   GET   /api/concierge/anomaly-events
 *   PATCH /api/concierge/anomaly-events/:eventId/resolve
 *   PATCH /api/concierge/anomaly-events/:eventId/false-positive
 *
 * Concierge widzi tylko swój budynek (`req.user.buildingId`).
 */
@Controller('concierge')
export class AnomalyEventsConciergeController {
  constructor(private readonly svc: AnomalyEventsService) {}

  @Get('anomaly-events')
  @UseGuards(ConciergeJwtAuthGuard)
  async list(
    @Request() req: any,
    @Query('since_hours') sinceHoursRaw?: string,
    @Query('limit') limitRaw?: string,
    @Query('unresolved') unresolvedRaw?: string,
  ) {
    return this.svc.listForBuilding(req.user.buildingId, {
      sinceHours: sinceHoursRaw ? +sinceHoursRaw : undefined,
      limit: limitRaw ? +limitRaw : undefined,
      unresolvedOnly: unresolvedRaw === '1' || unresolvedRaw === 'true',
    })
  }

  @Patch('anomaly-events/:eventId/resolve')
  @UseGuards(ConciergeJwtAuthGuard)
  async resolve(@Param('eventId') eventId: string, @Request() req: any) {
    return this.svc.resolve(eventId, 'CONCIERGE', req.user.sub, [req.user.buildingId])
  }

  @Patch('anomaly-events/:eventId/false-positive')
  @UseGuards(ConciergeJwtAuthGuard)
  async falsePositive(@Param('eventId') eventId: string, @Request() req: any) {
    return this.svc.markFalsePositive(eventId, 'CONCIERGE', req.user.sub, [req.user.buildingId])
  }

  @Get('anomaly-events/:eventId/image')
  @UseGuards(ConciergeJwtAuthGuard)
  async image(@Param('eventId') eventId: string, @Request() req: any, @Res() res: Response) {
    return this.svc.streamImage(eventId, [req.user.buildingId], res)
  }
}
