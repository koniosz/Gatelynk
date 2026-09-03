import {
  Injectable, Logger, ForbiddenException, NotFoundException,
  BadGatewayException, BadRequestException,
} from '@nestjs/common'
import { ModuleRef } from '@nestjs/core'
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'
import { PrismaService } from '../prisma/prisma.service'
import { PushService } from '../push/push.service'
import { EdgeGateway } from '../edge/edge.gateway'

// Wspólny dispatcher dla wywołań do Edge przez Tailscale HTTP proxy
// (ten sam co w building-admin.service / resident.service). Konfigurowany
// w entrypoint-api.sh, default localhost:1055.
const edgeDispatcher: Dispatcher | undefined = process.env.TS_HTTP_PROXY
  ? new ProxyAgent(process.env.TS_HTTP_PROXY)
  : undefined

/**
 * Faza Fall-Det Etap 3 — Cloud persistence + push notify dla anomalii wizyjnych.
 *
 * Dane przychodzą z Edge przez `EVT { event: 'ANOMALY_DETECTED' }` (tunnel WS) →
 * `EdgeGateway.handleMessage` → `recordFromEdge(...)` tutaj.
 *
 * Push idzie do:
 *   • Building Admins przypisanych do budynku (zawsze)
 *   • Concierges przypisanych do budynku (zawsze)
 *   • Residents w budynku z `notifyAnomalies=true` (opt-in)
 *
 * Cooldown 5 min per `(buildingId, cameraDeviceId)` żeby seria 3 framów upadku
 * nie wygenerowała 3 push-ów. Cooldown trzymany in-memory (Map) — przy restarcie
 * API resetuje się, co jest akceptowalne (rzadkie restarty, koszt = jeden
 * dodatkowy push w skrajnym przypadku).
 *
 * Raw SQL bo Prisma client czasem ma drift z nowymi polami w monorepo (CLAUDE.md
 * Faza 7.1: typed client działa, ale zostawiamy raw SQL żeby nie zaleznieć od
 * `prisma generate` w pipeline deploy-u).
 */
@Injectable()
export class AnomalyEventsService {
  private readonly logger = new Logger(AnomalyEventsService.name)
  private readonly cooldown = new Map<string, number>()
  private readonly COOLDOWN_MS = 5 * 60 * 1000 // 5 min

