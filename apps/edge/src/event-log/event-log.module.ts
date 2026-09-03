import { Module, Global } from '@nestjs/common'
import { EventLogService } from './event-log.service'
import { EventLogController } from './event-log.controller'

@Global()   // dostępny wszędzie bez importowania
@Module({
  controllers: [EventLogController],
  providers: [EventLogService],
  exports: [EventLogService],
})
export class EventLogModule {}
