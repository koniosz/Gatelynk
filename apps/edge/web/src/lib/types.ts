/**
 * GateLynk Edge SPA — wspólne typy.
 *
 * Odpowiada response-om z istniejących endpointów Edge NestJS:
 *   GET    /devices                            → DeviceEntry[]
 *   GET    /devices/tree                       → DeviceTreeNode[]
 *   POST   /devices/:id/test                   → TestResult (legacy)
 *   POST   /devices/:id/test-matrix            → TestMatrix
 *   POST   /devices/:id/relay/:relayIndex      → { ok, latencyMs }
 *   POST   /devices/:id/hold-open              → { holding, seconds, deviceId }
 *   POST   /devices/:id/hold-open/cancel       → { cancelled }
 *   POST   /devices/:id/dnd                    → { dnd, deviceId }
 *   GET    /devices/drivers                    → DriverCatalogEntry[]
 *
 * Driver-katalog dla wizarda + nazwa typu/labelka mapowana lokalnie (bez fetch).
 */

export type DeviceType =
  | 'INTERCOM'
  | 'CAMERA'
  | 'LPR_CAMERA'
  | 'ELEVATOR'
  | 'LIGHTING'
  | 'SWITCH'
  | 'LAN_SWITCH'
  | 'LOCK'
  | 'KNX_BRIDGE'
  | 'KNX_OBJECT'

export interface Relay {
  index: number
  name: string
}

export interface DeviceConfig {
  name?: string
  manufacturer?: string
  model?: string
  ipAddress?: string
  httpPort?: number
  login?: string
  /**
   * UWAGA: stary `GET /devices` zwraca hasło plain-text — Edge to LAN-only,
   * ale wciąż NIE wyświetlamy go w UI. Patrz `DeviceCard` — pomijamy.
   * Faza X (TODO): backend powinien sanityzować (jak `EdgeGateway` po stronie Cloud).
   */
  password?: string
  relays?: Relay[]
  channel?: number
  rtspPort?: number
  driverId?: string
  /** Catch-all dla driver-specific pól (mjpegPort, whitelistMode, …). */
  [key: string]: any
}

export interface DeviceEntry {
  deviceId: string
  type: DeviceType
  config: DeviceConfig
  enabled: boolean
}

/** Pojedyncze urządzenie w `/devices/tree` (zagnieżdżone w `group.devices`). */
export interface DeviceTreeNode {
  deviceId: string
  name?: string
  ipAddress?: string
  manufacturer?: string
  model?: string
  relays?: { index: number; name: string }[]
  online: boolean
  checkedAt?: string
}

/** Grupa typu urządzenia w `/devices/tree`. */
export interface DeviceTreeGroup {
  type: DeviceType
  label: string
  icon: string
  devices: DeviceTreeNode[]
}

/** Wynik testu (legacy `/test`). */
export interface TestResult {
  online: boolean
  latency?: number
  detail?: string
  error?: string
  snapshot?: string
}

/** Per-capability test (nowy `/test-matrix`, Faza A). */
export interface TestMatrixEntry {
  supported: boolean
  tested: boolean
  ok?: boolean
  detail?: string
  hint?: string
  error?: string
  latencyMs?: number
}

// ── LAN switch (port management) ───────────────────────────────────────────

export interface PortStateView {
  portIdx: number
  name: string
  linkUp: boolean
  speedMbps: number
  poeEnabled: boolean
  poeMode: string
  poePower: number
  rxBytes: number
  txBytes: number
  assignedDeviceId?: string
  customLabel?: string
}

export interface LanSwitchStatus {
  online: boolean
  lastFetchedAt: number | null
  lastError: string | null
}

export interface LanSwitchPortsResponse {
  ports: PortStateView[]
  status: LanSwitchStatus
}

// ── Wizard: drivery + discovery ────────────────────────────────────────────

export type FieldType =
  | 'text' | 'password' | 'number' | 'select' | 'boolean'
  | 'textarea' | 'relays' | 'mac' | 'group-address'
  | 'discovery-pick' | 'repeating-group'

export type FieldGroup =
  | 'network' | 'auth' | 'rtsp' | 'relays' | 'lpr'
  | 'ai' | 'cloud' | 'knx' | 'advanced'

export interface DriverField {
  key: string
  label: string
  type: FieldType
  group: FieldGroup
  required?: boolean
  default?: unknown
  help?: string
  placeholder?: string
  options?: { value: string; label: string }[]
  min?: number
  max?: number
}

export interface DriverCertification {
  status: 'certified' | 'beta' | 'untested' | 'community'
  testedFirmware?: string[]
  testedAt?: string
  testedBy?: string
  knownIssues?: string[]
  recommendedFor?: 'residential' | 'commercial' | 'enterprise'
}

export interface Driver {
  id: string
  type: DeviceType
  manufacturer: string
  models: string[]
  label: string
  icon?: string
  notes?: string
  fields: DriverField[]
  defaults?: Record<string, unknown>
  certification?: DriverCertification
}

export type DiscoveryProtocol = 'mdns' | 'knxnet-ip'

export interface DiscoveryCandidate {
  ip: string
  port?: number
  hostname?: string
  mac?: string
  vendor?: string
  model?: string
  serial?: string
  friendlyName?: string
  txt?: Record<string, string>
  suggestedType?: DeviceType
  suggestedDriverId?: string | null
  alternativeDrivers?: string[]
  foundVia: DiscoveryProtocol
  discoveredAt: number
}

export interface DiscoveryRunStatus {
  id: string
  status: 'running' | 'done' | 'error'
  protocols: DiscoveryProtocol[]
  startedAt: number
  finishedAt?: number
  timeoutMs: number
  candidates: DiscoveryCandidate[]
  error?: string
}

export interface TestMatrix {
  deviceId: string
  driverId: string | null
  ip?: string
  found: boolean
  online: boolean
  startedAt: number
  finishedAt: number
  capabilities: {
    network: TestMatrixEntry
    auth: TestMatrixEntry
    ping: TestMatrixEntry
    snapshot?: TestMatrixEntry
    restart?: TestMatrixEntry
    openDoor?: TestMatrixEntry
    toggle?: TestMatrixEntry
    lock?: TestMatrixEntry
    unlock?: TestMatrixEntry
    rtsp?: TestMatrixEntry
    mjpeg?: TestMatrixEntry
    lprPushList?: TestMatrixEntry
    lprEvents?: TestMatrixEntry
  }
}
