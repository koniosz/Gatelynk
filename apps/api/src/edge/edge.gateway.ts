import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { HttpAdapterHost, ModuleRef } from '@nestjs/core'
import { Interval } from '@nestjs/schedule'
import * as WebSocket from 'ws'
import * as http from 'http'
import { formatUnitLabel } from '../common/unit-label'
import { EdgeService } from './edge.service'
import { EdgeOutboxService } from './edge-outbox.service'
import { LprReadsService } from '../lpr-reads/lpr-reads.service'
import { GuestsValidationService } from '../guests/guests-validation.service'
import { AnomalyEventsService } from '../anomaly-events/anomaly-events.service'
import { guessDriverId, type DeviceType } from '@gatelynk/device-drivers'

/**
 * Czy adres należy do tailnetu (CGNAT 100.64.0.0/10 — Tailscale)?
 * Tylko taki adres nadaje się do HTTP Cloud→Edge: publiczny adres osiedla
 * (źródło WS przez NAT) nie ma wystawionego portu 4000 i jego zapisanie
 * zatruwa `edge_devices.ipAddress`.
 */
function isTailnetIp(ip?: string): boolean {
  if (!ip) return false
  const m = ip.match(/^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/)
  return m !== null && Number(m[1]) >= 64 && Number(m[1]) <= 127
}

interface ConnectedEdge {
  deviceId: string
  buildingId: number
  type: string
  ws: WebSocket
  connectedAt: Date
  lastSeen: Date
  version?: string
  remoteIp?: string
  // FAZA f (2026-06-02) — cache ostatniego `STATUS` message-a z Edge.
  // Wykorzystywane przez `getLastStatus(deviceId)` w Integrator dashboard
  // żeby nie robić HTTP fetch do `http://<ip>:4000/status` przy każdym
  // polling-u dashboardu. Edge wysyła STATUS okresowo (Tunnel pings).
  lastStatus?: {
    uptime: number | null
    queueSize: number | null
    version: string | null
    ts: number
  }
}

