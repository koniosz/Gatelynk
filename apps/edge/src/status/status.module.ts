import { Module } from '@nestjs/common'
import { StatusService } from './status.service'
import { StatusController } from './status.controller'
import { ActivationModule } from '../activation/activation.module'
import { TunnelModule } from '../tunnel/tunnel.module'

@Module({
  imports: [ActivationModule, TunnelModule],
  providers: [StatusService],
  controllers: [StatusController],
  exports: [StatusService],
})
export class StatusModule {}
