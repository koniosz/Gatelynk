import { Module } from '@nestjs/common'
import { PassportModule } from '@nestjs/passport'
import { IntegratorService } from './integrator.service'
import { IntegratorReadinessService } from './readiness.service'
import { IntegratorController } from './integrator.controller'
import { IntegratorJwtStrategy } from './integrator-jwt.strategy'
import { AuthModule } from '../auth/auth.module'
import { PrismaModule } from '../prisma/prisma.module'
import { EdgeModule } from '../edge/edge.module'
import { MailModule } from '../mail/mail.module'
import { IntercomAkuvoxExportService } from '../resident/intercom-akuvox-export.service'

@Module({
  imports: [PassportModule, AuthModule, PrismaModule, EdgeModule, MailModule],
  providers: [IntegratorService, IntegratorReadinessService, IntegratorJwtStrategy, IntercomAkuvoxExportService],
  controllers: [IntegratorController],
})
export class IntegratorModule {}
