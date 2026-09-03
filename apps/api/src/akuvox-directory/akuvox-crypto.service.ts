/**
 * Szyfrowanie poświadczeń urządzeń Akuvox (pkt 18 spec) — AES-256-GCM,
 * klucz z env AKUVOX_CRED_KEY (64 znaki hex lub base64 → 32 bajty).
 *
 * Zasady:
 *  - brak klucza → zapis poświadczeń ODRZUCANY z czytelnym błędem (nigdy
 *    plain-text fallback);
 *  - hasła nie trafiają do logów ani do frontendu po zapisie (API zwraca
 *    wyłącznie credentialIsSet);
 *  - dotyczy TYLKO nowych poświadczeń akuvox_devices — istniejące plain-text
 *    sekrety innych tabel bez zmian (Faza 7.7 odroczona).
 *
 * Format zapisu: `v1:<iv b64>:<authTag b64>:<ciphertext b64>`.
 */
import { BadRequestException, Injectable } from '@nestjs/common'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { AkuvoxDirectoryConfigService } from './akuvox-directory-config.service'

const PREFIX = 'v1'

@Injectable()
export class AkuvoxCryptoService {
  constructor(private readonly config: AkuvoxDirectoryConfigService) {}

  get hasKey(): boolean {
    return this.resolveKey() !== null
  }

  private resolveKey(): Buffer | null {
    const raw = this.config.credKey
    if (!raw) return null
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex')
    const b64 = Buffer.from(raw, 'base64')
    if (b64.length === 32) return b64
    return null
  }

  encrypt(plain: string): string {
    const key = this.resolveKey()
    if (!key) {
      throw new BadRequestException(
        'AKUVOX_CRED_KEY nie jest skonfigurowany (32 bajty hex/base64) — zapis poświadczeń odrzucony',
      )
    }
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return [PREFIX, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':')
  }

  decrypt(payload: string): string {
    const key = this.resolveKey()
    if (!key) {
      throw new BadRequestException('AKUVOX_CRED_KEY nie jest skonfigurowany — nie można odczytać poświadczeń')
    }
    const parts = payload.split(':')
    if (parts.length !== 4 || parts[0] !== PREFIX) {
      throw new BadRequestException('Nieprawidłowy format zaszyfrowanych poświadczeń')
    }
    const [, ivB64, tagB64, dataB64] = parts
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
  }
}
