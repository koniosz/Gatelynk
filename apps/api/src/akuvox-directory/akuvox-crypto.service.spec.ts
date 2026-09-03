/**
 * Testy szyfrowania poświadczeń AES-256-GCM (pkt 18 spec) — bez bazy.
 */
import { ConfigService } from '@nestjs/config'
import { AkuvoxCryptoService } from './akuvox-crypto.service'
import { AkuvoxDirectoryConfigService } from './akuvox-directory-config.service'

function makeService(env: Record<string, string | undefined>): AkuvoxCryptoService {
  const config = { get: (key: string) => env[key] } as unknown as ConfigService
  return new AkuvoxCryptoService(new AkuvoxDirectoryConfigService(config))
}

const HEX_KEY = 'a'.repeat(64)

describe('AkuvoxCryptoService', () => {
  it('roundtrip encrypt → decrypt (klucz hex)', () => {
    const svc = makeService({ AKUVOX_CRED_KEY: HEX_KEY })
    const enc = svc.encrypt('tajne-hasło-R29C-żółć')
    expect(enc).toMatch(/^v1:/)
    expect(enc).not.toContain('tajne')
    expect(svc.decrypt(enc)).toBe('tajne-hasło-R29C-żółć')
  })

  it('roundtrip z kluczem base64 (32 bajty)', () => {
    const svc = makeService({ AKUVOX_CRED_KEY: Buffer.alloc(32, 7).toString('base64') })
    expect(svc.decrypt(svc.encrypt('x'))).toBe('x')
  })

  it('każde szyfrowanie daje inny ciphertext (losowy IV)', () => {
    const svc = makeService({ AKUVOX_CRED_KEY: HEX_KEY })
    expect(svc.encrypt('haslo')).not.toBe(svc.encrypt('haslo'))
  })

  it('brak klucza → odrzuca zapis z czytelnym błędem (nigdy plain-text fallback)', () => {
    const svc = makeService({})
    expect(svc.hasKey).toBe(false)
    expect(() => svc.encrypt('haslo')).toThrow(/AKUVOX_CRED_KEY/)
  })

  it('klucz o złej długości traktowany jak brak klucza', () => {
    const svc = makeService({ AKUVOX_CRED_KEY: 'za-krotki' })
    expect(svc.hasKey).toBe(false)
    expect(() => svc.encrypt('haslo')).toThrow(/AKUVOX_CRED_KEY/)
  })

  it('zły klucz przy odczycie → błąd (GCM auth tag)', () => {
    const enc = makeService({ AKUVOX_CRED_KEY: HEX_KEY }).encrypt('haslo')
    const other = makeService({ AKUVOX_CRED_KEY: 'b'.repeat(64) })
    expect(() => other.decrypt(enc)).toThrow()
  })

  it('uszkodzony payload → czytelny błąd formatu', () => {
    const svc = makeService({ AKUVOX_CRED_KEY: HEX_KEY })
    expect(() => svc.decrypt('nie-v1-format')).toThrow(/format/i)
  })
})

describe('AkuvoxDirectoryConfigService — feature flags (pkt 21)', () => {
  it('defaulty ze spec: V2=true, MANUAL_IMPORT=true, PROVISIONING=false, WRITE_API=false', () => {
    const cfg = new AkuvoxDirectoryConfigService({ get: () => undefined } as unknown as ConfigService)
    expect(cfg.flags).toEqual({
      directoryV2: true,
      manualImport: true,
      provisioningSync: false,
      directoryWriteApi: false,
    })
  })

  it('env nadpisuje defaulty ("false"/"0"/"off" → false, reszta → true)', () => {
    const cfg = new AkuvoxDirectoryConfigService({
      get: (k: string) =>
        ({ AKUVOX_DIRECTORY_V2: 'false', AKUVOX_PROVISIONING_SYNC: 'true', AKUVOX_MANUAL_IMPORT: '0' })[k],
    } as unknown as ConfigService)
    expect(cfg.flags.directoryV2).toBe(false)
    expect(cfg.flags.provisioningSync).toBe(true)
    expect(cfg.flags.manualImport).toBe(false)
  })
})