@Injectable()
export class EdgeGateway implements OnModuleInit {
  private readonly logger = new Logger(EdgeGateway.name)
  private wss: WebSocket.Server
  private connections = new Map<string, ConnectedEdge>()

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly edge: EdgeService,
    private readonly outbox: EdgeOutboxService,
    // Lazy-resolved to keep EdgeModule free of the LprReadsModule dependency
    // (LprReadsModule already imports role modules that pull in PrismaModule →
    // we avoid the loop by grabbing the service at runtime).
    private readonly moduleRef: ModuleRef,
  ) {}

  private lprReads?: LprReadsService
  private getLprReads(): LprReadsService | undefined {
    if (this.lprReads) return this.lprReads
    try {
      this.lprReads = this.moduleRef.get(LprReadsService, { strict: false })
      // Rejestrujemy się w serwisie, żeby mógł prosić o miniatury przez tunel
      // (kierunek odwrotny). Push zamiast pull — import w drugą stronę
      // dałby cykl modułowy.
      this.lprReads?.setEdgeGateway?.(this)
    } catch {
      // Service not wired yet (e.g. during boot) — just skip recording this event.
    }
    return this.lprReads
  }

  // Lazy-resolved tak samo jak LprReadsService — żeby uniknąć cyklicznej
  // zależności (GuestsModule importuje EdgeModule dla `EdgeService.verifyToken`,
  // a EdgeGateway musi wywołać GuestsValidationService.validatePin po
  // `GUEST_PIN_USED`).
  private guestsValidation?: GuestsValidationService
  private getGuestsValidation(): GuestsValidationService | undefined {
    if (this.guestsValidation) return this.guestsValidation
    try {
      this.guestsValidation = this.moduleRef.get(GuestsValidationService, { strict: false })
    } catch {
      // Not wired during boot — skip; first event after boot retries.
    }
    return this.guestsValidation
  }

  // 2026-07-08 — AccessEventsService dla audytu odmów ograniczeń gościa
  // (GUEST_ACCESS_DENIED z Edge). Lazy-resolve jak pozostałe.
  private accessEventsSvc?: any
  private getAccessEvents(): any | undefined {
    if (this.accessEventsSvc) return this.accessEventsSvc
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { AccessEventsService } = require('../access-events/access-events.service')
      this.accessEventsSvc = this.moduleRef.get(AccessEventsService, { strict: false })
    } catch {
      // Not wired during boot — skip; first event after boot retries.
    }
    return this.accessEventsSvc
  }

  // Lazy-resolved jak inne service-y żeby AnomalyEventsModule mógł importować
  // PushModule (który nie zależy od EdgeModule) bez tworzenia cyklu.
  private anomalyEvents?: AnomalyEventsService
  private getAnomalyEvents(): AnomalyEventsService | undefined {
    if (this.anomalyEvents) return this.anomalyEvents
    try {
      this.anomalyEvents = this.moduleRef.get(AnomalyEventsService, { strict: false })
    } catch {
      // Not wired during boot — skip; first event after boot retries.
    }
    return this.anomalyEvents
  }

  // 2026-09-01 — SITUATION_ALERT (upadek potwierdzony przez VLM na Edge):
  // push krytyczny do WSZYSTKICH mieszkańców budynku — na osiedlu bez
  // obsługi sąsiedzi są najszybszą pomocą. Lazy-resolve PushService jak
  // pozostałe serwisy z modułów importujących EdgeModule.
  private pushSvc?: any
  private getPush(): any | undefined {
    if (this.pushSvc) return this.pushSvc
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PushService } = require('../push/push.service')
      this.pushSvc = this.moduleRef.get(PushService, { strict: false })
    } catch {
      // Not wired during boot — skip; kolejny alert spróbuje ponownie.
    }
    return this.pushSvc
  }

  // FAZA d (2026-06-02) — CourierVisitService. Edge zgłasza
  // `COURIER_VISIT_NEW` gdy kurier wpisze 4-cyfrowy kod ktorego nie ma
  // w guest_pins/resident_pins. Lazy-resolve tak jak inne (CourierVisitService
  // żyje w ResidentModule który importuje EdgeModule → bez lazy mielibyśmy cykl).
  private courierVisits?: any
  private getCourierVisits(): any | undefined {
    if (this.courierVisits) return this.courierVisits
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { CourierVisitService } = require('../resident/courier-visit.service')
      this.courierVisits = this.moduleRef.get(CourierVisitService, { strict: false })
    } catch {
      // Not wired during boot — skip; first event after boot retries.
    }
    return this.courierVisits
  }

  // Lazy-resolved jak inne service-y — IntercomCallService żyje w ResidentModule
  // który importuje EdgeModule (dla EdgeService/EdgeGateway), więc bez lazy
  // mielibyśmy cykl. Edge zgłasza INTERCOM_CALL_INVITE / INTERCOM_SIGNAL /
  // INTERCOM_CALL_ENDED — patrz docs/intercom-akuvox-call.md.
  private intercomCalls?: any
  private getIntercomCalls(): any | undefined {
    if (this.intercomCalls) return this.intercomCalls
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { IntercomCallService } = require('../resident/intercom-call.service')
      this.intercomCalls = this.moduleRef.get(IntercomCallService, { strict: false })
    } catch {
      // Not wired during boot — skip; first event after boot retries.
    }
    return this.intercomCalls
  }

  onModuleInit() {
    const httpServer: http.Server = this.httpAdapterHost.httpAdapter.getHttpServer()

    this.wss = new WebSocket.Server({ noServer: true })

    httpServer.on('upgrade', (request: http.IncomingMessage, socket: any, head: Buffer) => {
      const url = new URL(request.url ?? '', `http://${request.headers.host}`)
      if (url.pathname !== '/api/edge/tunnel') {
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, request)
      })
    })

    this.wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
      this.handleConnection(ws, req)
    })

    this.logger.log('Edge tunnel WebSocket ready at /api/edge/tunnel')
  }

  // ── New connection ────────────────────────────────────────────────────────────
  private async handleConnection(ws: WebSocket, req: http.IncomingMessage) {
    const token = this.extractToken(req)
    if (!token) {
      this.logger.warn('Edge connection rejected — no token')
      ws.close(4001, 'Unauthorized')
      return
    }

    const identity = this.edge.verifyToken(token)
    if (!identity) {
      this.logger.warn('Edge connection rejected — invalid token')
      ws.close(4001, 'Unauthorized')
      return
    }

    const { deviceId, buildingId, type } = identity

    // Extract remote IP from the HTTP upgrade request
    const observedIp = (
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress?.replace('::ffff:', '')
    ) || undefined

    // Dev override: gdy API żyje w Dockerze (colima/orbstack), `observedIp` to
    // adres bramy mostka (np. 172.18.0.1) — ten adres NIE prowadzi do hostowych
    // serwisów na colima/lima. Edge HTTP API (port 4000) jest osiągalny pod
    // `host.docker.internal`. Ustaw `EDGE_HTTP_HOST_OVERRIDE=host.docker.internal`
    // w `.env`, a sync access-points i statyczny fallback przejdą przez ten host.
    //
    // ⚠️ WYŁĄCZNIE dev. Na produkcji ten override przypisuje KAŻDEMU Edge'owi
    // ten sam adres — 2026-08-11 sekret `EDGE_HTTP_HOST_OVERRIDE=100.90.244.90`
    // (relikt z czasów jednego budynku) kierował HTTP wszystkich budynków na
    // Edge Villa Natury: podgląd kamer VN zwracał pusty obraz, a sync stworzył
    // w b11 punkty dostępu wskazujące urządzenia INNEGO obiektu (naciśnięcie
    // „Wjazd" w VN otwierało bramę w Villa Naturze).
    //
    // Produkcyjna reguła: źródłowy adres WS przez NAT to PUBLICZNY adres
    // osiedla — port 4000 nie jest tam wystawiony i nigdy nie wolno go zapisać
    // (touch() nadpisałby edge_devices.ipAddress, zatruwając też fallback).
    // Do HTTP nadaje się wyłącznie adres tailnetowy (100.64.0.0/10 — cloud
    // sięga Edge'a własnym tailscaledem); w innym razie bierzemy ostatni dobry
    // adres z bazy (ustawiany ręcznie przy instalacji obiektu).
    const override = (process.env.EDGE_HTTP_HOST_OVERRIDE ?? '').trim()
    let remoteIp = override.length > 0 ? override : (isTailnetIp(observedIp) ? observedIp : undefined)
    if (!remoteIp) {
      const stored = await this.edge.getStoredIp(deviceId)
      if (stored) {
        remoteIp = stored
        this.logger.log(
          `Edge ${deviceId}: WS z adresu nietailnetowego (${observedIp ?? 'unknown'}) — używam IP z bazy: ${stored}`,
        )
      }
    }

    // Close existing connection for this device (reconnect scenario)
    const existing = this.connections.get(deviceId)
    if (existing) {
      existing.ws.close(4000, 'superseded')
      this.connections.delete(deviceId)
    }

    const conn: ConnectedEdge = {
      deviceId, buildingId, type, ws,
      connectedAt: new Date(), lastSeen: new Date(),
      remoteIp,
    }
    this.connections.set(deviceId, conn)

    this.logger.log(`Edge connected: ${deviceId} (${type}) — building ${buildingId} — IP ${remoteIp ?? 'unknown'}`)
    await this.edge.touch(deviceId, remoteIp)

    // Sync access points non-blocking (don't await)
    if (remoteIp) {
      this.edge.syncAccessPoints(deviceId, buildingId, remoteIp).catch((err) =>
        this.logger.warn(`syncAccessPoints failed: ${err.message}`),
      )
    }

    // Faza 7.6 — replay pending outbox dla tego Edge. Wszystkie CMD-y
    // które zaszły gdy Edge był offline (np. PLATE_UPSERT dla nowego gościa,
    // PIN_DELETE dla cancelled) zostają teraz wysłane w kolejności
    // chronologicznej. ACK od Edge oznaczy `deliveredAt`.
    this.replayPendingForDevice(deviceId, ws).catch((err) =>
      this.logger.warn(`replayPending failed [${deviceId}]: ${err.message}`),
    )

    // Refactor 2026-06-01 — pełen AP / Schedule sync przy reconnect.
    // Defense-in-depth: outbox replay obsługuje delta-zmiany, ale stary Edge
    // który nigdy nie dostał inicjalnego SYNC_ALL (świeża aktywacja, albo
    // po `apsReplaceAll` na Cloud-side) — dostaje tu pełen stan.
    this.pushAccessPointSync(deviceId, buildingId, ws).catch((err) =>
      this.logger.warn(`AP_SYNC_ALL push failed [${deviceId}]: ${err.message}`),
    )

    // 2026-06-02 — RESIDENT_PIN sync. Mieszkańcy mogli zmienić PIN-y gdy Edge
    // był offline; przy reconnect Edge dostaje pełen aktualny stan żeby
    // klawiatura Akuvox mogła ich autoryzować.
    this.pushResidentPinSync(buildingId, ws).catch((err) =>
      this.logger.warn(`RESIDENT_PIN_SYNC_ALL push failed [${deviceId}]: ${err.message}`),
    )

    // 2026-07-08 — GUEST PIN sync z ograniczeniami dostępu. Dotąd delty
    // (PIN_UPSERT/DELETE) szły przez outbox-replay, ale pełen stan przy
    // reconnect domyka drift (ograniczenia + snapshot użyć portalowych —
    // Edge liczy limity offline jako lokalne PIN/LPR + portalUses z Cloud).
    this.pushGuestPinSync(buildingId, ws).catch((err) =>
      this.logger.warn(`PIN_SYNC_ALL push failed [${deviceId}]: ${err.message}`),
    )

    this.startPing(deviceId)

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        this.handleMessage(deviceId, buildingId, msg)
      } catch {
        this.logger.warn(`Invalid message from ${deviceId}`)
      }
    })

    ws.on('close', () => {
      this.connections.delete(deviceId)
      this.logger.log(`Edge disconnected: ${deviceId}`)
    })

    ws.on('error', (err: Error) => {
      this.logger.error(`Edge error [${deviceId}]: ${err.message}`)
    })
  }

  // ── Handle incoming message from Edge ────────────────────────────────────────
  private async handleMessage(deviceId: string, buildingId: number, msg: any) {
    const conn = this.connections.get(deviceId)
    if (conn) conn.lastSeen = new Date()

    switch (msg.type) {
      case 'PONG':
        break

      case 'STATUS':
        this.logger.debug(
          `Status from ${deviceId}: uptime=${msg.uptime}s queue=${msg.queueSize}`,
        )
        // FAZA f (2026-06-02): cache w connections Map żeby Integrator
        // dashboard mógł odczytać uptime/queueSize/version bez HTTP fetch.
        if (conn) {
          const uptimeNum = typeof msg.uptime === 'number' ? msg.uptime : null
          const queueNum  = typeof msg.queueSize === 'number' ? msg.queueSize : null
          const verStr    = typeof msg.version === 'string' ? msg.version : null
          conn.lastStatus = {
            uptime: uptimeNum,
            queueSize: queueNum,
            version: verStr,
            ts: Date.now(),
          }
          if (verStr) conn.version = verStr
        }
        await this.edge.touch(deviceId, undefined, msg.version)
        break

      case 'EVT':
        // Miniatury obsługujemy PRZED logowaniem — lecą często (galeria
        // odczytów) i zaśmiecałyby log jedną linią na każde zdjęcie.
        if (msg.event === 'LPR_SNAPSHOT_DATA') {
          this.handleSnapshotData(msg.data ?? {})
          break
        }
        this.logger.log(`Event from ${deviceId}: ${msg.event}`)
        // Route LPR_READ events to the reads service (fire-and-forget; errors
        // are logged inside the service — never crash the WS handler).
        if (msg.event === 'LPR_READ') {
          const svc = this.getLprReads()
          if (svc) {
            svc.recordRead(buildingId, msg.data ?? {}).catch((err) =>
              this.logger.warn(`LPR_READ persist failed [${deviceId}]: ${err.message}`),
            )
          }
        }
        // Faza 2D: Edge zgłasza, że ktoś otworzył domofon kodem zaproszenia.
        // Re-walidujemy PIN po stronie Cloud (defense-in-depth — Edge mógł
        // zostać skompromitowany / mieć stale `guest_pins`) i jeśli pasuje
        // — odpalamy `markFirstUse` (push do mieszkańca + usedAt).
        if (msg.event === 'GUEST_PIN_USED') {
          const svc = this.getGuestsValidation()
          if (svc) {
            const pin = String(msg.data?.pin ?? '')
            svc.validatePin(buildingId, pin).catch((err) =>
              this.logger.warn(`GUEST_PIN_USED handle failed [${deviceId}]: ${err.message}`),
            )
          }
        }
        // 2026-07-08 — zliczanie limitowanych otwarć gościa. Edge raportuje
        // każde FAKTYCZNE otwarcie (PIN/LPR) z dedup uuid — INSERT z
        // ON CONFLICT DO NOTHING jest idempotentny przy retry z offline queue.
        if (msg.event === 'GUEST_ACCESS_USED') {
          const d = msg.data ?? {}
          const guestId = Number(d.guestId ?? 0)
          const source = d.source === 'LPR' ? 'LPR' : 'PIN'
          const apId = Number.isFinite(Number(d.accessPointId)) && Number(d.accessPointId) > 0
            ? Number(d.accessPointId)
            : null
          const useId = typeof d.useId === 'string' && d.useId.length <= 64 ? d.useId : null
          if (guestId > 0) {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { PrismaService } = require('../prisma/prisma.service')
            let prismaSvc: any
            try {
              prismaSvc = this.moduleRef.get(PrismaService, { strict: false })
            } catch { prismaSvc = null }
            if (prismaSvc) {
              prismaSvc.$executeRaw`
                INSERT INTO "guest_access_uses"
                  ("buildingId", "guestId", "accessPointId", "source", "dedupKey", "ts")
                VALUES (${buildingId}, ${guestId}, ${apId}, ${source}, ${useId},
                        ${d.ts ? new Date(Number(d.ts)) : new Date()})
                ON CONFLICT ("dedupKey") DO NOTHING
              `.catch((e: Error) =>
                this.logger.warn(`GUEST_ACCESS_USED persist failed [${deviceId}]: ${e.message}`),
              )
            }
          }
        }
        // 2026-07-08 — odmowa ograniczeń gościa na Edge (OUT_OF_SCHEDULE /
        // USES_EXHAUSTED / AP_NOT_ALLOWED) → audit w access_events, spójnie
        // z Cloud-owymi odmowami portalu i PIN (EXPIRED/INACTIVE).
        if (msg.event === 'GUEST_ACCESS_DENIED') {
          const d = msg.data ?? {}
          const guestId = Number(d.guestId ?? 0)
          const reason = String(d.reason ?? '')
          const source = d.source === 'LPR' ? 'LPR' : 'PIN'
          const apId = Number.isFinite(Number(d.accessPointId)) && Number(d.accessPointId) > 0
            ? Number(d.accessPointId)
            : null
          if (guestId > 0 && ['OUT_OF_SCHEDULE', 'USES_EXHAUSTED', 'AP_NOT_ALLOWED'].includes(reason)) {
            const svcAe = this.getAccessEvents()
            if (svcAe) {
              svcAe.record({
                buildingId,
                type: source === 'LPR' ? 'LPR_MATCH' : 'PIN_USED',
                accessPointId: apId,
                gateOpened: false,
                reason,
                guestId,
                plate: typeof d.plate === 'string' ? d.plate : null,
                openedById: null,
                openedByType: 'EDGE',
              }).catch((e: Error) =>
                this.logger.warn(`GUEST_ACCESS_DENIED audit failed [${deviceId}]: ${e.message}`),
              )
            }
          }
        }
        // 2026-05-24 — Fall detection Etap 3. Edge wysyła po wykryciu upadku
        // (YOLOv8-pose + heurystyka geometryczna). Cloud persyst-uje
        // w `anomaly_events` + triggeruje push do BA/Konsjerża + opt-in
        // mieszkańców (`Resident.notifyAnomalies=true`).
        //
        // Payload: { cameraDeviceId, ts, anomalyType: 'FALL', likelihood,
        //            indicators: [...], imageFilename? }
        // FAZA d (2026-06-02) — Edge zgłasza nową wizytę kuriera. Cloud
        // tworzy CourierVisit PENDING + broadcastuje push do mieszkańców
        // ('Kurier kod XXXX — wpuścić?'). Mieszkaniec klika 'Wpuść' →
        // POST /resident/courier-visits/accept/:id → Cloud AP_TEST_FIRE.
        if (msg.event === 'COURIER_VISIT_NEW') {
          const svc = this.getCourierVisits()
          if (svc) {
            const d = msg.data ?? {}
            const code = String(d.code ?? '')
            if (!/^\d{4}$/.test(code)) {
              this.logger.warn(`COURIER_VISIT_NEW z ${deviceId} ma niepoprawny kod "${code}" — ignoruję`)
            } else {
              svc.recordNewVisit(buildingId, code, {
                courierBrand: typeof d.courierBrand === 'string' ? d.courierBrand : null,
                mac: typeof d.mac === 'string' ? d.mac : undefined,
              }).catch((err: Error) =>
                this.logger.warn(`COURIER_VISIT_NEW handle failed [${deviceId}]: ${err.message}`),
              )
            }
          }
        }
        // FAZA 8.g (2026-06-03) — wynik testu połączenia AI Engine.
        // Edge wysyła po każdym AI_ENGINE_TEST command. Zapisujemy do
        // `ai_engines.lastTest*` żeby BA/Integrator widzieli "Ostatni test: X
        // temu, OK 47ms" bez czekania na live response (frontend polluje GET).
        if (msg.event === 'AI_ENGINE_TEST_RESULT') {
          const d = msg.data ?? {}
          const ok = Boolean(d.ok)
          const ms = typeof d.ms === 'number' ? Math.round(d.ms) : null
          const statusCode = typeof d.statusCode === 'number' ? d.statusCode : null
          const err = typeof d.error === 'string' ? d.error : null
          // Raw SQL — Prisma Client może jeszcze nie znać `ai_engines` przed
          // `prisma generate`; raw zapisuje niezawodnie.
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { PrismaService } = require('../prisma/prisma.service')
          const prismaSvc = this.moduleRef.get(PrismaService, { strict: false })
          if (prismaSvc) {
            prismaSvc.$executeRaw`
              UPDATE "ai_engines"
                 SET "lastTestAt" = CURRENT_TIMESTAMP,
                     "lastTestOk" = ${ok},
                     "lastTestMs" = ${ms},
                     "lastTestErr" = ${err},
                     "lastTestCode" = ${statusCode},
                     "updatedAt" = CURRENT_TIMESTAMP
               WHERE "buildingId" = ${buildingId}
            `.catch((e: Error) =>
              this.logger.warn(`AI_ENGINE_TEST_RESULT persist failed [${deviceId}]: ${e.message}`),
            )
          }
        }
        // FAZA 8.h.8 (2026-06-08) — wynik testu Ollama LLM z availableModels.
        // Edge wysyła po LLM_TEST command. Zapisujemy `llmLastTest*` +
        // `llmAvailableModels` (JSONB) żeby UI mogło pokazać listę faktycznie
        // zainstalowanych modeli (vs presety które mogą NIE być pulled).
        if (msg.event === 'LLM_TEST_RESULT') {
          const d = msg.data ?? {}
          const ok = Boolean(d.ok)
          const ms = typeof d.ms === 'number' ? Math.round(d.ms) : null
          const statusCode = typeof d.statusCode === 'number' ? d.statusCode : null
          const err = typeof d.error === 'string' ? d.error : null
          const availableModels = Array.isArray(d.availableModels)
            ? d.availableModels.filter((m: unknown): m is string => typeof m === 'string')
            : []
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { PrismaService } = require('../prisma/prisma.service')
          const prismaSvc = this.moduleRef.get(PrismaService, { strict: false })
          if (prismaSvc) {
            prismaSvc.$executeRaw`
              UPDATE "ai_engines"
                 SET "llmLastTestAt" = CURRENT_TIMESTAMP,
                     "llmLastTestOk" = ${ok},
                     "llmLastTestMs" = ${ms},
                     "llmLastTestErr" = ${err},
                     "llmLastTestCode" = ${statusCode},
                     "llmAvailableModels" = ${JSON.stringify(availableModels)}::jsonb,
                     "updatedAt" = CURRENT_TIMESTAMP
               WHERE "buildingId" = ${buildingId}
            `.catch((e: Error) =>
              this.logger.warn(`LLM_TEST_RESULT persist failed [${deviceId}]: ${e.message}`),
            )
          }
        }

        // FAZA 8.h.6 (2026-06-05) — Edge raportuje swój AI Engine config
        // do Cloud przy każdym reconnect (i po PUT z Edge UI). Cloud robi
        // INSERT ON CONFLICT DO NOTHING — user-set z Cloud Integrator panel
        // ZAWSZE wygrywa (gdy row już istnieje to nic nie zmieniamy).
        // Bez tego Edge auto-migration z env-var YOLO_URL nie jest widoczna
        // w Cloud UI, choć Edge działa.
        if (msg.event === 'AI_ENGINE_REPORT') {
          const d = msg.data ?? {}
          const url = String(d.url ?? '').trim()
          const healthPath = String(d.healthPath ?? '/health')
          const model = String(d.model ?? 'yolov8n')
          const enabled = d.enabled !== false
          // FAZA 8.h.7 — LLM fields w raporcie
          const llmUrl = typeof d.llmUrl === 'string' && d.llmUrl.trim() ? d.llmUrl.trim() : null
          const llmModel = typeof d.llmModel === 'string' && d.llmModel.trim() ? d.llmModel.trim() : 'qwen2.5:14b'
          const llmEnabled = d.llmEnabled !== false
          if (!url || !/^https?:\/\//.test(url)) {
            this.logger.warn(`AI_ENGINE_REPORT z ${deviceId}: invalid url — ignoruję`)
          } else {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { PrismaService } = require('../prisma/prisma.service')
            const prismaSvc = this.moduleRef.get(PrismaService, { strict: false })
            if (prismaSvc) {
              // ON CONFLICT (buildingId) DO NOTHING — user-set wins (Cloud
              // Integrator panel ZAWSZE wygrywa, Edge raport tylko gdy
              // Cloud DB pusty — np. po świeżym deploy lub auto-migracja env).
              prismaSvc.$executeRaw`
                INSERT INTO "ai_engines"
                  ("buildingId", "url", "healthPath", "model", "enabled",
                   "llmUrl", "llmModel", "llmEnabled",
                   "createdAt", "updatedAt")
                VALUES
                  (${buildingId}, ${url}, ${healthPath}, ${model}, ${enabled},
                   ${llmUrl}, ${llmModel}, ${llmEnabled},
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ON CONFLICT ("buildingId") DO NOTHING
              `.then((rows: number) => {
                if (rows > 0) {
                  this.logger.log(`AI_ENGINE_REPORT [b#${buildingId}]: synced from Edge (yolo=${url} llm=${llmUrl})`)
                }
                // rows=0 = już było, Cloud user-set wygrywa
              }).catch((e: Error) =>
                this.logger.warn(`AI_ENGINE_REPORT persist failed [${deviceId}]: ${e.message}`),
              )
            }
          }
        }
        // 2026-09-01 — potwierdzony przez VLM upadek → push krytyczny do
        // wszystkich mieszkańców budynku. Edge wysyła TYLKO po pozytywnej
        // bramce VLM (fałszywe alarmy zostają w feedzie Zdarzeń bez pusha).
        if (msg.event === 'SITUATION_ALERT') {
          const push = this.getPush()
          const d = msg.data ?? {}
          const title = String(d.title ?? '').slice(0, 120)
          const body = String(d.body ?? '').slice(0, 400)
          if (push && title && body) {
            push.sendToBuilding(buildingId, title, body, {
              type: 'situation-alert',
              kind: String(d.kind ?? ''),
              ts: Number(d.ts ?? Date.now()),
            }).catch((e: Error) =>
              this.logger.warn(`SITUATION_ALERT push failed [${deviceId}]: ${e.message}`),
            )
            this.logger.warn(`SITUATION_ALERT b${buildingId}: ${title}`)
          }
        }
        if (msg.event === 'ANOMALY_DETECTED') {
          const svc = this.getAnomalyEvents()
          if (svc) {
            const d = msg.data ?? {}
            const cameraDeviceId = String(d.cameraDeviceId ?? '')
            const anomalyType = String(d.anomalyType ?? '')
            const likelihood = Number(d.likelihood ?? 0)
            const indicators = Array.isArray(d.indicators)
              ? d.indicators.filter((x: any) => typeof x === 'string')
              : []
            const tsMs = Number(d.ts ?? Date.now())
            const imageFilename = typeof d.imageFilename === 'string' ? d.imageFilename : null
            if (!cameraDeviceId || !anomalyType) {
              this.logger.warn(`ANOMALY_DETECTED z ${deviceId} bez cameraDeviceId/anomalyType — ignoruję`)
            } else {
              svc.recordFromEdge({
                buildingId,
                cameraDeviceId,
                ts: new Date(tsMs),
                type: anomalyType,
                likelihood,
                indicators,
                imageFilename,
              }).catch((err: Error) =>
                this.logger.warn(`ANOMALY_DETECTED persist failed [${deviceId}]: ${err.message}`),
              )
            }
          }
        }
        // ── Domofon: SIP↔WebRTC call bridge (2026-06-13) ──────────────────
        // Za flagą INTERCOM_CALL_ENABLED — gating w IntercomCallService.enabled.
        // docs/intercom-akuvox-call.md.
        if (msg.event === 'INTERCOM_CALL_INVITE') {
          const svc = this.getIntercomCalls()
          if (svc) {
            const d = msg.data ?? {}
            if (!d.sessionId) {
              this.logger.warn(`INTERCOM_CALL_INVITE z ${deviceId} bez sessionId — ignoruję`)
            } else {
              svc.handleInvite(buildingId, {
                sessionId: String(d.sessionId),
                intercomDeviceId: typeof d.intercomDeviceId === 'string' ? d.intercomDeviceId : deviceId,
                intercomName: typeof d.intercomName === 'string' ? d.intercomName : undefined,
                unitId: typeof d.unitId === 'number' ? d.unitId : undefined,
                unitLabel: typeof d.unitLabel === 'string' ? d.unitLabel : undefined,
                residentIds: Array.isArray(d.residentIds)
                  ? d.residentIds.filter((x: unknown): x is number => typeof x === 'number')
                  : [],
                snapshotUrl: typeof d.snapshotUrl === 'string' ? d.snapshotUrl : undefined,
                // Hint przycisku panelu → konkretny lokal (routing D2). Edge
                // mapuje SIP extension/relayIndex na unitId gdy domofon klatkowy.
                buttonUnitId: typeof d.buttonUnitId === 'number' ? d.buttonUnitId : undefined,
                // Numer wybrany z książki Akuvoxa (Remote Phonebook) → Cloud
                // mapuje na units.number i routuje punktowo do tego lokalu.
                dialedExtension: typeof d.dialedExtension === 'string' ? d.dialedExtension : undefined,
              }).catch((err: Error) =>
                this.logger.warn(`INTERCOM_CALL_INVITE handle failed [${deviceId}]: ${err.message}`),
              )
            }
          }
        }
        if (msg.event === 'INTERCOM_SIGNAL') {
          const svc = this.getIntercomCalls()
          if (svc) {
            const d = msg.data ?? {}
            // Tylko sygnały Edge→app buforujemy (from:'edge') do SSE.
            if (d.sessionId && (d.kind === 'offer' || d.kind === 'answer' || d.kind === 'ice')) {
              svc.bufferSignalForApp({
                sessionId: String(d.sessionId),
                kind: d.kind,
                sdp: typeof d.sdp === 'string' ? d.sdp : undefined,
                candidate: d.candidate && typeof d.candidate === 'object' ? d.candidate : undefined,
                from: 'edge',
              })
            }
          }
        }
        if (msg.event === 'INTERCOM_CALL_ENDED') {
          const svc = this.getIntercomCalls()
          if (svc) {
            const d = msg.data ?? {}
            if (d.sessionId) {
              svc.handleEnded(String(d.sessionId), String(d.endReason ?? 'ANSWERED_HANGUP'))
                .catch((err: Error) =>
                  this.logger.warn(`INTERCOM_CALL_ENDED handle failed [${deviceId}]: ${err.message}`),
                )
            }
          }
        }
        // Multi-station (2026-07-05): Janus (1 handle SIP) odrzucił drugie,
        // równoległe wywołanie z innej stacji (486 Busy → missed_call). Sesja
        // nie powstaje (gość słyszy zajętość) — logujemy dla audytu instalatora.
        if (msg.event === 'INTERCOM_STATION_BUSY') {
          const d = msg.data ?? {}
          this.logger.warn(
            `INTERCOM_STATION_BUSY [b#${buildingId}] from=${d.fromUri ?? '?'} — ` +
              `równoległe wywołanie odrzucone (most zajęty)`,
          )
        }
        break

      case 'ACK':
        this.logger.debug(`ACK from ${deviceId}: cmd=${msg.id} success=${msg.success}`)
        // Faza 7.6 — Edge zwraca message-id które wysłaliśmy w CMD. Mark
        // delivered w outbox-ie. Jeśli to legacy id (8-char random sprzed
        // 7.6) — markDelivered cicho zignoruje (P2025).
        if (typeof msg.id === 'string' && msg.id.length > 0) {
          if (msg.success === false) {
            this.outbox.markAttempted(msg.id, msg.error ?? 'edge NACK').catch(() => {/* */})
          } else {
            this.outbox.markDelivered(msg.id).catch(() => {/* */})
          }
        }
        break

      // ── Faza B-2 (wizard): Edge → Cloud sync urządzeń ───────────────────
      //
      // DEVICE_UPSERT  { deviceUuid, type, driverId?, config } — pojedyncze
      //   urządzenie dodane/zmienione w wizardzie. Sanityzujemy hasło (NIE
      //   przechowujemy plain-text w Cloud — Edge sqlite jest source of truth).
      // DEVICE_DELETE  { deviceUuid } — usunięcie.
      // DEVICE_SYNC_ALL { devices: [...] } — pełna lista przy reconnect WS;
      //   triggeruje upsert+cleanup brakujących.
      case 'DEVICE_UPSERT':
        // `msg.type` to discriminator wiadomości ("DEVICE_UPSERT"), `msg.deviceType`
        // to typ urządzenia (INTERCOM/CAMERA/SWITCH/...) — patrz tunnel.types.ts.
        if (!msg.deviceUuid || !msg.deviceType) {
          this.logger.warn(`DEVICE_UPSERT z ${deviceId} bez deviceUuid/deviceType — ignoruję`)
          break
        }
        this.edge.mirrorUpsertDevice({
          buildingId,
          edgeDeviceId: deviceId,
          deviceUuid: msg.deviceUuid,
          type: msg.deviceType,
          driverId: this.resolveDriverId(msg.deviceType, msg.driverId, msg.config),
          config: this.sanitizeDeviceConfig(msg.config ?? {}),
        }).catch((err) =>
          this.logger.warn(`DEVICE_UPSERT persist failed [${deviceId}]: ${err.message}`),
        )
        break

      case 'DEVICE_DELETE':
        if (!msg.deviceUuid) {
          this.logger.warn(`DEVICE_DELETE z ${deviceId} bez deviceUuid — ignoruję`)
          break
        }
        this.edge.mirrorDeleteDevice({
          buildingId,
          deviceUuid: msg.deviceUuid,
        }).catch((err) =>
          this.logger.warn(`DEVICE_DELETE failed [${deviceId}]: ${err.message}`),
        )
        break

      case 'DEVICE_SYNC_ALL':
        if (!Array.isArray(msg.devices)) {
          this.logger.warn(`DEVICE_SYNC_ALL z ${deviceId} bez devices[] — ignoruję`)
          break
        }
        this.edge.mirrorSyncAll({
          buildingId,
          edgeDeviceId: deviceId,
          devices: msg.devices.map((d: any) => {
            const type = d.deviceType ?? d.type  // tolerujemy oba klucze (legacy)
            return {
              deviceUuid: d.deviceUuid ?? d.deviceId,
              type,
              driverId: this.resolveDriverId(type, d.driverId, d.config),
              config: this.sanitizeDeviceConfig(d.config ?? {}),
            }
          }).filter((d: any) => d.deviceUuid && d.type),
        }).then((r) =>
          this.logger.log(`SYNC_ALL [${deviceId}]: ${r.upserted} upserted, ${r.deleted} deleted`)
        ).catch((err) =>
          this.logger.warn(`DEVICE_SYNC_ALL failed [${deviceId}]: ${err.message}`),
        )
        break

      default:
        this.logger.warn(`Unknown message type from ${deviceId}: ${msg.type}`)
    }
  }

  /**
   * Sanityzacja configu urządzenia PRZED zapisem do Cloud Postgres.
   *
   * Source of truth dla haseł = Edge sqlite. W Cloud trzymamy tylko meta
   * (IP, model, manufacturer, role) — wystarcza do listy w panelu BA.
   * Hasła do urządzeń (Akuvox/Hik admin password, Shelly digest pass, ...)
   * NIE są wysyłane do chmury — zostają lokalnie na Edge.
   *
   * Jeśli admin chce poprawić hasło, robi to przez wizard na Edge `/ui/wizard`,
   * nie przez Cloud panel.
   */
  /**
   * Rozwiązuje driverId dla mirror-a. Edge wysyła `driverId` jeśli config to ma,
   * ale legacy configi w Edge sqlite (sprzed Fazy 2) mogą go nie zawierać —
   * zostały utworzone gdy katalog driverów jeszcze nie istniał. Zgadujemy
   * driverId po `manufacturer + model` przez `guessDriverId` z device-drivers.
   *
   * Bez tego BA panel pokazuje „driver = -" i certyfikacja jako „untested".
   */
  private resolveDriverId(
    deviceType: string | undefined,
    explicitDriverId: string | undefined | null,
    config: Record<string, any> | undefined,
  ): string | null {
    if (typeof explicitDriverId === 'string' && explicitDriverId.length > 0) {
      return explicitDriverId
    }
    if (!deviceType) return null
    return guessDriverId(deviceType as DeviceType, {
      manufacturer: typeof config?.manufacturer === 'string' ? config.manufacturer : undefined,
      model:        typeof config?.model        === 'string' ? config.model        : undefined,
    })
  }

  private sanitizeDeviceConfig(config: Record<string, any>): Record<string, any> {
    const SENSITIVE_KEYS = new Set([
      'password',
      'rtspPassword',
      'sipPassword',
      'personalAccessKey',  // Tedee (gdyby kiedyś wszedł — dziś driver wyrejestrowany)
      'token',
      'apiKey',
      'apiToken',           // Nuki Web API (SMART_LOCK, 2026-07-08) — token żyje tylko na Edge
      'secret',
    ])
    const sanitized: Record<string, any> = {}
    for (const [k, v] of Object.entries(config)) {
      if (SENSITIVE_KEYS.has(k)) {
        // Zapisujemy tylko flagę „is set" — UI panelu pokaże „••••••••" jeśli true
        sanitized[`${k}IsSet`] = !!v
        continue
      }
      sanitized[k] = v
    }
    return sanitized
  }

  // ── Send command to Edge device ───────────────────────────────────────────────
  //
  // Faza 7.6 — wszystkie wywołania persistują się przez outbox PRZED WS.send,
  // więc przy reconnect lub lost ACK, retry-cron dostarczy. ID outbox-row
  // jest jednocześnie WS message-id; ACK z tego id → markDelivered.
  //
  // Caller (BA service, GuestService etc.) zachowuje semantykę fire-and-forget
  // — sygnatura wraca void/Promise<void>. Błąd w outbox (np. DB down) jest
  // logowany ale NIE blokuje sendingu — fallback to legacy behaviour (random id).
  // To jest defense-in-depth: lepiej wysłać bez persistencji niż w ogóle nie
  // wysłać.
  // ── Miniatury odczytów LPR przez tunel ──────────────────────────────────────

  /** Oczekujące żądania miniatur: requestId → rozstrzygnięcie obietnicy. */
  private readonly pendingSnapshots = new Map<
    string,
    { resolve: (buf: Buffer | null) => void; timer: NodeJS.Timeout }
  >()

  /**
   * Limit jednoczesnych żądań miniatur NA CAŁY system.
   *
   * ⚠️ Tunel przenosi także polecenia otwarcia bramy. Nawet przy zmniejszonych
   * obrazach (~25 KB) galeria z kilkudziesięcioma miniaturami mogłaby zająć
   * kanał na długo. Trzy równoczesne żądania to kompromis: panel ładuje się
   * płynnie, a polecenie otwarcia nigdy nie czeka dłużej niż jedną miniaturę.
   */
  private snapshotInFlight = 0
  private static readonly SNAPSHOT_MAX_INFLIGHT = 3

  /**
   * Pobiera miniaturę odczytu tablicy PRZEZ TUNEL — bez łączenia się do Edge.
   *
   * Edge stoi za NAT-em i łączy się wychodząco, więc droga „chmura → Edge"
   * działa tylko przy dodatkowej sieci VPN. Gdy ta padnie, miniatury znikają
   * po cichu (tak było przez 8 dni, 2026-08-07). Tunel istnieje zawsze, gdy
   * Edge jest online — dlatego to on jest teraz drogą podstawową.
   *
   * Zwraca `null` gdy Edge offline, brak zdjęcia albo przekroczono czas —
   * wołający ma wtedy fallback na starą drogę HTTP.
   */
  async requestLprSnapshot(
    buildingId: number,
    edgeReadId: number,
    maxWidth = 480,
    timeoutMs = 8000,
  ): Promise<Buffer | null> {
    if (this.snapshotInFlight >= EdgeGateway.SNAPSHOT_MAX_INFLIGHT) return null

    // Edge tego budynku, który jest ONLINE — offline nie ma sensu pytać.
    const entry = [...this.connections.entries()].find(
      ([, c]) => c.buildingId === buildingId && c.ws.readyState === WebSocket.OPEN,
    )
    if (!entry) return null
    const [deviceId, conn] = entry

    const requestId = `snap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    this.snapshotInFlight++

    return new Promise<Buffer | null>((resolve) => {
      const done = (buf: Buffer | null) => {
        this.snapshotInFlight--
        this.pendingSnapshots.delete(requestId)
        resolve(buf)
      }
      const timer = setTimeout(() => done(null), timeoutMs)
      this.pendingSnapshots.set(requestId, { resolve: done, timer })

      try {
        // Świadomie POMIJAMY outbox: miniatura ma sens tylko teraz. Zapisanie
        // jej do kolejki oznaczałoby, że Edge po powrocie online wysyła zdjęcie,
        // na które nikt już nie czeka.
        conn.ws.send(JSON.stringify({
          type: 'CMD', id: requestId, action: 'LPR_SNAPSHOT_GET',
          payload: { requestId, edgeReadId, maxWidth },
        }))
      } catch {
        clearTimeout(timer)
        done(null)
      }
    })
  }

  /** Odbiór miniatury z Edge — dopina do oczekującego żądania. */
  private handleSnapshotData(data: any) {
    const requestId = String(data?.requestId ?? '')
    const pending = this.pendingSnapshots.get(requestId)
    if (!pending) return          // spóźniona odpowiedź — żądanie już wygasło
    clearTimeout(pending.timer)
    if (data?.ok && typeof data.base64 === 'string') {
      pending.resolve(Buffer.from(data.base64, 'base64'))
    } else {
      pending.resolve(null)
    }
  }

  async sendCommand(
    deviceId: string,
    buildingId: number,
    action: string,
    payload?: Record<string, any>,
  ): Promise<void> {
    let outboxId: string | null = null
    try {
      outboxId = await this.outbox.enqueueForDevice(buildingId, deviceId, action, payload ?? {})
    } catch (err: any) {
      this.logger.warn(`outbox.enqueue failed [${deviceId}] ${action}: ${err?.message ?? err}`)
    }
    const conn = this.connections.get(deviceId)
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return
    const id = outboxId ?? Math.random().toString(36).slice(2, 10)
    conn.ws.send(JSON.stringify({ type: 'CMD', id, action, payload }))
    if (outboxId) {
      this.outbox.markAttempted(outboxId).catch(() => {/* noop */})
    }
  }

  // ── Broadcast to all Edge devices of a building ───────────────────────────────
  //
  // Faza 7.6 — broadcast przechodzi przez outbox PER device (1 row na każdy
  // znany Edge w budynku, nie tylko online). Offline Edge dostają WS przy
  // reconnect dzięki replayowi z outbox-a.
  async sendToBuilding(
    buildingId: number,
    action: string,
    payload?: Record<string, any>,
  ): Promise<void> {
    let outboxRows: { edgeDeviceId: string; outboxId: string }[] = []
    try {
      outboxRows = await this.outbox.enqueueForBuilding(buildingId, action, payload ?? {})
    } catch (err: any) {
      this.logger.warn(`outbox.enqueueForBuilding failed [${buildingId}] ${action}: ${err?.message ?? err}`)
    }
    // Wysyłka WS — tylko dla online Edge. Offline mają row pending i czekają.
    for (const row of outboxRows) {
      const conn = this.connections.get(row.edgeDeviceId)
      if (conn && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(JSON.stringify({ type: 'CMD', id: row.outboxId, action, payload }))
        this.outbox.markAttempted(row.outboxId).catch(() => {/* noop */})
      }
    }
    // Fallback dla edge case-u: outbox failed (DB down) — legacy fire-and-forget
    // żeby przynajmniej coś się stało.
    if (outboxRows.length === 0) {
      for (const [, conn] of this.connections) {
        if (conn.buildingId === buildingId && conn.ws.readyState === WebSocket.OPEN) {
          const id = Math.random().toString(36).slice(2, 10)
          conn.ws.send(JSON.stringify({ type: 'CMD', id, action, payload }))
        }
      }
    }
  }

  // ── Online status ─────────────────────────────────────────────────────────────
  isOnline(deviceId: string): boolean {
    const conn = this.connections.get(deviceId)
    return !!conn && conn.ws.readyState === WebSocket.OPEN
  }

  /**
   * FAZA f (2026-06-02) — ostatni cache-owany STATUS payload z Edge.
   * Zwraca null jeśli Edge nigdy nie wysłał STATUS (np. dopiero co podłączony)
   * albo jest offline. Używane przez Integrator dashboard polling.
   */
  getLastStatus(deviceId: string): {
    uptime: number | null
    queueSize: number | null
    version: string | null
    ts: number
  } | null {
    const conn = this.connections.get(deviceId)
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return null
    return conn.lastStatus ?? null
  }

  /** Zwraca IP live połączenia Edge dla danego budynku (bez zapytania do bazy) */
  getEdgeIpForBuilding(buildingId: number): string | undefined {
    for (const conn of this.connections.values()) {
      if (conn.buildingId === buildingId && conn.ws.readyState === WebSocket.OPEN && conn.remoteIp) {
        return conn.remoteIp
      }
    }
    return undefined
  }

  getOnlineDevices() {
    return [...this.connections.values()].map((c) => ({
      deviceId: c.deviceId,
      buildingId: c.buildingId,
      type: c.type,
      connectedAt: c.connectedAt,
      lastSeen: c.lastSeen,
    }))
  }

  // ── Periodic access-point sync (every 5 min) ─────────────────────────────────
  @Interval(300_000)
  async periodicAccessPointSync() {
    for (const conn of this.connections.values()) {
      if (conn.ws.readyState === WebSocket.OPEN && conn.remoteIp) {
        this.edge.syncAccessPoints(conn.deviceId, conn.buildingId, conn.remoteIp).catch((err) =>
          this.logger.warn(`periodicSync failed [${conn.deviceId}]: ${err.message}`),
        )
      }
    }
  }

  // ── Replay pending outbox po reconnect Edge (Faza 7.6) ──────────────────────
  //
  // Edge został online → wysyłamy wszystko co czeka w outbox-ie. ACK od
  // Edge zaktualizuje deliveredAt; bez ACK cron-retry spróbuje znowu po 60s.
  private async replayPendingForDevice(deviceId: string, ws: WebSocket) {
    const pending = await this.outbox.pendingForDevice(deviceId, 200)
    if (pending.length === 0) return
    this.logger.log(`replay ${pending.length} pending outbox entries for ${deviceId}`)
    for (const entry of pending) {
      if (ws.readyState !== WebSocket.OPEN) break
      ws.send(JSON.stringify({
        type: 'CMD',
        id: entry.id,
        action: entry.action,
        payload: entry.payload,
      }))
      await this.outbox.markAttempted(entry.id).catch(() => {/* */})
    }
  }

  // ── Access Point / Schedule sync (Refactor 2026-06-01) ────────────────────
  //
  // Pełny push stanu access_points + access_point_schedules budynku do Edge.
  // Wywołane przy każdym reconnect (handleConnection). Edge zrobi
  // `apsReplaceAll` + `apsScheduleReplaceAll` — atomicznie nadpisuje lokalny
  // stan.
  //
  // Brak outbox dla SYNC_ALL — to defensive defense-in-depth, pojedynczy
  // delta-edit jest już w outbox-ie przez `pushApUpsertToEdge`/SCHEDULE_UPSERT
  // w BA service. Tutaj baseline na start.
  private async pushAccessPointSync(deviceId: string, buildingId: number, ws: WebSocket) {
    if (ws.readyState !== WebSocket.OPEN) return
    // Lazy resolve PrismaService — EdgeGateway nie ma go w constructor (już
    // i tak hoist-uje moduleRef dla LprReads/GuestsValidation).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PrismaService } = require('../prisma/prisma.service')
    let prisma: any
    try {
      prisma = this.moduleRef.get(PrismaService, { strict: false })
    } catch {
      this.logger.warn('pushAccessPointSync: PrismaService not available')
      return
    }
    if (!prisma) return

    const aps = await prisma.$queryRaw<Array<{
      id: number; buildingId: number; label: string; icon: string;
      isActive: boolean; sortOrder: number;
      deviceId: string; relayIndex: number;
      outputDeviceId: string | null; outputIndex: number | null;
      durationMs: number; scope: string;
      // FAZA c (2026-06-02) — semantyczna kategoria.
      category: string;
    }>>`
      SELECT id, "buildingId", label, icon, "isActive", "sortOrder",
             "deviceId", "relayIndex",
             "outputDeviceId", "outputIndex", "durationMs", scope,
             category
        FROM "access_points"
       WHERE "buildingId" = ${buildingId}
       ORDER BY "sortOrder" ASC, id ASC
    `.catch(() => [] as any[])

    const schedules = await prisma.$queryRaw<Array<{
      id: number; accessPointId: number; cronExpr: string;
      label: string | null; enabled: boolean;
    }>>`
      SELECT s.id, s."accessPointId", s."cronExpr", s.label, s.enabled
        FROM "access_point_schedules" s
        JOIN "access_points" ap ON ap.id = s."accessPointId"
       WHERE ap."buildingId" = ${buildingId}
       ORDER BY s.id ASC
    `.catch(() => [] as any[])

    // FAZA c (2026-06-02) — full sync linków LPR camera → AP. Edge cache w
    // `lpr_camera_ap_links` table; `HikvisionLprService` iteruje po match.
    const lprLinks = await prisma.$queryRaw<Array<{
      id: number; cameraDeviceUuid: string; accessPointId: number;
      direction: string; buildingId: number;
    }>>`
      SELECT id, "cameraDeviceUuid", "accessPointId", direction, "buildingId"
        FROM "lpr_camera_ap_links"
       WHERE "buildingId" = ${buildingId}
       ORDER BY id ASC
    `.catch(() => [] as any[])

    // Fire-and-forget — brak outboxu dla SYNC_ALL (idempotentne, zawsze
    // wysyłane przy reconnect).
    const apId = Math.random().toString(36).slice(2, 10)
    ws.send(JSON.stringify({
      type: 'CMD',
      id: `aps-${apId}`,
      action: 'AP_SYNC_ALL',
      payload: { items: aps },
    }))
    ws.send(JSON.stringify({
      type: 'CMD',
      id: `sch-${apId}`,
      action: 'SCHEDULE_SYNC_ALL',
      payload: { items: schedules },
    }))
    ws.send(JSON.stringify({
      type: 'CMD',
      id: `lpr-link-${apId}`,
      action: 'LPR_AP_LINK_SYNC_ALL',
      payload: { items: lprLinks },
    }))

    // FAZA 8.h.2 (2026-06-05) — pełen sync role + aiAnalysisEnabled per kamera.
    // Defense-in-depth dla migracji backfill SQL które nie przechodzą przez
    // tunel — bez tego Edge może mieć stale role='LPR' a Cloud 'STANDARD'.
    const cams = await prisma.$queryRaw<Array<{
      edgeDeviceId: string; role: string; aiAnalysisEnabled: boolean;
    }>>`
      SELECT "edgeDeviceId", "role", "aiAnalysisEnabled"
        FROM "lpr_cameras"
       WHERE "buildingId" = ${buildingId}
         AND "edgeDeviceId" IS NOT NULL
       ORDER BY id ASC
    `.catch(() => [] as any[])
    ws.send(JSON.stringify({
      type: 'CMD',
      id: `cam-sync-${apId}`,
      action: 'CAMERA_SYNC_ALL',
      payload: {
        items: cams.map((c) => ({
          cameraDeviceId: c.edgeDeviceId,
          role: c.role,
          aiAnalysisEnabled: c.aiAnalysisEnabled,
        })),
      },
    }))

    // FAZA 8.h.25 (2026-06-12) — PLATE_SYNC_ALL przy reconnect. Zamyka lukę
    // z 8.h.24: zgubiony outbox-delivery (PLATE_UPSERT) = wieczny drift
    // lpr_plates vs vehicles aż do ręcznego resync-to-edge. Edge robi
    // replace-all per kamera LPR, więc wysyłamy KOMPLETNY stan whitelisty:
    // APPROVED vehicles (payload jak buildPlateSyncPayload w BA service —
    // kind/tags/unitLabel, owner tylko nie-PII) + aktywni goście z tablicą.
    const plateItems = await this.collectPlateSyncItems(prisma, buildingId)
    ws.send(JSON.stringify({
      type: 'CMD',
      id: `plate-sync-${apId}`,
      action: 'PLATE_SYNC_ALL',
      payload: { items: plateItems },
    }))

    // Multi-station intercom bridge (2026-07-05) — rejestr stacji domofonowych
    // płynie z Cloud (building_intercoms) do Edge (sqlite intercom_bridge).
    // Edge używa go do: (a) mapowania SIP fromUri→edgeDeviceId+nazwa przy
    // INVITE, (b) rozwiązania IP stacji przy outbound, (c) wiedzy które stacje
    // mają aktywny most. Konfiguracja NIGDY nie jest ręczna na Edge — zawsze
    // przez ten sync (reconnect) + live push z integrator service.
    const intercoms = await prisma.$queryRaw<Array<{
      id: number; name: string; edgeDeviceId: string | null;
      ipAddress: string | null; bridgeEnabled: boolean;
    }>>`
      SELECT id, name, "edgeDeviceId", "ipAddress", "bridgeEnabled"
        FROM "building_intercoms"
       WHERE "buildingId" = ${buildingId}
       ORDER BY id ASC
    `.catch(() => [] as any[])
    ws.send(JSON.stringify({
      type: 'CMD',
      id: `intercom-sync-${apId}`,
      action: 'INTERCOM_SYNC_ALL',
      payload: {
        items: intercoms.map((i) => ({
          intercomId: i.id,
          buildingId,
          name: i.name,
          edgeDeviceId: i.edgeDeviceId,
          ipAddress: i.ipAddress,
          bridgeEnabled: i.bridgeEnabled === true,
        })),
      },
    }))

    // 2026-07-30 — BUILDING_CONFIG_UPDATE przy reconnect (wzorzec CAMERA_SYNC_ALL
    // / 8.h.2). Edge zapisuje objectType+features do kv; pierwszy konsument:
    // HikvisionLprService czyta features.exitGrace (przepustka wyjazdowa,
    // docs/exit-grace-pass.md). Bez tego świeżo postawiony / przywrócony Edge
    // nie znałby konfiguracji do czasu pierwszego PATCH-a w panelu.
    const bld = await prisma.$queryRaw<Array<{
      objectType: string | null; features: any;
    }>>`
      SELECT "objectType", features FROM "buildings" WHERE id = ${buildingId} LIMIT 1
    `.catch(() => [] as any[])
    if (bld[0]) {
      ws.send(JSON.stringify({
        type: 'CMD',
        id: `bcfg-${apId}`,
        action: 'BUILDING_CONFIG_UPDATE',
        payload: {
          buildingId,
          objectType: bld[0].objectType,
          features: bld[0].features ?? {},
        },
      }))
    }

    this.logger.log(
      `AP/SCHEDULE/LPR_LINK/CAMERA/PLATE/INTERCOM/BUILDING_CONFIG_SYNC pushed to ${deviceId} ` +
      `(${aps.length} APs, ${schedules.length} schedules, ${lprLinks.length} LPR links, ` +
      `${cams.length} cameras, ${plateItems.length} plates, ${intercoms.length} intercoms)`,
    )
  }

  /**
   * Pełna whitelista tablic budynku dla PLATE_SYNC_ALL (8.h.25).
   *
   * Item shape = `PlateEntry` na Edge (hikvision-lpr.service.ts):
   * `{ plate, owner, kind, tags, unitLabel, validFrom?, validUntil? }`.
   * UWAGA: Edge oczekuje `validUntil`, nie `validTo`.
   *
   * Vehicles: tylko APPROVED. unitLabel liczone jak
   * `BuildingAdminService.computeUnitLabel` (najnowszy aktywny unit_residents
   * pivot → stairwell/number), ale w jednym query przez LATERAL JOIN.
   * tags rozszerzone o serviceName/make/model/color — identycznie jak
   * `buildPlateSyncPayload`. `owner` bez PII: serviceName albo ''.
   *
   * Goście: status ACTIVE, vehiclePlate != null, okno ważności nie minęło.
   * Owner "Gość {name} ({inviter})" — ta sama konwencja co delta-sync
   * w resident/concierge service.
   *
   * Dedup po znormalizowanej tablicy, vehicle wygrywa nad gościem (case
   * WE387YT z 8.h.24: wpis mieszkańca z unit_label > wpis gościa bez) —
   * Edge `lprReplaceAll` robi czysty INSERT, duplikat plate w items
   * wywaliłby transakcję na UNIQUE constraint.
   */
  private async collectPlateSyncItems(prisma: any, buildingId: number): Promise<Array<Record<string, any>>> {
    const vehicles = await prisma.$queryRaw<Array<{
      licensePlate: string; kind: string; serviceName: string | null;
      make: string | null; model: string | null; color: string | null;
      tags: string[]; validFrom: Date | null; validTo: Date | null;
      autoOpen: boolean | null;
      unitNumber: string | null; stairwellName: string | null; unitStreet: string | null;
      ownUnitNumber: string | null; ownStairwellName: string | null; ownUnitStreet: string | null;
    }>>`
      SELECT v."licensePlate", v.kind::text AS kind, v."serviceName",
             v.make, v.model, v.color,
             COALESCE(v.tags, '{}') AS tags,
             v."validFrom", v."validTo",
             v."autoOpen",
             u.number AS "unitNumber", s.name AS "stairwellName", u.street AS "unitStreet",
             ou.number AS "ownUnitNumber", os.name AS "ownStairwellName", ou.street AS "ownUnitStreet"
        FROM "vehicles" v
        -- 2026-09-07: lokal przypisany WPROST do pojazdu (wygrywa nad lokalem mieszkańca)
        LEFT JOIN "units" ou ON ou.id = v."unitId"
        LEFT JOIN "stairwells" os ON os.id = ou."stairwellId"
        LEFT JOIN LATERAL (
          SELECT ur."unitId"
            FROM "unit_residents" ur
           WHERE ur."residentId" = v."residentId"
             AND (ur."untilDate" IS NULL OR ur."untilDate" > NOW())
           ORDER BY ur."sinceDate" DESC
           LIMIT 1
        ) cur ON TRUE
        LEFT JOIN "units" u ON u.id = cur."unitId"
        LEFT JOIN "stairwells" s ON s.id = u."stairwellId"
       WHERE v."buildingId" = ${buildingId}
         AND v.status::text = 'APPROVED'
       ORDER BY v.id ASC
    `.catch(() => [] as any[])

    const guests = await prisma.$queryRaw<Array<{
      id: number; name: string; vehiclePlate: string;
      validFrom: Date | null; validTo: Date | null;
      inviterFirstName: string | null; inviterLastName: string | null;
    }>>`
      SELECT g.id, g.name, g."vehiclePlate", g."validFrom", g."validTo",
             r."firstName" AS "inviterFirstName", r."lastName" AS "inviterLastName"
        FROM "guests" g
        LEFT JOIN "residents" r ON r.id = g."residentId"
       WHERE g."buildingId" = ${buildingId}
         AND g.status::text = 'ACTIVE'
         AND g."vehiclePlate" IS NOT NULL
         AND (g."validTo" IS NULL OR g."validTo" > NOW())
       ORDER BY g.id ASC
    `.catch(() => [] as any[])

    // Klucz dedup — ta sama normalizacja co `normalizePlate` na Edge.
    const normalize = (p: string) => (p ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    const seen = new Set<string>()
    const items: Array<Record<string, any>> = []

    for (const v of vehicles) {
      const key = normalize(v.licensePlate)
      if (!key || seen.has(key)) continue
      seen.add(key)
      const isService = v.kind === 'SERVICE' || v.kind === 'DELIVERY'
      const extraTags: string[] = []
      if (isService && v.serviceName) extraTags.push(v.serviceName)
      if (v.make)  extraTags.push(v.make)
      if (v.model) extraTags.push(v.model)
      if (v.color) extraTags.push(v.color)
      const tags = Array.from(new Set([...extraTags, ...(Array.isArray(v.tags) ? v.tags : [])]))
      // Jawny lokal pojazdu (dowolny kind) > lokal mieszkańca (tylko RESIDENT) —
      // ta sama reguła co BuildingAdminService.vehicleUnitLabel.
      const unitLabel = v.ownUnitNumber
        ? formatUnitLabel({ number: v.ownUnitNumber, street: v.ownUnitStreet, stairwellName: v.ownStairwellName })
        : (v.kind === 'RESIDENT' && v.unitNumber
          ? formatUnitLabel({ number: v.unitNumber, street: v.unitStreet, stairwellName: v.stairwellName })
          : null)
      items.push({
        plate: v.licensePlate,
        owner: isService && v.serviceName ? v.serviceName : '',
        kind: v.kind,
        tags,
        unitLabel,
        // 2026-09-25 — przełącznik mieszkańca (false = rozpoznaj, nie otwieraj).
        autoOpen: v.autoOpen ?? true,
        ...(v.validFrom ? { validFrom: v.validFrom.toISOString() } : {}),
        ...(v.validTo ? { validUntil: v.validTo.toISOString() } : {}),
      })
    }

    for (const g of guests) {
      const key = normalize(g.vehiclePlate)
      if (!key || seen.has(key)) continue
      seen.add(key)
      const inviter = `${g.inviterFirstName ?? ''} ${g.inviterLastName ?? ''}`.trim() || 'mieszkaniec'
      items.push({
        plate: g.vehiclePlate,
        owner: `Gość ${g.name} (${inviter})`,
        kind: 'GUEST',
        // 2026-07-08 — Edge sprawdza po guestId ograniczenia gościa
        // (harmonogram/limit/allowlista AP z guest_pins) przy matchu tablicy.
        guestId: g.id,
        ...(g.validFrom ? { validFrom: g.validFrom.toISOString() } : {}),
        ...(g.validTo ? { validUntil: g.validTo.toISOString() } : {}),
      })
    }

    return items
  }

  // ── Cron retry (1 min) — dla device-ów online z lost ACK-iem ────────────────
  //
  // Reconnect-replay (`replayPendingForDevice`) ratuje 99% przypadków, ale
  // gdy WS dropnie po wysłaniu CMD ale przed ACK (rzadkie — np. zatka się TCP),
  // entry zostaje pending mimo że Edge mógł go zaaplikować. Cron co 60s
  // resend-uje wszystko z `lastAttemptAt < NOW() - 60s` dla online device-ów.
  // Po 10 prób → deadletter (`markAttempted` ustawia `failedAt`).
  @Interval(60_000)
  async retryOutboxPending() {
    const pending = await this.outbox.pendingForRetry({ olderThanMs: 60_000 }, 100)
    if (pending.length === 0) return
    let resent = 0
    for (const entry of pending) {
      if (!entry.edgeDeviceId) continue
      const conn = this.connections.get(entry.edgeDeviceId)
      if (!conn || conn.ws.readyState !== WebSocket.OPEN) continue
      conn.ws.send(JSON.stringify({
        type: 'CMD',
        id: entry.id,
        action: entry.action,
        payload: entry.payload,
      }))
      await this.outbox.markAttempted(entry.id, 'cron retry').catch(() => {/* */})
      resent++
    }
    if (resent > 0) this.logger.log(`outbox retry: resent ${resent} entries`)
  }

  // ── Ping loop (30s) ───────────────────────────────────────────────────────────
  private startPing(deviceId: string) {
    const interval = setInterval(() => {
      const conn = this.connections.get(deviceId)
      if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
        clearInterval(interval)
        return
      }
      conn.ws.send(JSON.stringify({ type: 'PING', ts: Date.now() }))
    }, 30_000)
  }

  // ── Extract Bearer token from request ─────────────────────────────────────────
  private extractToken(req: http.IncomingMessage): string | null {
    const auth = req.headers['authorization']
    if (auth?.startsWith('Bearer ')) return auth.slice(7)
    const url = new URL(req.url ?? '', 'http://localhost')
    return url.searchParams.get('token')
  }

  // ── RESIDENT_PIN sync (2026-06-02) ───────────────────────────────────────────
  /**
   * Pełny sync stałych PIN-ów mieszkańców do Edge po reconnect WS.
   * Edge potrzebuje aktualnej listy do walidacji klawiaturą Akuvox offline.
   * Wysyłamy WSZYSTKICH mieszkańców z `intercomPin != null` per buildingId.
   */
  private async pushResidentPinSync(buildingId: number, ws: WebSocket) {
    if (ws.readyState !== WebSocket.OPEN) return
    // Lazy resolve PrismaService — EdgeGateway nie ma go w constructor (jak
    // pushAccessPointSync). UWAGA: moduleRef.get('PrismaService') po STRING
    // tokenie rzuca "Nest could not find PrismaService element" nawet ze
    // strict:false (provider jest zarejestrowany po klasie, nie po stringu) —
    // a wyjątek leci przed `??` fallback, więc cała synchronizacja PIN-ów
    // failowała na produkcji. Rozwiązujemy po klasie w try/catch.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PrismaService } = require('../prisma/prisma.service')
    let prisma: any
    try {
      prisma = this.moduleRef.get(PrismaService, { strict: false })
    } catch {
      this.logger.warn('pushResidentPinSync: PrismaService not available')
      return
    }
    if (!prisma) {
      this.logger.warn('pushResidentPinSync: PrismaService not available')
      return
    }
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id AS "residentId", "intercomPin" AS pin,
              (COALESCE("firstName", '') || ' ' || COALESCE("lastName", '')) AS "residentName"
         FROM residents
        WHERE "buildingId" = $1 AND "intercomPin" IS NOT NULL`,
      buildingId,
    ) as Array<{ residentId: number; pin: string; residentName: string }>
    const msg = {
      type: 'CMD',
      id: `rpin-${Math.random().toString(36).slice(2, 10)}`,
      action: 'RESIDENT_PIN_SYNC_ALL',
      payload: { items: rows },
      ts: Date.now(),
    }
    ws.send(JSON.stringify(msg))
    this.logger.log(`RESIDENT_PIN_SYNC_ALL pushed: ${rows.length} pins → building ${buildingId}`)
  }

  // ── GUEST PIN sync z ograniczeniami (2026-07-08) ─────────────────────────────
  /**
   * Pełny sync PIN-ów AKTYWNYCH gości do Edge po reconnect WS — z
   * ograniczeniami dostępu (allowedAccessPoints/recurringSchedule) oraz
   * snapshot-em użyć PORTALOWYCH per (gość, AP). Edge robi replace-all
   * `guest_pins` i od tej chwili egzekwuje harmonogram/limity OFFLINE.
   *
   * portalUses zawiera TYLKO source='PORTAL' — użycia PIN/LPR Edge liczy sam
   * (lokalne guest_uses); wysyłanie ich z powrotem zdublowałoby licznik.
   */
  private async pushGuestPinSync(buildingId: number, ws: WebSocket) {
    if (ws.readyState !== WebSocket.OPEN) return
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PrismaService } = require('../prisma/prisma.service')
    let prisma: any
    try {
      prisma = this.moduleRef.get(PrismaService, { strict: false })
    } catch {
      this.logger.warn('pushGuestPinSync: PrismaService not available')
      return
    }
    if (!prisma) {
      this.logger.warn('pushGuestPinSync: PrismaService not available')
      return
    }
    const guests = await prisma.$queryRaw<Array<{
      id: number; pin: string; name: string;
      validFrom: Date | null; validTo: Date | null;
      allowedAccessPoints: any; recurringSchedule: any;
    }>>`
      SELECT id, pin, name, "validFrom", "validTo",
             "allowedAccessPoints", "recurringSchedule"
        FROM "guests"
       WHERE "buildingId" = ${buildingId}
         AND status::text = 'ACTIVE'
         AND ("validTo" IS NULL OR "validTo" > NOW())
       ORDER BY id ASC
    `.catch(() => [] as any[])

    // Snapshot użyć portalowych per (guestId, apId) w jednym query.
    const guestIds = guests.map((g: any) => g.id)
    const usesByGuest = new Map<number, Record<string, number>>()
    if (guestIds.length > 0) {
      const uses = await prisma.$queryRawUnsafe(
        `SELECT "guestId", "accessPointId", COUNT(*)::int AS count
           FROM "guest_access_uses"
          WHERE "guestId" = ANY($1) AND source = 'PORTAL' AND "accessPointId" IS NOT NULL
          GROUP BY "guestId", "accessPointId"`,
        guestIds,
      ).catch(() => [] as any[]) as Array<{ guestId: number; accessPointId: number; count: number }>
      for (const u of uses) {
        const rec = usesByGuest.get(u.guestId) ?? {}
        rec[String(u.accessPointId)] = Number(u.count)
        usesByGuest.set(u.guestId, rec)
      }
    }

    const items = guests.map((g: any) => ({
      pin: g.pin,
      guestId: g.id,
      guestName: g.name,
      ...(g.validFrom ? { validFrom: g.validFrom.toISOString() } : {}),
      ...(g.validTo ? { validUntil: g.validTo.toISOString() } : {}),
      ...(g.allowedAccessPoints ? { allowedAccessPoints: g.allowedAccessPoints } : {}),
      ...(g.recurringSchedule ? { recurringSchedule: g.recurringSchedule } : {}),
      ...(usesByGuest.has(g.id) ? { portalUses: usesByGuest.get(g.id) } : {}),
    }))

    ws.send(JSON.stringify({
      type: 'CMD',
      id: `gpin-${Math.random().toString(36).slice(2, 10)}`,
      action: 'PIN_SYNC_ALL',
      payload: { pins: items },
      ts: Date.now(),
    }))
    this.logger.log(`PIN_SYNC_ALL pushed: ${items.length} guest pins → building ${buildingId}`)
  }
}
