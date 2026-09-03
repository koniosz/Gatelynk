/**
 * REST API dla zarządzania portami switcha LAN (UniFi).
 *
 *   GET    /devices/:id/switch/ports                      → PortStateView[]
 *   POST   /devices/:id/switch/ports/:idx/poe             body { enabled: bool }
 *   PATCH  /devices/:id/switch/ports/:idx/assignment      body { label?: string; assignedDeviceId?: string|null }
 *   POST   /devices/:id/switch/refresh                    → force refresh z UniFi
 *   GET    /devices/:id/switch/status                     → { online, lastFetchedAt, lastError }
 *
 * `:id` to GateLynk deviceId switcha. Wszystkie endpointy są LAN-only (Edge
 * jest za firewall-em, brak auth challenge — analogicznie do reszty `/devices/*`).
 */
import {
  BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Patch, Post,
} from '@nestjs/common'
import { LanSwitchService } from './lan-switch.service'

interface SetPoeBody { enabled: boolean }
interface SetAssignmentBody { label?: string; assignedDeviceId?: string | null }

@Controller('devices/:id/switch')
export class LanSwitchController {
  constructor(private readonly svc: LanSwitchService) {}

  @Get('ports')
  listPorts(@Param('id') id: string) {
    return { ports: this.svc.listPorts(id), status: this.svc.status(id) }
  }

  @Get('status')
  status(@Param('id') id: string) {
    return this.svc.status(id)
  }

  @Post('refresh')
  async refresh(@Param('id') id: string) {
    await this.svc.refresh(id)
    return { refreshed: true, status: this.svc.status(id) }
  }

  @Post('ports/:idx/poe')
  async setPoe(
    @Param('id') id: string,
    @Param('idx', ParseIntPipe) idx: number,
    @Body() body: SetPoeBody,
  ) {
    if (typeof body?.enabled !== 'boolean') {
      throw new BadRequestException('Body must contain { enabled: boolean }')
    }
    await this.svc.setPortPoe(id, idx, body.enabled)
    return { ok: true, portIdx: idx, poeEnabled: body.enabled }
  }

  @Patch('ports/:idx/assignment')
  async setAssignment(
    @Param('id') id: string,
    @Param('idx', ParseIntPipe) idx: number,
    @Body() body: SetAssignmentBody,
  ) {
    await this.svc.setPortAssignment(id, idx, {
      label: body?.label,
      assignedDeviceId: body?.assignedDeviceId === null ? null : body?.assignedDeviceId,
    })
    return { ok: true, portIdx: idx }
  }
}
