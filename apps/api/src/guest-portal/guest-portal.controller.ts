import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Req,
  BadRequestException,
} from '@nestjs/common'
import type { Request } from 'express'
import { GuestPortalService } from './guest-portal.service'

/**
 * Public controller — bez `@UseGuards(...)`. Token sam w sobie jest credentialem.
 * Prefix `/api/guest-portal` żeby nie kolidować z innymi `/api/...` route'ami.
 */
@Controller('guest-portal')
export class GuestPortalController {
  constructor(private readonly portal: GuestPortalService) {}

  /** Inicjalny request z `app/g/[token]/page.tsx` (Next.js, server-side fetch
   *  lub client-side useEffect — oba działają, bo brak auth). */
  @Get(':token')
  async getInvitation(@Param('token') token: string) {
    return this.portal.getInvitation(token)
  }

  /** Otwarcie bramy/wjazdu. Body: `{ accessPointId: number }`. Zwraca 200
   *  z labelem (do wyświetlenia toast-a „Brama otwarta") albo 4xx/5xx. */
  @Post(':token/open')
  async openAccessPoint(
    @Param('token') token: string,
    @Body() body: { accessPointId?: unknown; nonce?: string },
    @Req() req: Request,
  ) {
    const accessPointId = Number(body?.accessPointId)
    if (!Number.isInteger(accessPointId) || accessPointId <= 0) {
      throw new BadRequestException('Brakuje accessPointId')
    }
    // X-Forwarded-For na Fly — zaufanie pierwszemu hopowi (Fly proxy doda
    // realny client IP). Jeśli pusty, fallback na socket.remoteAddress.
    const xff = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
    const ip = xff || req.socket.remoteAddress || undefined
    return this.portal.openAccessPoint(token, accessPointId, ip, body?.nonce)
  }
}
