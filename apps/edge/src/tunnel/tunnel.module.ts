import { Module } from '@nestjs/common'
import { TunnelService } from './tunnel.service'
import { TunnelController } from './tunnel.controller'
import { ActivationModule } from '../activation/activation.module'
import { DevicesModule } from '../devices/devices.module'
import { SyncModule } from '../sync/sync.module'
import { KnowledgeModule } from '../knowledge/knowledge.module'
import { AccessPointsModule } from '../access-points/access-points.module'

@Module({
  imports: [ActivationModule, DevicesModule, SyncModule, KnowledgeModule, AccessPointsModule],
  providers: [TunnelService],
  controllers: [TunnelController],
  exports: [TunnelService],
})
export class TunnelModule {}
