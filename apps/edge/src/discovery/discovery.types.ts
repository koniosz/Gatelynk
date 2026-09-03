/**
 * Typy domeny dla modułu Discovery.
 *
 * Discovery składa się z 3 protokołów wykonywanych równolegle:
 *   • mDNS browse — wyszukiwanie po service-name (`_shelly._tcp`, `_http._tcp`),
 *   • KNXnet/IP search — natywny UDP SEARCH_REQUEST → wszystkie KNX-IP routery odpowiadają,
 *   • (opcjonalnie w przyszłości) ARP scan z OUI lookup — fallback dla urządzeń bez mDNS.
 *
 * Każdy kandydat (`DiscoveryCandidate`) ma `suggestedDriverId` policzony przez korelację
 * hints w katalogu driverów (`DiscoveryHints.mdnsService`/`macPrefixes`).
 *
 * Run jest in-memory (Map<runId, DiscoveryRun>). Po zakończeniu trzymamy 5 minut
 * żeby UI miało czas zassać wynik, potem GC.
 */

import type { DeviceType } from '@gatelynk/device-drivers'

/** Protokół wykrywania. */
export type DiscoveryProtocol = 'mdns' | 'knxnet-ip' | 'lan-scan'

/** Pojedynczy kandydat — urządzenie znalezione w LAN. */
export interface DiscoveryCandidate {
  /** Adres IP — zawsze obecny (mDNS rozwiązuje hostname → IP). */
  ip: string
  /** Port (jeśli mDNS publikował SRV record, albo KNX = 3671). */
  port?: number
  /** Hostname z mDNS (np. `shellypro1-349454ABCDEF.local`). */
  hostname?: string
  /** Adres MAC — gdy znamy (z ARP albo SEARCH_RESPONSE w KNX). */
  mac?: string
  /** Producent z TXT records lub OUI lookup. */
  vendor?: string
  /** Model — gdy producent go publikuje w mDNS TXT (`md=Pro1`, …). */
  model?: string
  /** Serial / SN — KNX publikuje to w DIB Device Info; Shelly w TXT. */
  serial?: string
  /** Friendly name urządzenia (KNX SEARCH_RESPONSE) lub TXT `name=`. */
  friendlyName?: string
  /** TXT records z mDNS (key→value) — surowe dane do prezentacji w UI „Pokaż detale". */
  txt?: Record<string, string>
  /** Sugerowany typ urządzenia — z `DriverDriver.type` po dopasowaniu. */
  suggestedType?: DeviceType
  /** Sugerowany driverId — gdy heurystyka dopasowała go pewnie (>1 match → null + lista alternatyw). */
  suggestedDriverId?: string | null
  /** Alternatywne dopasowania — UI może pokazać dropdown „Wybierz wariant". */
  alternativeDrivers?: string[]
  /** Protokół, który go znalazł — do statystyk i debugu. */
  foundVia: DiscoveryProtocol
  /** Timestamp wykrycia (Date.now()). */
  discoveredAt: number
}

/** Status jednego run-a discovery. */
export type DiscoveryStatus = 'running' | 'done' | 'error'

/** Pojedynczy run discovery — uruchomiony przez `POST /devices/discover`. */
export interface DiscoveryRun {
  id: string
  status: DiscoveryStatus
  protocols: DiscoveryProtocol[]
  /** Start (Date.now()). */
  startedAt: number
  /** Koniec (Date.now()) — undefined dopóki status === 'running'. */
  finishedAt?: number
  /** Timeout w ms — po nim run kończy się jako `done`. */
  timeoutMs: number
  /** Wszystkie zebrane kandydaty (mDNS + KNXnet/IP itp.). */
  candidates: DiscoveryCandidate[]
  /** Błąd globalny (gdy `status === 'error'`). */
  error?: string
}

/** Argumenty POST /devices/discover. */
export interface DiscoveryStartOpts {
  /** Które protokoły uruchomić. Default: wszystkie. */
  protocols?: DiscoveryProtocol[]
  /** Timeout w ms. Default: 15000 (15 sek). Max: 60000 (1 min). */
  timeoutMs?: number
}
