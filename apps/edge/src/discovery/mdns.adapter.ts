/**
 * mDNS / Bonjour browse — wyszukuje urządzenia po service-name.
 *
 * Korzysta z `bonjour-service` (pure JS, MIT, 0 deps natywnych). Pakiet
 * trzyma sam socket UDP multicast (224.0.0.251:5353), my tylko subskrybujemy
 * `up` event-y i agregujemy.
 *
 * Strategy:
 *   • Dla każdego driver-a z `endpoints.discovery.mdnsService` startujemy
 *     osobnego `browser`.
 *   • Browser publikuje `up(service)` i `down(service)` — agregujemy `up`
 *     do mapy `key = ip|name`, deduplikujemy.
 *   • Po timeout zamykamy wszystkie browsery i zwracamy zebrane kandydaty.
 *
 * Korelacja z driverami:
 *   Każdy kandydat ma `foundVia: 'mdns'` + `suggestedDriverId` policzony przez
 *   match service-name lub hostname-pattern z `DiscoveryHints` w katalogu.
 *
 * UWAGA: na macOS bonjour-service korzysta z systemowego mDNSResponder w tle,
 * więc czasem 1-2 pakiety wpadają z opóźnieniem 1-2s. Default timeout 15s
 * daje margines.
 */
import { Logger } from '@nestjs/common'
import { Bonjour, type Service } from 'bonjour-service'
import {
  DRIVERS,
  type DeviceDriver,
  type DiscoveryHints,
} from '@gatelynk/device-drivers'
import type { DiscoveryCandidate } from './discovery.types'

const logger = new Logger('MdnsDiscovery')

/**
 * Wyciąga unikalne service-name z hints driverów. Driver może podać string
 * lub array — normalizujemy do array, deduplikujemy.
 */
function collectMdnsServices(): string[] {
  const set = new Set<string>()
  for (const d of DRIVERS) {
    const hints: DiscoveryHints | undefined = d.endpoints.discovery
    if (!hints?.mdnsService) continue
    const arr = Array.isArray(hints.mdnsService) ? hints.mdnsService : [hints.mdnsService]
    for (const svc of arr) set.add(svc)
  }
  return [...set]
}

/**
 * Generyczne (low-confidence) service-types które publikuje wszystko z webowym UI
 * — drukarki, NAS-y, AVR-y, IP kamery, smart-glove. Match driverowi po nich
 * jest **dopuszczalny tylko jeśli równocześnie pasuje hostname-pattern**, inaczej
 * nadpisze wszystko jako pierwszy driver z listy.
 */
const GENERIC_MDNS_SERVICES = new Set(['_http._tcp', '_https._tcp', '_workstation._tcp'])

/**
 * Match service do drivera — po service-name lub hostname-pattern. Zwraca
 * pierwszy match (driverzy są sortowani w `DRIVERS` od najpopularniejszych)
 * + listę alternatyw (gdy więcej niż 1 driver pasuje).
 *
 * Reguły:
 *  • match po specyficznym service-name (`_shelly._tcp`, `_axis-video._tcp`, …)
 *    → wystarczy sam service-name.
 *  • match po generycznym service-name (`_http._tcp`) → wymagamy równocześnie
 *    hostname-pattern (np. `^shellypro\d+-`) lub TXT match. Inaczej każda
 *    drukarka w sieci byłaby „Shelly".
 *  • match po samym hostname-pattern (bez wpisu w `mdnsService`) → wystarczy
 *    pattern matchuje hostname.
 *
 * Service-name musi zaczynać się od `_` (bonjour-service publikuje `service.type`
 * bez `_tcp` / `_udp` suffixa, ale fqdn ma pełną nazwę).
 */
