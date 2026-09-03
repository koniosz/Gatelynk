import { Module } from '@nestjs/common'
import { PushService } from './push.service'
import { PrismaModule } from '../prisma/prisma.module'

@Module({
  imports: [PrismaModule],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
