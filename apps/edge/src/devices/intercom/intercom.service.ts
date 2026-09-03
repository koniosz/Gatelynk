import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { DeviceStatusEntry } from '../../tunnel/tunnel.types'
import {
  resolveDriver,
  restartAction as engineRestartAction,
  openDoorAction as engineOpenDoorAction,
  setDndAction as engineSetDndAction,
} from '../driver-engine'
import { requestWithDigest } from '../http-digest'
import { lanHttpsAgent } from '../lan-https-agent'
import { StoreService } from '../../store/store.service'

/**
 * Kody błędów Akuvox `/fcgi/OpenDoor` na ludzki język. Bez tego integrator
 * widzi w panelu tylko „Internal server error" i nie wie, czy problem jest
 * w sieci, w haśle, czy w ustawieniach samej kasety.
 *
 * -3 („Not Enable") to najczęstszy przypadek przy nowej stacji: w firmware
 * trzeba najpierw włączyć otwieranie przekaźnika przez HTTP API
 * (Intercom → Relay / „Open Relay via HTTP”), inaczej urządzenie grzecznie
 * odpowiada 200 i nic nie robi.
 */
const AKUVOX_RETCODE_HINTS: Record<number, string> = {
  [-1]: 'kaseta odrzuciła żądanie (nieznana akcja)',
  [-2]: 'zły numer przekaźnika — sprawdź numerację wyjść w konfiguracji urządzenia',
  [-3]: 'otwieranie przekaźnika przez HTTP API jest WYŁĄCZONE w ustawieniach kasety',
  [-4]: 'kaseta pracuje w trybie High Security — sprawdź hasło API',
}

/** Wyciąga `retcode` z odpowiedzi Akuvox OpenDoor (JSON obiekt albo string). */
function extractAkuvoxRetcode(data: unknown): number | null {
  if (data == null) return null
  if (typeof data === 'object') {
    const r = (data as any).retcode
    return typeof r === 'number' ? r : null
  }
  const m = String(data).match(/"retcode"\s*:\s*(-?\d+)/)
  return m ? Number.parseInt(m[1], 10) : null
}

interface IntercomConfig {
  ipAddress: string
  login: string
  password: string
  manufacturer: string
  model: string
  doorRelayIndex?: number
  /** Wskaźnik na driver z katalogu @gatelynk/device-drivers — gdy ustawiony,
   *  serwis dispatchuje akcje (open/restart) przez `driver-engine` zamiast
   *  starych `if (m.includes(…))`. Patrz `driver-engine.ts`. */
  driverId?: string
  [key: string]: unknown
}

interface IntercomDevice {
  id: string
  config: IntercomConfig
  lastSeen?: number
  online: boolean
}

@Injectable()
export class IntercomService {
  private readonly logger = new Logger(IntercomService.name)
  private devices: Map<string, IntercomDevice> = new Map()

  // StoreService jest @Global() — inject bez extra imports w DevicesModule.
  // Używane do persystentnego logu trigerów (`relay_triggers` table).
  constructor(private readonly store: StoreService) {}

  addDevice(id: string, config: IntercomConfig) {
    this.devices.set(id, { id, config, online: false })
    this.logger.log(`Intercom registered: ${id} (${config.manufacturer} ${config.model} @ ${config.ipAddress})`)
    this.ping(id)
  }

  removeDevice(id: string): boolean {
    const existed = this.devices.delete(id)
    if (existed) this.logger.log(`Intercom unregistered: ${id}`)
    return existed
  }

  async execute(action: string, payload?: any): Promise<any> {
    const targetId = payload?.deviceId ?? [...this.devices.keys()][0]
    const device = this.devices.get(targetId)
    if (!device) throw new Error(`Intercom ${targetId} not found`)

    // Źródło triggera (HTTP/PIN/LPR/HOLD_OPEN/OTHER) — caller może podać
    // w payloadzie żeby chart Monitoringu wiedział co kogo otworzyło.
    const source = (payload?.source as 'HTTP' | 'PIN' | 'HOLD_OPEN' | 'LPR' | 'OTHER') ?? 'OTHER'

    switch (action) {
      case 'OPEN_DOOR':
        return this.openDoor(device, payload?.doorIndex ?? 0, source)
      case 'CLOSE_DOOR':
        return this.closeDoor(device, payload?.doorIndex ?? 0)
      case 'OPEN_GATE':
        return this.openDoor(device, payload?.gateIndex ?? 1, source)
      case 'HOLD_OPEN':
        return this.holdOpen(targetId, payload?.seconds ?? 30, payload?.doorIndex ?? 0)
      case 'CANCEL_HOLD_OPEN':
        return this.cancelHoldOpen(targetId)
      case 'DND_ON':
        return this.setDnd(targetId, true)
      case 'DND_OFF':
        return this.setDnd(targetId, false)
      default:
        throw new Error(`Intercom: unknown action ${action}`)
    }
  }

