/**
 * Feature flags Akuvox Directory Sync v2 (pkt 21 spec) — env przez ConfigService,
 * defaulty ze spec. Celowo NIE w Building.featurePermissions (to matrix uprawnień
 * ról per budynek, nie przełączniki platformowe).
 */
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

export interface AkuvoxDirectoryFlags {
  /** Cała integracja v2 (endpointy + panel). Default: true. */
  directoryV2: boolean
  /** Ręczny eksport/import plików (MVP). Default: true. */
  manualImport: boolean
  /** Provisioning pull przez urządzenie (Etap 2). Default: false. */
  provisioningSync: boolean
  /** Zapis katalogu przez API urządzenia (Etap 3, wymaga potwierdzonych endpointów). Default: false. */
  directoryWriteApi: boolean
}

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback
  return !['false', '0', 'no', 'off'].includes(value.trim().toLowerCase())
}

@Injectable()
export class AkuvoxDirectoryConfigService {
  constructor(private readonly config: ConfigService) {}

  get flags(): AkuvoxDirectoryFlags {
    return {
      directoryV2: envBool(this.config.get<string>('AKUVOX_DIRECTORY_V2'), true),
      manualImport: envBool(this.config.get<string>('AKUVOX_MANUAL_IMPORT'), true),
      provisioningSync: envBool(this.config.get<string>('AKUVOX_PROVISIONING_SYNC'), false),
      directoryWriteApi: envBool(this.config.get<string>('AKUVOX_DIRECTORY_WRITE_API'), false),
    }
  }

  /** Klucz AES-256-GCM do poświadczeń urządzeń (hex 64 znaki lub base64 32 bajty). */
  get credKey(): string | undefined {
    const v = this.config.get<string>('AKUVOX_CRED_KEY')
    return v && v.trim() !== '' ? v.trim() : undefined
  }
}
