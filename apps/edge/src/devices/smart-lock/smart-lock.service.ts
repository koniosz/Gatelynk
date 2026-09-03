/**
 * SmartLockService — zamki drzwi lokalu przez Nuki Web API (2026-07-08).
 *
 * Architektura (wiążąca decyzja właściciela):
 *   • Token API Nuki żyje TYLKO tutaj — `device_config` sqlite
 *     (`type='SMART_LOCK'`, config `{ name, smartlockId, apiToken }`),
 *     dokładnie jak hasła kamer. Cloud NIGDY nie przechowuje tokenu
 *     (mirror DEVICE_UPSERT sanityzuje `apiToken` → `apiTokenIsSet`).
 *   • Cloud → Edge tą samą ścieżką co przekaźniki:
 *     `POST /devices/{uuid}/relay/{n}` → DeviceRegistryService.triggerRelay
 *     → SmartLockService.unlatch (relayIndex ignorowany — zamek ma 1 „wyjście").
 *   • Wewnętrzne fires (AccessPointExecutor) idą przez NukiOutputDriver
 *     w OutputDriverRegistryService (case 'SMART_LOCK').
 *
 * Serwis jest STATELESS — config czytany ze StoreService przy każdym wywołaniu
 * (żaden in-memory map; `DEVICE_CONFIG_UPDATE` z tunelu i PATCH /devices
 * działają natychmiast bez re-registracji).
 *
 * Nuki Web API (https://api.nuki.io):
 *   • GET  /smartlock/{smartlockId}           → stan (state, batteryCritical…)
 *   • POST /smartlock/{smartlockId}/action    → { action: 3 } = unlatch
 *     (otwarcie zapadki; 1=unlock, 2=lock, 3=unlatch)
 *   • Auth: `Authorization: Bearer <apiToken>` (token z Nuki Web → API).
 *   • Timeout 10 s; 401/403/404/503 mapowane na czytelne polskie komunikaty.
 *
 * Testowalność: baza URL nadpisywalna przez `config.apiBaseUrl` albo env
 * `NUKI_API_BASE` — testy jednostkowe stawiają lokalny stub HTTP.
 */
import { Injectable, Logger } from '@nestjs/common'
import axios, { AxiosError } from 'axios'
import { StoreService } from '../../store/store.service'
import { EventLogService } from '../../event-log/event-log.service'

export const NUKI_ACTION_UNLATCH = 3
export const NUKI_TIMEOUT_MS = 10_000

/**
 * Nuki lock states → polski opis (Web API `state.state`).
 * Kody wg oficjalnej dokumentacji Nuki (Web API / MQTT / BLE — spójne):
 *   0 uncalibrated, 1 locked, 2 unlocking, 3 unlocked, 4 locking,
 *   5 unlatched, 6 unlocked (lock'n'go), 7 unlatching, 254 motor blocked,
 *   255 undefined.
 * Zweryfikowane na produkcyjnym zamku (22633966703, 2026-07-10): state=1.
 */
export const NUKI_STATE_LABELS: Record<number, string> = {
  0: 'Nieskalibrowany',
  1: 'Zamknięty',
  2: 'Otwieranie…',
  3: 'Otwarty',
  4: 'Rygluje…',
  5: 'Otwarty (klamka)',
  6: 'Otwarty',
  7: 'Otwieranie klamki…',
  254: 'Silnik zablokowany',
  255: 'Nieznany',
}

/**
 * Nuki door-sensor states → polski opis. UWAGA: w Web API pole nazywa się
 * `state.doorState` (NIE `doorsensorState` jak w części dokumentacji BLE) —
 * potwierdzone na produkcji: `state.doorState = 3` (drzwi otwarte).
 * Kody: 0 unavailable, 1 deactivated, 2 closed, 3 open, 4 unknown,
 *       5 calibrating.
 * Dla 0/1 (brak/wyłączony czujnik) NIE pokazujemy labela (null) — mieszkaniec
 * nie ma czujnika drzwi, tylko stan rygla.
 */
export const NUKI_DOORSENSOR_LABELS: Record<number, string | null> = {
  0: null,
  1: null,
  2: 'Drzwi zamknięte',
  3: 'Drzwi otwarte',
  4: 'Drzwi: stan nieznany',
  5: 'Kalibracja czujnika…',
}

/** Zmapowany stan zamka (bez `raw`) — czysta funkcja, łatwa do testów. */
export interface MappedNukiState {
  state: number | null
  stateLabel: string
  /** Alias `state` — nowy kontrakt Cloud/iOS (lockState/lockStateLabel). */
  lockState: number | null
  lockStateLabel: string
  doorState: number | null
  doorStateLabel: string | null
  batteryCritical: boolean | null
  keypadBatteryCritical: boolean | null
}

