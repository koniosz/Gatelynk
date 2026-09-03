/**
 * Cienka warstwa adapterowa nad pakietem `@gatelynk/device-drivers`.
 *
 * Zastępuje rozsiane po Edge `if (m.includes('hikvision'))` jednym dispatchem
 * po `config.driverId`. Każdy serwis urządzenia (intercom, cameras, …) używa
 * helperów z tego pliku, dzięki czemu nowy producent = nowy plik w katalogu
 * driverów, bez dotykania serwisów.
 *
 * Engine **nie** wykonuje żadnych requestów — zwraca rozwinięte URL-e i
 * gotowe „spec" obiekty (method/url/body/auth). Wykonanie należy do
 * wywołującego (np. w `device-registry.service.ts` jest już cały kod
 * Digest-aware HTTP, który po prostu dostaje URL z drivera).
 */
import {
  DRIVERS,
  findDriver,
  guessDriverId,
  renderTemplate,
  renderTemplates,
  type DeviceDriver,
  type ActionEndpoint,
} from '@gatelynk/device-drivers'

/**
 * Kształt configu z punktu widzenia Edge — `Record<string, unknown>` z
 * opcjonalnym `driverId`. Reszta pól zależy od drivera.
 */
export interface DeviceConfigShape {
  driverId?: string
  manufacturer?: string
  model?: string
  ipAddress?: string
  httpPort?: number
  rtspPort?: number
  channel?: number
  login?: string
  password?: string
  rtspLogin?: string
  rtspPassword?: string
  rtspPath?: string  // override
  // … i wszystko inne, co może występować w driverze
  [key: string]: unknown
}

/**
 * Znajdź driver dla danego configu. Najpierw po `config.driverId`,
 * potem fallback po `manufacturer + model`. Zwraca `null` gdy nie ma
 * dopasowania (legacy config nieznanego producenta).
 */
export function resolveDriver(
  type: 'INTERCOM' | 'CAMERA' | 'LPR_CAMERA' | 'ELEVATOR' | 'LIGHTING',
  config: DeviceConfigShape,
): DeviceDriver | null {
  if (config.driverId) {
    const direct = findDriver(config.driverId)
    if (direct) return direct
  }
  const guessedId = guessDriverId(type, {
    manufacturer: config.manufacturer,
    model: config.model,
  })
  return findDriver(guessedId)
}

/**
 * Zwraca zmienną mapę do template'ingu — wyciąga z configu pola, które
 * najczęściej występują w URLach (`{ip}`, `{httpPort}`, `{channel}`, …).
 * Wywołujący może dodać swoje (`{relay}` przy otwarciu drzwi).
 */
export function buildTemplateVars(config: DeviceConfigShape, extras?: Record<string, unknown>) {
  // 2026-05-14 fix: stare implementacje robiły `{ ..., channel: config.channel ?? 1, ...config }`
  // co WPISYWAŁO z powrotem `channel: undefined` gdy config eksplicytnie zawierał `channel: undefined`
  // (np. synthetic `{ manufacturer: 'hikvision', channel: undefined }` z `buildRtspPaths(m, undefined)`).
  // Skutek: template `{channel*100+1}` rozwijał się na `NaN*100+1 = NaN`, ffmpeg dostawał
  // `Streaming/Channels/NaN` i RTSP server zwracał 400.
  //
  // Naprawa: filter undefined z config-a PRZED spread, fallbacki zostają.
  const cleaned: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(config)) {
    if (v !== undefined) cleaned[k] = v
  }
  return {
    ip: config.ipAddress ?? '',
    httpPort: config.httpPort ?? 80,
    rtspPort: config.rtspPort ?? 554,
    channel: config.channel ?? 1,
    login: config.login ?? '',
    ...cleaned,
    ...(extras ?? {}),
  }
}

/** URL-e do testu połączenia (ping) — kolejność = priorytet. */
export function pingUrls(driver: DeviceDriver | null, config: DeviceConfigShape): string[] {
  if (!driver?.endpoints.ping) return []
  return renderTemplates(driver.endpoints.ping, buildTemplateVars(config))
}

/** URL-e do HTTP snapshotu. */
export function snapshotUrls(driver: DeviceDriver | null, config: DeviceConfigShape): string[] {
  if (!driver?.endpoints.snapshot) return []
  return renderTemplates(driver.endpoints.snapshot, buildTemplateVars(config))
}

/**
 * Ścieżki RTSP (bez `rtsp://user:pass@ip:port/`). Jeśli config ma `rtspPath`
 * (override) — używamy wyłącznie jego.
 */
export function rtspPaths(driver: DeviceDriver | null, config: DeviceConfigShape): string[] {
  if (config.rtspPath && typeof config.rtspPath === 'string') return [config.rtspPath]
  if (!driver?.endpoints.rtspPath) return []
  return renderTemplates(driver.endpoints.rtspPath, buildTemplateVars(config))
}

/**
 * Spec restartu — gotowy do wywołania przez axios. Zwraca null gdy driver
 * nie wspiera lub nie znamy drivera.
 */
export interface ResolvedAction {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  url: string
  // Rozszerzone w Fazie 1 wizard-a: `bearer`/`apikey` dla cloud-bound driverów
  // (np. Tedee). Edge http-digest engine obsługuje wyłącznie `basic`/`digest`/`none`;
  // dla `bearer`/`apikey`/`cloud` wykonanie musi pójść osobną ścieżką (cloud SDK).
  auth: 'basic' | 'digest' | 'bearer' | 'apikey' | 'none'
  /** Protokół wykonania — patrz `ActionEndpoint.protocol` w types.ts. */
  protocol?: 'http' | 'knxnet-ip' | 'cloud'
  body?: string
  contentType?: string
  okStatus?: number[]
}

function resolveAction(
  endpoint: ActionEndpoint | undefined,
  config: DeviceConfigShape,
  extras?: Record<string, unknown>,
): ResolvedAction | null {
  if (!endpoint) return null
  const vars = buildTemplateVars(config, extras)
  return {
    method: endpoint.method,
    url: renderTemplate(endpoint.url, vars),
    auth: endpoint.auth,
    protocol: endpoint.protocol,
    body: endpoint.body ? renderTemplate(endpoint.body, vars) : undefined,
    contentType: endpoint.contentType,
    okStatus: endpoint.okStatus,
  }
}

export function restartAction(
  driver: DeviceDriver | null,
  config: DeviceConfigShape,
): ResolvedAction | null {
  return resolveAction(driver?.endpoints.restart, config)
}

export function openDoorAction(
  driver: DeviceDriver | null,
  config: DeviceConfigShape,
  relayIndex: number,
): ResolvedAction | null {
  return resolveAction(driver?.endpoints.openDoor, config, { relay: relayIndex })
}

export function closeDoorAction(
  driver: DeviceDriver | null,
  config: DeviceConfigShape,
  relayIndex: number,
): ResolvedAction | null {
  return resolveAction(driver?.endpoints.closeDoor, config, { relay: relayIndex })
}

/**
 * Faza F-4.1: DND (Do Not Disturb) — `{state}` w URL/body rozwijane do
 * `'on'|'off'` (firmware-specific syntax dobrany przez driver-engine).
 */
export function setDndAction(
  driver: DeviceDriver | null,
  config: DeviceConfigShape,
  enabled: boolean,
): ResolvedAction | null {
  return resolveAction(driver?.endpoints.setDnd, config, { state: enabled ? 'on' : 'off' })
}

/**
 * Eksport całego katalogu — używane przez nowy endpoint `/devices/drivers`,
 * który wystawia katalog dla webowego/Edge admin UI.
 */
export { DRIVERS }
