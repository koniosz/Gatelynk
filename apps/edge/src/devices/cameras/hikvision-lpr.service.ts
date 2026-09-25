import { Injectable, Logger } from '@nestjs/common'
import { Interval } from '@nestjs/schedule'
import { lanHttpsAgent } from '../lan-https-agent'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { requestWithDigest } from '../http-digest'
import { StoreService } from '../../store/store.service'
import { IntercomService } from '../intercom/intercom.service'
// 2026-07-08 — wspólna walidacja ograniczeń gościa (allowlista AP /
// harmonogram / limit użyć) — ta sama logika co PIN na domofonie.
import { IntercomPinService } from '../intercom/intercom-pin.service'
import { EventLogService } from '../../event-log/event-log.service'
import { VisionDetectService } from './vision-detect.service'
import { lenientPlateMatch } from './plate-fuzzy.util'
// 2026-07-30 — Przepustka wyjazdowa (exit grace pass): czysta logika decyzji
// wydzielona do testowalnego modułu (docs/exit-grace-pass.md).
import {
  parseExitGraceConfig,
  normalizeConfidence,
  confidenceAcceptable,
  resolveCameraExitDirection,
  decideExit,
  findNearMissPlate,
  type ExitGraceConfig,
} from './exit-grace.util'
// Lazy reference — circular: HikvisionLprService > AccessPointsModule > DevicesModule > HikvisionLprService
import type { AccessPointExecutorService } from '../../access-points/access-point-executor.service'

/**
 * HikvisionLprService — Edge-side LPR service.
 *
 * Architektura: "edge-only" — cała biała lista żyje na Edge (SQLite),
 * kamera jest tylko detektorem (wysyła zdarzenie ANPR z tablicą).
 *
 *   Flow:
 *     1. Kamera (Hikvision DeepinView) wysyła event XML → Edge HTTP listener
 *        (LprEventsController) → `handleAnprEvent`.
 *     2. Edge wykonuje match przeciwko SQLite (`lpr_plates`).
 *     3. Na hit — Edge wyzwala przekaźnik podłączonego domofonu
 *        (linkedIntercomDeviceId / linkedRelayIndex).
 *     4. Per-plate cooldown (domyślnie 10s) chroni event log przed spamem
 *        gdy auto stoi pod szlabanem.
 *
 * Lista jest synchronizowana z Cloud przez tunnel:
 *   PLATE_UPSERT / PLATE_DELETE / PLATE_SYNC_ALL
 *
 * Uwaga: firmware DeepinView V5.8.x nie akceptuje ISAPI `plateInfoList`,
 * dlatego nie próbujemy wgrywać listy do kamery — wszystkie decyzje
 * zapadają po stronie Edge.
 */

const httpsAgent = lanHttpsAgent

interface LprCameraConfig {
  ipAddress: string
  login?: string       // default 'admin' for Hikvision
  password: string
  manufacturer: string
  channel?: number
  httpPort?: number
  /** Linked intercom for gate opening. If omitted, the first intercom registered is used. */
  linkedIntercomDeviceId?: string
  /** Relay index on the linked intercom (1-based; Akuvox E18 uses 1). */
  linkedRelayIndex?: number
  /** Min delay between gate triggers for the same plate (ms). Default 10_000. */
  rateLimitMs?: number
  /**
   * Próg pewności ANPR (0.0–1.0) ustawiany przez LPR_SET_CONFIDENCE
   * (`setConfidence` persystuje go tutaj). Używany też przez przepustkę
   * wyjazdową jako minimalny confidence odczytu (misread nie tworzy/nie
   * konsumuje passa). Brak = default 0.8 (driver.constants).
   */
  confidenceThreshold?: number
  /**
   * Refactor 2026-06-01: bezpośredni link do AccessPoint. Gdy ustawiony,
   * LPR po match-u woła `accessPointExecutor.fire(id, {trigger:'LPR_MATCH'})`
   * zamiast routować przez linkedIntercomDeviceId+linkedRelayIndex. Pozwala
   * adminowi przypiąć kamerę LPR do dowolnego punktu dostępu (np. „wjazd
   * główny" zamiast „domofon-pieszo") bez modyfikowania configu drivera.
   *
   * Jeśli puste — fallback do legacy linkedIntercomDeviceId path.
   */
  linkedAccessPointId?: number
}

interface LprDevice {
  id: string
  config: LprCameraConfig
}

export interface PlateEntry {
  plate: string
  /** @deprecated Privacy — Edge UI nie pokazuje. Zostaje w schemie dla legacy
   *  Cloud syncu który jeszcze nie nadaje `unitLabel`. Cloud po stronie produkcji
   *  powinien zaczynać wysyłać `unitLabel` (adres lokalu) zamiast nazwiska. */
  owner?: string
  /** Privacy-safe identyfikator lokalu (np. "Niewinna 6/1"). Cloud → Edge sync
   *  preferuje to pole nad `owner`. Widoczne w panelu instalatora w Edge. */
  unitLabel?: string
  /** Vehicle kind z Cloud (RESIDENT | SERVICE | GUEST). Pomaga asystentowi AI
   *  rozróżnić kuriera od mieszkańca bez polegania na innych heurystykach. */
  kind?: 'RESIDENT' | 'SERVICE' | 'GUEST' | string
  /** Tagi z panelu BA (np. `["Kurier","DPD","niebieski VAN"]`). Asystent
   *  AI używa ich jako primary źródło identyfikacji. */
  tags?: string[]
  validFrom?: string | Date | null
  validUntil?: string | Date | null
  /** 2026-07-08 — id gościa (Cloud) dla tablic gości. Flow LPR sprawdza po nim
   *  ograniczenia (harmonogram/limit/allowlista AP) w guest_pins. */
  guestId?: number | null
  /** 2026-09-25 — przełącznik mieszkańca: false = rozpoznaj (odczyt, push,
   *  historia), ale NIE otwieraj bramy. Brak pola = otwieraj (jak dotąd). */
  autoOpen?: boolean | null
}

/**
 * One ISAPI probe result. `status=0` means the request never got a response
 * (network error / timeout); inspect `error` in that case. `snippet` is a
 * shortened `body` safe to surface in logs or HTTP responses without flooding.
 */
export interface ProbeStep {
  method: 'GET' | 'PUT' | 'POST'
  path: string
  status: number
  body: string
  snippet: string
  error?: string
}

/**
 * Report returned by `ensureAnprTriggering()` / the manual
 * `POST /lpr/:id/camera-setup` endpoint. `steps` is the ordered list of every
 * ISAPI exchange we made so the integrator can see exactly what the firmware
 * accepted or rejected.
 */
export interface CameraSetupReport {
  ok: boolean
  reason?: string
  triggerPath?: string
  steps: ProbeStep[]
}

@Injectable()
export class HikvisionLprService {
  private readonly logger = new Logger(HikvisionLprService.name)
  private devices = new Map<string, LprDevice>()
  /** Per-plate cooldown: `${cameraDeviceId}:${plate}` → last-triggered ts. */
  private lastTrigger = new Map<string, number>()
  /**
   * TunnelService injected lazily via setter to avoid the circular dependency
   * TunnelModule → DevicesModule → HikvisionLprService → TunnelService.
   * Matches the pattern used in `SyncService.setTunnelSend`.
   */
  private tunnelSend?: (event: string, data: any, deviceId?: string) => boolean

  constructor(
    private store: StoreService,
    private intercom: IntercomService,
    private eventLog: EventLogService,
    // 2026-05-22: po każdym LPR insert wymuszamy off-cycle vision snapshot
    // (`triggerForLpr`) żeby YOLO+OCR miał szansę złapać brand na boku vana
    // w momencie gdy LPR widzi plate — zamiast czekać do 60s tick.
    private vision: VisionDetectService,
    // 2026-07-08 — walidacja ograniczeń gościa (checkGuestRestrictions).
    private intercomPin: IntercomPinService,
  ) {}

  setTunnelSend(fn: (event: string, data: any, deviceId?: string) => boolean) {
    this.tunnelSend = fn
  }

  /**
   * AccessPointExecutorService wstrzykiwane lazy (setter-based DI), żeby
   * uniknąć cykli modułowych. Wywołuje TunnelService.onModuleInit po
   * stworzeniu executora — patrz `apps/edge/src/access-points/access-points.module.ts`.
   * Refactor 2026-06-01.
   */
  private accessPointExecutor: AccessPointExecutorService | null = null
  setAccessPointExecutor(executor: AccessPointExecutorService) {
    this.accessPointExecutor = executor
  }

  addDevice(id: string, config: LprCameraConfig) {
    this.devices.set(id, { id, config })
    this.logger.log(`LPR camera registered: ${id} @ ${config.ipAddress}`)

    // Kamera ma POSTować eventy ANPR na Edge HTTP listener + musi mieć
    // zalinkowany event-trigger → center notification (httpHost #1). Firmware
    // DeepinView V5.8.x czasem odrzuca konfiguracyjne PUT-y — dlatego całość
    // jest best-effort: każdy krok loguje swój wynik i przechodzi dalej.
    this.configureEventListener(id)
      .then(() => this.ensureAnprTriggering(id))
      .catch(err => {
        this.logger.warn(`Camera auto-config on ${id} did not complete: ${err.message}`)
      })

    // Odczyt tablic po stronie Edge — dla kamer, które ich NIE wysyłają.
    // Starsze DeepinView (np. DS-2CD4A26FWD-IZS/P, fw V5.4.x) przyjmują
    // konfigurację wysyłki bez błędu, ale zdarzeń ANPR nią nie przenoszą:
    // publikują wyłącznie gołe „wykryto pojazd". Wtedy kamera służy nam za
    // wyzwalacz, a tablicę czytamy sami — patrz `LprAlertStreamService`.
    void this.edgeOcrEnabled(id, config).then((on) => {
      if (on) this.alertStream?.start(id)
    })
  }

  /** Rodziny kamer, które fizycznie NIE wysyłają tablicy po sieci (tylko SDK). */
  private static readonly SDK_ONLY_ANPR = /DS-2CD4A\d{2}FWD/

