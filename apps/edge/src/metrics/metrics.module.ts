import { Module, forwardRef } from '@nestjs/common'
import { MetricsService } from './metrics.service'
import { SystemController } from './system.controller'
import { DevicesModule } from '../devices/devices.module'
import { ActivationModule } from '../activation/activation.module'
import { TunnelModule } from '../tunnel/tunnel.module'
import { StoreModule } from '../store/store.module'

/**
 * MetricsModule — `/api/system` + `/api/metrics` + cron sampling +
 * Settings actions (`/api/system/restart`, `/factory-reset`, `/settings/cloud`).
 *
 * Zależy od:
 *  • DevicesModule  — DeviceRegistry do count online devices
 *  • TunnelModule   — cloud connection status
 *  • ActivationModule — deviceId/buildingId
 *  • StoreModule    — factory-reset wipe sqlite
 *  • EventLogModule (@Global) — audit log destrukcyjnych akcji
 */
@Module({
  imports: [
    DevicesModule,
    ActivationModule,
    StoreModule,
    forwardRef(() => TunnelModule),
  ],
  providers: [MetricsService],
  controllers: [SystemController],
  exports: [MetricsService],
})
export class MetricsModule {}
