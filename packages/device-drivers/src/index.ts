/**
 * Publiczny punkt wejścia pakietu `@gatelynk/device-drivers`.
 *
 * Eksportuje:
 *   • typy (DeviceDriver, DriverField, …)
 *   • silnik szablonów (renderTemplate)
 *   • katalog driverów (DRIVERS) + helpery `findDriver`, `driversForType`,
 *     `guessDriverId` (dla legacy configów bez `driverId`).
 */

export type {
  DeviceType, FieldType, FieldGroup,
  DriverField, Capability, ActionEndpoint,
  DriverEndpoints, DeviceDriver,
  DiscoveryHints,
  DriverConstants, DriverCertification,
} from './types'

export { renderTemplate, renderTemplates } from './template'
export type { TemplateVars } from './template'

// Lista certyfikowanych urządzeń — patrz `certified.ts`
export { CERTIFIED, certifiedFor, isCertified } from './certified'
export type { CertifiedDevice } from './certified'

import type { DeviceDriver, DeviceType } from './types'
import { hikvisionIntercom, hikvisionLpr, hikvisionCamera } from './catalog/hikvision'
import { akuvoxIntercom } from './catalog/akuvox'
import { dahuaCamera, dahuaItcLpr } from './catalog/dahua'
import { twoNHelios } from './catalog/twoN'
import { dnakeIntercom } from './catalog/dnake'
import { comelitIntercom } from './catalog/comelit'
import { shellyPro1 } from './catalog/shelly'
import { unifiSwitchPro8PoE } from './catalog/unifi'
// `tedeeCloud` jest świadomie NIE eksportowany do DRIVERS[] — decyzja
// architektoniczna 2026-05-13: smart-locki mieszkaniowe (Tedee, Nuki) to
// prywatne klucze mieszkańca, nie infrastruktura budynku. Drivery zostają
// w pliku jako szkic do przyszłej implementacji **w iOS app** (Keychain →
// tedee.com API peer-to-peer, GateLynk Cloud nie widzi PAK). Patrz docstring
// w `catalog/tedee.ts` po pełne uzasadnienie i przyszły roadmap.
// import { tedeeCloud } from './catalog/tedee'
import { knxIpBridge, knxGenericObject } from './catalog/knx'

/**
 * Pełen katalog driverów. Kolejność = kolejność wyświetlania w pickerze
 * „Producent" w UI. Pierwsze = najczęściej spotykane na rynku.
 *
 * Reguła doboru: tu trafiają TYLKO urządzenia **infrastruktury budynku** —
 * te, którymi zarządza operator (administracja). Urządzenia prywatne
 * mieszkańca (smart-locki, prywatne kamery) — patrz `MOBILE_DRIVERS` (TBD).
 */
export const DRIVERS: DeviceDriver[] = [
  // Domofony
  akuvoxIntercom,
  hikvisionIntercom,
  twoNHelios,
  dnakeIntercom,
  comelitIntercom,
  // Kamery (zwykłe)
  hikvisionCamera,
  dahuaCamera,
  // LPR
  hikvisionLpr,
  dahuaItcLpr,
  // SWITCH (relay, Ethernet) — Shelly Pro
  shellyPro1,
  // LAN_SWITCH (managed L2/L3 + PoE) — Ubiquiti UniFi
  unifiSwitchPro8PoE,
  // KNX — bridge + generyczny object (eelectron / Jung / Gira)
  knxIpBridge,
  knxGenericObject,
]

/** Pełny zbiór nazw producentów — dla pickera. */
export function manufacturers(type?: DeviceType): string[] {
  const list = type ? DRIVERS.filter((d) => d.type === type) : DRIVERS
  return Array.from(new Set(list.map((d) => d.manufacturer)))
}

export function findDriver(id: string | null | undefined): DeviceDriver | null {
  if (!id) return null
  return DRIVERS.find((d) => d.id === id) ?? null
}

export function driversForType(type: DeviceType): DeviceDriver[] {
  return DRIVERS.filter((d) => d.type === type)
}

export function driversForManufacturer(
  type: DeviceType,
  manufacturer: string,
): DeviceDriver[] {
  return DRIVERS.filter(
    (d) => d.type === type && d.manufacturer.toLowerCase() === manufacturer.toLowerCase(),
  )
}

/**
 * Legacy bridge: starsze configi w bazie nie mają `driverId`, tylko
 * `manufacturer` + `model`. Ta funkcja zgaduje driver po dopasowaniu modelu
 * (jeśli zna), w ostateczności po samym producencie.
 *
 * Używana w Edge w `applyConfig` przy starcie — leniwie uzupełnia `driverId`.
 */
export function guessDriverId(
  type: DeviceType,
  config: { manufacturer?: string; model?: string },
): string | null {
  const mfr = (config.manufacturer ?? '').toLowerCase().trim()
  const model = (config.model ?? '').toLowerCase().trim()
  if (!mfr) return null

  const candidates = DRIVERS.filter(
    (d) => d.type === type && d.manufacturer.toLowerCase() === mfr,
  )
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0].id

  // Mamy kilku driverów dla tego producenta — dopasuj po modelu.
  if (model) {
    const exact = candidates.find((d) => d.models.some((m) => m.toLowerCase() === model))
    if (exact) return exact.id
    const partial = candidates.find((d) => d.models.some((m) => m.toLowerCase().includes(model) || model.includes(m.toLowerCase())))
    if (partial) return partial.id
  }
  return candidates[0].id
}

/**
 * Szybkie sprawdzenie czy dany driver wspiera daną akcję — używane przez UI
 * do ukrywania przycisków („Restart"/„MJPEG live") gdy producent ich nie umie.
 */
export function hasCapability(
  driverId: string | null | undefined,
  capability: import('./types').Capability,
): boolean {
  const d = findDriver(driverId)
  return d?.capabilities.includes(capability) ?? false
}