  /**
   * Czy dla tej kamery czytamy tablice lokalnie.
   *
   * Domyślnie WYŁĄCZONE — kamery oddające odczyty natywnie (jak w Villi
   * Natura) mają robić to dalej po swojemu; własne OCR byłoby wtedy zbędnym
   * obciążeniem i drugim źródłem prawdy.
   *
   * Model bierzemy Z URZĄDZENIA, nie z formularza. Powód praktyczny (VN,
   * 2026-08-05): w konfiguracji siedział `iDS-TCM403-AI`, bo kreator wybrał
   * go po cichu za instalatora, a fizycznie to `DS-2CD4A26FWD-IZS/P`.
   * Gdyby ta funkcja ufała polu z formularza, w ogóle by się nie włączyła —
   * a to najgorszy rodzaj awarii: cicha i wyglądająca na poprawną konfigurację.
   */
  private async edgeOcrEnabled(id: string, config: LprCameraConfig): Promise<boolean> {
    const explicit = (config as any).plateSource
    if (explicit === 'edge-ocr') {
      this.logger.log(`[${id}] tryb odczytu tablic: GateLynk Edge (wymuszony w konfiguracji)`)
      return true
    }
    if (explicit === 'camera') {
      this.logger.log(`[${id}] tryb odczytu tablic: kamera natywnie (wymuszony w konfiguracji)`)
      return false
    }

    try {
      const res = await requestWithDigest(
        'GET', `${this.baseUrl(config)}/ISAPI/System/deviceInfo`,
        this.user(config), config.password,
        { timeout: 5000, validateStatus: (s: number) => s === 200 },
      )
      const model = String(String(res.data).match(/<model>([^<]*)</i)?.[1] ?? '').toUpperCase()
      if (model && HikvisionLprService.SDK_ONLY_ANPR.test(model)) {
        this.logger.log(
          `[${id}] kamera ${model} nie wysyła tablic po sieci — włączam odczyt lokalny na Edge`,
        )
        return true
      }
      this.logger.log(
        `[${id}] tryb odczytu tablic: kamera natywnie (wykryto ${model || 'nieznany model'})`,
      )
      return false
    } catch (e: any) {
      // Brak odpowiedzi nie może włączać OCR „na wszelki wypadek" — to by
      // znaczyło, że chwilowa niedostępność kamery zmienia tryb jej pracy.
      this.logger.debug(`[${id}] nie udało się odczytać modelu z kamery: ${e?.message ?? e}`)
      return false
    }
  }

  private alertStream: { start(id: string): void; stop(id: string): void } | null = null
  /** Setter-based DI — bezpośrednia zależność dałaby cykl (pułapka #8). */
  setAlertStream(svc: { start(id: string): void; stop(id: string): void }) {
    this.alertStream = svc
  }

  /** Config kamery — używane przez `LprAlertStreamService`. */
  getConfig(cameraDeviceId: string): LprCameraConfig | undefined {
    return this.devices.get(cameraDeviceId)?.config
  }

  removeDevice(id: string) {
    this.alertStream?.stop(id)
    this.devices.delete(id)
  }

  getDeviceIds(): string[] {
    return [...this.devices.keys()]
  }

  /** Dispatch entry for tunnel commands (PLATE_UPSERT / PLATE_DELETE / PLATE_SYNC_ALL). */
  async execute(action: string, payload: any): Promise<any> {
    const cameraDeviceId: string = payload?.cameraDeviceId ?? [...this.devices.keys()][0]
    if (!cameraDeviceId) throw new Error('No LPR camera registered on this Edge')

    switch (action) {
      case 'PLATE_UPSERT':    return this.upsertPlate(cameraDeviceId, payload)
      case 'PLATE_DELETE':    return this.deletePlate(cameraDeviceId, payload.plate)
      case 'PLATE_SYNC_ALL':  return this.syncAll(cameraDeviceId, payload.plates ?? [])
      case 'LPR_SET_CONFIDENCE': return this.setConfidence(cameraDeviceId, payload.threshold)
      default: throw new Error(`LPR: unknown action ${action}`)
    }
  }

  // ─── Faza F-3.1 (2026-05-14): SET_CONFIDENCE ─────────────────────────────
  //
  // Reguluje próg pewności ANPR detekcji w Hikvision LPR. Domyślny driver-side
  // `confidenceThreshold` (z `driver.constants` w device-drivers) jest 0.8 —
  // ale per-kamera może być inny (ciemne ujęcie, większe false-positive),
  // stąd potrzeba runtime override.
  //
  // Hikvision ISAPI dla ANPR: zmienna ścieżka per fw. Próbujemy w kolejności:
  //   1. /ISAPI/Traffic/channels/{ch}/vehicleDetect (V5.6+)
  //   2. /ISAPI/Smart/Vehicle/{ch}/vehicleDetect    (V5.7+)
  //
  // Pole XML: `MinTrustLevel` (1-100, integer). Threshold 0.0-1.0 mapujemy
  // na 1-100 przez `Math.round(threshold * 100)`.
  //
  // GET najpierw → patch XML → PUT (tak samo jak `ensureAnprTriggering`).

  async setConfidence(cameraDeviceId: string, threshold: number): Promise<{
    set: boolean
    threshold: number
    pathUsed?: string
    previous?: number
    error?: string
  }> {
    const dev = this.getDevice(cameraDeviceId)
    if (typeof threshold !== 'number' || threshold < 0 || threshold > 1) {
      throw new Error('threshold must be 0.0–1.0')
    }
    const trustLevel = Math.round(threshold * 100)
    const candidates = [
      `/ISAPI/Traffic/channels/${dev.config.channel ?? 1}/vehicleDetect`,
      `/ISAPI/Smart/Vehicle/${dev.config.channel ?? 1}/vehicleDetect`,
    ]

    for (const path of candidates) {
      try {
        const url = `${this.baseUrl(dev.config)}${path}`
        // GET — pobieramy istniejący config (XML)
        const getRes = await requestWithDigest('GET', url, this.user(dev.config), dev.config.password, {
          httpsAgent,
          timeout: 5000,
          validateStatus: () => true,
        })
        if (getRes.status !== 200) {
          this.logger.debug?.(`setConfidence: GET ${path} → ${getRes.status}, próbuję następny`)
          continue
        }
        const xml = String(getRes.data ?? '')
        // Wyciągnij obecny MinTrustLevel (do `previous` w odpowiedzi — ułatwia diagnostykę)
        const m = xml.match(/<MinTrustLevel>(\d+)<\/MinTrustLevel>/)
        const previous = m ? Number(m[1]) : undefined
        // Patch — replace lub dorzucenie node-a
        let patched: string
        if (/<MinTrustLevel>/.test(xml)) {
          patched = xml.replace(/<MinTrustLevel>\d+<\/MinTrustLevel>/, `<MinTrustLevel>${trustLevel}</MinTrustLevel>`)
        } else {
          // Dorzuć przed zamknięciem root-elementu (heurystyka)
          patched = xml.replace(/<\/(\w+)>\s*$/, `<MinTrustLevel>${trustLevel}</MinTrustLevel></$1>`)
        }
        const putRes = await requestWithDigest('PUT', url, this.user(dev.config), dev.config.password, {
          data: patched,
          headers: { 'Content-Type': 'application/xml' },
          httpsAgent,
          timeout: 6000,
          validateStatus: () => true,
        })
        if (putRes.status === 200 || putRes.status === 201) {
          this.logger.log(
            `LPR ${cameraDeviceId} confidence set to ${trustLevel} (${(threshold * 100).toFixed(0)}%) via ${path}`,
          )
          // Persistujemy też w configu (żeby driver.constants override był trwały
          // i przeżył restart Edge — następny push do kamery użyje tej wartości).
          this.store.setDeviceConfig(cameraDeviceId, 'LPR_CAMERA', { ...dev.config, confidenceThreshold: threshold })
          return { set: true, threshold, pathUsed: path, previous }
        }
        this.logger.warn(`setConfidence: PUT ${path} → ${putRes.status}: ${this.short(putRes.data)}`)
      } catch (err: any) {
        this.logger.debug?.(`setConfidence: ${path} threw — ${err.message}`)
      }
    }
    return { set: false, threshold, error: 'Żadna z ścieżek ISAPI nie zaakceptowała PUT (fw quirk?). Sprawdź log Edge.' }
  }

  // ── Whitelist CRUD — pisze do SQLite; Edge jest jedynym źródłem prawdy. ─────
  async upsertPlate(cameraDeviceId: string, entry: PlateEntry) {
    this.getDevice(cameraDeviceId)                                // ensure registered
    const plate = this.normalizePlate(entry.plate)
    if (!plate) throw new Error('Empty plate')
    this.store.lprUpsertPlate(cameraDeviceId, plate, {
      owner: entry.owner,
      validFrom: this.toMillis(entry.validFrom),
      validUntil: this.toMillis(entry.validUntil),
      unitLabel: entry.unitLabel,
      kind: entry.kind,
      tags: entry.tags,
      guestId: typeof entry.guestId === 'number' && entry.guestId > 0 ? entry.guestId : null,
      autoOpen: entry.autoOpen === false ? false : true,
    })
    // Log uses unitLabel (privacy-safe) + tags + kind w czytelnej formie.
    const labelParts: string[] = []
    if (entry.unitLabel) labelParts.push(entry.unitLabel)
    if (entry.kind && entry.kind !== 'RESIDENT') labelParts.push(entry.kind)
    if (entry.tags && entry.tags.length > 0) labelParts.push(`[${entry.tags.join(', ')}]`)
    if (entry.autoOpen === false) labelParts.push('auto-open OFF')
    const tag = labelParts.length > 0 ? labelParts.join(' ') : (entry.owner ?? '')
    this.logger.log(`Plate whitelisted: ${plate}${tag ? ` (${tag})` : ''} on ${cameraDeviceId}`)
    return { ok: true, plate }
  }

  async deletePlate(cameraDeviceId: string, rawPlate: string) {
    this.getDevice(cameraDeviceId)
    const plate = this.normalizePlate(rawPlate)
    const removed = this.store.lprDeletePlate(cameraDeviceId, plate)
    this.logger.log(`Plate removed: ${plate} (${removed} row) from ${cameraDeviceId}`)
    return { ok: true, plate, removed }
  }

  async syncAll(cameraDeviceId: string, desired: PlateEntry[]) {
    this.getDevice(cameraDeviceId)
    const rows = desired.map(d => ({
      plate: this.normalizePlate(d.plate),
      owner: d.owner,
      unitLabel: d.unitLabel,
      kind: d.kind,
      tags: d.tags,
      validFrom: this.toMillis(d.validFrom),
      validUntil: this.toMillis(d.validUntil),
      guestId: typeof d.guestId === 'number' && d.guestId > 0 ? d.guestId : null,
      autoOpen: d.autoOpen === false ? false : true,
    })).filter(r => r.plate.length > 0)
    this.store.lprReplaceAll(cameraDeviceId, rows)
    this.logger.log(`syncAll on ${cameraDeviceId}: ${rows.length} plate(s)`)
    return { ok: true, count: rows.length }
  }

  listPlates(cameraDeviceId: string) {
    this.getDevice(cameraDeviceId)
    return this.store.lprListPlates(cameraDeviceId)
  }

  /**
   * Read-only feed of ANPR detections for the Edge panel modal
   * ("Odczyty" tab). Supports plate substring search and matched/unmatched
   * filter. Newest first, capped at 1000 rows.
   */
  listReads(
    cameraDeviceId: string,
    opts: { plate?: string; matched?: boolean; limit?: number } = {},
  ) {
    this.getDevice(cameraDeviceId)
    return this.store.lprListReads(cameraDeviceId, opts)
  }

