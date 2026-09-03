import { Module } from '@nestjs/common'
import { BuildingsService } from './buildings.service'
import { BuildingsController, IntegratorsController, BuildingAdminsController, ConciergesController } from './buildings.controller'
import { LicenseModule } from '../license/license.module'

@Module({
  imports: [LicenseModule],
  providers: [BuildingsService],
  controllers: [BuildingsController, IntegratorsController, BuildingAdminsController, ConciergesController],
  exports: [BuildingsService],
})
export class BuildingsModule {}
