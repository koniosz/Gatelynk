/** Odbiór alertów strażnika Edge AI — patrz MonitoringService (auth: token
 *  HMAC w body, bez JWT — wołane skryptem z Mac Mini). */
import { Body, Controller, HttpCode, Post } from '@nestjs/common'
import { MonitoringService, MonitorStatus } from './monitoring.service'

@Controller('monitoring')
export class MonitoringController {
  constructor(private readonly monitoring: MonitoringService) {}

  @Post('ai-health-alert')
  @HttpCode(200)
  async aiHealthAlert(
    @Body() body: { token?: string; component?: string; status?: MonitorStatus; detail?: string },
  ) {
    return this.monitoring.handleAlert({
      token: String(body?.token ?? ''),
      component: String(body?.component ?? ''),
      status: body?.status === 'UP' ? 'UP' : 'DOWN',
      detail: typeof body?.detail === 'string' ? body.detail : undefined,
    })
  }
}
