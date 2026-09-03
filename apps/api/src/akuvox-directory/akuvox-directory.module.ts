/**
 * Akuvox Directory Sync v2 (2026-07-30) — przebudowa integracji kontaktów
 * Akuvox pod firmware 29.30.10.x. Analiza: docs/akuvox-directory-v2-analysis.md.
 * Instrukcja instalatora: docs/akuvox-directory-v2-installer.md.
 *
 * Legacy (Remote Phonebook XML + UserData.tgz per-budynek) pozostaje bez zmian
 * zachowania — patrz @deprecated w resident/intercom-phonebook.controller.ts
 * i resident/intercom-akuvox-export.service.ts.
 */
import { Module } from '@nestjs/common'
import { PassportModule } from '@nestjs/passport'
import { PrismaModule } from '../prisma/prisma.module'
import { AkuvoxCryptoService } from './akuvox-crypto.service'
import { AkuvoxDirectoryConfigService } from './akuvox-directory-config.service'
import { AkuvoxDirectoryController } from './akuvox-directory.controller'
import { AkuvoxDirectoryService } from './akuvox-directory.service'
import { AkuvoxProvisioningController } from './akuvox-provisioning.controller'
import { DirectoryDiffService } from './domain/directory-diff.service'
import { DirectoryProjectionService } from './domain/directory-projection.service'
import { AkuvoxTemplateParser } from './template/akuvox-template.parser'

@Module({
  imports: [PassportModule, PrismaModule],
  providers: [
    AkuvoxDirectoryService,
    AkuvoxDirectoryConfigService,
    AkuvoxCryptoService,
    DirectoryProjectionService,
    DirectoryDiffService,
    AkuvoxTemplateParser,
  ],
  controllers: [AkuvoxDirectoryController, AkuvoxProvisioningController],
})
export class AkuvoxDirectoryModule {}
