import { Module } from '@nestjs/common'
import { MailModule } from '../mail/mail.module'
import { MonitoringController } from './monitoring.controller'
import { MonitoringService } from './monitoring.service'

@Module({
  imports: [MailModule],
  controllers: [MonitoringController],
  providers: [MonitoringService],
})
export class MonitoringModule {}
