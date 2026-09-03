/**
 * Endpointy `/api/invite/*` — patrz `apps/api/src/invite/invite.service.ts`
 * + spec w `docs/design/guest-invite-2026-05-11/`.
 *
 * Wszystkie endpointy public (token w URL = capability). Walidacje + rate
 * limit + audit są w service. Tutaj tylko routing + extrakcja IP.
 */
import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Req,
  HttpCode,
} from '@nestjs/common'
import type { Request } from 'express'
import { InviteService } from './invite.service'

@Controller('invite')
export class InviteController {
  constructor(private readonly invite: InviteService) {}

  @Get(':token')
  async getInvite(@Param('token') token: string, @Req() req: Request) {
    return this.invite.getInvite(token, this.extractIp(req))
  }

  @Post(':token/open')
  @HttpCode(200)
  async open(
    @Param('token') token: string,
    @Body() body: { accessId?: string; clientTs?: number; confirmedAt?: number; nonce?: string },
    @Req() req: Request,
  ) {
    return this.invite.openAccess(token, body?.accessId ?? '', this.extractIp(req), body?.nonce)
  }

  /** Polling statusu prośby o zatwierdzenie (UNIT_DOOR approvalRequired). */
  @Get(':token/approval/:requestId')
  async approvalStatus(
    @Param('token') token: string,
    @Param('requestId') requestId: string,
  ) {
    return this.invite.approvalStatus(token, requestId)
  }

  @Post(':token/pin')
  @HttpCode(200)
  async revealPin(
    @Param('token') token: string,
    @Body() body: { reason?: 'reveal' | 'copy' },
    @Req() req: Request,
  ) {
    return this.invite.revealPin(token, body?.reason ?? 'reveal', this.extractIp(req))
  }

  @Post(':token/report')
  @HttpCode(200)
  async report(
    @Param('token') token: string,
    @Body() body: { reason?: string },
    @Req() req: Request,
  ) {
    return this.invite.reportAbuse(token, body?.reason, this.extractIp(req))
  }

  /** Extract client IP — Fly.io / Cloudflare ustawiają `Fly-Client-IP` /
   *  `X-Forwarded-For`. Default fallback do `req.ip`. */
  private extractIp(req: Request): string | undefined {
    const xff = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
    const flyIp = (req.headers['fly-client-ip'] as string | undefined)?.trim()
    return flyIp || xff || req.ip || undefined
  }
}