  // ── Camera event → whitelist match → gate trigger ───────────────────────────
  /**
   * Wywoływane przez `LprEventsController` po parsingu XML z kamery.
   *
   * Edge robi match w SQLite, na hit wyzwala przekaźnik podłączonego domofonu.
   * Per-plate cooldown (domyślnie 10s) chroni event log przed spamem gdy auto
   * stoi pod szlabanem i kamera wyzwala event co klatkę.
   *
   * Zwraca { matched, opened, plate, reason?, owner? }.
   */
  async handleAnprEvent(
    cameraDeviceId: string,
    rawPlate: string,
    extra?: {
      confidence?: number
      direction?: string
      vehicleColor?: string
      vehicleBrand?: string
      vehicleType?: string
      vehicleSubtype?: string
      image?: Buffer | null
      rawXml?: string
    },
  ) {
    const rawNormalized = this.normalizePlate(rawPlate)
    if (!rawNormalized) return { matched: false, opened: false, plate: '', reason: 'empty_plate' }

    const dev = this.devices.get(cameraDeviceId)
    if (!dev) {
      this.logger.warn(`ANPR event for unknown camera ${cameraDeviceId}`)
      return { matched: false, opened: false, plate: rawNormalized, reason: 'unknown_camera' }
    }

    // Log każdej detekcji (audit / queue do Cloud).
    // 2026-05-14 fix: NIE logujemy `extra.image` (Buffer JPG ~2-3 MB base64)
    // ani `extra.rawXml` (pełen response z kamery) do `detail` — dławiło
    // frontend `/ui` na innerHTML render-ze. Zostawiamy tylko metadane.
    const { image: _img, rawXml: _raw, ...metaForLog } = extra ?? {}
    this.eventLog.info('LPR', `🚗 Plate detected: ${rawNormalized}`, {
      cameraDeviceId,
      ...metaForLog,
      imageSizeBytes: extra?.image ? (extra.image as Buffer).length : undefined,
    })

    // Match przeciwko Edge whitelist — strict first, OCR-fuzzy fallback.
    // `plate` = wartość użyta downstream (cooldown key, finalizeRead, event log).
    // Po fuzzy hit plate = corrected variant (czyli WHITELIST plate, nie raw OCR).
    // To zapewnia idempotentny cooldown (kolejny odczyt tej samej tablicy
    // — bez znaczenia czy OCR znowu pomyli — trafia w ten sam key).
    let plate = rawNormalized
    let match = this.store.lprMatchPlate(cameraDeviceId, plate)
    if (!match) {
      const fuzzy = this.tryOcrFuzzyMatch(cameraDeviceId, plate)
      if (fuzzy) {
        this.eventLog.info('LPR', `🔍 OCR fuzzy: ${plate} → ${fuzzy.plate} (matched)`, {
          cameraDeviceId, rawPlate: plate, correctedPlate: fuzzy.plate,
        })
        plate = fuzzy.plate
        match = fuzzy.match
      }
    }

    // 2026-09-15 — ŁAGODNE dopasowanie do rejestru (tylko powiadomienie i
    // historia, BEZ otwierania): odczyt potwierdzony klatkami, ale z pomyłką
    // OCR spoza ścisłych klas (np. WE38711 zamiast WE387YT). Bramę otwiera
    // wyłącznie odczyt ścisły lub ścisły OCR-fuzzy — patrz plate-fuzzy.util.
    if (!match) {
      const lenient = this.tryLenientMatch(cameraDeviceId, [plate])
      if (lenient) {
        this.eventLog.info('LPR', `🔎 Odczyt ${plate} dopasowany łagodnie → ${lenient.plate} (bez otwierania bramy)`, {
          cameraDeviceId, rawPlate: plate, correctedPlate: lenient.plate, cost: lenient.cost,
        })
        return this.finalizeRead(cameraDeviceId, lenient.plate, {
          matched: true, opened: false, reason: 'probable_match',
          owner: lenient.match.owner ?? null,
          unitLabel: lenient.match.unitLabel ?? null,
          kind: lenient.match.kind ?? null,
          tags: lenient.match.tags ?? [],
          extra: { ...extra, ocrRaw: plate },
        })
      }
    }

    if (!match) {
      // ── Przepustka wyjazdowa (2026-07-30, docs/exit-grace-pass.md) ─────
      // dir=IN → utwórz/nadpisz pass; dir=OUT → ważny pass otwiera bramę
      // (single-use), wygasły wg polityki OPEN_AND_FLAG/DENY. Zwraca null
      // gdy feature wyłączony / brak passa — wtedy zachowanie jak dotychczas.
      const exitGraceResult = await this.handleExitGraceNoMatch(cameraDeviceId, plate, extra)
      if (exitGraceResult) return exitGraceResult

      this.eventLog.warn('LPR', `⛔ Plate ${plate} not on allowlist`, { cameraDeviceId })
      return this.finalizeRead(cameraDeviceId, plate, {
        matched: false, opened: false, reason: 'not_whitelisted', extra,
      })
    }

    // Rate-limit: ten sam plate w oknie cooldown = nie otwieraj ponownie.
    const cooldown = dev.config.rateLimitMs ?? 10_000
    const key = `${cameraDeviceId}:${plate}`
    const last = this.lastTrigger.get(key) ?? 0
    const sinceLast = Date.now() - last
    // Wspólne snapshot fields propagowane z match-u do finalizeRead.
    // Wszystkie pola privacy-safe (`tags`/`kind`/`unitLabel`), bez `owner`.
    const matchSnapshot = {
      owner:     match.owner ?? null,
      unitLabel: match.unitLabel ?? null,
      kind:      match.kind ?? null,
      tags:      match.tags ?? [],
    }

    if (sinceLast < cooldown) {
      this.logger.debug(`Cooldown active for ${plate} on ${cameraDeviceId} (${sinceLast}ms < ${cooldown}ms), skipping`)
      return this.finalizeRead(cameraDeviceId, plate, {
        matched: true, opened: false, reason: 'cooldown', ...matchSnapshot, extra,
      })
    }

    // ── Przełącznik mieszkańca (2026-09-25) ────────────────────────────────
    // Tablica jest ZNANA (matched=1 → historia, push „rozpoznano"), ale
    // właściciel wyłączył automatyczne otwieranie w karcie pojazdu. Nie
    // wyzwalamy żadnego przekaźnika; bez cooldownu — po włączeniu w apce
    // kolejny odczyt (po PLATE_UPSERT z Cloud) otwiera od razu.
    if (match.autoOpen === false) {
      this.eventLog.info(
        'LPR',
        `⏸ ${plate}${match.unitLabel ? ` (${match.unitLabel})` : ''}: rozpoznano, automatyczne otwieranie wyłączone przez mieszkańca`,
        { cameraDeviceId, plate },
      )
      return this.finalizeRead(cameraDeviceId, plate, {
        matched: true, opened: false, reason: 'auto_open_disabled', ...matchSnapshot, extra,
      })
    }

    // ── Ograniczenia dostępu gościa (2026-07-08) — OFFLINE enforcement ─────
    // match.guestId ≠ null → tablica GOŚCIA. Ograniczenia (allowlista AP,
    // harmonogram cykliczny Europe/Warsaw, limit użyć) żyją w guest_pins —
    // sprawdzamy tą samą logiką co PIN na domofonie
    // (IntercomPinService.checkGuestRestrictions). Odmowa → brama NIE otwiera
    // się; read z reason jedzie do Cloud w LPR_READ (audyt) +
    // GUEST_ACCESS_DENIED (historia gościa w iOS/panelach).
    const guestRestr = match.guestId
      ? this.store.guestRestrictionsByGuestId(match.guestId)
      : null
    const guestCheck = (apId: number | null): string | null => {
      if (!match.guestId || !guestRestr) return null
      return this.intercomPin.checkGuestRestrictions(
        { guestId: match.guestId, ...guestRestr },
        apId,
      )
    }

    // ── Wyzwolenie bramy ────────────────────────────────────────────────────
    //
    // FAZA c (2026-06-02): kolejność rozwiązywania AP do fire:
    //   1. lpr_camera_ap_links (nowa wielokrotna powiązka — może być >1 AP,
    //      np. wjazdowa kamera otwierająca wjazd + wyjazd jako safety).
    //      Fire-ujemy WSZYSTKIE — jeden success wystarcza by uznać że "opened".
    //   2. legacy `dev.config.linkedAccessPointId` (single — fallback).
    //   3. legacy `dev.config.linkedIntercomDeviceId` + `linkedRelayIndex`.
    //
    // Każdy fire trafia do AccessPointExecutor który robi pulse na bound output.
    const apLinks = this.store.lprApLinksForCamera(cameraDeviceId)

    if (apLinks.length > 0 && this.accessPointExecutor) {
      let anyOpened = false
      let lastReason: string | undefined
      const firedAps: number[] = []
      for (const link of apLinks) {
        // Ograniczenia gościa per AP — link spoza allowlisty / po limicie /
        // poza harmonogramem NIE odpala (pozostałe linki wciąż próbujemy).
        const guestDenial = guestCheck(link.accessPointId)
        if (guestDenial) {
          lastReason = guestDenial
          this.logger.log(
            `LPR guest#${match.guestId} denied on AP#${link.accessPointId}: ${guestDenial} (${plate})`,
          )
          continue
        }
        const result = await this.accessPointExecutor.fire(link.accessPointId, {
          trigger: 'LPR_MATCH',
          plate,
          actor: `LPR:${cameraDeviceId}`,
          meta: {
            cameraDeviceId,
            confidence: extra?.confidence,
            direction: extra?.direction ?? link.direction,
            linkDirection: link.direction,
            linkId: link.id,
            unitLabel: match.unitLabel,
            kind: match.kind,
            tags: match.tags,
          },
        })
        if (result.opened) {
          anyOpened = true
          firedAps.push(link.accessPointId)
          this.recordGuestUse(match.guestId, link.accessPointId)
        } else {
          lastReason = result.reason ?? undefined
          this.logger.warn(
            `LPR fire(#${link.accessPointId}, ${link.direction}) failed: ${result.reason ?? '?'}`,
          )
        }
      }
      if (anyOpened) {
        this.lastTrigger.set(key, Date.now())
        const labelParts: string[] = []
        if (match.unitLabel) labelParts.push(match.unitLabel)
        if (match.tags && match.tags.length > 0) labelParts.push(`[${match.tags.join(', ')}]`)
        const matchTag = labelParts.length > 0 ? labelParts.join(' ') : (match.owner ?? '')
        this.eventLog.success(
          'LPR',
          `✅ Gate opened for ${plate}${matchTag ? ` (${matchTag})` : ''} via AP#${firedAps.join(',#')}`,
          { cameraDeviceId, accessPointIds: firedAps, plate },
        )
        return this.finalizeRead(cameraDeviceId, plate, {
          matched: true, opened: true, ...matchSnapshot, extra,
        })
      }
      this.eventLog.warn(
        'LPR',
        `⚠️ Wszystkie AP powiązane z kamerą ${cameraDeviceId} dla ${plate} nie otworzyły: ${lastReason ?? 'unknown'}`,
        { cameraDeviceId, plate },
      )
      this.emitGuestDenied(match.guestId, apLinks[0]?.accessPointId ?? null, lastReason, plate)
      return this.finalizeRead(cameraDeviceId, plate, {
        matched: true, opened: false, reason: lastReason ?? 'ap_fire_failed', ...matchSnapshot, extra,
      })
    }

    // Legacy single-link (refactor 2026-06-01).
    const linkedApId = dev.config.linkedAccessPointId
    if (linkedApId && this.accessPointExecutor) {
      const guestDenial = guestCheck(linkedApId)
      if (guestDenial) {
        this.eventLog.warn('LPR', `⛔ Gość ${plate}: odmowa ${guestDenial} na AP#${linkedApId}`, {
          cameraDeviceId, accessPointId: linkedApId, plate,
        })
        this.emitGuestDenied(match.guestId, linkedApId, guestDenial, plate)
        return this.finalizeRead(cameraDeviceId, plate, {
          matched: true, opened: false, reason: guestDenial, ...matchSnapshot, extra,
        })
      }
      const result = await this.accessPointExecutor.fire(linkedApId, {
        trigger: 'LPR_MATCH',
        plate,
        actor: `LPR:${cameraDeviceId}`,
        meta: {
          cameraDeviceId,
          confidence: extra?.confidence,
          direction: extra?.direction,
          unitLabel: match.unitLabel,
          kind: match.kind,
          tags: match.tags,
        },
      })
      if (result.opened) {
        this.lastTrigger.set(key, Date.now())
        this.recordGuestUse(match.guestId, linkedApId)
        const labelParts: string[] = []
        if (match.unitLabel) labelParts.push(match.unitLabel)
        if (match.tags && match.tags.length > 0) labelParts.push(`[${match.tags.join(', ')}]`)
        const matchTag = labelParts.length > 0 ? labelParts.join(' ') : (match.owner ?? '')
        this.eventLog.success('LPR', `✅ Gate opened for ${plate}${matchTag ? ` (${matchTag})` : ''} via AP#${linkedApId}`, {
          cameraDeviceId, accessPointId: linkedApId, plate,
        })
        return this.finalizeRead(cameraDeviceId, plate, {
          matched: true, opened: true, ...matchSnapshot, extra,
        })
      }
      // Executor zwrócił !opened — log + audit reason. To może być
      // `not_found` (AP usunięty), `inactive`, `gate_error`. Fallback do
      // legacy ścieżki nie ma sensu — admin ustawił binding świadomie,
      // jeśli AP jest sknocone to wina configu.
      this.logger.warn(`LPR fire(#${linkedApId}) returned not-opened (reason=${result.reason ?? '?'}) — not falling back to legacy`)
      this.eventLog.warn('LPR', `⚠️ Gate via AP#${linkedApId} for ${plate} failed: ${result.reason ?? 'unknown'}`, {
        cameraDeviceId, accessPointId: linkedApId, plate,
      })
      return this.finalizeRead(cameraDeviceId, plate, {
        matched: true, opened: false, reason: result.reason ?? 'ap_fire_failed', ...matchSnapshot, extra,
      })
    }

    // Legacy path — gdy linkedAccessPointId nie ustawione, działamy jak dawniej.
    // Po backfillu w produkcji to powinno zostać już głównie historyczne.
    const intercomId = dev.config.linkedIntercomDeviceId ?? this.firstIntercomId()
    const relayIdx = dev.config.linkedRelayIndex ?? 1
    if (!intercomId) {
      this.logger.warn(`No intercom linked for LPR camera ${cameraDeviceId}`)
      this.eventLog.warn('LPR', `⚠️ No linked intercom for camera ${cameraDeviceId} — set linkedAccessPointId or linkedIntercomDeviceId in config`, { plate })
      return this.finalizeRead(cameraDeviceId, plate, {
        matched: true, opened: false, reason: 'no_linked_intercom', ...matchSnapshot, extra,
      })
    }

    // Legacy path bez AP w storze — nie wiemy który AP odpala. Gość z
    // allowlistą AP → fail-closed (AP_NOT_ALLOWED); harmonogram/limit
    // sprawdzane przeciw sumie użyć (apId=null).
    {
      const guestDenial = guestCheck(null)
      if (guestDenial) {
        this.eventLog.warn('LPR', `⛔ Gość ${plate}: odmowa ${guestDenial} (legacy intercom path)`, {
          cameraDeviceId, plate,
        })
        this.emitGuestDenied(match.guestId, null, guestDenial, plate)
        return this.finalizeRead(cameraDeviceId, plate, {
          matched: true, opened: false, reason: guestDenial, ...matchSnapshot, extra,
        })
      }
    }

    try {
      // `source: 'LPR'` — żeby chart Monitoringu pokazywał tablicy zamiast
      // generycznego „OTHER".
      await this.intercom.execute('OPEN_DOOR', { deviceId: intercomId, doorIndex: relayIdx, source: 'LPR' })
      this.lastTrigger.set(key, Date.now())
      this.recordGuestUse(match.guestId, null)
      // Privacy: w logach pokazujemy unitLabel + tags zamiast nazwiska.
      const labelParts: string[] = []
      if (match.unitLabel) labelParts.push(match.unitLabel)
      if (match.tags && match.tags.length > 0) labelParts.push(`[${match.tags.join(', ')}]`)
      const matchTag = labelParts.length > 0 ? labelParts.join(' ') : (match.owner ?? '')
      this.eventLog.success('LPR', `✅ Gate opened for ${plate}${matchTag ? ` (${matchTag})` : ''} (legacy)`, {
        cameraDeviceId, intercomId, relayIdx, plate,
      })
      return this.finalizeRead(cameraDeviceId, plate, {
        matched: true, opened: true, ...matchSnapshot, extra,
      })
    } catch (err: any) {
      this.logger.error(`Failed to open gate for ${plate}: ${err.message}`)
      this.eventLog.error('LPR', `❌ Failed to open gate for ${plate}: ${err.message}`, { cameraDeviceId })
      return this.finalizeRead(cameraDeviceId, plate, {
        matched: true, opened: false, reason: 'gate_error', error: err.message, ...matchSnapshot, extra,
      })
    }
  }

