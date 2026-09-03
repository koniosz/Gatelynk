import {
  Controller, Post, Get, Delete, Body, Param, Req, UseGuards, HttpCode, BadGatewayException,
  HttpException, HttpStatus,
} from '@nestjs/common'
import { EdgeService, ActivateEdgeDto, RefreshEdgeTokenDto, GenerateActivationCodeDto } from './edge.service'
import { EdgeGateway } from './edge.gateway'
import { ActivationThrottleService } from './activation-throttle.service'
import { AuthGuard } from '@nestjs/passport'

/**
 * PR-1: przy odrzuceniu (throttle / zły kod) odpowiadamy po STAŁYM czasie
 * (min. 800 ms od początku requestu), żeby timing nie zdradzał czy kod
 * istnieje w bazie, jest wygasły, czy jedynie wpadliśmy na limiter.
 */
const ACTIVATE_REJECT_FLOOR_MS = 800

@Controller('edge')
export class EdgeController {
  constructor(
    private edge: EdgeService,
    private gateway: EdgeGateway,
    private activationThrottle: ActivationThrottleService,
  ) {}

  // ── Public endpoints (called by Edge device) ─────────────────────────────────

  /** Step 1: Exchange one-time code → JWT + refresh token.
   *  PR-1: rate-limit per IP + per kod (5/min, 30/h) + stały czas odpowiedzi
   *  przy odrzuceniu. */
  @Post('activate')
  @HttpCode(200)
  async activate(@Body() dto: ActivateEdgeDto, @Req() req: any) {
    const startedAt = Date.now()
    const ip = this.clientIp(req)
    const code = (dto.activationCode ?? '').trim()

    if (!this.activationThrottle.consume(ip, code)) {
      await this.padTo(startedAt)
      throw new HttpException(
        'Zbyt wiele prób aktywacji — spróbuj ponownie później',
        HttpStatus.TOO_MANY_REQUESTS,
      )
    }

    try {
      return await this.edge.activate(dto)
    } catch (err) {
      await this.padTo(startedAt)
      throw err
    }
  }

  /** Realny IP klienta — za Fly proxy `fly-client-ip`, fallback X-Forwarded-For / socket. */
  private clientIp(req: any): string {
    const fly = req.headers?.['fly-client-ip']
    if (typeof fly === 'string' && fly) return fly
    const xff = req.headers?.['x-forwarded-for']
    if (typeof xff === 'string' && xff) return xff.split(',')[0].trim()
    return req.ip ?? req.socket?.remoteAddress ?? 'unknown'
  }

  /** Dopiąć czas odpowiedzi do stałego floor-u (anti-timing-oracle). */
  private async padTo(startedAt: number): Promise<void> {
    const elapsed = Date.now() - startedAt
    if (elapsed < ACTIVATE_REJECT_FLOOR_MS) {
      await new Promise((r) => setTimeout(r, ACTIVATE_REJECT_FLOOR_MS - elapsed))
    }
  }

  /** Step 2: Refresh JWT using long-lived refresh token */
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshEdgeTokenDto) {
    return this.edge.refreshToken(dto)
  }

  // ── Admin endpoints (called from superadmin panel) ────────────────────────────

  /** Generate activation code for a building */
  @UseGuards(AuthGuard('jwt'))
  @Post('buildings/:buildingId/activation-code')
  generateCode(
    @Param('buildingId') buildingId: string,
    @Body() body: { type?: 'EDGE' | 'EDGE_AI'; name?: string },
    @Req() req: any,
  ) {
    const dto: GenerateActivationCodeDto = {
      buildingId: +buildingId,
      type: body.type,
      name: body.name,
    }
    return this.edge.generateActivationCode(req.user.id, dto)
  }

  /** List edge devices for a building (with online status) */
  @UseGuards(AuthGuard('jwt'))
  @Get('buildings/:buildingId/devices')
  async list(@Param('buildingId') buildingId: string) {
    const devices = await this.edge.listForBuilding(+buildingId)
    return devices.map((d) => ({
      ...d,
      isOnline: this.gateway.isOnline(d.id),
    }))
  }

  /** List currently connected edge devices (all buildings) */
  @UseGuards(AuthGuard('jwt'))
  @Get('online')
  getOnline() {
    return this.gateway.getOnlineDevices()
  }

  /** Delete an edge device */
  @UseGuards(AuthGuard('jwt'))
  @Delete('devices/:deviceId')
  remove(@Param('deviceId') deviceId: string, @Req() req: any) {
    return this.edge.remove(deviceId, req.user.id)
  }

  /** Force immediate access-point sync for all connected edges of a building */
  @UseGuards(AuthGuard('jwt'))
  @Post('buildings/:buildingId/sync-access-points')
  async syncAccessPoints(@Param('buildingId') buildingId: string) {
    await this.gateway.periodicAccessPointSync()
    return { synced: true }
  }

  /** Device tree — all LAN devices managed by Edge, grouped by type with online status.
   *  Available to super-admins (jwt) and installers (jwt). */
  @UseGuards(AuthGuard('jwt'))
  @Get('buildings/:buildingId/device-tree')
  async getDeviceTree(@Param('buildingId') buildingId: string) {
    // Prefer live WebSocket IP, fall back to last-known DB IP
    let ip: string | undefined = this.gateway.getEdgeIpForBuilding(+buildingId)
    if (!ip) ip = (await this.edge.resolveEdgeIp(+buildingId)) ?? undefined
    if (!ip) throw new BadGatewayException('Edge niedostępny lub nieaktywny dla tego budynku')

    try {
      return await this.edge.getDeviceTreeFromEdge(ip)
    } catch (err: any) {
      throw new BadGatewayException(`Nie można pobrać drzewa urządzeń: ${err.message}`)
    }
  }
}
