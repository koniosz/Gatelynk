import { Controller, Get, Post } from '@nestjs/common'
import { TunnelService } from './tunnel.service'

@Controller('tunnel')
export class TunnelController {
  constructor(private tunnel: TunnelService) {}

  @Get('status')
  status() {
    return this.tunnel.getConnectionInfo()
  }

  @Post('reconnect')
  reconnect() {
    this.tunnel.reconnect()
    return { success: true }
  }
}