/**
 * Czyste mapowanie payloadu Nuki `GET /smartlock/{id}` → polskie labely.
 * Wyodrębnione z `getState` żeby testy jednostkowe pokrywały mapowanie kodów
 * (w tym nieznane/błędne) bez stawiania serwera HTTP.
 */
export function mapNukiState(data: any): MappedNukiState {
  const st = data?.state ?? {}
  const state: number | null = typeof st.state === 'number' ? st.state : null
  const doorRaw = typeof st.doorState === 'number' ? st.doorState : null
  // UWAGA: kody 0/1 (unavailable/deactivated) są MAPOWANE na null (brak
  // czujnika) — trzeba odróżnić „klucz obecny = null" od „klucz nieznany"
  // (fallback), bo `null ?? fallback` skasowałoby zamierzone null.
  const doorStateLabel =
    doorRaw === null
      ? null
      : Object.prototype.hasOwnProperty.call(NUKI_DOORSENSOR_LABELS, doorRaw)
        ? NUKI_DOORSENSOR_LABELS[doorRaw]
        : 'Drzwi: stan nieznany'
  const stateLabel =
    state !== null ? (NUKI_STATE_LABELS[state] ?? `Stan ${state}`) : 'Nieznany'
  return {
    state,
    stateLabel,
    lockState: state,
    lockStateLabel: stateLabel,
    doorState: doorRaw,
    doorStateLabel,
    batteryCritical: st.batteryCritical ?? null,
    keypadBatteryCritical: st.keypadBatteryCritical ?? null,
  }
}

export interface SmartLockConfig {
  name?: string
  smartlockId: string
  apiToken: string
  /** Override dla testów/probe — default https://api.nuki.io */
  apiBaseUrl?: string
  /** Override timeoutu (testy jednostkowe) — default NUKI_TIMEOUT_MS (10 s). */
  timeoutMs?: number
}

export interface SmartLockState extends MappedNukiState {
  ok: true
  smartlockId: string
  name: string | null
  raw?: unknown
}

/** Pozycja listy zamków (onboarding mieszkańca — bez tokenu w response). */
export interface SmartLockListItem {
  smartlockId: string
  name: string
}

@Injectable()
export class SmartLockService {
  private readonly logger = new Logger(SmartLockService.name)

  constructor(
    private readonly store: StoreService,
    private readonly eventLog: EventLogService,
  ) {}

  /** Config zamka z device_config. Rzuca gdy brak/niekompletny. */
  private resolveConfig(deviceUuid: string): SmartLockConfig {
    const dc = this.store.getDeviceConfigs().find((d) => d.deviceId === deviceUuid)
    if (!dc) throw new Error(`Zamek ${deviceUuid} nie jest skonfigurowany na Edge`)
    if (String(dc.type).toUpperCase() !== 'SMART_LOCK') {
      throw new Error(`Urządzenie ${deviceUuid} nie jest zamkiem (type=${dc.type})`)
    }
    const cfg = dc.config as Partial<SmartLockConfig>
    if (!cfg.smartlockId) throw new Error(`Zamek ${deviceUuid}: brak smartlockId w konfiguracji`)
    if (!cfg.apiToken) throw new Error(`Zamek ${deviceUuid}: brak tokenu API Nuki w konfiguracji`)
    return cfg as SmartLockConfig
  }

  private baseUrl(cfg: SmartLockConfig): string {
    return (cfg.apiBaseUrl || process.env.NUKI_API_BASE || 'https://api.nuki.io').replace(/\/+$/, '')
  }

  /** Mapowanie błędów HTTP/network Nuki na czytelny polski komunikat. */
  private describeNukiError(err: unknown): string {
    const ax = err as AxiosError
    if (ax?.code === 'ECONNABORTED' || /timeout/i.test(String(ax?.message))) {
      return 'Nuki API nie odpowiada (timeout 10 s) — sprawdź internet na obiekcie'
    }
    const status = ax?.response?.status
    switch (status) {
      case 401:
        return 'Nuki API odrzuciło token (401) — token wygasł lub jest błędny; wygeneruj nowy w Nuki Web → API'
      case 403:
        return 'Brak uprawnień do tego zamka (403) — token nie ma dostępu do smartlockId'
      case 404:
        return 'Zamek nie istnieje w Nuki Web (404) — sprawdź smartlockId'
      case 503:
        return 'Nuki API chwilowo niedostępne (503) — zamek offline lub serwis Nuki ma awarię'
      default:
        return status
          ? `Nuki API błąd HTTP ${status}`
          : `Błąd połączenia z Nuki API: ${String((ax as any)?.message ?? err)}`
    }
  }

