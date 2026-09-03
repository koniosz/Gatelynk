import { Module } from '@nestjs/common'
import { LanSwitchService } from './lan-switch.service'
import { LanSwitchController } from './lan-switch.controller'

/**
 * LanSwitchModule — UniFi (i w przyszłości Cisco/HP) managed switche.
 *
 * StoreService jest @Global() więc bez explicit imports. Polling jest
 * pure-setInterval, więc ScheduleModule też nie potrzebny.
 *
 * UWAGA: device-registry.service.ts wstrzykuje LanSwitchService bezpośrednio,
 * podobnie jak IntercomService/CamerasService/etc. Dlatego eksportujemy.
 */
@Module({
  controllers: [LanSwitchController],
  providers: [LanSwitchService],
  exports: [LanSwitchService],
})
export class LanSwitchModule {}
