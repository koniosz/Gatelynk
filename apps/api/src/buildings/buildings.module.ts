import { Module } from '@nestjs/common'
import { BuildingsService } from './buildings.service'
import { BuildingsController } from './buildings.controller'
import { LicenseModule } from '../license/license.module'

@Module({
  imports: [LicenseModule],
  providers: [BuildingsService],
  controllers: [BuildingsController],
  exports: [BuildingsService],
})
export class BuildingsModule {}