  // EdgeGateway resolved lazily żeby uniknąć cyklu EdgeModule ↔ AnomalyEventsModule.
  // (EdgeModule importuje wiele rzeczy które same importują EdgeModule pośrednio).
  private edgeGateway?: EdgeGateway
  private getEdgeGateway(): EdgeGateway | undefined {
    if (this.edgeGateway) return this.edgeGateway
    try {
      this.edgeGateway = this.moduleRef.get(EdgeGateway, { strict: false })
    } catch {
      // Not wired yet — caller fallback do DB.
    }
    return this.edgeGateway
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Persyst zdarzenie + trigger push notify.
   * Zwraca id eventu (BigInt jako string żeby JSON-friendly).
   */
  async recordFromEdge(input: {
    buildingId: number
    cameraDeviceId: string
    ts: Date
    type: string             // 'FALL' | ...
    likelihood: number
    indicators: string[]
    imageFilename?: string | null
  }): Promise<string> {
    const indicatorsJson = JSON.stringify(input.indicators)

    const rows = await this.prisma.$queryRaw<{ id: bigint }[]>`
      INSERT INTO "anomaly_events"
        ("buildingId", "cameraDeviceId", "ts", "type", "likelihood", "indicators", "imageFilename")
      VALUES
        (${input.buildingId}, ${input.cameraDeviceId}, ${input.ts}, ${input.type},
         ${input.likelihood}, ${indicatorsJson}::jsonb, ${input.imageFilename ?? null})
      RETURNING id
    `
    const eventId = rows[0]?.id?.toString() ?? '?'

    this.logger.warn(
      `🚨 ANOMALY ${input.type} recorded — building ${input.buildingId}, ` +
      `cam ${input.cameraDeviceId}, likelihood ${(input.likelihood * 100).toFixed(0)}%, ` +
      `event id ${eventId}`,
    )

    // Cooldown check — nie spamujemy push-ami.
    const cooldownKey = `${input.buildingId}:${input.cameraDeviceId}`
    const lastPush = this.cooldown.get(cooldownKey) ?? 0
    if (Date.now() - lastPush < this.COOLDOWN_MS) {
      this.logger.log(`Push skipped (cooldown active) for ${cooldownKey}`)
      return eventId
    }
    this.cooldown.set(cooldownKey, Date.now())

    // Fire-and-forget push (nie blokujemy persist-u na slow APNs).
    this.notifyRecipients({ ...input, eventId }).catch((err) =>
      this.logger.error(`notifyRecipients failed: ${err.message}`),
    )

    return eventId
  }

  private async notifyRecipients(input: {
    buildingId: number
    cameraDeviceId: string
    type: string
    likelihood: number
    eventId: string
  }) {
    // Nazwa kamery — z device_config (mirror) jeśli zsynchronizowane,
    // fallback do deviceId. Tabela edge_device_mirror trzyma config jako JSONB.
    const camRows = await this.prisma.$queryRaw<{ name: string | null }[]>`
      SELECT (config->>'name') AS name
        FROM "edge_device_mirror"
       WHERE "buildingId" = ${input.buildingId}
         AND "deviceUuid" = ${input.cameraDeviceId}
       LIMIT 1
    `
    const cameraName = camRows[0]?.name ?? input.cameraDeviceId
    const likelihoodPct = Math.round(input.likelihood * 100)
    const title = '🚨 Możliwy upadek osoby'
    const body = `Kamera ${cameraName} — wykryto upadek (${likelihoodPct}%)`

    // Opt-in residents — tylko ci z notifyAnomalies=true w tym budynku.
    const residents = await this.prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM "residents"
       WHERE "buildingId" = ${input.buildingId}
         AND "notifyAnomalies" = TRUE
    `

    const data = {
      type: 'ANOMALY',
      anomalyId: input.eventId,
      anomalyType: input.type,
      buildingId: input.buildingId,
      cameraDeviceId: input.cameraDeviceId,
    }

    // Per-resident send (PushService API operuje per residentId).
    // Building admins i concierges nie mają jeszcze push-tokenów w iOS app —
    // dostają przez panel webowy (BA dashboard banner pull-uje co 30s).
    // TODO: gdy iOS app dla BA/Concierge powstanie — rozbudować PushService.
    await Promise.all(
      residents.map((r) =>
        this.push.sendToResident(r.id, title, body, data).catch((err: Error) =>
          this.logger.warn(`Push to resident ${r.id} failed: ${err.message}`),
        ),
      ),
    )

    this.logger.log(
      `Push dispatched: ${residents.length} opt-in resident(s) for ` +
      `building ${input.buildingId} (cooldown ${this.COOLDOWN_MS / 1000}s)`,
    )
  }

  /**
   * Lista zdarzeń dla budynku (BA + Concierge + Resident wspólny endpoint
   * z różnymi guardami w controllerach).
   */
  async listForBuilding(
    buildingId: number,
    opts: {
      sinceHours?: number   // default 24
      limit?: number        // default 100, max 500
      unresolvedOnly?: boolean
    } = {},
  ) {
    const sinceHours = clampNum(opts.sinceHours ?? 24, 1, 24 * 30, 24)
    const limit = clampNum(opts.limit ?? 100, 1, 500, 100)
    const sinceMs = Date.now() - sinceHours * 60 * 60 * 1000
    const since = new Date(sinceMs)

    type Row = {
      id: bigint
      buildingId: number
      cameraDeviceId: string
      ts: Date
      type: string
      likelihood: number
      indicators: any
      imageFilename: string | null
      resolvedAt: Date | null
      resolvedBy: string | null
      falsePositive: boolean
      createdAt: Date
    }

    const rows: Row[] = opts.unresolvedOnly
      ? await this.prisma.$queryRaw<Row[]>`
          SELECT id, "buildingId", "cameraDeviceId", ts, type, likelihood,
                 indicators, "imageFilename", "resolvedAt", "resolvedBy",
                 "falsePositive", "createdAt"
            FROM "anomaly_events"
           WHERE "buildingId" = ${buildingId}
             AND ts >= ${since}
             AND "resolvedAt" IS NULL
             AND "falsePositive" = FALSE
           ORDER BY ts DESC
           LIMIT ${limit}
        `
      : await this.prisma.$queryRaw<Row[]>`
          SELECT id, "buildingId", "cameraDeviceId", ts, type, likelihood,
                 indicators, "imageFilename", "resolvedAt", "resolvedBy",
                 "falsePositive", "createdAt"
            FROM "anomaly_events"
           WHERE "buildingId" = ${buildingId}
             AND ts >= ${since}
           ORDER BY ts DESC
           LIMIT ${limit}
        `

    return {
      events: rows.map((r) => ({
        id: r.id.toString(),
        buildingId: r.buildingId,
        cameraDeviceId: r.cameraDeviceId,
        ts: r.ts.toISOString(),
        type: r.type,
        likelihood: r.likelihood,
        indicators: Array.isArray(r.indicators) ? r.indicators : [],
        imageFilename: r.imageFilename,
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
        resolvedBy: r.resolvedBy,
        falsePositive: r.falsePositive,
        createdAt: r.createdAt.toISOString(),
      })),
      total: rows.length,
      sinceMs,
      sinceHours,
    }
  }

  async resolve(id: string, actorType: 'BA' | 'CONCIERGE', actorId: number, buildingIds: number[]) {
    const event = await this.findAndGuard(id, buildingIds)
    if (event.resolvedAt) return event // idempotent

    await this.prisma.$executeRaw`
      UPDATE "anomaly_events"
         SET "resolvedAt" = NOW(),
             "resolvedBy" = ${`${actorType}:${actorId}`}
       WHERE id = ${BigInt(id)}
    `
    this.logger.log(`Anomaly ${id} resolved by ${actorType}:${actorId}`)
    return this.findAndGuard(id, buildingIds)
  }

  async markFalsePositive(id: string, actorType: 'BA' | 'CONCIERGE', actorId: number, buildingIds: number[]) {
    await this.findAndGuard(id, buildingIds)
    await this.prisma.$executeRaw`
      UPDATE "anomaly_events"
         SET "falsePositive" = TRUE,
             "resolvedAt"    = NOW(),
             "resolvedBy"    = ${`${actorType}:${actorId}`}
       WHERE id = ${BigInt(id)}
    `
    this.logger.log(`Anomaly ${id} marked FALSE POSITIVE by ${actorType}:${actorId}`)
    return this.findAndGuard(id, buildingIds)
  }

  /**
   * Stream JPEG-a anomalii z Edge LAN przez Cloud proxy.
   *
   * iOS i web nie mają dostępu do Edge IP (Edge w LAN budynku) — Cloud
   * pull-through forwarduje binary z `http://<edge>:4000/vision/frame/:filename`
   * przez Tailscale dispatcher.
   *
   * Permissions: anomaly buildingId musi być w `buildingIds` calling-usera.
   * Resident dostaje to przez listę swojego budynku (1 element).
   */
  async streamImage(id: string, buildingIds: number[], res: import('express').Response) {
    const event = await this.findAndGuard(id, buildingIds)
    if (!event.imageFilename) throw new NotFoundException('Brak obrazu dla tej anomalii')

    // Walidacja filename — defense in depth, Edge i tak waliduje.
    const filename = event.imageFilename
    if (!/^[0-9]+_[A-Za-z0-9._-]+\.jpg$/.test(filename)) {
      throw new BadRequestException('Niepoprawna nazwa klatki')
    }

    const ip = await this.resolveEdgeIp(event.buildingId)
    try {
      const edgeRes = await undiciFetch(
        `http://${ip}:4000/vision/frame/${encodeURIComponent(filename)}`,
        { signal: AbortSignal.timeout(10_000), dispatcher: edgeDispatcher },
      )
      if (edgeRes.status === 404) throw new NotFoundException('Klatka niedostępna')
      if (!edgeRes.ok) throw new Error(`Edge HTTP ${edgeRes.status}`)
      const buf = Buffer.from(await edgeRes.arrayBuffer())
      res.setHeader('Content-Type', 'image/jpeg')
      // Klatki są immutable (timestamp + UUID w nazwie) — bezpiecznie 1h cache.
      res.setHeader('Cache-Control', 'private, max-age=3600')
      res.setHeader('Content-Length', buf.length)
      res.end(buf)
    } catch (err: any) {
      if (err instanceof NotFoundException) throw err
      throw new BadGatewayException(`Klatka niedostępna: ${err?.message ?? 'błąd'}`)
    }
  }

  /**
   * Resolve Edge IP — najpierw live WS, potem fallback do DB. Sygnatura
   * świadomie kopiuje wzorzec z BuildingAdminService.resolveEdgeIp żeby
   * AnomalyEventsService był samowystarczalny.
   */
  private async resolveEdgeIp(buildingId: number): Promise<string> {
    let ip: string | undefined
    const gw = this.getEdgeGateway()
    if (gw) {
      try { ip = gw.getEdgeIpForBuilding(buildingId) } catch { /* fallback */ }
    }
    if (!ip) {
      const edge = await this.prisma.edgeDevice.findFirst({
        where: { buildingId, isActivated: true },
        orderBy: { lastSeenAt: 'desc' },
      })
      ip = edge?.ipAddress ?? undefined
    }
    if (!ip) throw new BadGatewayException('Brak połączenia z bramką')
    return ip
  }

  private async findAndGuard(id: string, buildingIds: number[]) {
    let bigId: bigint
    try {
      bigId = BigInt(id)
    } catch {
      throw new NotFoundException('Anomaly nie znaleziona')
    }
    const rows = await this.prisma.$queryRaw<
      {
        id: bigint
        buildingId: number
        resolvedAt: Date | null
        falsePositive: boolean
        imageFilename: string | null
      }[]
    >`
      SELECT id, "buildingId", "resolvedAt", "falsePositive", "imageFilename"
        FROM "anomaly_events"
       WHERE id = ${bigId}
       LIMIT 1
    `
    const event = rows[0]
    if (!event) throw new NotFoundException('Anomaly nie znaleziona')
    if (!buildingIds.includes(event.buildingId)) {
      throw new ForbiddenException('Brak dostępu do tej anomalii')
    }
    return event
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function clampNum(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback
  if (n < min) return min
  if (n > max) return max
  return Math.floor(n)
}
