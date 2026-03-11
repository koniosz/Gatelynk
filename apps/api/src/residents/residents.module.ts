import { Module } from '@nestjs/common'
import { ResidentsService } from './residents.service'
import { ResidentsController } from './residents.controller'
import { BuildingsModule } from '../buildings/buildings.module'

@Module({
  imports: [BuildingsModule],
  providers: [ResidentsService],
  controllers: [ResidentsController],
  exports: [ResidentsService],
})
export class ResidentsModule {}