  /**
   * Otwarcie zapadki (unlatch, action=3) — akcja „open" AccessPointa.
   * Rzuca Error z czytelnym komunikatem — caller (executor / relay endpoint)
   * audytuje i zwraca 5xx do Cloud.
   */
  async unlatch(deviceUuid: string): Promise<void> {
    const cfg = this.resolveConfig(deviceUuid)
    const url = `${this.baseUrl(cfg)}/smartlock/${cfg.smartlockId}/action`
    try {
      const res = await axios.post(
        url,
        { action: NUKI_ACTION_UNLATCH },
        {
          headers: {
            Authorization: `Bearer ${cfg.apiToken}`,
            'Content-Type': 'application/json',
          },
          timeout: cfg.timeoutMs ?? NUKI_TIMEOUT_MS,
          // 2xx = sukces (Nuki zwraca 204 No Content) — reszta rzucamy sami.
          validateStatus: () => true,
        },
      )
      if (res.status < 200 || res.status >= 300) {
        const err = new AxiosError(`HTTP ${res.status}`)
        ;(err as any).response = res
        throw err
      }
      this.eventLog.success('SMART_LOCK', `🔓 Nuki unlatch OK (${cfg.name ?? deviceUuid})`, {
        deviceUuid,
        smartlockId: cfg.smartlockId,
      })
    } catch (err: unknown) {
      const msg = this.describeNukiError(err)
      this.eventLog.error('SMART_LOCK', `❌ Nuki unlatch failed: ${msg}`, {
        deviceUuid,
        smartlockId: cfg.smartlockId,
      })
      throw new Error(msg)
    }
  }

  /**
   * Stan zamka — `GET /smartlock/{id}` (przycisk „Testuj" w panelu
   * Integratora oraz probe). Zwraca zmapowany stan + surowe pole `raw`.
   */
  async getState(deviceUuid: string): Promise<SmartLockState> {
    const cfg = this.resolveConfig(deviceUuid)
    const url = `${this.baseUrl(cfg)}/smartlock/${cfg.smartlockId}`
    try {
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${cfg.apiToken}` },
        timeout: cfg.timeoutMs ?? NUKI_TIMEOUT_MS,
        validateStatus: () => true,
      })
      if (res.status < 200 || res.status >= 300) {
        const err = new AxiosError(`HTTP ${res.status}`)
        ;(err as any).response = res
        throw err
      }
      const data = res.data as any
      return {
        ok: true,
        smartlockId: cfg.smartlockId,
        name: data?.name ?? cfg.name ?? null,
        ...mapNukiState(data),
        raw: data,
      }
    } catch (err: unknown) {
      throw new Error(this.describeNukiError(err))
    }
  }

  /**
   * Lista zamków konta Nuki dla PODANEGO tokenu — onboarding mieszkańca
   * (2026-07-09). Wywoływane ZANIM istnieje device_config: token przychodzi
   * jako argument (Cloud → Edge, transport WS/HTTP), NIE jest zapisywany.
   * `GET /smartlock` → mapujemy do `{ smartlockId, name }` (BEZ tokenu ani
   * innych pól — response wraca do Cloud, który go NIE loguje).
   *
   * UWAGA prywatności: token NIE trafia do EventLog ani do zwracanego obiektu.
   */
  async listSmartlocks(
    apiToken: string,
    opts?: { apiBaseUrl?: string; timeoutMs?: number },
  ): Promise<SmartLockListItem[]> {
    const token = String(apiToken ?? '').trim()
    if (token.length < 10) throw new Error('Podaj token API Nuki (Nuki Web → API)')
    const base = (opts?.apiBaseUrl || process.env.NUKI_API_BASE || 'https://api.nuki.io').replace(
      /\/+$/,
      '',
    )
    try {
      const res = await axios.get(`${base}/smartlock`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: opts?.timeoutMs ?? NUKI_TIMEOUT_MS,
        validateStatus: () => true,
      })
      if (res.status < 200 || res.status >= 300) {
        const err = new AxiosError(`HTTP ${res.status}`)
        ;(err as any).response = res
        throw err
      }
      const arr = Array.isArray(res.data) ? res.data : []
      return arr
        .map((sl: any) => ({
          smartlockId: String(sl?.smartlockId ?? sl?.id ?? '').trim(),
          name: String(sl?.name ?? '').trim() || 'Zamek Nuki',
        }))
        .filter((x: SmartLockListItem) => /^\d{5,20}$/.test(x.smartlockId))
    } catch (err: unknown) {
      throw new Error(this.describeNukiError(err))
    }
  }
}
