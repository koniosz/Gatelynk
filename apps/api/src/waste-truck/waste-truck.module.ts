import { Module } from '@nestjs/common'
import { PushModule } from '../push/push.module'
import { WasteTruckService } from './waste-truck.service'

@Module({
  imports: [PushModule],
  providers: [WasteTruckService],
  exports: [WasteTruckService],
})
export class WasteTruckModule {}
