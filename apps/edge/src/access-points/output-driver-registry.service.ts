/**
 * OutputDriverRegistryService — dispatcher między abstrakcyjnym
 * AccessPoint a fizycznym driverem urządzenia.
 *
 * Refactor 2026-06-01. Po stronie executora chcemy mieć jedno API:
 *     driver.pulse(deviceUuid, outputIndex, durationMs)
 *
 * Pod spodem rezolvujemy konkretny driver na podstawie typu urządzenia
 * (`device_config.type`):
 *   • INTERCOM       → AkuvoxOutputDriver    (woła IntercomService.execute('OPEN_DOOR'))
 *   • LPR_CAMERA     → HikvisionLprOutputDriver (ISAPI /System/IO/outputs/<n>/trigger)
 *   • CAMERA         → HikvisionLprOutputDriver (kamery vision z relay-em też podchodzą)
 *   • SWITCH / LAN_SWITCH → LanSwitchOutputDriver (PoE toggle jako "pulse")
 *   • SMART_LOCK     → NukiOutputDriver (Nuki Web API unlatch — 2026-07-08)
 *
 * Jeśli typ nieznany — zwracamy null i executor wraca do legacy fallback
 * (intercom.execute('OPEN_DOOR', { doorIndex: legacyRelayIndex })).
 */
import { Injectable, Logger } from '@nestjs/common'
import { IntercomService } from '../devices/intercom/intercom.service'
import { LanSwitchService } from '../devices/lan-switch/lan-switch.service'
import { SmartLockService } from '../devices/smart-lock/smart-lock.service'
import { StoreService } from '../store/store.service'
import { EventLogService } from '../event-log/event-log.service'
import { requestWithDigest } from '../devices/http-digest'

export interface OutputDriver {
  /**
   * Stempelka „pulse" przekaźnika: aktywuj wyjście, poczekaj `durationMs`,
   * deaktywuj. Część driverów (Akuvox/2N) ma natywne auto-release konfigurowane
   * po stronie urządzenia → `durationMs` jest pominięty. Hikvision ISAPI
   * `/IO/outputs/<n>/trigger` z `outputState=high` zostaje na zawsze dopóki nie
   * przyjdzie `low` — tam musimy explicitnie wait+low.
   *
   * Rzuca Error przy awarii — caller (AccessPointExecutor) loguje i zwraca
   * meaningful reason do audytu (`gate_error`, `driver_unavailable`, ...).
   */
  pulse(deviceUuid: string, outputIndex: number, durationMs: number): Promise<void>
  /** Diagnostyczna etykieta — używana w logach. */
  describe(): string
}

@Injectable()
export class OutputDriverRegistryService {
  private readonly logger = new Logger(OutputDriverRegistryService.name)

  constructor(
    private readonly intercom: IntercomService,
    private readonly lanSwitch: LanSwitchService,
    private readonly smartLock: SmartLockService,
    private readonly store: StoreService,
    private readonly eventLog: EventLogService,
  ) {}

  /**
   * Rezolvuje driver dla deviceUuid. Czyta `device_config.type` ze StoreService
   * i mapuje na konkretny driver. Zwraca null gdy:
   *   • urządzenie nie jest w device_config (brak rzędu)
   *   • typ nie ma dispatchera (np. KNX_BRIDGE — TODO future)
   */
  resolve(deviceUuid: string): OutputDriver | null {
    const cfg = this.store.getDeviceConfigs().find(d => d.deviceId === deviceUuid)
    if (!cfg) {
      this.logger.warn(`resolve: device ${deviceUuid} not in device_config`)
      return null
    }
    const type = String(cfg.type).toUpperCase()
    switch (type) {
      case 'INTERCOM':
        return new AkuvoxOutputDriver(this.intercom, this.eventLog)
      case 'LPR_CAMERA':
      case 'CAMERA':
        // Hikvision LPR/visual cameras with I/O relays — used for direct
        // gate trigger zamiast jechania przez Akuvox doorIndex.
        return new HikvisionRelayOutputDriver(this.store, this.eventLog)
      case 'SWITCH':
      case 'LAN_SWITCH':
        return new LanSwitchOutputDriver(this.lanSwitch, this.eventLog)
      case 'SMART_LOCK':
        // Nuki Web API (2026-07-08) — drzwi lokalu (AP category=UNIT_DOOR).
        return new NukiOutputDriver(this.smartLock)
      default:
        this.logger.warn(`resolve: no driver for type=${type} (device ${deviceUuid})`)
        return null
    }
  }
}