  // ─── Faza F-2 (2026-05-14): HOLD_OPEN ────────────────────────────────────
  //
  // Trzymaj otwartą bramę/drzwi przez `seconds` sekund — przydatne dla kuriera,
  // ekipy remontowej, sprzątaczek. Akuvox/Hik/2N/DNAKE NIE mają natywnego
  // hold-open w API, więc symulujemy:
  //   • setInterval(openDoor, 4000) cyklicznie pobudza relay
  //   • większość intercomów ma relay auto-release po 2-5s (config urządzenia)
  //   • przy interwale 4s drzwi nigdy nie zamykają się dłużej niż na ~4s
  //   • po `seconds` setTimeout odpala cancelHoldOpen
  //
  // Stan: `Map<deviceId, NodeJS.Timer[interval, timeout]>` żeby cancel mógł
  // czyścić oba timery. Ponowne wywołanie HOLD_OPEN przed expire — rejestruje
  // nowy timer i kasuje stary (nie kumulujemy).
  //
  // Bezpieczeństwo: `seconds` ograniczone do `driver.constants.holdOpenMaxSeconds`
  // (default 600 = 10 min). Większe = throw BadRequest.

  private holdOpenTimers: Map<string, { interval: NodeJS.Timeout; timeout: NodeJS.Timeout }> = new Map()
  private readonly HOLD_OPEN_PULSE_MS = 4_000
  private readonly HOLD_OPEN_MAX_SECONDS_DEFAULT = 600

  async holdOpen(
    deviceId: string,
    seconds: number,
    doorIndex: number,
  ): Promise<{ holding: true; seconds: number; deviceId: string }> {
    const device = this.devices.get(deviceId)
    if (!device) throw new Error(`Intercom ${deviceId} not found`)
    // Walidacja granic — fallback do default gdy driver nie ma constants
    const driverMax = (device.config as any)?.holdOpenMaxSeconds ?? this.HOLD_OPEN_MAX_SECONDS_DEFAULT
    const clamped = Math.max(5, Math.min(seconds, driverMax))
    if (clamped !== seconds) {
      this.logger.warn(`holdOpen(${deviceId}): seconds=${seconds} clamped to ${clamped} (driver max=${driverMax})`)
    }

    // Anuluj poprzedni hold gdy aktywny
    this.cancelHoldOpen(deviceId)

    // Pierwsze otwarcie natychmiast, potem co HOLD_OPEN_PULSE_MS
    this.openDoor(device, doorIndex, 'HOLD_OPEN').catch((err) =>
      this.logger.warn(`holdOpen(${deviceId}) initial openDoor failed: ${err.message}`),
    )
    const interval = setInterval(() => {
      this.openDoor(device, doorIndex, 'HOLD_OPEN').catch((err) =>
        this.logger.warn(`holdOpen(${deviceId}) refresh openDoor failed: ${err.message}`),
      )
    }, this.HOLD_OPEN_PULSE_MS)
    const timeout = setTimeout(() => this.cancelHoldOpen(deviceId), clamped * 1000)

    this.holdOpenTimers.set(deviceId, { interval, timeout })
    this.logger.log(`HOLD_OPEN start: ${deviceId} relay=${doorIndex} for ${clamped}s`)
    return { holding: true, seconds: clamped, deviceId }
  }

  cancelHoldOpen(deviceId: string): { cancelled: boolean } {
    const timers = this.holdOpenTimers.get(deviceId)
    if (!timers) return { cancelled: false }
    clearInterval(timers.interval)
    clearTimeout(timers.timeout)
    this.holdOpenTimers.delete(deviceId)
    this.logger.log(`HOLD_OPEN cancelled: ${deviceId}`)
    return { cancelled: true }
  }

