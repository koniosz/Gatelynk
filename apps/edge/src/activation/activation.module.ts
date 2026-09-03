import { Module } from '@nestjs/common'
import { ActivationService } from './activation.service'
import { ActivationController } from './activation.controller'
import { UiAuthModule } from '../ui-auth/ui-auth.module'

@Module({
  // PR-2: UiAuthModule — kontroler ustawia PIN Edge UI przy aktywacji
  imports: [UiAuthModule],
  providers: [ActivationService],
  controllers: [ActivationController],
  exports: [ActivationService],
})
export class ActivationModule {}