// ─── Nuki smart lock driver (2026-07-08) ─────────────────────────────────────
/**
 * Drzwi lokalu przez Nuki Web API. `pulse` = unlatch (action=3) — zamek ma
 * natywne auto-domknięcie zapadki, `durationMs`/`outputIndex` ignorowane
 * (jedno „wyjście"). Cała logika HTTP (Bearer token z device_config sqlite,
 * timeout 10 s, mapowanie 401/403/404/503) w SmartLockService.
 */
class NukiOutputDriver implements OutputDriver {
  constructor(private readonly smartLock: SmartLockService) {}

  async pulse(deviceUuid: string, _outputIndex: number, _durationMs: number): Promise<void> {
    await this.smartLock.unlatch(deviceUuid)
  }

  describe(): string {
    return 'NukiOutputDriver (Nuki Web API unlatch)'
  }
}

// ─── Akuvox / generic intercom driver ─────────────────────────────────────────
/**
 * Najprostszy driver — deleguje do istniejącej ścieżki IntercomService.
 * Akuvox/2N/Dnake/Hikvision Intercom mają natywne auto-release po N sekundach
 * (config po stronie urządzenia, typowo 2-5s) — dlatego `durationMs` ignorujemy.
 * Source='OTHER' bo executor nadpisze go w meta audytu na podstawie triggera.
 */
class AkuvoxOutputDriver implements OutputDriver {
  constructor(
    private readonly intercom: IntercomService,
    private readonly eventLog: EventLogService,
  ) {}

  async pulse(deviceUuid: string, outputIndex: number, _durationMs: number): Promise<void> {
    await this.intercom.execute('OPEN_DOOR', {
      deviceId: deviceUuid,
      doorIndex: outputIndex,
      // Source='OTHER' tu, ale executor po sukcesie i tak doda właściwy
      // trigger ('LPR'/'PIN'/'MANUAL'/'SCHEDULE') do meta access_events.
      source: 'OTHER',
    })
  }

  describe(): string {
    return 'AkuvoxOutputDriver (IntercomService.OPEN_DOOR)'
  }
}

// ─── Hikvision LPR / camera I/O relay driver ──────────────────────────────────
/**
 * Hikvision DeepinView (np. iDS-2CD7A46G0/P-IZHSY) ma 1-2 alarm output portów
 * dostępnych przez ISAPI `/System/IO/outputs/<n>/trigger`. Workflow:
 *
 *   PUT /ISAPI/System/IO/outputs/<n>/trigger
 *   <IOPortDataCap><outputState>high</outputState></IOPortDataCap>
 *
 *   ...wait durationMs...
 *
 *   PUT /ISAPI/System/IO/outputs/<n>/trigger
 *   <IOPortDataCap><outputState>low</outputState></IOPortDataCap>
 *
 * Wymaga digest auth (admin/<password>). Konfig urządzenia trzymamy w
 * device_config — same fields co camerasService:
 *   ipAddress, login (default 'admin'), password, httpPort (default 80)
 *
 * `outputIndex` — 1-based, zgodne z ISAPI ścieżką. Jeśli kamera nie wspiera
 * I/O outputs (firmware-dependent), pierwszy PUT zwraca 4xx → rzucamy Error
 * → executor zaaudytuje `reason='gate_error'` i nie crashuje całego Edge.
 */
class HikvisionRelayOutputDriver implements OutputDriver {
  constructor(
    private readonly store: StoreService,
    private readonly eventLog: EventLogService,
  ) {}