  /** Lista aktualnie aktywnych hold-open-ów — używane przez `/status` endpoint. */
  listActiveHolds(): string[] {
    return [...this.holdOpenTimers.keys()]
  }

  // ─── Faza F-4.1 (2026-05-14): DND (Do Not Disturb) ──────────────────────
  //
  // Włącza/wyłącza dzwonienia z intercomu. Typowy use-case portiera: nocą
  // wyłączamy żeby kurier nie budził mieszkańców. Akuvox FCGI:
  //   GET /fcgi/do?action=DoNotDisturb&op=on (lub off)
  //
  // Driver wystawia endpoint przez `endpoints.setDnd` w katalogu. Driver-engine
  // rozwija `{state}` na 'on'|'off'. Bez setDnd w driverze → throw.
  async setDnd(deviceId: string, enabled: boolean): Promise<{ dnd: boolean; deviceId: string }> {
    const device = this.devices.get(deviceId)
    if (!device) throw new Error(`Intercom ${deviceId} not found`)

    const driver = resolveDriver('INTERCOM', device.config as any)
    const action = engineSetDndAction(driver, device.config as any, enabled)
    if (!action) {
      throw new Error(
        `Driver ${driver?.id ?? device.config.manufacturer} nie wspiera DND. ` +
        `Sprawdź czy driver ma 'dnd' w capabilities i 'setDnd' w endpoints.`,
      )
    }

    try {
      const axios = require('axios')
      const res = await axios.request({
        method: action.method,
        url: action.url,
        data: action.body,
        headers: action.contentType ? { 'Content-Type': action.contentType } : {},
        httpsAgent: lanHttpsAgent,
        timeout: 5000,
        validateStatus: () => true,
      })
      if (res.status >= 200 && res.status < 300) {
        this.logger.log(`DND ${enabled ? 'ON' : 'OFF'} for ${deviceId} via ${action.url}`)
        return { dnd: enabled, deviceId }
      }
      throw new Error(`HTTP ${res.status}: ${String(res.data).slice(0, 200)}`)
    } catch (err: any) {
      this.logger.error(`setDnd(${deviceId}, ${enabled}) failed: ${err.message}`)
      throw err
    }
  }

  /**
   * Restart urządzenia — driver z katalogu definiuje metodę (PUT/POST/GET)
   * i URL. Jeśli driver nie wspiera restartu (lub nie znamy go) wracamy do
   * starych dopasowań po manufacturer (Akuvox/Hik/2N/Dnake) — to gwarantuje
   * że nawet legacy configi bez `driverId` nadal restartują się.
   */
  async restart(deviceId: string): Promise<{ restarted: boolean }> {
    const device = this.devices.get(deviceId)
    if (!device) throw new Error(`Intercom ${deviceId} not found`)
    const { config } = device

    const driver = resolveDriver('INTERCOM', config)
    const action = engineRestartAction(driver, config)
    if (action) {
      this.logger.log(`Restart ${deviceId} via driver "${driver?.id}" → ${action.method} ${action.url}`)
      await this.callAction(action, config)
      return { restarted: true }
    }

    // Fallback dla legacy/unknown — stara logika.
    const url = this.legacyRestartUrl(config)
    this.logger.log(`Restart ${deviceId} via legacy fallback → ${url}`)
    await axios.request({
      method: this.legacyRestartMethod(config),
      url,
      auth: { username: config.login, password: config.password },
      timeout: 8000,
    })
    return { restarted: true }
  }

  private legacyRestartUrl(config: IntercomConfig): string {
    const base = `http://${config.ipAddress}`
    const m = (config.manufacturer ?? '').toLowerCase()
    if (m.includes('akuvox'))    return `${base}/fcgi/do?action=Restart`
    if (m.includes('2n'))        return `${base}/api/system/reboot`
    if (m.includes('dnake'))     return `${base}/fcgi/do?action=Restart`
    if (m.includes('hikvision')) return `${base}/ISAPI/System/reboot`
    return `${base}/cgi-bin/reboot`
  }

  private legacyRestartMethod(config: IntercomConfig): 'GET' | 'POST' | 'PUT' {
    const m = (config.manufacturer ?? '').toLowerCase()
    if (m.includes('hikvision')) return 'PUT'
    if (m.includes('2n'))        return 'POST'
    return 'GET'
  }

