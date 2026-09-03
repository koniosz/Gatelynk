/**
 * AkuvoxDirectoryUserAdapter — adapter dla NOWYCH instalacji (pkt 5 spec):
 * firmware 29.30.10.465+ (model Directory → User → Contact Details).
 *
 * TWARDA ZASADA (pkt 7): generator jest wyłącznie template-driven — bez
 * wgranego template'a dla (model, firmwareVersion) ODMAWIA generacji.
 * Pierwszy realny template musi wgrać instalator z urządzenia (eksport
 * przykładowego usera) — patrz docs/akuvox-directory-v2-installer.md.
 * Nie tworzymy formatu CSV/XML „na oko".
 */
import { BadRequestException } from '@nestjs/common'
import {
  AkuvoxAdapter,
  AkuvoxCapabilities,
  AkuvoxDeviceInfo,
  AkuvoxDirectorySnapshot,
  AkuvoxDirectoryUser,
  ApplyResult,
  GeneratedImportFile,
  TemplateSpec,
  VerificationResult,
} from '../domain/directory.types'
import { detectCapabilitiesFromInfo } from './akuvox-capabilities'
import { generateFromSpec } from '../template/akuvox-file-generator'

export class AkuvoxDirectoryUserAdapter implements AkuvoxAdapter {
  constructor(
    private readonly info: AkuvoxDeviceInfo,
    private readonly snapshot: AkuvoxDirectorySnapshot,
    private readonly uploadedTemplate: { spec: TemplateSpec; source: string } | null,
  ) {}

  async detectCapabilities(): Promise<AkuvoxCapabilities> {
    return detectCapabilitiesFromInfo(this.info)
  }

  async exportCurrentDirectory(): Promise<AkuvoxDirectorySnapshot> {
    return this.snapshot
  }

  async generateImportFile(users: AkuvoxDirectoryUser[]): Promise<GeneratedImportFile> {
    if (!this.uploadedTemplate) {
      throw new BadRequestException(
        `Brak template'a formatu importu dla ${this.info.model || '?'} / firmware ${this.info.firmwareVersion || '?'}. ` +
          `Wyeksportuj z urządzenia przykładowy plik użytkowników i wgraj go jako template (Panel Integratora → Akuvox → Directory Sync → Import/Eksport) — formatu nie generujemy „na oko".`,
      )
    }
    const ext = this.uploadedTemplate.spec.format === 'csv' ? 'csv' : this.uploadedTemplate.spec.format === 'xml' ? 'xml' : 'tgz'
    // Bugfix 2026-07-30 (2): archiwum z urządzenia (np. PhoneContacts.tgz) —
    // wynik dostaje tę samą nazwę zewnętrzną, żeby import był 1:1.
    const fileName = this.uploadedTemplate.spec.outerFilename ?? `GateLynkDirectory.${ext}`
    return generateFromSpec(users, this.uploadedTemplate.spec, {
      fileName,
      templateSource: this.uploadedTemplate.source,
    })
  }

  async applyDirectory(_file: GeneratedImportFile): Promise<ApplyResult> {
    return {
      ok: false,
      message:
        'Tryb MANUAL: import wykonuje instalator w web UI urządzenia. DEVICE_API wyłącznie po potwierdzeniu oficjalnych endpointów Akuvox (Etap 3, flaga AKUVOX_DIRECTORY_WRITE_API).',
    }
  }

  async verifyDirectory(): Promise<VerificationResult> {
    return {
      ok: false,
      message: 'Weryfikacja automatyczna niedostępna — wgraj eksport z urządzenia (widok E) i porównaj różnice.',
    }
  }
}