  // ── Przepustka wyjazdowa (exit grace pass, 2026-07-30) ─────────────────────
  //
  // docs/exit-grace-pass.md. Cała decyzja zapada na Edge (offline-first, jak
  // whitelist/PIN-y). Konfiguracja: Building.features.exitGrace — payload
  // BUILDING_CONFIG_UPDATE zapisany w kv (store.buildingConfigGet), default
  // WYŁĄCZONE. Kierunek IN/OUT bierzemy z linków kamera→AP
  // (lpr_camera_ap_links.direction) — tak jak działa reszta LPR.

  /** Cache configu exitGrace (kv decrypt + JSON parse per odczyt to zbędny koszt). */
  private exitGraceCache: { at: number; cfg: ExitGraceConfig } | null = null
  private exitGraceConfig(): ExitGraceConfig {
    const now = Date.now()
    if (this.exitGraceCache && now - this.exitGraceCache.at < 10_000) {
      return this.exitGraceCache.cfg
    }
    let cfg = parseExitGraceConfig(undefined)
    try {
      cfg = parseExitGraceConfig(this.store.buildingConfigGet()?.features?.exitGrace)
    } catch (err: any) {
      this.logger.warn(`exitGraceConfig read failed: ${err.message}`)
    }
    this.exitGraceCache = { at: now, cfg }
    return cfg
  }

