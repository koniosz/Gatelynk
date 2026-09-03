/**
 * AccessPointsModule (refactor 2026-06-01).
 *
 * Trzy serwisy:
 *   • OutputDriverRegistryService — dispatcher per device type (Akuvox/
 *     Hikvision/LanSwitch).
 *   • AccessPointExecutorService  — entrypoint `fire(apId, ctx)` używany
 *     przez LPR / PIN / manual remote-open / cron.
 *   • ScheduleService              — cron runner co 60s, używa executora.
 *
 * Importuje DevicesModule (potrzebuje IntercomService + LanSwitchService).
 * Eksportuje executor + registry — TunnelService chwyta executor lazy
 * (`setTunnelSend`), HikvisionLprService / IntercomPinService inject-ują
 * go bezpośrednio.
 */
import { Module, forwardRef } from '@nestjs/common'
import { DevicesModule } from '../devices/devices.module'
import { AccessPointExecutorService } from './access-point-executor.service'
import { OutputDriverRegistryService } from './output-driver-registry.service'
import { ScheduleService } from './schedule.service'

@Module({
  imports: [forwardRef(() => DevicesModule)],
  providers: [
    OutputDriverRegistryService,
    AccessPointExecutorService,
    ScheduleService,
  ],
  exports: [
    OutputDriverRegistryService,
    AccessPointExecutorService,
  ],
})
export class AccessPointsModule {}