  /**
   * Wykonuje request opisany przez `ResolvedAction` z drivera. Wybiera
   * Basic albo Digest auth wg `action.auth`. Body — jeśli driver je definiuje
   * (np. Hik openDoor wysyła XML).
   */
  private async callAction(
    action: import('../driver-engine').ResolvedAction,
    config: IntercomConfig,
  ): Promise<unknown> {
    const headers: Record<string, string> = {}
    if (action.contentType) headers['Content-Type'] = action.contentType
    const okStatuses = action.okStatus ?? [200, 201, 202, 204]

    if (action.auth === 'digest') {
      const res = await requestWithDigest(action.method, action.url, config.login, config.password, {
        data: action.body,
        headers,
        timeout: 8000,
        validateStatus: () => true,
      })
      if (!okStatuses.includes(res.status)) {
        throw new Error(`HTTP ${res.status} ${action.url}`)
      }
      return res.data
    }
    const res = await axios.request({
      method: action.method,
      url: action.url,
      data: action.body,
      headers,
      auth: action.auth === 'basic'
        ? { username: config.login, password: config.password }
        : undefined,
      timeout: 8000,
      validateStatus: () => true,
      httpsAgent: action.url.startsWith('https://') ? lanHttpsAgent : undefined,
    })
    if (!okStatuses.includes(res.status)) {
      throw new Error(`HTTP ${res.status} ${action.url}`)
    }
    return res.data
  }

  // ── OpenDoor: driver-first, legacy fallback ──────────────────────────────────
  private async openDoor(
    device: IntercomDevice,
    relayIndex: number,
    source: 'HTTP' | 'PIN' | 'HOLD_OPEN' | 'LPR' | 'OTHER' = 'OTHER',
  ): Promise<any> {
    const { config } = device

    // 0) AKUVOX z High Security Mode — stary `/fcgi/do?action=OpenDoor&door=N`
    //    zwraca `{"retcode":-4,"Not Safe"}` (firmware blokuje). Działa TYLKO nowy
    //    format `/fcgi/OpenDoor?action=OpenDoor&DoorNum={1-based}` + DIGEST z
    //    hasłem API (`rtspPassword ?? 'admin'` — NIE web-hasło `config.password`,
    //    które dla API jest błędne). To samo dotyczy resident „Otwórz"/LPR/PIN —
    //    wszystkie szły starą drogą i po cichu dostawały „Not Safe" (Edge logował
    //    fałszywe OK, bo nie sprawdzał `retcode`). DoorNum = relayIndex + 1.
    if ((config.manufacturer ?? '').toLowerCase().includes('akuvox')) {
      const doorNum = relayIndex + 1
      const url = `https://${config.ipAddress}/fcgi/OpenDoor?action=OpenDoor&DoorNum=${doorNum}`
      const user = (config as any).rtspLogin ?? config.login ?? 'admin'
      const pass = (config as any).rtspPassword ?? 'admin'
      try {
        this.logger.log(`OpenDoor ${device.id} (Akuvox high-security) → GET ${url}`)
        const res = await requestWithDigest('GET', url, user, pass, {
          httpsAgent: lanHttpsAgent,
          // Stare kasety (R29C w VN) robią handshake DHE ~2 s na zimnym
          // połączeniu, a `requestWithDigest` wykonuje dwa żądania
          // (challenge + auth). 8 s bywało za mało i użytkownik dostawał
          // „Internal server error" mimo sprawnego urządzenia.
          timeout: 12_000,
          validateStatus: () => true,
        })
        const retcode = extractAkuvoxRetcode(res.data)
        if (res.status !== 200 || retcode !== 0) {
          const hint = retcode != null ? AKUVOX_RETCODE_HINTS[retcode] : undefined
          throw new Error(
            `Akuvox OpenDoor retcode=${retcode} status=${res.status}` +
              (hint ? ` — ${hint}` : '') +
              ` body=${JSON.stringify(res.data).slice(0, 120)}`,
          )
        }
        device.online = true
        device.lastSeen = Date.now()
        try { this.store.relayTriggerInsert(device.id, relayIndex, source) } catch { /* logged in store */ }
        this.logger.log(`✅ Akuvox OpenDoor OK (DoorNum=${doorNum}) on ${device.id}`)
        return { opened: true, relay: relayIndex }
      } catch (err: any) {
        device.online = false
        throw new Error(`Cannot open door (Akuvox): ${err.message}`)
      }
    }

    // 1) Spróbuj drivera z katalogu — to jest „nowa droga".
    const driver = resolveDriver('INTERCOM', config)
    const action = engineOpenDoorAction(driver, config, relayIndex)
    if (action) {
      try {
        this.logger.log(`OpenDoor ${device.id} via driver "${driver?.id}" → ${action.method} ${action.url}`)
        await this.callAction(action, config)
        device.online = true
        device.lastSeen = Date.now()
        // Persistent log każdego otwarcia — `store.service.ts → relay_triggers`.
        // Source ('HTTP'/'PIN'/'HOLD_OPEN'/'LPR'/'OTHER') zachowuje semantykę
        // analityczną: kto wystrzelił relay (panel/PIN/cykl hold-open/LPR/inne).
        try { this.store.relayTriggerInsert(device.id, relayIndex, source) } catch { /* logged in store */ }
        return { opened: true, relay: relayIndex }
      } catch (err: any) {
        device.online = false
        throw new Error(`Cannot open door: ${err.message}`)
      }
    }

    // 2) Fallback dla legacy/unknown — stara logika manufacturer-switch.
    const url = this.legacyOpenDoorUrl(config, relayIndex, 'open')
    try {
      this.logger.log(`OpenDoor ${device.id} via legacy fallback → GET ${url}`)
      await axios.get(url, {
        auth: { username: config.login, password: config.password },
        timeout: 5000,
      })
      device.online = true
      device.lastSeen = Date.now()
      this.logger.log(`Door ${relayIndex} opened on ${device.id}`)
      // Persistent log każdego otwarcia — legacy fallback (configi bez driverId).
      try { this.store.relayTriggerInsert(device.id, relayIndex, source) } catch { /* logged in store */ }
      return { opened: true, relay: relayIndex }
    } catch (err: any) {
      device.online = false
      throw new Error(`Cannot open door: ${err.message}`)
    }
  }

