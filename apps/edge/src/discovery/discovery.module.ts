import { Module } from '@nestjs/common'
import { DiscoveryService } from './discovery.service'
import { DiscoveryController } from './discovery.controller'

/**
 * Discovery moduł — mDNS browse + KNXnet/IP search.
 *
 * EventLogService używamy z @Global EventLogModule (już importowany pierwszy
 * w `AppModule`), więc nie trzeba importować eksplicytnie.
 */
@Module({
  controllers: [DiscoveryController],
  providers: [DiscoveryService],
  exports: [DiscoveryService],
})
export class DiscoveryModule {}
