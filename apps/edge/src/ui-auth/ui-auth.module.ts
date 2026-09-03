import { Module } from '@nestjs/common'
import { UiAuthService } from './ui-auth.service'
import { UiAuthController } from './ui-auth.controller'

/**
 * PR-2 (2026-07) — PIN/hasło do Edge UI.
 * StoreModule i EventLogModule są @Global, więc nie trzeba ich importować.
 * Eksportujemy UiAuthService, bo:
 *   • main.ts pobiera go przez `app.get()` do middleware'a,
 *   • ActivationModule ustawia PIN przy aktywacji (opcjonalne pole `pin`).
 */
@Module({
  providers: [UiAuthService],
  controllers: [UiAuthController],
  exports: [UiAuthService],
})
export class UiAuthModule {}
