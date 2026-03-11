import { Module } from '@nestjs/common'
import { UnitsService } from './units.service'
import { UnitsController } from './units.controller'
import { LicenseModule } from '../license/license.module'
import { BuildingsModule } from '../buildings/buildings.module'

@Module({
  imports: [LicenseModule, BuildingsModule],
  providers: [UnitsService],
  controllers: [UnitsController],
  exports: [UnitsService],
})
export class UnitsModule {}