  /**
   * Hook w ścieżce no-match `handleAnprEvent`.
   *
   * Zwraca wynik `finalizeRead` gdy przepustka COŚ zrobiła (utworzenie passa
   * przy IN też — z niezmienionym reason `not_whitelisted`, żeby audyt
   * wyglądał jak dotychczas), albo `null` → caller kontynuuje ścieżkę
   * no-match bez zmian (feature off / MIXED / za niski confidence / brak passa).
   */
  private async handleExitGraceNoMatch(
    cameraDeviceId: string,
    plate: string,
    extra?: {
      confidence?: number
      direction?: string
      vehicleColor?: string
      vehicleBrand?: string
      vehicleType?: string
      vehicleSubtype?: string
      image?: Buffer | null
      rawXml?: string
    },
  ): Promise<Awaited<ReturnType<HikvisionLprService['finalizeRead']>> | null> {
    const cfg = this.exitGraceConfig()
    if (!cfg.enabled) return null

    const dev = this.devices.get(cameraDeviceId)
    if (!dev) return null

    const apLinks = this.store.lprApLinksForCamera(cameraDeviceId)
    const camDirection = resolveCameraExitDirection(apLinks)
    if (camDirection === null) return null
    if (camDirection === 'MIXED') {
      this.logger.debug(
        `exit-grace: kamera ${cameraDeviceId} ma mieszane linki IN+OUT — pomijam (nie da się rozstrzygnąć kierunku)`,
      )
      return null
    }

    // Minimalny confidence odczytu — misread nie tworzy ANI nie konsumuje
    // passa. Próg = per-kamera confidenceThreshold (LPR_SET_CONFIDENCE)
    // albo 0.8 (spójny z driver-side defaultem). Kamera nie raportująca
    // confidence (null) przechodzi — filtruje ją własny MinTrustLevel.
    const threshold = dev.config.confidenceThreshold ?? 0.8
    const confidence = normalizeConfidence(extra?.confidence)
    if (!confidenceAcceptable(confidence, threshold)) {
      this.logger.debug(
        `exit-grace: confidence ${confidence} < ${threshold} dla ${plate} na ${cameraDeviceId} — pomijam`,
      )
      return null
    }

    const now = Date.now()

    if (camDirection === 'IN') {
      // WJAZD spoza whitelisty → utwórz/nadpisz przepustkę. Nie zmieniamy
      // dotychczasowego audytu (LPR_NO_MATCH dir=IN jedzie jak dziś) — caller
      // kontynuuje standardową ścieżką, więc zwracamy null.
      const expiresAt = now + cfg.minutes * 60_000
      try {
        this.store.exitPassUpsert(plate, now, expiresAt, cameraDeviceId)
        this.eventLog.info(
          'LPR',
          `🎫 Exit pass: ${plate} wjechał spoza listy — przepustka wyjazdowa na ${cfg.minutes} min`,
          { cameraDeviceId, plate, enteredAt: now, expiresAt },
        )
      } catch (err: any) {
        this.logger.warn(`exit-grace: upsert failed for ${plate}: ${err.message}`)
      }
      return null
    }

    // camDirection === 'OUT' — próba wyjazdu spoza whitelisty.
    const pass = this.store.exitPassGet(plate)
    const decision = decideExit(pass, cfg, now)

    if (decision.action === 'NONE') {
      // Brak passa / zużyty — near-miss (Levenshtein 1) logujemy TYLKO jako
      // warning do przyszłego tuningu OCR. NIE otwieramy (decyzja z koncepcji).
      if (decision.reason === 'no_pass') {
        try {
          const near = findNearMissPlate(plate, this.store.exitPassActivePlates())
          if (near) {
            this.eventLog.warn(
              'LPR',
              `🎫 Exit pass near-miss: odczyt ${plate} ≈ aktywna przepustka ${near} (odległość 1) — NIE otwieram`,
              { cameraDeviceId, plate, nearMissPlate: near },
            )
          }
        } catch { /* diagnostyka — nie może wywrócić ścieżki odczytu */ }
      }
      return null // zachowanie jak dziś (not_whitelisted)
    }

    const exitPassMeta = {
      enteredAt: decision.enteredAt,
      expiresAt: decision.expiresAt,
      dwellMinutes: decision.dwellMinutes,
      graceMinutes: cfg.minutes,
      afterExpiry: cfg.afterExpiry,
      entryCameraDeviceId: pass?.cameraDeviceId ?? null,
    }

    if (decision.action === 'DENY') {
      // Polityka DENY po oknie: nie otwieramy, audyt z reason=overstay_denied.
      this.eventLog.warn(
        'LPR',
        `🎫⛔ Exit pass DENY: ${plate} przekroczył okno (${decision.dwellMinutes} min > ${cfg.minutes} min) — brama zamknięta`,
        { cameraDeviceId, plate, ...exitPassMeta },
      )
      return this.finalizeRead(cameraDeviceId, plate, {
        matched: false, opened: false, reason: decision.reason, extra, exitPass: exitPassMeta,
      })
    }

    // OPEN (exit_pass) lub OPEN_FLAG (overstay przy OPEN_AND_FLAG) → otwórz
    // ISTNIEJĄCĄ ścieżką multi-fire linków LPR→AP (ta sama co przy match).
    // camDirection==='OUT' gwarantuje że wszystkie linki tej kamery są OUT.
    if (!this.accessPointExecutor) {
      this.logger.warn(`exit-grace: brak AccessPointExecutor — nie mogę otworzyć dla ${plate}`)
      return null
    }
    let anyOpened = false
    let lastReason: string | undefined
    const firedAps: number[] = []
    for (const link of apLinks) {
      const result = await this.accessPointExecutor.fire(link.accessPointId, {
        trigger: 'EXIT_PASS',
        plate,
        actor: `LPR:${cameraDeviceId}`,
        meta: {
          cameraDeviceId,
          confidence: extra?.confidence,
          direction: extra?.direction ?? link.direction,
          linkDirection: link.direction,
          linkId: link.id,
          exitPass: exitPassMeta,
          overstay: decision.reason === 'overstay',
        },
      })
      if (result.opened) {
        anyOpened = true
        firedAps.push(link.accessPointId)
      } else {
        lastReason = result.reason ?? undefined
        this.logger.warn(
          `exit-grace fire(#${link.accessPointId}, ${link.direction}) failed: ${result.reason ?? '?'}`,
        )
      }
    }

    if (!anyOpened) {
      this.eventLog.warn(
        'LPR',
        `🎫⚠️ Exit pass: żaden AP kamery ${cameraDeviceId} nie otworzył dla ${plate}: ${lastReason ?? 'unknown'}`,
        { cameraDeviceId, plate },
      )
      return this.finalizeRead(cameraDeviceId, plate, {
        matched: false, opened: false, reason: lastReason ?? 'ap_fire_failed', extra, exitPass: exitPassMeta,
      })
    }

    // Sukces — zużyj pass (single-use) + cooldown jak przy match.
    try { this.store.exitPassMarkUsed(plate, now) } catch (err: any) {
      this.logger.warn(`exit-grace: markUsed failed for ${plate}: ${err.message}`)
    }
    this.lastTrigger.set(`${cameraDeviceId}:${plate}`, now)
    if (decision.reason === 'overstay') {
      this.eventLog.warn(
        'LPR',
        `🎫⏱ OVERSTAY: ${plate} wyjechał po ${decision.dwellMinutes} min (okno ${cfg.minutes} min) — otwarto (OPEN_AND_FLAG) via AP#${firedAps.join(',#')}`,
        { cameraDeviceId, accessPointIds: firedAps, plate, ...exitPassMeta },
      )
    } else {
      this.eventLog.success(
        'LPR',
        `🎫✅ Wyjazd na przepustce: ${plate} (${decision.dwellMinutes} min na osiedlu) via AP#${firedAps.join(',#')}`,
        { cameraDeviceId, accessPointIds: firedAps, plate, ...exitPassMeta },
      )
    }
    return this.finalizeRead(cameraDeviceId, plate, {
      matched: false, opened: true, reason: decision.reason, extra, exitPass: exitPassMeta,
    })
  }

  // ── Ograniczenia gościa — bookkeeping (2026-07-08) ─────────────────────────

  /**
   * Zapis użycia LPR (wjazd = użycie) lokalnie + raport do Cloud eventem
   * GUEST_ACCESS_USED (dedup uuid — retry z offline queue nie dubluje).
   * No-op dla pojazdów nie-gości (guestId=null).
   */
  private recordGuestUse(guestId: number | null | undefined, accessPointId: number | null) {
    if (!guestId) return
    const useId = randomUUID()
    try {
      this.store.guestUseRecord(guestId, accessPointId, 'LPR', useId)
    } catch (err: any) {
      this.logger.warn(`guestUseRecord (LPR) failed: ${err.message}`)
    }
    this.tunnelSend?.('GUEST_ACCESS_USED', {
      guestId,
      accessPointId,
      source: 'LPR',
      useId,
      ts: Date.now(),
    })
  }

  /** Audyt odmowy ograniczeń gościa do Cloud — tylko dla reason-ów gościa. */
  private emitGuestDenied(
    guestId: number | null | undefined,
    accessPointId: number | null,
    reason: string | undefined,
    plate: string,
  ) {
    if (!guestId || !reason) return
    if (!['AP_NOT_ALLOWED', 'OUT_OF_SCHEDULE', 'USES_EXHAUSTED'].includes(reason)) return
    this.tunnelSend?.('GUEST_ACCESS_DENIED', {
      guestId,
      accessPointId,
      source: 'LPR',
      reason,
      plate,
      ts: Date.now(),
    })
  }

  /**
   * Persist the read to SQLite + push to Cloud (via tunnel, which queues when
   * offline). Keeps `handleAnprEvent` readable by hiding the bookkeeping.
   */
  private async finalizeRead(
    cameraDeviceId: string,
    plate: string,
    res: {
      matched: boolean
      opened: boolean
      owner?: string | null
      /** Privacy-safe identyfikator lokalu z whitelist match-u. */
      unitLabel?: string | null
      /** Vehicle kind snapshot (RESIDENT/SERVICE/GUEST). */
      kind?: string | null
      /** Tags snapshot z whitelist match-u. */
      tags?: string[]
      reason?: string
      error?: string
      extra?: {
        confidence?: number
        direction?: string
        vehicleColor?: string
        vehicleBrand?: string
        vehicleType?: string
        vehicleSubtype?: string
        image?: Buffer | null
        rawXml?: string
        /** 2026-09-15 — surowy odczyt OCR przy dopasowaniu łagodnym / niepotwierdzonym. */
        ocrRaw?: string
      }
      /**
       * 2026-07-30 — meta przepustki wyjazdowej (reason exit_pass /
       * overstay / overstay_denied). Jedzie w LPR_READ do Cloud, ląduje w
       * `access_events.meta` (enteredAt/dwellMinutes → etykiety PL w feedzie).
       */
      exitPass?: {
        enteredAt: number
        expiresAt: number
        dwellMinutes: number
        graceMinutes: number
        afterExpiry: string
        entryCameraDeviceId: string | null
      }
    },
  ) {
    const ts = Date.now()

    // If the event only brought a plate crop (<20 KB is the telltale size),
    // pull a fresh full-scene snapshot from the camera directly. This way
    // the operator always sees the whole vehicle even when firmware doesn't
    // attach the scene picture to the ANPR event multipart.
    const fullImage = await this.augmentWithLiveSnapshotIfSmall(cameraDeviceId, res.extra?.image)

    // Persist the snapshot *before* inserting the row so the image_path we
    // store always points at an existing file. Filename is human-readable
    // for troubleshooting — same `<ts>_<plate>.jpg` scheme is also used by
    // the Cloud side when it caches a copy.
    const imagePath = this.persistSnapshot(fullImage, ts, plate)

    // Diagnostic: dump the raw event XML alongside the JPEG so we can
    // discover which exotic tag a given firmware uses for brand/colour/etc.
    // Cleaned up by the same 30-day retention sweep as the JPEGs.
    this.persistRawXml(res.extra?.rawXml, ts, plate)

    // Semantyczne IN/OUT liczone RAZ i zapisywane także lokalnie — asystent AI
    // (ai-prototype) czyta kierunek z lokalnego `lpr_reads`, nie z Cloud; bez
    // tego „ile aut wjechało" na kamerach bez natywnego forward/reverse = 0.
    const direction =
      this.store.lprSemanticDirection(cameraDeviceId, res.extra?.direction) ?? res.extra?.direction ?? null

    let edgeReadId: number | null = null
    try {
      edgeReadId = this.store.lprInsertRead({
        cameraDeviceId,
        plate,
        matched: res.matched,
        owner: res.owner ?? null,
        unitLabel: res.unitLabel ?? null,
        kind: res.kind ?? null,
        tags: res.tags ?? [],
        gateOpened: res.opened,
        reason: res.reason ?? null,
        confidence: res.extra?.confidence ?? null,
        direction,
        imagePath,
        vehicleColor: res.extra?.vehicleColor ?? null,
        vehicleBrand: res.extra?.vehicleBrand ?? null,
        vehicleType: res.extra?.vehicleType ?? null,
        vehicleSubtype: res.extra?.vehicleSubtype ?? null,
        ts,
      })
    } catch (err: any) {
      this.logger.warn(`Failed to persist LPR read: ${err.message}`)
    }

    // 2026-05-22: trigger off-cycle vision snapshot (YOLO+OCR) — fire-and-forget,
    // throttled per-camera w VisionDetectService. Cel: gdy LPR widzi van DPD,
    // vision robi snapshot W TYM MOMENCIE zamiast czekać do następnego 60s tick.
    // Bez tego van przejeżdża w 5-10s i wpada między dwa cykliczne snapshots,
    // przez co brand_detected/text_raw zostają NULL (opisany scenariusz 9:47 DPD).
    this.vision.triggerForLpr(cameraDeviceId).catch((err) => {
      this.logger.debug(`LPR-triggered vision snapshot failed (non-fatal): ${err?.message}`)
    })

    // Cloud payload. The image itself isn't shipped over the WebSocket (could
    // be 100–500 KB per read — too heavy). Instead we send a URL the Cloud
    // can fetch on demand via the Edge tunnel, or serve as a reverse proxy.
    const payload = {
      cameraDeviceId,
      plate,
      matched: res.matched,
      owner: res.owner ?? null,
      gateOpened: res.opened,
      reason: res.reason ?? null,
      confidence: res.extra?.confidence ?? null,
      // Semantyczne IN/OUT (push „gość wjechał/wyjechał" w Cloud); fallback
      // do surowego forward/reverse z kamery, gdy nie da się rozstrzygnąć.
      direction,
      vehicleColor: res.extra?.vehicleColor ?? null,
      vehicleBrand: res.extra?.vehicleBrand ?? null,
      vehicleType: res.extra?.vehicleType ?? null,
      vehicleSubtype: res.extra?.vehicleSubtype ?? null,
      hasImage: !!imagePath,
      edgeReadId,
      ts,
      // Surowy odczyt OCR dla reason=probable_match/unconfirmed (treść pusha
      // „kamera odczytała …"); undefined dla zwykłych odczytów.
      ocrRaw: res.extra?.ocrRaw,
      // Meta przepustki wyjazdowej (undefined dla zwykłych odczytów — JSON
      // stringify pomija pole, starszy Cloud po prostu je zignoruje).
      exitPass: res.exitPass,
    }
    // Wysyłka do Cloud:
    //   • jeśli `tunnelSend` jest podpięty (to standard — wire-up w
    //     `tunnel.service.ts:onModuleInit`), idziemy przez `sendEvent` które
    //     samo decyduje send vs enqueue. Boolean wraca jako „delivered to
    //     socket" — wtedy ustawiamy `synced_to_cloud=1` w lokalnej tabeli,
    //     żeby `backfillUnsyncedLprReads` po reconnect tego nie powtórzył.
    //   • jeśli `tunnelSend` jeszcze niepodpięty (early boot), enqueue do
    //     event_queue jako fallback. `synced_to_cloud=0` zostaje — backfill
    //     po reconnect i tak go wyłapie.
    //
    // UWAGA: WS jest fire-and-forget. „delivered=true" oznacza tylko że dane
    // weszły do socket buffera; jeśli Cloud nie dostał, idempotent INSERT po
    // stronie Cloud (partial unique index na edgeReadId) i tak nie pozwoli
    // na duplikat jak backfill kiedykolwiek to ponowi.
    try {
      let delivered = false
      if (this.tunnelSend) {
        delivered = this.tunnelSend('LPR_READ', payload, cameraDeviceId)
      } else {
        this.store.enqueue('LPR_READ', { ...payload, deviceId: cameraDeviceId })
      }
      if (delivered && edgeReadId != null) {
        this.store.lprMarkReadSynced(edgeReadId)
      }
    } catch (err: any) {
      this.logger.warn(`Failed to push LPR_READ to tunnel: ${err.message}`)
    }

    return {
      matched: res.matched,
      opened: res.opened,
      plate,
      reason: res.reason,
      error: res.error,
      owner: res.owner ?? undefined,
      imagePath,
    }
  }