  async pulse(deviceUuid: string, outputIndex: number, durationMs: number): Promise<void> {
    const cfg = this.store.getDeviceConfigs().find(d => d.deviceId === deviceUuid)?.config as any
    if (!cfg) throw new Error(`Hikvision config missing for ${deviceUuid}`)
    const ip = cfg.ipAddress
    if (!ip) throw new Error(`Hikvision ${deviceUuid} has no ipAddress in config`)
    const login = cfg.login ?? 'admin'
    const password = cfg.password
    if (!password) throw new Error(`Hikvision ${deviceUuid} has no password in config`)
    const port = cfg.httpPort ?? 80
    const idx = Math.max(1, outputIndex)
    const url = `http://${ip}:${port}/ISAPI/System/IO/outputs/${idx}/trigger`

    const xmlHigh = `<IOPortDataCap><outputState>high</outputState></IOPortDataCap>`
    const xmlLow = `<IOPortDataCap><outputState>low</outputState></IOPortDataCap>`
    const headers = { 'Content-Type': 'application/xml' }

    // 1) HIGH
    const r1 = await requestWithDigest('PUT', url, login, password, {
      data: xmlHigh,
      headers,
      timeout: 8000,
      validateStatus: () => true,
    })
    if (r1.status < 200 || r1.status >= 300) {
      throw new Error(
        `Hikvision ${deviceUuid} I/O out#${idx} HIGH failed: HTTP ${r1.status} (${String(r1.data).slice(0, 200)})`,
      )
    }

    // 2) wait durationMs (clamped 100..30_000 — defensive guard)
    const wait = Math.max(100, Math.min(durationMs ?? 800, 30_000))
    await new Promise(resolve => setTimeout(resolve, wait))

    // 3) LOW
    const r2 = await requestWithDigest('PUT', url, login, password, {
      data: xmlLow,
      headers,
      timeout: 8000,
      validateStatus: () => true,
    })
    if (r2.status < 200 || r2.status >= 300) {
      // Nie throw-ujemy — relay nadal może wisieć w HIGH, ale to lepsze niż
      // dwukrotne raportowanie błędu. Logujemy WARN do audytu.
      this.eventLog.warn(
        'RELAY',
        `⚠️ Hikvision ${deviceUuid} I/O out#${idx} LOW failed: HTTP ${r2.status} — relay może wisieć`,
        { deviceUuid, outputIndex: idx, ip },
      )
    }
  }

  describe(): string {
    return 'HikvisionRelayOutputDriver (ISAPI /System/IO/outputs)'
  }
}

// ─── LAN switch (UniFi PoE toggle) driver ─────────────────────────────────────
/**
 * Symuluje pulse na switchu PoE: off → wait → on (jeśli aktualnie ON), albo
 * on → wait → off (jeśli OFF). Use case: relayowy moduł zasilany 12V PoE
 * splitter, gdzie odcięcie PoE = zwarcie obwodu = otwarcie elektrozaczepu.
 *
 * UWAGA: to nieideal — `durationMs` to czas między toggle-em, nie czas
 * trwania impulsu z punktu widzenia obciążenia (PoE off oznacza brak zasilania
 * splittera, więc wszystko podłączone padnie). W praktyce użyteczny tylko dla
 * dedykowanych przekaźnikowych portów. Dla pełnego open/close powinno się
 * używać dedykowanego relay-modułu (Shelly etc.), TODO future.
 */
class LanSwitchOutputDriver implements OutputDriver {
  private readonly logger = new Logger(LanSwitchOutputDriver.name)
  constructor(
    private readonly lanSwitch: LanSwitchService,
    private readonly eventLog: EventLogService,
  ) {}

  async pulse(deviceUuid: string, outputIndex: number, durationMs: number): Promise<void> {
    // Sprawdzamy aktualny stan portu — pulsujemy w przeciwną stronę.
    let initialPoe: boolean
    try {
      const ports = this.lanSwitch.listPorts(deviceUuid)
      const p = ports.find(x => x.portIdx === outputIndex)
      if (!p) throw new Error(`port ${outputIndex} not found on switch ${deviceUuid}`)
      initialPoe = p.poeEnabled
    } catch (err: any) {
      throw new Error(`LanSwitch lookup failed: ${err.message}`)
    }

    const wait = Math.max(100, Math.min(durationMs ?? 800, 30_000))
    // OFF first if it's ON; ON first if OFF. End in initial state.
    await this.lanSwitch.setPortPoe(deviceUuid, outputIndex, !initialPoe)
    await new Promise(r => setTimeout(r, wait))
    await this.lanSwitch.setPortPoe(deviceUuid, outputIndex, initialPoe)
  }

  describe(): string {
    return 'LanSwitchOutputDriver (UniFi PoE toggle)'
  }
}

// re-export types if needed by tests
export { AkuvoxOutputDriver, HikvisionRelayOutputDriver, LanSwitchOutputDriver, NukiOutputDriver }
