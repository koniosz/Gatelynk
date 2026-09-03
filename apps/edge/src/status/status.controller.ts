import { Controller, Get } from '@nestjs/common'
import { StatusService } from './status.service'
import { TunnelService } from '../tunnel/tunnel.service'

@Controller('status')
export class StatusController {
  constructor(
    private status: StatusService,
    private tunnel: TunnelService,
  ) {}

  @Get()
  get() {
    return this.status.getFullStatus()
  }

  /** Used by UI header — returns LAN IP + device info */
  @Get('info')
  info() {
    return this.status.getInfo()
  }

  /** Used by UI header — returns cloud tunnel connection status */
  @Get('cloud')
  cloud() {
    return {
      connected: this.tunnel.isConnected(),
      ...this.tunnel.getConnectionInfo(),
    }
  }
}