  /**
   * Write the event's JPEG to `<data>/lpr-snapshots/<ts>_<plate>.jpg`.
   * Returns the filename (relative to the snapshots dir) so it round-trips
   * safely through the DB without locking us into an absolute path. Any IO
   * failure is swallowed — a missing snapshot is better than a crash that
   * would drop the whole read.
   */
  /**
   * If the multipart payload only carried a small plate-crop JPEG (or no
   * image at all), fetch a fresh full-scene picture from the camera via
   * ISAPI. The call is best-effort with a short timeout — if it fails we
   * fall back to whatever came in the event so we never lose the read.
   *
   * Thresholds: <20 KB is almost certainly a plate crop (typical plate
   * JPEGs are 2–5 KB, vehicle crops 30–150 KB, full scenes 200 KB+).
   */
  private async augmentWithLiveSnapshotIfSmall(
    cameraDeviceId: string,
    image: Buffer | null | undefined,
  ): Promise<Buffer | null | undefined> {
    if (image && image.length >= 20_000) return image // already looks like a real picture
    const dev = this.devices.get(cameraDeviceId)
    if (!dev) return image
    const cfg = dev.config
    const port = cfg.httpPort ? `:${cfg.httpPort}` : ''
    // DeepinView ANPR channel is usually 1 (`/channels/1/picture`). The
    // `101` variant covers main-stream on some firmwares. Try both quickly
    // and keep the first non-trivial JPEG.
    const urls = [
      `http://${cfg.ipAddress}${port}/ISAPI/Streaming/channels/1/picture`,
      `http://${cfg.ipAddress}${port}/ISAPI/Streaming/channels/101/picture`,
    ]
    for (const url of urls) {
      try {
        const res = await requestWithDigest('GET', url, this.user(cfg), cfg.password, {
          responseType: 'arraybuffer',
          timeout: 3000,
          validateStatus: (s: number) => s === 200,
        })
        const buf = Buffer.from(res.data as ArrayBuffer)
        if (buf.length < 1000 || buf[0] !== 0xff || buf[1] !== 0xd8) continue
        this.logger.debug(`Live snapshot fallback OK (${buf.length}B) from ${url}`)
        return buf
      } catch (err: any) {
        this.logger.debug(`Live snapshot fallback failed at ${url}: ${err?.response?.status ?? err?.code ?? err?.message}`)
      }
    }
    return image // keep whatever the event gave us
  }

  /**
   * Save the event's raw XML to `<data>/lpr-snapshots/<ts>_<plate>.xml`
   * for post-hoc inspection. Useful when a firmware puts `vehicleBrand`
   * under an unexpected tag name — we can grep the dump to discover it
   * without waiting for another vehicle. Skipped silently on IO errors;
   * a missing diagnostic file must not break the read path.
   */
  private persistRawXml(xml: string | null | undefined, ts: number, plate: string): void {
    if (!xml || xml.length === 0) return
    try {
      const filename = `${ts}_${plate}.xml`
      const full = path.join(this.store.lprSnapshotsDir(), filename)
      fs.writeFileSync(full, xml, 'utf8')
    } catch { /* best effort */ }
  }

  private persistSnapshot(image: Buffer | null | undefined, ts: number, plate: string): string | null {
    if (!image || image.length === 0) return null
    // Defensive sanity check: JPEGs start with 0xFF 0xD8 0xFF. If the camera
    // sent something exotic, skip persistence rather than save garbage.
    if (image.length < 4 || image[0] !== 0xff || image[1] !== 0xd8) {
      this.logger.debug(`Non-JPEG attachment (${image.length}B) for ${plate} — skipping snapshot`)
      return null
    }
    try {
      const filename = `${ts}_${plate}.jpg`
      const full = path.join(this.store.lprSnapshotsDir(), filename)
      fs.writeFileSync(full, image)
      return filename
    } catch (err: any) {
      this.logger.warn(`Snapshot save failed for ${plate}: ${err.message}`)
      return null
    }
  }

  // ── Retention: sweep LPR reads older than 30 days (Edge-local). ─────────────
  /**
   * Cloud keeps 30 days; Edge matches that to cap SQLite growth. Fires every
   * hour and deletes rows past the 30-day mark. Using @Interval instead of
   * @Cron to avoid cron-expression dependencies.
   */
  @Interval(60 * 60 * 1000)
  retentionSweep() {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
    try {
      const removed = this.store.lprSweepOldReads(cutoff)
      if (removed > 0) {
        this.logger.log(`LPR reads retention: removed ${removed} row(s) older than 30 days`)
      }
    } catch (err: any) {
      this.logger.warn(`LPR reads sweep failed: ${err.message}`)
    }

    // Przepustki wyjazdowe (2026-07-30): efemeryczne — wygasłe/zużyte
    // starsze niż 24 h kasujemy (RODO, docs/exit-grace-pass.md).
    try {
      const removedPasses = this.store.exitPassSweep(Date.now() - 24 * 60 * 60 * 1000)
      if (removedPasses > 0) {
        this.logger.log(`Exit passes retention: removed ${removedPasses} row(s) older than 24h`)
      }
    } catch (err: any) {
      this.logger.warn(`Exit passes sweep failed: ${err.message}`)
    }

    // Snapshot cleanup: delete snapshot artefacts (`.jpg` and diagnostic
    // `.xml` dumps) older than the cutoff. We go by filename prefix
    // (`<ts>_…`) rather than mtime so cloning/syncing the data dir to
    // another Edge doesn't erase the history.
    try {
      const dir = this.store.lprSnapshotsDir()
      let deleted = 0
      for (const f of fs.readdirSync(dir)) {
        const m = f.match(/^(\d+)_/)
        if (!m) continue
        if (Number(m[1]) < cutoff) {
          try { fs.unlinkSync(path.join(dir, f)); deleted++ } catch { /* ignore per-file errors */ }
        }
      }
      if (deleted > 0) this.logger.log(`LPR snapshots retention: removed ${deleted} file(s)`)
    } catch (err: any) {
      this.logger.warn(`LPR snapshot sweep failed: ${err.message}`)
    }
  }

