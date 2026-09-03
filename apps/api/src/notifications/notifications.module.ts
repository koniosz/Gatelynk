import { Module } from '@nestjs/common'
import { NotificationsService } from './notifications.service'
import { NotificationsController } from './notifications.controller'
import { PrismaModule } from '../prisma/prisma.module'
import { BuildingsModule } from '../buildings/buildings.module'
import { PushModule } from '../push/push.module'

@Module({
  imports: [PrismaModule, BuildingsModule, PushModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
