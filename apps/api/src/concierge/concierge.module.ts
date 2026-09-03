import { Module } from '@nestjs/common'
import { PassportModule } from '@nestjs/passport'
import { ConciergeService } from './concierge.service'
import { ConciergeController } from './concierge.controller'
import { ConciergeAssistantController } from './concierge-assistant.controller'
import { ConciergeJwtStrategy } from './concierge-jwt.strategy'
import { AuthModule } from '../auth/auth.module'
import { PrismaModule } from '../prisma/prisma.module'
import { MailModule } from '../mail/mail.module'
import { PushModule } from '../push/push.module'
import { EdgeModule } from '../edge/edge.module'
import { AccessEventsModule } from '../access-events/access-events.module'

@Module({
  // EdgeModule is imported so the concierge can push freshly-registered
  // plates to Edge (PLATE_UPSERT / PLATE_DELETE) — otherwise Edge wouldn't
  // recognise a car identified here until the next full whitelist sync.
  // Plus ConciergeAssistantController (2026-05-22) używa EdgeGateway do
  // resolve Edge IP po buildingId z JWT.
  imports: [PassportModule, AuthModule, PrismaModule, MailModule, PushModule, EdgeModule, AccessEventsModule],
  providers: [ConciergeService, ConciergeJwtStrategy],
  controllers: [ConciergeController, ConciergeAssistantController],
})
export class ConciergeModule {}