  // ── Auto-configure camera to send events to this Edge ───────────────────────
  /**
   * Registers our HTTP listener in the camera's notification host list so that
   * the camera POSTs ANPR events to us. Best-effort — if auth is wrong or the
   * firmware differs, we just log and move on.
   */
  private async configureEventListener(cameraDeviceId: string) {
    const dev = this.getDevice(cameraDeviceId)
    const edgeHost = this.getEdgeHostForCamera(dev.config.ipAddress)
    if (!edgeHost) {
      this.logger.warn(`Cannot determine Edge host IP reachable from camera ${dev.config.ipAddress}`)
      return
    }

    // Hikvision wants each HttpHostNotification to have a unique id (1..32).
    // We use id=1 and overwrite it — single-tenant camera per building is fine.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HttpHostNotification version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
  <id>1</id>
  <url>/events/lpr/hikvision/${cameraDeviceId}</url>
  <protocolType>HTTP</protocolType>
  <parameterFormatType>XML</parameterFormatType>
  <addressingFormatType>ipaddress</addressingFormatType>
  <ipAddress>${edgeHost.ip}</ipAddress>
  <portNo>${edgeHost.port}</portNo>
  <httpAuthenticationMethod>none</httpAuthenticationMethod>
</HttpHostNotification>`

    const url = `${this.baseUrl(dev.config)}/ISAPI/Event/notification/httpHosts/1`
    try {
      const res = await requestWithDigest('PUT', url, this.user(dev.config), dev.config.password, {
        data: xml,
        headers: { 'Content-Type': 'application/xml' },
        httpsAgent,
        timeout: 6000,
        validateStatus: () => true,
      })
      if (res.status === 200 || res.status === 201) {
        this.logger.log(`Camera ${cameraDeviceId} configured to POST ANPR events to http://${edgeHost.ip}:${edgeHost.port}/events/lpr/hikvision/${cameraDeviceId}`)
      } else {
        this.logger.warn(`Camera httpHost config returned ${res.status}: ${this.short(res.data)}`)
      }
    } catch (err: any) {
      this.logger.warn(`Camera httpHost config failed: ${err.message}`)
    }
  }

  // ── Auto-configure ANPR event → center notification linkage ─────────────────
  /**
   * Even with `httpHosts/1` pointed at Edge, a Hikvision camera won't actually
   * POST anything unless the Vehicle-Detect trigger is linked to
   * "Notify Surveillance Center". Without that, users normally go into the
   * camera web UI and tick "Notify Surveillance Center" under Event → Smart Event.
   *
   * This method tries to do the same over ISAPI. It's deliberately forgiving:
   *   - Tries multiple trigger ID naming conventions (firmware drift).
   *   - GET → patch XML → PUT. If GET succeeds but PUT fails, we log and
   *     continue — better a partial success than a crash on startup.
   *
   * Return value is a structured diagnostic report so the manual
   * `POST /lpr/:id/camera-setup` endpoint can surface exactly what the camera
   * accepted/rejected without grepping logs.
   */
  async ensureAnprTriggering(cameraDeviceId: string): Promise<CameraSetupReport> {
    const dev = this.getDevice(cameraDeviceId)
    const steps: ProbeStep[] = []

    // Discover what the camera reports as its trigger list — purely diagnostic,
    // we don't *need* it, but it helps when the camera refuses later PUTs.
    steps.push(await this.probe('GET', '/ISAPI/Event/triggers', dev.config))

    // Try the plausible VehicleDetect-like trigger IDs that DeepinView
    // firmware revisions have used. First one that returns <EventTrigger> wins.
    // UWAGA na kolejność i pisownię: DeepinView 4A (fw V5.4.5, np.
    // DS-2CD4A26FWD-IZS/P) używa `vehicledetection-1` — WSZYSTKO małymi, bez
    // wielbłądziej pisowni. Brak tego wariantu na liście dawał fałszywe
    // „No VehicleDetect trigger found" mimo poprawnie skonfigurowanej kamery
    // (VN, 2026-08-05). Nowsze firmware'y używają wariantów `VehicleDetect*`.
    const candidates = [
      'VehicleDetect-1', 'vehicleDetect-1', 'VehicleDetect', 'ANPR-1', 'anpr-1',
      // DOPISANE NA KOŃCU, nie na początku — celowo. DeepinView 4A (fw V5.4.5,
      // np. DS-2CD4A26FWD-IZS/P) używa `vehicledetection-1` (same małe litery)
      // i bez tego wariantu dostawaliśmy fałszywe „No VehicleDetect trigger
      // found" mimo poprawnie skonfigurowanej kamery (VN, 2026-08-05).
      // Kolejność ma znaczenie: kamery, które już działały, dalej dopasowują
      // się przez swoją dotychczasową nazwę, więc wdrożenie tej zmiany nie
      // przepina istniejących instalacji na inny trigger.
      'vehicledetection-1', 'VehicleDetection-1',
    ]
    let triggerPath: string | null = null
    let currentXml: string | null = null
    for (const t of candidates) {
      const path = `/ISAPI/Event/triggers/${t}`
      const res = await this.probe('GET', path, dev.config)
      steps.push(res)
      if (res.status === 200 && /<EventTrigger[\s>]/i.test(res.body ?? '')) {
        triggerPath = path
        currentXml = res.body ?? ''
        break
      }
    }

    if (!triggerPath || !currentXml) {
      this.logger.warn(`[${cameraDeviceId}] No VehicleDetect trigger found via ISAPI — włącz ANPR w panelu kamery (Configuration → Event → Smart Event)`)
      this.eventLog.warn('LPR', `⚠️ Camera ${cameraDeviceId} not returning VehicleDetect trigger — check camera panel`)
      return { ok: false, reason: 'no_vehicle_detect_trigger', steps }
    }

    // Patch XML: ensure <EventTriggerNotification> with notificationMethod=center exists.
    const patched = this.patchTriggerWithCenterNotification(currentXml)
    const putStep = await this.probe('PUT', triggerPath, dev.config, patched)
    steps.push(putStep)

    if (putStep.status === 200 || putStep.status === 201) {
      this.logger.log(`[${cameraDeviceId}] ANPR trigger linked to center notification (${triggerPath})`)
      this.eventLog.success('LPR', `✅ Camera ${cameraDeviceId} configured — will push reads to Edge`)
      // Surface what the firmware reports about vehicle-attribute support — read
      // only. Modifying these endpoints risks clobbering unrelated settings, so
      // enablement is left to the camera web UI. The diagnostic trace lets the
      // integrator see at a glance which attributes are already emitted.
      await this.probeVehicleAttributes(dev.config, steps)
      return { ok: true, triggerPath, steps }
    }

    this.logger.warn(`[${cameraDeviceId}] PUT ${triggerPath} returned ${putStep.status}: ${this.short(putStep.body)}`)
    this.eventLog.warn('LPR', `⚠️ Camera ${cameraDeviceId} rejected PUT ${triggerPath} (${putStep.status}) — open the camera panel and tick "Notify Surveillance Center"`)
    return { ok: false, reason: `put_failed_${putStep.status}`, triggerPath, steps }
  }

  /**
   * Best-effort diagnostic — hit the paths that DeepinView firmwares use to
   * expose vehicle-attribute recognition settings. We don't write anything:
   * just append the GET responses to the setup report so the installer can
   * confirm at a glance whether colour/brand/type recognition is enabled.
   * Failures are silent (probe already captures them as steps).
   */
  private async probeVehicleAttributes(cfg: LprCameraConfig, steps: ProbeStep[]) {
    const candidates = [
      '/ISAPI/Smart/VehicleDetect/1',
      '/ISAPI/Traffic/channels/1/vehicleDetect',
      '/ISAPI/Traffic/channels/1/capture',
    ]
    for (const p of candidates) {
      steps.push(await this.probe('GET', p, cfg))
    }
  }

  /**
   * Given the camera's current `<EventTrigger>` XML, insert (or keep) a
   * `<EventTriggerNotification><notificationMethod>center</notificationMethod></EventTriggerNotification>`
   * inside `<EventTriggerNotificationList>`. Rest of the document is preserved
   * so we don't accidentally wipe other settings (schedule, recording, etc.).
   */
  private patchTriggerWithCenterNotification(xml: string): string {
    // Already has a center notification? Leave the XML alone — PUTing the same
    // doc back is still a useful liveness check.
    if (/<notificationMethod>\s*center\s*<\/notificationMethod>/i.test(xml)) {
      return xml
    }

    const centerEntry =
      `<EventTriggerNotification>` +
        `<id>1</id>` +
        `<notificationMethod>center</notificationMethod>` +
        `<notificationRecurrence>beginning</notificationRecurrence>` +
      `</EventTriggerNotification>`

    // Case A: <EventTriggerNotificationList> exists — inject our entry at the top.
    const listOpen = xml.match(/<EventTriggerNotificationList[^>]*>/i)
    if (listOpen) {
      return xml.replace(listOpen[0], listOpen[0] + centerEntry)
    }

    // Case B: no notification list at all — inject a fresh one right before </EventTrigger>.
    const closeTag = '</EventTrigger>'
    const closeIdx = xml.lastIndexOf(closeTag)
    if (closeIdx > 0) {
      return xml.slice(0, closeIdx) +
        `<EventTriggerNotificationList>${centerEntry}</EventTriggerNotificationList>` +
        xml.slice(closeIdx)
    }

    // Unknown shape — append; camera will either accept or 400 with a clear msg.
    return xml + `<EventTriggerNotificationList>${centerEntry}</EventTriggerNotificationList>`
  }

  /**
   * Low-level HTTP helper for ISAPI probes. Never throws — every failure turns
   * into a `ProbeStep` with status=0 and an `error` field. This keeps the
   * diagnostic report uniform whether the endpoint 404s, times out, or 403s.
   */
  private async probe(
    method: 'GET' | 'PUT' | 'POST',
    path: string,
    cfg: LprCameraConfig,
    body?: string,
  ): Promise<ProbeStep> {
    const url = `${this.baseUrl(cfg)}${path}`
    try {
      const res = await requestWithDigest(method, url, this.user(cfg), cfg.password, {
        data: body,
        headers: body ? { 'Content-Type': 'application/xml' } : undefined,
        httpsAgent,
        timeout: 6000,
        validateStatus: () => true,
      })
      const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '')
      return { method, path, status: res.status, body: text, snippet: this.short(text) }
    } catch (err: any) {
      return { method, path, status: 0, body: '', snippet: err.message, error: err.message }
    }
  }

  /**
   * Best effort: pick the Edge's LAN-facing IP the camera can reach.
   * Override via EDGE_PUBLIC_HOST env var (ip:port) if autodetect is wrong.
   */
  private getEdgeHostForCamera(cameraIp: string): { ip: string; port: number } | null {
    const override = process.env.EDGE_PUBLIC_HOST
    if (override) {
      const [ip, port] = override.split(':')
      return { ip, port: Number(port) || 4000 }
    }
    const os = require('os') as typeof import('os')
    const ifaces = os.networkInterfaces()
    // Find a non-internal IPv4 in the same /24 as the camera, otherwise the first non-internal IPv4.
    const camPrefix = cameraIp.split('.').slice(0, 3).join('.')
    let fallback: string | null = null
    for (const name of Object.keys(ifaces)) {
      for (const addr of ifaces[name] ?? []) {
        if (addr.family !== 'IPv4' || addr.internal) continue
        if (addr.address.startsWith(camPrefix + '.')) return { ip: addr.address, port: 4000 }
        fallback ??= addr.address
      }
    }
    return fallback ? { ip: fallback, port: 4000 } : null
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  private getDevice(id: string): LprDevice {
    const d = this.devices.get(id)
    if (!d) throw new Error(`LPR camera ${id} not registered`)
    return d
  }

  private firstIntercomId(): string | null {
    // IntercomService exposes a Map via iteration — we peek at the first key.
    // Keeps the dependency one-way (no circular import) and matches single-gate setups.
    const ids = (this.intercom as any).devices?.keys?.()
    if (!ids) return null
    const first = ids.next?.()
    return first && !first.done ? first.value as string : null
  }

  /** Username for ISAPI. Hikvision default is 'admin' — use it if the config omits login. */
  private user(cfg: LprCameraConfig): string {
    return cfg.login && cfg.login.trim().length > 0 ? cfg.login : 'admin'
  }

  private baseUrl(cfg: LprCameraConfig) {
    const port = cfg.httpPort ? `:${cfg.httpPort}` : ''
    return `http://${cfg.ipAddress}${port}`
  }

  /** Uppercase, strip whitespace, dashes, dots. Keep alphanumerics only. */
  normalizePlate(p: string): string {
    return (p ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  }

  /**
   * OCR-fuzzy fallback (2026-05-18) — Hikvision DeepinView ANPR czasem myli
   * znaki o podobnym kształcie: O↔0 (litera "O" jako cyfra "zero"), I↔1↔L,
   * S↔5, B↔8, Z↔2, G↔6. Przykład realny: Kurier GLS plate `WO71843` był
   * odczytany 2× jako `W071843` (litera O → cyfra 0) → strict match fail
   * → matched=0 → brama nie otworzyła się mimo że plate jest w whiteliście.
   *
   * Strategia: dla każdego znaku w odczytanej tablicy generujemy kombinacje
   * single-char substitutions z tej samej klasy OCR-confusion. Cap 32 wariantów
   * żeby uniknąć eksplozji dla plate-ów z wieloma niejednoznacznymi znakami.
   *
   * Stosowane TYLKO po fail strict matcha (pierwszy try). False-positive
   * risk minimalny bo whitelist ma <500 plate-ów i variants są constrained
   * do shape-similar chars (nie wszystkie litery z każdą).
   */
  private static readonly OCR_EQUIV_SETS: string[][] = [
    ['0', 'O', 'Q', 'D'],   // round shapes
    ['1', 'I', 'L'],        // vertical
    ['5', 'S'],
    ['8', 'B'],
    ['2', 'Z'],
    ['6', 'G'],
    // Litery z ukośnych kresek — mylone, gdy tablica jest mała w kadrze i
    // wierzchołki się zlewają. Dodane po zgłoszeniu z VN (2026-08-07):
    // `WE8FN26` odczytane jako `NE8FN26` mimo ostrego zdjęcia. Bez tej pary
    // pojazd mieszkańca nie dopasowałby się do białej listy z powodu jednej
    // litery.
    ['W', 'V', 'N', 'M'],
    ['E', 'F'],
    ['7', 'T'],
    ['4', 'A'],
  ]

  private static readonly OCR_CHAR_ALTS: Record<string, string[]> = (() => {
    const m: Record<string, string[]> = {}
    for (const set of HikvisionLprService.OCR_EQUIV_SETS) {
      for (const c of set) {
        m[c] = set.filter((x) => x !== c)
      }
    }
    return m
  })()

  /**
   * Generuje warianty plate-u przez OCR-podstawienia. Każdy znak z OCR-alts
   * mnoży liczbę wariantów. Przykład: `W071843` → znak `0` ma alts `[O,Q,D]`
   * → 4 warianty (`W071843`, `WO71843`, `WQ71843`, `WD71843`). Plate bez
   * ambiguous chars zwraca pustą listę.
   *
   * Cap: 32 wariantów (wyklucza explosion dla niezwykłych plate-ów).
   * Original plate pomijany w wyniku (już sprawdzony strict).
   */
  private generateOcrVariants(plate: string, maxVariants = 32): string[] {
    let variants: string[] = ['']
    for (const c of plate) {
      const alts = [c, ...(HikvisionLprService.OCR_CHAR_ALTS[c] ?? [])]
      const next: string[] = []
      outer: for (const v of variants) {
        for (const a of alts) {
          next.push(v + a)
          if (next.length >= maxVariants * 4) break outer
        }
      }
      variants = next
    }
    return variants.filter((v) => v !== plate).slice(0, maxVariants)
  }

  /**
   * Odczyt NIEPOTWIERDZONY z alertStreamu (2026-09-15) — jedna klatka albo
   * pewność poniżej progu. Dotąd lądował tylko w logu, więc przejazd
   * mieszkańca „za poprzednim autem" (VN 13.09 17:51: WE387YT odczytane
   * z jednej klatki jako WE38711) nie istniał ani w panelu, ani w pushu.
   *
   * Zasady:
   *   • rejestr ma pierwszeństwo: ścisły → OCR-fuzzy → ŁAGODNY (plate-fuzzy.util,
   *     dokładnie jedna tablica z whitelisty kamery) → read `matched=1,
   *     reason=probable_match` (push „prawdopodobnie", BEZ otwierania bramy),
   *   • bez dopasowania: read `matched=0, reason=unconfirmed` gdy pewność ≥ 0.5
   *     (ślad w panelu + materiał dla korelatora tailgatingu),
   *   • dedup: ta sama tablica na tej kamerze w 30 s → pomijamy; alertStream
   *     dodatkowo wstrzymuje niepotwierdzone 8 s i anuluje, gdy w tym czasie
   *     nadejdzie pewny odczyt z tej kamery.
   */
  async handleUncertainRead(
    cameraDeviceId: string,
    rawPlate: string,
    extra: {
      confidence?: number
      agreedFrames?: number
      candidates?: string[]
      image?: Buffer | null
      direction?: string
      vehicleBrand?: string
    },
  ) {
    const raw = this.normalizePlate(rawPlate)
    if (!raw) return null
    const dev = this.devices.get(cameraDeviceId)
    if (!dev) return null

    const candidates = Array.from(new Set(
      [raw, ...(extra.candidates ?? []).map((c) => this.normalizePlate(c))].filter(Boolean),
    ))

    let plate: string | null = null
    let match: ReturnType<StoreService['lprMatchPlate']> = null
    for (const c of candidates) {
      match = this.store.lprMatchPlate(cameraDeviceId, c)
      if (match) { plate = c; break }
      const fz = this.tryOcrFuzzyMatch(cameraDeviceId, c)
      if (fz) { plate = fz.plate; match = fz.match; break }
    }
    if (!match) {
      const lenient = this.tryLenientMatch(cameraDeviceId, candidates)
      if (lenient) { plate = lenient.plate; match = lenient.match }
    }

    const now = Date.now()
    const key = `${cameraDeviceId}:${plate ?? raw}`
    if (now - (this.lastUncertain.get(key) ?? 0) < 30_000) {
      this.logger.debug(`[${cameraDeviceId}] niepotwierdzony odczyt ${raw} — duplikat w 30 s, pomijam`)
      return null
    }
    if (plate && now - (this.lastTrigger.get(key) ?? 0) < (dev.config.rateLimitMs ?? 10_000)) {
      this.logger.debug(`[${cameraDeviceId}] niepotwierdzony odczyt ${raw} → ${plate} tuż po pewnym odczycie, pomijam`)
      return null
    }
    this.lastUncertain.set(key, now)

    const conf = extra.confidence ?? 0
    if (match && plate) {
      this.eventLog.info('LPR', `🔎 Niepewny odczyt ${raw} dopasowany do rejestru → ${plate} (bez otwierania bramy)`, {
        cameraDeviceId, rawPlate: raw, correctedPlate: plate, confidence: conf, agreedFrames: extra.agreedFrames,
      })
      return this.finalizeRead(cameraDeviceId, plate, {
        matched: true, opened: false, reason: 'probable_match',
        owner: match.owner ?? null,
        unitLabel: match.unitLabel ?? null,
        kind: match.kind ?? null,
        tags: match.tags ?? [],
        extra: {
          confidence: conf, direction: extra.direction, image: extra.image,
          vehicleBrand: extra.vehicleBrand, ocrRaw: raw,
        },
      })
    }

    if (conf < 0.5) {
      this.logger.debug(`[${cameraDeviceId}] niepotwierdzony odczyt ${raw} (pewność ${conf.toFixed(2)}) poniżej 0.5 — bez wpisu`)
      return null
    }
    this.eventLog.info('LPR', `❔ Niepotwierdzony odczyt ${raw} (pewność ${conf.toFixed(2)}) — zapisany bez dopasowania`, {
      cameraDeviceId, confidence: conf, agreedFrames: extra.agreedFrames,
    })
    return this.finalizeRead(cameraDeviceId, raw, {
      matched: false, opened: false, reason: 'unconfirmed',
      extra: {
        confidence: conf, direction: extra.direction, image: extra.image,
        vehicleBrand: extra.vehicleBrand, ocrRaw: raw,
      },
    })
  }

  /** Dedup niepotwierdzonych odczytów: `${camera}:${plate}` → ts ostatniego wpisu. */
  private readonly lastUncertain = new Map<string, number>()

  /**
   * Łagodne dopasowanie do rejestru kamery (plate-fuzzy.util) + kontrola
   * ważności wpisu (goście mają okna). Niejednoznaczność = brak dopasowania.
   */
  private tryLenientMatch(
    cameraDeviceId: string,
    candidates: string[],
  ): { plate: string; raw: string; cost: number; match: NonNullable<ReturnType<StoreService['lprMatchPlate']>> } | null {
    const whitelist = this.store.lprListPlates(cameraDeviceId).map((p) => p.plate)
    if (!whitelist.length) return null
    const res = lenientPlateMatch(candidates, whitelist)
    if (res.ambiguous) {
      this.logger.log(`[${cameraDeviceId}] łagodne dopasowanie ${candidates.join('/')} niejednoznaczne — pomijam`)
      return null
    }
    if (!res.match) return null
    const match = this.store.lprMatchPlate(cameraDeviceId, res.match.plate)
    if (!match) return null
    return { plate: res.match.plate, raw: res.match.raw, cost: res.match.cost, match }
  }

  /**
   * Próbuje wszystkich OCR-wariantów aż znajdzie hit w whiteliście. Zwraca
   * `{plate: corrected, match: <whitelistEntry>}` na sukces, null gdy żaden
   * wariant nie match-uje. Maksymalnie 32 lookupów do sqlite — tanio
   * (indeksowane `lpr_plates_plate_idx`).
   */
  private tryOcrFuzzyMatch(
    cameraDeviceId: string,
    plate: string,
  ): { plate: string; match: NonNullable<ReturnType<StoreService['lprMatchPlate']>> } | null {
    for (const variant of this.generateOcrVariants(plate)) {
      const match = this.store.lprMatchPlate(cameraDeviceId, variant)
      if (match) return { plate: variant, match }
    }
    return null
  }

  private toMillis(d?: string | Date | null): number | null {
    if (!d) return null
    const dt = d instanceof Date ? d : new Date(d)
    const ms = dt.getTime()
    return Number.isFinite(ms) ? ms : null
  }

  private short(data: any, max = 200): string {
    const s = typeof data === 'string' ? data : JSON.stringify(data ?? '')
    return s.length > max ? s.slice(0, max) + '…' : s
  }
}