  private async closeDoor(device: IntercomDevice, relayIndex: number): Promise<any> {
    // Most intercoms auto-close; explicit close is a no-op or reset
    this.logger.log(`Door ${relayIndex} close requested on ${device.id}`)
    return { closed: true, relay: relayIndex }
  }

  /**
   * Legacy URL builder dla configów bez `driverId` lub gdy driver nie ma
   * zdefiniowanego `openDoor` endpointu. Zachowane 1:1 z poprzedniej wersji
   * — nie ruszać, dopóki nie zmigrowane wszystkie konfigi do nowego formatu.
   */
  private legacyOpenDoorUrl(config: IntercomConfig, relay: number, action: string): string {
    const base = `http://${config.ipAddress}`
    const m = (config.manufacturer ?? '').toLowerCase()

    if (m.includes('akuvox')) {
      // Akuvox ISAPI: /fcgi/do?action=OpenDoor&door=0
      return `${base}/fcgi/do?action=OpenDoor&door=${relay}`
    }
    if (m.includes('2n') || m.includes('2N')) {
      // 2N REST API
      return `${base}/api/switch/ctrl?switch=${relay}&action=trigger`
    }
    if (m.includes('dnake')) {
      return `${base}/fcgi/do?action=OpenDoor&doorIndex=${relay}`
    }
    if (m.includes('hikvision')) {
      // Hikvision ISAPI
      return `${base}/ISAPI/AccessControl/RemoteControl/door/${relay}`
    }
    // Generic fallback
    return `${base}/cgi-bin/door?relay=${relay}&action=${action}`
  }

  private async ping(id: string) {
    const device = this.devices.get(id)
    if (!device) return
    try {
      await axios.get(`http://${device.config.ipAddress}`, { timeout: 3000 })
      device.online = true
      device.lastSeen = Date.now()
    } catch {
      device.online = false
    }
  }

  getStatus(): DeviceStatusEntry[] {
    return [...this.devices.values()].map((d) => ({
      id: d.id,
      type: 'INTERCOM',
      label: `${d.config.manufacturer} ${d.config.model} (${d.config.ipAddress})`,
      status: d.online ? 'online' : 'offline',
      lastSeen: d.lastSeen,
    }))
  }
}
