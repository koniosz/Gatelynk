import { Module } from '@nestjs/common'
import { RestoreController } from './restore.controller'

/**
 * RestoreModule — upload kopii zapasowej + staging dla swap przy restart.
 *
 * Patrz `restore.controller.ts` po pełny flow + pre-bootstrap handler
 * w `main.ts`.
 *
 * StoreService + EventLogService są @Global() więc bez explicit imports.
 */
@Module({
  controllers: [RestoreController],
})
export class RestoreModule {}