function matchDriver(svc: Service): { driverId: string | null; alternatives: string[] } {
  const matches: DeviceDriver[] = []
  const svcType = `_${svc.type}._${svc.protocol}`
  const hostMatchesPattern = (pattern?: RegExp) => !!pattern && !!svc.host && pattern.test(svc.host)

  for (const d of DRIVERS) {
    const hints = d.endpoints.discovery
    if (!hints) continue

    let hit = false

    if (hints.mdnsService) {
      const wanted = Array.isArray(hints.mdnsService) ? hints.mdnsService : [hints.mdnsService]
      const serviceMatched = wanted.includes(svcType)

      if (serviceMatched) {
        if (GENERIC_MDNS_SERVICES.has(svcType)) {
          // Generic service — wymagamy potwierdzenia przez hostname-pattern.
          // (W przyszłości można też dodać TXT-key match, np. TXT.app=shelly-*)
          hit = hostMatchesPattern(hints.mdnsHostnamePattern)
        } else {
          hit = true
        }
      }
    }

    // Match po samym hostname-pattern (driver nie ma mdnsService, tylko pattern).
    if (!hit && !hints.mdnsService && hostMatchesPattern(hints.mdnsHostnamePattern)) {
      hit = true
    }

    if (hit) matches.push(d)
  }

  if (matches.length === 0) return { driverId: null, alternatives: [] }
  return {
    driverId: matches[0].id,
    alternatives: matches.slice(1).map((d) => d.id),
  }
}

/**
 * Konwertuje `Service` z bonjour-service na nasz `DiscoveryCandidate`.
 * IP wyciągamy z `addresses[]` (preferujemy IPv4).
 */
function serviceToCandidate(svc: Service): DiscoveryCandidate | null {
  const ipv4 = svc.addresses?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a))
  if (!ipv4) return null

  const { driverId, alternatives } = matchDriver(svc)

  // TXT records — bonjour-service zwraca jako obiekt, normalizujemy do string.
  const txt: Record<string, string> = {}
  if (svc.txt) {
    for (const [k, v] of Object.entries(svc.txt)) {
      txt[k] = typeof v === 'string' ? v : Buffer.isBuffer(v) ? v.toString('utf-8') : String(v)
    }
  }

  // Sugerowany typ — z drivera (jeśli matchnęliśmy)
  const driver = driverId ? DRIVERS.find((d) => d.id === driverId) : null

  return {
    ip: ipv4,
    port: svc.port,
    hostname: svc.host,
    vendor: driver?.manufacturer,
    model: txt.md ?? txt.model,  // Shelly publikuje `md=Pro1`, Hik `model=...`
    friendlyName: svc.name,
    txt,
    suggestedType: driver?.type,
    suggestedDriverId: driverId,
    alternativeDrivers: alternatives.length > 0 ? alternatives : undefined,
    foundVia: 'mdns',
    discoveredAt: Date.now(),
  }
}

/**
 * Uruchamia mDNS browse na wszystkich service-name'ach z driverów. Zbiera
 * kandydatów przez `timeoutMs` i zwraca po zamknięciu wszystkich browserów.
 */
export async function mdnsBrowseAll(timeoutMs: number): Promise<DiscoveryCandidate[]> {
  const services = collectMdnsServices()
  if (services.length === 0) {
    logger.log('No mDNS services configured in driver catalog — skipping mDNS scan')
    return []
  }

  logger.log(`Starting mDNS browse for ${services.length} service-type(s): ${services.join(', ')}`)
  const bonjour = new Bonjour()
  const candidates = new Map<string, DiscoveryCandidate>()

  // Każda service-name → osobny browser. Bonjour wymaga `{ type, protocol }`
  // skąd parsujemy `_shelly._tcp` → `{ type: 'shelly', protocol: 'tcp' }`.
  for (const svcName of services) {
    const m = svcName.match(/^_([^.]+)\._(tcp|udp)$/)
    if (!m) {
      logger.warn(`Invalid mDNS service-name "${svcName}" — skipping`)
      continue
    }
    const [, type, protocol] = m
    const browser = bonjour.find({ type, protocol: protocol as 'tcp' | 'udp' })

    browser.on('up', (svc) => {
      const candidate = serviceToCandidate(svc)
      if (!candidate) return
      const key = `${candidate.ip}|${candidate.friendlyName}|${svcName}`
      if (!candidates.has(key)) {
        candidates.set(key, candidate)
        logger.log(
          `mDNS up: ${svc.name} @ ${candidate.ip}:${candidate.port} ` +
          `(driver=${candidate.suggestedDriverId ?? 'unknown'})`,
        )
      }
    })

    browser.on('down', (svc) => {
      logger.debug?.(`mDNS down: ${svc.name}`)
    })
  }

  // Czekamy timeout, potem zamykamy
  await new Promise<void>((res) => setTimeout(res, timeoutMs))

  try {
    bonjour.destroy()
  } catch (err: any) {
    logger.warn(`Bonjour destroy failed: ${err.message}`)
  }

  return [...candidates.values()]
}
