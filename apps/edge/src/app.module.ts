import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { ScheduleModule } from '@nestjs/schedule'
import configuration from './config/configuration'
import { StoreModule } from './store/store.module'
import { ActivationModule } from './activation/activation.module'
import { TunnelModule } from './tunnel/tunnel.module'
import { MqttModule } from './mqtt/mqtt.module'
import { DevicesModule } from './devices/devices.module'
import { SyncModule } from './sync/sync.module'
import { StatusModule } from './status/status.module'
import { EventLogModule } from './event-log/event-log.module'
import { DiscoveryModule } from './discovery/discovery.module'
import { MetricsModule } from './metrics/metrics.module'
import { AssistantModule } from './assistant/assistant.module'
import { RestoreModule } from './restore/restore.module'
import { KnowledgeModule } from './knowledge/knowledge.module'
import { AccessPointsModule } from './access-points/access-points.module'
import { UiAuthModule } from './ui-auth/ui-auth.module'

@Module({
  imports: [
    EventLogModule,   // must be first — @Global, used by all modules
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ScheduleModule.forRoot(),
    StoreModule,
    UiAuthModule,     // PR-2: PIN Edge UI — przed ActivationModule (import w Activation)
    ActivationModule,
    KnowledgeModule,  // before TunnelModule — handler injection
    DevicesModule,    // before AccessPointsModule (registry zależy od IntercomService/LanSwitchService)
    AccessPointsModule, // before TunnelModule — executor injection
    TunnelModule,
    MqttModule,
    SyncModule,
    StatusModule,
    DiscoveryModule,
    MetricsModule,
    AssistantModule,
    RestoreModule,
  ],
})
export class AppModule {}
