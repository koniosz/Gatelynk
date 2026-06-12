import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Interval } from '@nestjs/schedule'
import * as WebSocket from 'ws'
import { ActivationService } from '../activation/activation.service'
import { StoreService } from '../store/store.service'
import { DeviceRegistryService } from '../devices/device-registry.service'
import { HikvisionLprService } from '../devices/cameras/hikvision-lpr.service'
import { IntercomPinService } from '../devices/intercom/intercom-pin.service'
import { VisionDetectService } from '../devices/cameras/vision-detect.service'
import { VisionLlmSummarizerService } from '../devices/cameras/vision-llm-summarizer.service'
import { SyncService } from '../sync/sync.service'
import { CloudMessage, EdgeMessage, CloudCommand, TunnelAction } from './tunnel.types'
import { EventLogService } from '../event-log/event-log.service'
import { KnowledgeService } from '../knowledge/knowledge.service'
import { AccessPointExecutorService } from '../access-points/access-point-executor.service'

@Injectable()
export class TunnelService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TunnelService.name)
  private ws: WebSocket | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectDelay = 2000
  private readonly maxDelay = 60_000
  private isShuttingDown = false
  private lastPong = Date.now()
  private startTime = Date.now()

  constructor(
    private config: ConfigService,
    private activation: ActivationService,
    private store: StoreService,
    private deviceRegistry: DeviceRegistryService,
    private sync: SyncService,
    private eventLog: EventLogService,
    private lpr: HikvisionLprService,
    private intercomPin: IntercomPinService,
    private knowledge: KnowledgeService,
    private vision: VisionDetectService,
    private llm: VisionLlmSummarizerService,
    // Access Points refactor 2026-06-01 — executor potrzebuje sendEvent
    // (audyt ACCESS_POINT_FIRED), wstrzykujemy lazy w onModuleInit.
    private accessPointExecutor: AccessPointExecutorService,
  ) {}

  onModuleInit() {
    // Wire lazy tunnel senders for services that would otherwise create a
    // circular dependency (they live in modules we import, so we inject them
    // and hand them a bound `sendEvent` fn here).
    const send = this.sendEvent.bind(this)
    this.sync.setTunnelSend(send)
    this.lpr.setTunnelSend(send)
    this.intercomPin.setTunnelSend(send)
    // Access point executor lazy-injectowane (TunnelService > AccessPointsModule),
    // żeby executor mógł audyt-ować ACCESS_POINT_FIRED przez sendEvent.
    this.accessPointExecutor.setTunnelSend(send)
    // LPR + PIN serwisy też dostają lazy executor — Edge routuje przez
    // executor jeśli kamera/intercom mają linkedAccessPointId, fallback do legacy.
    this.lpr.setAccessPointExecutor(this.accessPointExecutor)
    this.intercomPin.setAccessPointExecutor(this.accessPointExecutor)
    // 2026-05-24 — Fall detection emit przez tunnel. Gdy WS down, sendEvent
    // zwraca false → VisionDetectService zapisuje do event_queue → SyncService
    // flush po reconnect.
    this.vision.setTunnelSend(send)
    // Faza B-2: wstrzykujemy push device-config do Cloud mirror.
    // DeviceRegistry woła to po saveDevice/removeDevice (z wizarda).
    this.deviceRegistry.setTunnelPush({
      deviceUpsert: (uuid, type, config, driverId) =>
        this.sendDeviceUpsert(uuid, type, config, driverId),
      deviceDelete: (uuid) => this.sendDeviceDelete(uuid),
    })

    if (this.activation.isActivated()) {
      this.connect()
    } else {
      this.logger.warn('Device not activated — tunnel standby. Activate via POST /activation/activate')
    }
  }

  onModuleDestroy() {
    this.isShuttingDown = true
    this.ws?.close(1000, 'shutdown')
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
  }

  // ── Connect ──────────────────────────────────────────────────────────────────
  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return

    const cloudUrl = this.activation.getCloudUrl()
    const token = this.activation.getToken()
    if (!token) { this.logger.error('No token — cannot connect'); return }

    const wsUrl = cloudUrl.replace(/^http/, 'ws') + '/api/edge/tunnel'
    this.logger.log(`Connecting to ${wsUrl}…`)

    this.ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${token}` },
      handshakeTimeout: 10_000,
    })

    this.ws.on('open', () => {
      this.logger.log('Tunnel connected')
      this.reconnectDelay = 2000
      this.lastPong = Date.now()
      this.eventLog.success('TUNNEL', '🔗 Connected to GateLynk Cloud')
      this.sendStatus()
      // Faza B-2: pełny sync urządzeń po reconnect — Cloud upsertuje wszystko
      // do `edge_device_mirror` i kasuje wpisy nieobecne w naszej liście
      // (defense-in-depth: chwytamy DEVICE_DELETE które wpadło gdy Edge był offline).
      this.sendDeviceSyncAll()
      // Half-open WS recovery: TCP rwie się po cichu (zmiana sieci, drop na
      // NAT-cie, Cloud watchdog) — przez ~90s `ws.readyState` raportuje
      // OPEN, `ws.send()` succeed-uje fire-and-forget, a pakiety lecą w
      // nicość. Edge oznaczał te odczyty jako `synced=1`, mimo że Cloud ich
      // nie zobaczył (luki widać post-mortem porównując `MAX(edgeReadId)` na
      // Edge vs Cloud). Na każdy reconnect distrust-ujemy ostatnie 5 minut
      // synced-stanu i pozwalamy backfill-owi je ponownie wysłać. Cloud-side
      // partial unique index + `ON CONFLICT DO NOTHING` (migracja
      // 20260427120000) deduplikuje zwycięskie odczyty, więc nadmiar to no-op.
      const reset = this.store.lprResetSyncFlagSince(Date.now() - 5 * 60_000)
      if (reset > 0) {
        this.logger.log(`Reset sync flag on ${reset} recent LPR read(s) — re-verifying delivery`)
      }
      // Najpierw event_queue (offline-buffered eventy z `enqueue`), potem
      // backfill LPR_READ z `lpr_reads` (rzędy z `synced_to_cloud=0` — patrz
      // SyncService.backfillUnsyncedLprReads). Cloud-side ON CONFLICT DO
      // NOTHING gwarantuje że duplikaty są no-op.
      this.sync.flush()
      this.sync.backfillUnsyncedLprReads()
    })

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        const msg: CloudMessage = JSON.parse(data.toString())
        this.handleCloudMessage(msg)
      } catch {
        this.logger.warn('Invalid message received')
      }
    })

    this.ws.on('close', (code, reason) => {
      this.logger.warn(`Tunnel closed (${code}): ${reason}`)
      this.eventLog.warn('TUNNEL', `🔌 Disconnected from cloud (code ${code})`)
      this.ws = null
      if (this.isShuttingDown) return

      if (code === 4001) {
        // Token expired or invalid — refresh first, then reconnect
        this.logger.log('Token rejected (4001) — refreshing…')
        this.activation.refreshToken().then((ok) => {
          if (ok) {
            this.logger.log('Token refreshed — reconnecting')
            this.reconnectDelay = 2000
            this.scheduleReconnect()
          } else {
            this.logger.error('Token refresh failed — re-activation required')
          }
        })
      } else {
        this.scheduleReconnect()
      }
    })

    this.ws.on('error', (err) => {
      this.logger.error(`Tunnel error: ${err.message}`)
    })
  }

  // ── Reconnect with exponential backoff ───────────────────────────────────────
  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.logger.log(`Reconnecting in ${this.reconnectDelay / 1000}s…`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxDelay)
      this.connect()
    }, this.reconnectDelay)
  }

  // ── Handle incoming cloud message ─────────────────────────────────────────────
  private async handleCloudMessage(msg: CloudMessage) {
    if (msg.type === 'PING') {
      this.lastPong = Date.now()
      this.send({ type: 'PONG', ts: Date.now() })
      return
    }

    if (msg.type === 'CMD') {
      this.logger.debug(`CMD ${msg.action} [${msg.id}]`)
      this.eventLog.info('TUNNEL', `📨 Command from cloud: ${msg.action}`, { id: msg.id, payload: msg.payload })
      try {
        const result = await this.executeCommand(msg)
        this.send({ type: 'ACK', id: msg.id, success: true, data: result })
        this.eventLog.success('TUNNEL', `✅ Command ${msg.action} executed`, { id: msg.id, result })
      } catch (err: any) {
        this.send({ type: 'ACK', id: msg.id, success: false, error: err.message })
        this.eventLog.error('TUNNEL', `❌ Command ${msg.action} failed: ${err.message}`, { id: msg.id })
      }
    }
  }

  // ── Execute command from cloud ────────────────────────────────────────────────
  private async executeCommand(cmd: CloudCommand): Promise<any> {
    const { action, payload } = cmd

    switch (action as TunnelAction) {
      case 'GET_STATUS':
        return this.buildStatus()

      case 'OPEN_DOOR':
        // Refactor 2026-06-01: jeśli Cloud przekazuje `apId` w payloadzie
        // (Cloud mógł sięgnąć po `outputDeviceId`/`outputIndex` przed wysyłką),
        // routujemy przez AccessPointExecutor — daje to audyt ACCESS_POINT_FIRED
        // z meta o triggerze MANUAL i actorze (resident/admin/concierge).
        // Bez `apId` zostajemy z legacy ścieżką (intercom.execute) — backwards
        // compat dla starych klientów (iOS app, BA test endpointu).
        if (payload && Number.isFinite(payload.apId) && Number(payload.apId) > 0) {
          return this.accessPointExecutor.fire(Number(payload.apId), {
            trigger: 'MANUAL',
            actor: typeof payload.actor === 'string' ? payload.actor : 'CLOUD',
            meta: { source: 'tunnel.OPEN_DOOR', ...(payload.meta ?? {}) },
          })
        }
        return this.deviceRegistry.executeOnDevice('intercom', action, payload)
      case 'CLOSE_DOOR':
        return this.deviceRegistry.executeOnDevice('intercom', action, payload)

      case 'OPEN_GATE':
        return this.deviceRegistry.executeOnDevice('intercom', 'OPEN_GATE', payload)

      // Faza F-2 (2026-05-14): hold-open. Payload `{ deviceId, seconds, doorIndex? }`.
      // Edge symuluje przez cykliczne openDoor — patrz IntercomService.holdOpen.
      case 'HOLD_OPEN':
      case 'CANCEL_HOLD_OPEN':
        return this.deviceRegistry.executeOnDevice('intercom', action, payload)

      case 'ELEVATOR_CALL':
        return this.deviceRegistry.executeOnDevice('elevator', action, payload)

      case 'LIGHTS_ON':
      case 'LIGHTS_OFF':
      case 'LIGHTS_DIM':
        return this.deviceRegistry.executeOnDevice('lighting', action, payload)

      case 'CAMERA_SNAPSHOT':
        return this.deviceRegistry.executeOnDevice('camera', action, payload)

      case 'PLATE_UPSERT':
      case 'PLATE_DELETE':
        return this.deviceRegistry.executeOnDevice('lprCamera', action, payload)

      // FAZA 8.h.25 (2026-06-12) — pełen replace-all whitelisty przy
      // reconnect (wzorzec 8.h.2/CAMERA_SYNC_ALL). lpr_plates jest keyed
      // (camera_device_id, plate), więc replace musi objąć KAŻDĄ kamerę LPR
      // — stary dispatch przez executeOnDevice brał tylko jedną
      // (payload.cameraDeviceId ?? pierwsza zarejestrowana).
      // `payload.plates` zostaje jako legacy alias dla `items`.
      case 'PLATE_SYNC_ALL': {
        const p = payload ?? {}
        const items = Array.isArray(p.items) ? p.items
          : Array.isArray(p.plates) ? p.plates
          : null
        if (!items) throw new Error('Missing items')
        const cameraIds = this.lpr.getDeviceIds()
        for (const cameraDeviceId of cameraIds) {
          await this.lpr.syncAll(cameraDeviceId, items)
        }
        this.logger.log(
          `PLATE_SYNC_ALL: replaced ${items.length} plate(s) on ${cameraIds.length} camera(s)`,
        )
        return { synced: items.length, cameras: cameraIds.length }
      }

      case 'PIN_UPSERT':
        return this.intercomPin.upsertPin(payload ?? {})
      case 'PIN_DELETE':
        return this.intercomPin.deletePin(payload ?? {})
      case 'PIN_SYNC_ALL':
        return this.intercomPin.syncAllPins(payload ?? {})

      // 2026-06-02 — RESIDENT_PIN: stały PIN mieszkańca.
      case 'RESIDENT_PIN_UPSERT': {
        const p = payload ?? {}
        if (typeof p.pin !== 'string' || typeof p.residentId !== 'number') {
          throw new Error('Missing pin/residentId')
        }
        this.store.residentPinUpsert(p.pin, p.residentId, p.residentName ?? null)
        return { upserted: true, pin: p.pin.slice(0, 2) + '***' }
      }
      case 'RESIDENT_PIN_DELETE': {
        const p = payload ?? {}
        if (typeof p.residentId !== 'number') throw new Error('Missing residentId')
        const n = this.store.residentPinDeleteByResident(p.residentId)
        return { deleted: n }
      }
      case 'RESIDENT_PIN_SYNC_ALL': {
        const items = (payload ?? {}).items
        if (!Array.isArray(items)) throw new Error('Missing items')
        this.store.residentPinReplaceAll(items)
        return { synced: items.length }
      }

      case 'KNOWLEDGE_UPSERT':
        return this.knowledge.upsert((payload ?? {}) as any)
      case 'KNOWLEDGE_DELETE':
        return this.knowledge.remove((payload ?? {}) as any)

      // ── Access Points refactor (2026-06-01) ───────────────────────────────
      // Cloud syncuje binding device→output + cron schedules. Edge zapisuje
      // 1:1 w SQLite — executor czyta z tego storu, nie z Cloud-a.
      case 'AP_UPSERT':
        return this.handleApUpsert(payload ?? {})
      case 'AP_DELETE':
        return this.handleApDelete(payload ?? {})
      case 'AP_SYNC_ALL':
        return this.handleApSyncAll(payload ?? {})
      case 'SCHEDULE_UPSERT':
        return this.handleScheduleUpsert(payload ?? {})
      case 'SCHEDULE_DELETE':
        return this.handleScheduleDelete(payload ?? {})
      case 'SCHEDULE_SYNC_ALL':
        return this.handleScheduleSyncAll(payload ?? {})
      case 'AP_TEST_FIRE':
        return this.handleApTestFire(payload ?? {})

      // FAZA c (2026-06-02) — multi-LPR per AP
      case 'LPR_AP_LINK_UPSERT':
        return this.handleLprApLinkUpsert(payload ?? {})
      case 'LPR_AP_LINK_DELETE':
        return this.handleLprApLinkDelete(payload ?? {})
      case 'LPR_AP_LINK_SYNC_ALL':
        return this.handleLprApLinkSyncAll(payload ?? {})

      // FAZA b (2026-06-02) — Building config (objectType + features)
      case 'BUILDING_CONFIG_UPDATE':
        // Edge zapisuje do KV (encrypted) — przyszłe service (np. offline
        // kurier flow) czytają stąd. Na razie nie ma konsumenta, ale
        // zapisujemy żeby outbox-replay przy reconnect nie wisiał.
        if (payload?.buildingId && payload?.features) {
          this.store.set(
            `building:${payload.buildingId}:config`,
            JSON.stringify({
              objectType: payload.objectType,
              features: payload.features,
            }),
          )
        }
        return { updated: true }

      case 'DEVICE_CONFIG_UPDATE':
        if (payload?.deviceId && payload?.config) {
          this.store.setDeviceConfig(payload.deviceId, payload.type, payload.config)
          return { updated: true }
        }
        throw new Error('Missing deviceId or config')

      // FAZA 8.g (2026-06-03) — AI Engine config update z Cloud.
      // Cloud wysyła po PATCH /integrator/buildings/:id/ai-engine. Edge
      // zapisuje do `ai_engines` table; VisionDetectService czyta dynamicznie
      // przez `aiEngineGet()` przy każdym cycle.
      case 'AI_ENGINE_CONFIG_UPDATE': {
        const p = payload ?? {}
        const url = typeof p.url === 'string' ? p.url : ''
        const buildingId = Number(p.buildingId ?? 0)
        if (!url) throw new Error('AI_ENGINE_CONFIG_UPDATE: missing url')
        if (!Number.isFinite(buildingId) || buildingId <= 0) {
          throw new Error('AI_ENGINE_CONFIG_UPDATE: invalid buildingId')
        }
        // FAZA 8.h.7 (2026-06-08) — payload teraz może zawierać LLM fields.
        // Pole undefined zachowuje obecną wartość (partial update).
        this.store.aiEngineUpsert({
          buildingId,
          url,
          healthPath: typeof p.healthPath === 'string' ? p.healthPath : null,
          model: typeof p.model === 'string' ? p.model : null,
          enabled: p.enabled === false ? false : true,
          llmUrl: p.llmUrl !== undefined ? (typeof p.llmUrl === 'string' ? p.llmUrl : null) : undefined,
          llmModel: typeof p.llmModel === 'string' ? p.llmModel : undefined,
          llmEnabled: typeof p.llmEnabled === 'boolean' ? p.llmEnabled : undefined,
        })
        this.logger.log(
          `[ai-engine] config updated → yolo=${url} model=${p.model ?? '(default)'} ` +
          `llm=${p.llmUrl ?? '(unchanged)'} llmModel=${p.llmModel ?? '(unchanged)'} ` +
          `enabled=${p.enabled !== false}/llm=${p.llmEnabled}`,
        )
        this.eventLog.success('SYSTEM', `🤖 AI Engine config updated`, { url, model: p.model, llmUrl: p.llmUrl, llmModel: p.llmModel })
        return { updated: true }
      }

      // FAZA 8.g (2026-06-03) — test połączenia z AI Engine.
      // BA/Integrator klika "Testuj" w UI → Cloud wysyła AI_ENGINE_TEST.
      // Edge robi GET /<healthPath> i odsyła wynik przez tunnel event
      // `AI_ENGINE_TEST_RESULT` z {ok, ms, statusCode, error, model, url}.
      //
      // Wynik leci jako EVT a NIE jako ACK data, bo Cloud chce zapisać go w
      // `ai_engines.lastTest*` przez EdgeGateway.handleMessage. ACK i tak
      // zwracamy { ok, ms, ... } na wypadek gdyby caller czekał na response.
      // FAZA 8.h (2026-06-03) — per-camera config (role + AI toggle).
      // Cloud wysyła po PATCH /integrator/buildings/:id/cameras/:cameraId.
      // Partial update — pola undefined są pomijane (nie nadpisujemy).
      case 'CAMERA_CONFIG_UPDATE': {
        const p = payload ?? {}
        const cameraDeviceId = typeof p.cameraDeviceId === 'string' ? p.cameraDeviceId : ''
        if (!cameraDeviceId) {
          throw new Error('CAMERA_CONFIG_UPDATE: missing cameraDeviceId')
        }
        const updates: string[] = []
        if (typeof p.role === 'string') {
          this.store.setCameraRole(cameraDeviceId, p.role)
          updates.push(`role=${p.role}`)
        }
        if (typeof p.aiAnalysisEnabled === 'boolean') {
          this.store.setCameraAiAnalysisEnabled(cameraDeviceId, p.aiAnalysisEnabled)
          updates.push(`ai=${p.aiAnalysisEnabled ? 'on' : 'off'}`)
        }
        if (updates.length === 0) {
          this.logger.warn(`CAMERA_CONFIG_UPDATE: no recognized fields in payload`)
          return { updated: false }
        }
        this.logger.log(
          `[camera-config] ${cameraDeviceId.slice(0, 8)}… ${updates.join(' ')}`,
        )
        return { updated: true, cameraDeviceId, applied: updates }
      }

      // FAZA 8.h.2 (2026-06-05) — pełen sync wszystkich kamer w budynku.
      // Wysyłane przez Cloud przy reconnect Edge (`handleConnection`) —
      // analogicznie do AP_SYNC_ALL. Bezpośredni replace-all dla `role` +
      // `aiAnalysisEnabled` w `device_config`. Defense-in-depth dla migracji
      // SQL na Cloud które nie przechodzą przez tunel CAMERA_CONFIG_UPDATE.
      case 'CAMERA_SYNC_ALL': {
        const items = Array.isArray(payload?.items) ? payload.items : []
        let applied = 0
        for (const item of items) {
          const cameraDeviceId = typeof item?.cameraDeviceId === 'string' ? item.cameraDeviceId : ''
          if (!cameraDeviceId) continue
          if (typeof item.role === 'string') {
            this.store.setCameraRole(cameraDeviceId, item.role)
          }
          if (typeof item.aiAnalysisEnabled === 'boolean') {
            this.store.setCameraAiAnalysisEnabled(cameraDeviceId, item.aiAnalysisEnabled)
          }
          applied++
        }
        this.logger.log(`CAMERA_SYNC_ALL: replaced config for ${applied} camera(s)`)
        return { synced: applied }
      }

      case 'AI_ENGINE_TEST': {
        const p = payload ?? {}
        const result = await this.vision.testEngineConnection({
          urlOverride: typeof p.urlOverride === 'string' ? p.urlOverride : undefined,
          healthPathOverride: typeof p.healthPathOverride === 'string' ? p.healthPathOverride : undefined,
        })
        // Push EVT do Cloud — EdgeGateway zapisze w DB
        this.sendEvent('AI_ENGINE_TEST_RESULT', {
          ...result,
          ts: Date.now(),
        })
        this.logger.log(
          `[ai-engine] test ${result.ok ? 'OK' : 'FAIL'} ms=${result.ms ?? '-'} status=${result.statusCode ?? '-'} ` +
          `${result.error ? `err=${result.error}` : ''}`,
        )
        return result
      }

      // FAZA 8.h.8 (2026-06-08) — test Ollama LLM, zwraca availableModels[].
      case 'LLM_TEST': {
        const p = payload ?? {}
        const result = await this.llm.testLlmConnection({
          urlOverride: typeof p.urlOverride === 'string' ? p.urlOverride : undefined,
        })
        // Push EVT do Cloud z availableModels — EdgeGateway zapisze do DB
        // (`ai_engines.llmAvailableModels` JSON) i frontend pokaże listę.
        this.sendEvent('LLM_TEST_RESULT', {
          ok: result.ok,
          ms: result.ms,
          statusCode: result.statusCode,
          error: result.error,
          url: result.url,
          availableModels: result.availableModels ?? [],
          ts: Date.now(),
        })
        this.logger.log(
          `[llm] test ${result.ok ? 'OK' : 'FAIL'} ms=${result.ms ?? '-'} ` +
          `models=${(result.availableModels ?? []).length} ` +
          `${result.error ? `err=${result.error}` : ''}`,
        )
        return result
      }

      case 'REBOOT':
        // 3-sec delay żeby ACK z `success: true` doszedł do Cloud przed
        // ubiciem procesu — inaczej BA dostanie 5xx zamiast „polecenie wysłane".
        //
        // ⚠️ WYMAGA service managera (launchd / pm2) który auto-restartuje
        // proces po `process.exit(0)`. Bez niego Edge zostaje wyłączony i
        // trzeba ręcznie zSSH-ować + `npm run start:prod`.
        // Patrz `apps/edge/install/com.gatelynk.edge.plist` + README.md.
        this.logger.warn('REBOOT command received — exiting in 3s (launchd will restart)')
        setTimeout(() => process.exit(0), 3000)
        return { rebooting: true }

      default:
        throw new Error(`Unknown action: ${action}`)
    }
  }

  // ── Access Points refactor (2026-06-01) — Cloud→Edge sync handlers ──────────
  //
  // Cloud wysyła AP_UPSERT/DELETE/SYNC_ALL i SCHEDULE_* z payloadem 1:1
  // mapowanym z Postgres-a. Edge zapisuje do lokalnego SQLite — executor czyta
  // z tej kopii (offline-first, jak guest_pins).
  //
  // Defense-in-depth: każdy handler waliduje payload (id musi być >0, cron
  // expr non-empty), rzuca Error przy problemach → ACK do Cloud z success=false.

  private toBool(v: unknown, dflt: boolean): boolean {
    if (typeof v === 'boolean') return v
    if (typeof v === 'number') return v !== 0
    if (typeof v === 'string') return v === 'true' || v === '1'
    return dflt
  }

  private handleApUpsert(payload: Record<string, any>): { upserted: boolean } {
    const id = Number(payload.id ?? 0)
    const buildingId = Number(payload.buildingId ?? 0)
    if (!Number.isFinite(id) || id <= 0) throw new Error('AP_UPSERT: invalid id')
    if (!Number.isFinite(buildingId) || buildingId <= 0) throw new Error('AP_UPSERT: invalid buildingId')

    this.store.apsUpsert({
      id,
      buildingId,
      label: String(payload.label ?? `AP #${id}`),
      icon: typeof payload.icon === 'string' ? payload.icon : null,
      scope: typeof payload.scope === 'string' ? payload.scope : 'RESIDENT',
      // FAZA c (2026-06-02) — kategoria semantyczna, default 'MAIN_ENTRY'.
      category: typeof payload.category === 'string' ? payload.category : 'MAIN_ENTRY',
      outputDeviceUuid: typeof payload.outputDeviceId === 'string' ? payload.outputDeviceId : null,
      outputIndex: Number.isFinite(payload.outputIndex) ? Number(payload.outputIndex) : null,
      durationMs: Number.isFinite(payload.durationMs) ? Number(payload.durationMs) : 800,
      isActive: this.toBool(payload.isActive, true),
      sortOrder: Number.isFinite(payload.sortOrder) ? Number(payload.sortOrder) : 0,
      legacyDeviceId: typeof payload.deviceId === 'string' ? payload.deviceId : null,
      legacyRelayIndex: Number.isFinite(payload.relayIndex) ? Number(payload.relayIndex) : null,
    })
    return { upserted: true }
  }

  private handleApDelete(payload: Record<string, any>): { deleted: boolean } {
    const id = Number(payload.id ?? 0)
    if (!Number.isFinite(id) || id <= 0) throw new Error('AP_DELETE: invalid id')
    const ok = this.store.apsDelete(id)
    return { deleted: ok }
  }

  private handleApSyncAll(payload: Record<string, any>): { count: number } {
    const items = Array.isArray(payload.items) ? payload.items : []
    const rows = items
      .map((it: any) => ({
        id: Number(it?.id ?? 0),
        buildingId: Number(it?.buildingId ?? 0),
        label: String(it?.label ?? ''),
        icon: typeof it?.icon === 'string' ? it.icon : null,
        scope: typeof it?.scope === 'string' ? it.scope : 'RESIDENT',
        category: typeof it?.category === 'string' ? it.category : 'MAIN_ENTRY',
        outputDeviceUuid: typeof it?.outputDeviceId === 'string' ? it.outputDeviceId : null,
        outputIndex: Number.isFinite(it?.outputIndex) ? Number(it.outputIndex) : null,
        durationMs: Number.isFinite(it?.durationMs) ? Number(it.durationMs) : 800,
        isActive: this.toBool(it?.isActive, true),
        sortOrder: Number.isFinite(it?.sortOrder) ? Number(it.sortOrder) : 0,
        legacyDeviceId: typeof it?.deviceId === 'string' ? it.deviceId : null,
        legacyRelayIndex: Number.isFinite(it?.relayIndex) ? Number(it.relayIndex) : null,
      }))
      .filter(r => r.id > 0 && r.buildingId > 0)
    this.store.apsReplaceAll(rows)
    this.logger.log(`AP_SYNC_ALL: replaced with ${rows.length} access point(s)`)
    return { count: rows.length }
  }

  // ── LPR camera → AccessPoint links (FAZA c, 2026-06-02) ─────────────────────

  private handleLprApLinkUpsert(payload: Record<string, any>): { upserted: boolean } {
    const id = Number(payload.id ?? 0)
    const accessPointId = Number(payload.accessPointId ?? 0)
    const buildingId = Number(payload.buildingId ?? 0)
    const cameraDeviceUuid = typeof payload.cameraDeviceUuid === 'string' ? payload.cameraDeviceUuid : ''
    if (!Number.isFinite(id) || id <= 0) throw new Error('LPR_AP_LINK_UPSERT: invalid id')
    if (!Number.isFinite(accessPointId) || accessPointId <= 0) throw new Error('LPR_AP_LINK_UPSERT: invalid accessPointId')
    if (!cameraDeviceUuid) throw new Error('LPR_AP_LINK_UPSERT: missing cameraDeviceUuid')
    if (!Number.isFinite(buildingId) || buildingId <= 0) throw new Error('LPR_AP_LINK_UPSERT: invalid buildingId')

    this.store.lprApLinkUpsert({
      id,
      cameraDeviceUuid,
      accessPointId,
      direction: typeof payload.direction === 'string' ? payload.direction : 'IN',
      buildingId,
    })
    return { upserted: true }
  }

  private handleLprApLinkDelete(payload: Record<string, any>): { deleted: boolean } {
    const id = Number(payload.id ?? 0)
    if (!Number.isFinite(id) || id <= 0) throw new Error('LPR_AP_LINK_DELETE: invalid id')
    const ok = this.store.lprApLinkDelete(id)
    return { deleted: ok }
  }

  private handleLprApLinkSyncAll(payload: Record<string, any>): { count: number } {
    const items = Array.isArray(payload.items) ? payload.items : []
    const rows = items
      .map((it: any) => ({
        id: Number(it?.id ?? 0),
        cameraDeviceUuid: typeof it?.cameraDeviceUuid === 'string' ? it.cameraDeviceUuid : '',
        accessPointId: Number(it?.accessPointId ?? 0),
        direction: typeof it?.direction === 'string' ? it.direction : 'IN',
        buildingId: Number(it?.buildingId ?? 0),
      }))
      .filter(r => r.id > 0 && r.accessPointId > 0 && r.cameraDeviceUuid && r.buildingId > 0)
    this.store.lprApLinksReplaceAll(rows)
    this.logger.log(`LPR_AP_LINK_SYNC_ALL: replaced with ${rows.length} link(s)`)
    return { count: rows.length }
  }

  private handleScheduleUpsert(payload: Record<string, any>): { upserted: boolean } {
    const id = Number(payload.id ?? 0)
    const accessPointId = Number(payload.accessPointId ?? 0)
    const cronExpr = typeof payload.cronExpr === 'string' ? payload.cronExpr.trim() : ''
    if (!Number.isFinite(id) || id <= 0) throw new Error('SCHEDULE_UPSERT: invalid id')
    if (!Number.isFinite(accessPointId) || accessPointId <= 0) throw new Error('SCHEDULE_UPSERT: invalid accessPointId')
    if (!cronExpr) throw new Error('SCHEDULE_UPSERT: empty cronExpr')

    this.store.apsScheduleUpsert({
      id,
      accessPointId,
      cronExpr,
      label: typeof payload.label === 'string' ? payload.label : null,
      enabled: this.toBool(payload.enabled, true),
      // lastFiredAt celowo undefined — apsScheduleUpsert zachowuje stary.
    })
    return { upserted: true }
  }

  private handleScheduleDelete(payload: Record<string, any>): { deleted: boolean } {
    const id = Number(payload.id ?? 0)
    if (!Number.isFinite(id) || id <= 0) throw new Error('SCHEDULE_DELETE: invalid id')
    const ok = this.store.apsScheduleDelete(id)
    return { deleted: ok }
  }

  private handleScheduleSyncAll(payload: Record<string, any>): { count: number } {
    const items = Array.isArray(payload.items) ? payload.items : []
    const rows = items
      .map((it: any) => ({
        id: Number(it?.id ?? 0),
        accessPointId: Number(it?.accessPointId ?? 0),
        cronExpr: typeof it?.cronExpr === 'string' ? it.cronExpr.trim() : '',
        label: typeof it?.label === 'string' ? it.label : null,
        enabled: this.toBool(it?.enabled, true),
      }))
      .filter(r => r.id > 0 && r.accessPointId > 0 && r.cronExpr.length > 0)
    this.store.apsScheduleReplaceAll(rows)
    this.logger.log(`SCHEDULE_SYNC_ALL: replaced with ${rows.length} schedule(s)`)
    return { count: rows.length }
  }

  private async handleApTestFire(payload: Record<string, any>): Promise<{ result: any }> {
    const apId = Number(payload.apId ?? payload.accessPointId ?? 0)
    if (!Number.isFinite(apId) || apId <= 0) throw new Error('AP_TEST_FIRE: invalid apId')
    const result = await this.accessPointExecutor.fire(apId, {
      trigger: 'MANUAL',
      actor: typeof payload.actor === 'string' ? payload.actor : 'ADMIN_TEST',
      meta: { source: 'ADMIN_TEST', ...(payload.meta ?? {}) },
    })
    return { result }
  }

  // ── Send event to cloud (with offline queuing) ────────────────────────────────
  /**
   * Zwracana wartość:
   *   • `true`  — wiadomość poszła w WS bezpośrednio (delivered to socket; nie
   *               wiemy 100% czy Cloud ją przyjął, ale to nasz najsilniejszy
   *               sygnał „nie offline")
   *   • `false` — WS nie był connected; wiadomość wpadła do `event_queue`
   *               (lub została cicho odrzucona, jeśli nic nas nie słucha)
   *
   * Boolean jest istotny dla wywołań które chcą zaktualizować lokalny stan
   * sync (np. `lpr_reads.synced_to_cloud`) tylko gdy realnie nadaliśmy. Dla
   * pozostałych miejsc — które po prostu chcą „best effort, zakolejkuj jak
   * nie idzie" — wartość można zignorować.
   */
  sendEvent(event: string, data: Record<string, any>, deviceId?: string): boolean {
    const msg: EdgeMessage = { type: 'EVT', event, deviceId, data, ts: Date.now() }
    if (this.isConnected()) {
      this.send(msg)
      return true
    }
    this.store.enqueue(event, { ...data, deviceId })
    this.logger.debug(`Queued offline event: ${event}`)
    return false
  }

  // ── Heartbeat: send STATUS every 30s ─────────────────────────────────────────
  @Interval(30_000)
  async heartbeat() {
    if (!this.isConnected()) return
    this.sendStatus()
    // Flush queued events + kontynuuj backfill LPR jeśli poprzednia runda
    // przerwała się (WS padł w połowie 500-rzędowego batcha) lub jeśli
    // świeże odczyty wpadły gdy WS drugorazowo utknęło. Dla budynku bez
    // długiego offline-u to no-op (lprUnsyncedCount = 0).
    this.sync.flush()
    this.sync.backfillUnsyncedLprReads()
  }

  // ── Watchdog: reconnect if PONG not received in 90s ──────────────────────────
  @Interval(90_000)
  watchdog() {
    if (!this.isConnected()) return
    if (Date.now() - this.lastPong > 90_000) {
      this.logger.warn('No PONG for 90s — forcing reconnect')
      this.ws?.terminate()
    }
  }

  /**
   * Proaktywny refresh tokenu co godzinę. Token EDGE jest wystawiany na 24h —
   * bez tego mechanizmu Edge dowiaduje się o expired tokenie dopiero gdy
   * tunel wpadnie w 4001, co wymusza reconnect-storm. Lepiej odświeżyć go
   * w tle, kiedy WS jest stabilne i mamy pewność że dosięgnięcie API działa.
   *
   * Dlatego przesyłamy refresh tylko gdy:
   *   • urządzenie aktywowane (mamy refresh token)
   *   • tunel jest aktualnie połączony (nie ma sensu walczyć z auth gdy
   *     i tak nie da się dosięgnąć /api/edge/refresh)
   *
   * Failure tutaj nie jest fatalny — jeśli refresh padnie, tunel po prostu
   * dożyje do expiry i wtedy wpadnie w standardowy 4001-flow (też z
   * próbą refresh w `ws.on('close')`).
   */
  @Interval(3_600_000) // 1h
  async proactiveTokenRefresh() {
    if (this.isShuttingDown) return
    if (!this.activation.isActivated()) return
    if (!this.isConnected()) return
    const ok = await this.activation.refreshToken()
    if (ok) {
      this.logger.log('Token proactively refreshed (WS still up)')
    } else {
      // Nie zamykamy tunelu — niech działa do expiry. Następna iteracja
      // za godzinę spróbuje ponownie. Jeśli refresh failuje permanentnie,
      // problem i tak ujawni się przy najbliższym 4001.
      this.logger.warn('Proactive token refresh failed — will retry in 1h')
    }
  }

  // ── Activation poller: pick up activation that happened after startup ─────────
  @Interval(5_000)
  checkActivation() {
    if (this.isShuttingDown || this.isConnected() || this.reconnectTimer) return
    if (this.activation.isActivated()) {
      this.logger.log('Activation detected — starting tunnel')
      this.connect()
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  private send(msg: EdgeMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  private sendStatus() {
    this.send(this.buildStatus())
  }

  private buildStatus(): EdgeMessage {
    return {
      type: 'STATUS',
      uptime: Math.round((Date.now() - this.startTime) / 1000),
      version: this.config.get<string>('version'),
      queueSize: this.store.queueSize(),
      devices: this.deviceRegistry.getStatus(),
      ts: Date.now(),
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  //  Faza B-2 (Wizard sync, 2026-05-13): Edge → Cloud device config sync
  //
  //  Wywołują DeviceRegistryService (po `saveDevice`/`removeDevice`) i
  //  `connect` `on('open')` (sendDeviceSyncAll przy reconnect).
  // ────────────────────────────────────────────────────────────────────────

  sendDeviceUpsert(
    deviceUuid: string,
    deviceType: string,
    config: Record<string, any>,
    driverId?: string | null,
  ) {
    this.send({
      type: 'DEVICE_UPSERT',
      deviceUuid,
      deviceType,
      driverId,
      config,
      ts: Date.now(),
    })
  }

  sendDeviceDelete(deviceUuid: string) {
    this.send({
      type: 'DEVICE_DELETE',
      deviceUuid,
      ts: Date.now(),
    })
  }

  /**
   * Full-sync — wysyła aktualną listę wszystkich urządzeń z sqlite Edge.
   * Cloud upsertuje + kasuje brakujące (cleanup). Wołane po reconnect WS.
   *
   * NIE odbywa się żadne filtrowanie na podstawie zmian; bierzemy snapshot
   * `getDeviceConfigs()` w całości — to ~kilkanaście urządzeń per Edge,
   * payload <20 KB, nie ma sensu optymalizować.
   */
  sendDeviceSyncAll() {
    const configs = this.store.getDeviceConfigs()
    this.send({
      type: 'DEVICE_SYNC_ALL',
      devices: configs.map((dc) => {
        const cfg = dc.config as Record<string, any>
        return {
          deviceUuid: dc.deviceId,
          deviceType: dc.type,
          driverId: typeof cfg.driverId === 'string' ? cfg.driverId : null,
          config: cfg,
        }
      }),
      ts: Date.now(),
    })
    this.logger.log(`DEVICE_SYNC_ALL: ${configs.length} device(s) sent to cloud`)
  }

  // ── Force reconnect (called after URL/config change) ─────────────────────────
  reconnect() {
    this.logger.log('Forced reconnect requested')
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    this.reconnectDelay = 2000
    if (this.ws) {
      this.ws.terminate()
      this.ws = null
    }
    setTimeout(() => this.connect(), 500)
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  getConnectionInfo() {
    return {
      connected: this.isConnected(),
      uptime: Math.round((Date.now() - this.startTime) / 1000),
      queueSize: this.store.queueSize(),
    }
  }
}
