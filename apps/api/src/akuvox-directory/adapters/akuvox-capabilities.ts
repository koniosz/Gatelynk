/**
 * Capabilities detection (pkt 6 spec) — Etap 1: CZYSTA FUNKCJA z (model,
 * firmwareVersion) + capabilitiesOverride z bazy. ZERO żądań sieciowych do
 * urządzeń (twarda granica); testowane wyłącznie na mockach/fixture.
 *
 * Progi wersji:
 *  - 29.30.10.128 (produkcyjny R29C) → „starsze": legacy phonebook URL + import
 *    plikowy formatu Contacts/UserData; wymaga migracji do LTS.
 *  - 29.30.10.465+ (LTS) → model Directory → User → Contact Details.
 *
 * supportsHttpApi ≠ zarządzanie kontaktami przez API — od tego jest OSOBNA
 * flaga supportsDirectoryWriteApi, domyślnie false wszędzie (żaden endpoint
 * API Akuvox nie jest potwierdzony oficjalną dokumentacją / testem na sprzęcie).
 */
import { AkuvoxCapabilities, AkuvoxDeviceInfo } from '../domain/directory.types'

/** Minimalna wersja z modelem Directory User (docelowy LTS wg spec). */
export const DIRECTORY_USER_MIN_FIRMWARE = '29.30.10.465'

/** Porównanie wersji firmware "a.b.c.d" — zwraca <0 / 0 / >0. */
export function compareFirmware(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

function isKnownVersion(fw: string): boolean {
  return /^\d+(\.\d+){1,3}$/.test(fw.trim())
}

export function detectCapabilitiesFromInfo(info: AkuvoxDeviceInfo): AkuvoxCapabilities {
  const model = (info.model || '').trim() || 'UNKNOWN'
  const fw = (info.firmwareVersion || '').trim()
  const known = isKnownVersion(fw)
  const directoryUsers = known && compareFirmware(fw, DIRECTORY_USER_MIN_FIRMWARE) >= 0

  const base: AkuvoxCapabilities = {
    model,
    firmwareVersion: fw || 'UNKNOWN',
    hardwareVersion: info.hardwareVersion,
    // Remote Phonebook URL — potwierdzony na 29.30.10.128 (produkcja).
    supportsLegacyPhonebookUrl: known,
    supportsDirectoryUsers: directoryUsers,
    supportsContactDetails: directoryUsers,
    // Formaty importu — zachowawczo: CSV/XML/TGZ potwierdzamy dopiero realnym
    // template'em z urządzenia (pkt 7). TGZ potwierdzony sprzętowo na E18C.
    supportsCsvImport: directoryUsers,
    supportsXmlImport: known,
    supportsTgzImport: known,
    // Menu HTTP API istnieje w firmware R29 — ale to NIE oznacza zapisu katalogu.
    supportsHttpApi: known,
    supportsDirectoryWriteApi: false,
  }

  // Ręczne nadpisania z bazy (np. integrator potwierdził CSV testem na sprzęcie).
  const override = info.capabilitiesOverride ?? undefined
  return override ? { ...base, ...override, model: base.model, firmwareVersion: base.firmwareVersion } : base
}

/** Rekomendowany adapter dla urządzenia. */
export function recommendedAdapter(caps: AkuvoxCapabilities): 'legacy-contacts' | 'directory-user' {
  return caps.supportsDirectoryUsers ? 'directory-user' : 'legacy-contacts'
}
