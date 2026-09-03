import { Module } from '@nestjs/common'
import { PassportModule } from '@nestjs/passport'
import { BuildingAdminService } from './building-admin.service'
import { BuildingAdminController } from './building-admin.controller'
import { BuildingAdminAssistantController } from './building-admin-assistant.controller'
import { BuildingAdminJwtStrategy } from './building-admin-jwt.strategy'
import { AuthModule } from '../auth/auth.module'
import { PrismaModule } from '../prisma/prisma.module'
import { PushModule } from '../push/push.module'
import { EdgeModule } from '../edge/edge.module'
import { AccessEventsModule } from '../access-events/access-events.module'
import { IntercomAkuvoxExportService } from '../resident/intercom-akuvox-export.service'
import { PaymentsAdminService } from '../payments/payments-admin.service'

@Module({
  imports: [PassportModule, AuthModule, PrismaModule, PushModule, EdgeModule, AccessEventsModule],
  providers: [BuildingAdminService, BuildingAdminJwtStrategy, IntercomAkuvoxExportService, PaymentsAdminService],
  controllers: [BuildingAdminController, BuildingAdminAssistantController],
})
export class BuildingAdminModule {}
