/**
 * Faza 7.6 — Persistent outbox dla Cloud→Edge messaging.
 *
 * Każde wywołanie `EdgeGateway.sendCommand` zapisuje row w `edge_sync_outbox`
 * przed wysłaniem WS, używa wygenerowane id jako message-id WS-CMD. Edge przy
 * ACK zwraca to id → row jest mark-delivered. Brak ACK → przy najbliższym
 * reconnect Edge dostaje wszystkie pending; cron co 1min ratuje device-y
 * online z lost ACK-iem (rzadkie, ale możliwe — np. WS drop podczas wysyłania).
 *
 * Po 10 nieudanych próbach row dostaje `failedAt` (deadletter) i alert dla
 * admina przez devices page (badge "X failed"). 30+ dniowe delivered są
 * cleanowane osobnym cron-em (TODO 7.6 follow-up — niski priorytet).
 */
import { Injectable, Logger } from '@nestjs/common'
import { Interval } from '@nestjs/schedule'
import { Prisma } from '@prisma/client'
import { randomBytes } from 'crypto'
import { PrismaService } from '../prisma/prisma.service'

export const OUTBOX_MAX_ATTEMPTS = 10

export interface OutboxEntry {
  id: string
  buildingId: number
  edgeDeviceId: string | null
  action: string
  payload: Prisma.JsonValue
  attempts: number
  createdAt: Date
}

@Injectable()
export class EdgeOutboxService {
  private readonly logger = new Logger(EdgeOutboxService.name)

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Zapisuje row dla konkretnego Edge. Zwraca id użyte jako WS message-id.
   * Caller (EdgeGateway) odpala WS.send niezależnie — outbox jest tylko
   * persistent log, nie blokuje sendingu.
   */
  async enqueueForDevice(
    buildingId: number,
    edgeDeviceId: string,
    action: string,
    payload: Record<string, any> = {},
  ): Promise<string> {
    const id = this.generateId()
    await this.prisma.edgeSyncOutboxEntry.create({
      data: {
        id,
        buildingId,
        edgeDeviceId,
        action,
        payload: payload as Prisma.JsonObject,
      },
    })
    return id
  }

  /**
   * Broadcast do wszystkich Edge w budynku — tworzy 1 row per znany Edge.
   * Pożytek: jeśli któryś Edge był offline, dostanie row pending; replay
   * przy reconnect zadowoli sync.
   *
   * Zwraca array pending IDs (do użycia jako WS message-id przez gateway).
   */
  async enqueueForBuilding(
    buildingId: number,
    action: string,
    payload: Record<string, any> = {},
  ): Promise<{ edgeDeviceId: string; outboxId: string }[]> {
    // Wszystkie Edge w budynku (online i offline). Online dostają WS od razu,
    // offline tylko row w outbox-ie do replay-u przy reconnect.
    const edges = await this.prisma.edgeDevice.findMany({
      where: { buildingId, isActivated: true },
      select: { id: true },
    })
    if (edges.length === 0) return []
    const out: { edgeDeviceId: string; outboxId: string }[] = []
    for (const e of edges) {
      const id = await this.enqueueForDevice(buildingId, e.id, action, payload)
      out.push({ edgeDeviceId: e.id, outboxId: id })
    }
    return out
  }

  /** Mark delivered po otrzymaniu ACK z konkretnym message-id. */
  async markDelivered(outboxId: string): Promise<void> {
    await this.prisma.edgeSyncOutboxEntry
      .update({
        where: { id: outboxId },
        data: { deliveredAt: new Date() },
      })
      .catch((err) => {
        // Może się zdarzyć że ACK przyszedł 2x (rzadkie) lub dla obsługi
        // legacy WS-CMD bez outbox-row (przed 7.6) — wtedy `update` nie
        // znajduje row i wywala P2025. Logujemy debug i idziemy dalej.
        this.logger.debug(`markDelivered ${outboxId}: ${err?.message ?? 'noop'}`)
      })
  }

  /**
   * Pending entries dla konkretnego Edge — sortowane chronologicznie.
   * Używane przy reconnect Edge: gateway pobiera listę i wysyła w kolejności.
   * Limit 200 żeby przy bardzo długim downtime nie zalać Edge tysiącami CMD
   * naraz (rest dostaje przy następnym cron-tickej).
   */
  async pendingForDevice(edgeDeviceId: string, limit = 200): Promise<OutboxEntry[]> {
    return this.prisma.edgeSyncOutboxEntry.findMany({
      where: {
        edgeDeviceId,
        deliveredAt: null,
        failedAt: null,
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: {
        id: true, buildingId: true, edgeDeviceId: true,
        action: true, payload: true, attempts: true, createdAt: true,
      },
    })
  }

  /**
   * Inkrementuje `attempts` i ustawia `lastAttemptAt`. Jeśli attempts osiąga
   * `OUTBOX_MAX_ATTEMPTS` po inkrementacji — zaznacza `failedAt`. Zwraca
   * informację czy entry jest w stanie failed (caller może wtedy emitować
   * alert).
   */
  async markAttempted(outboxId: string, error?: string): Promise<{ failed: boolean }> {
    const updated = await this.prisma.edgeSyncOutboxEntry
      .update({
        where: { id: outboxId },
        data: {
          attempts: { increment: 1 },
          lastAttemptAt: new Date(),
          lastError: error ?? null,
        },
      })
      .catch(() => null)
    if (!updated) return { failed: false }
    if (updated.attempts >= OUTBOX_MAX_ATTEMPTS) {
      await this.prisma.edgeSyncOutboxEntry.update({
        where: { id: outboxId },
        data: { failedAt: new Date() },
      })
      this.logger.error(
        `Outbox entry ${outboxId} → DEADLETTER (action=${updated.action}, edge=${updated.edgeDeviceId}, error=${error ?? 'no ACK'})`,
      )
      return { failed: true }
    }
    return { failed: false }
  }

  /**
   * Statystyki dla devices page — count pending + failed per Edge w budynku.
   * Zwraca map device_id → { pending, failed }. Używane w `listDevices`
   * w BuildingAdminService żeby UI mogło pokazać badge.
   */
  async statsForBuilding(
    buildingId: number,
  ): Promise<Map<string, { pending: number; failed: number }>> {
    type Row = { edgeDeviceId: string; status: 'pending' | 'failed'; cnt: bigint }
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT "edgeDeviceId",
             CASE WHEN "failedAt" IS NULL THEN 'pending' ELSE 'failed' END AS status,
             COUNT(*)::bigint AS cnt
        FROM "edge_sync_outbox"
       WHERE "buildingId" = ${buildingId}
         AND "deliveredAt" IS NULL
         AND "edgeDeviceId" IS NOT NULL
       GROUP BY "edgeDeviceId", status
    `
    const map = new Map<string, { pending: number; failed: number }>()
    for (const r of rows) {
      const cur = map.get(r.edgeDeviceId) ?? { pending: 0, failed: 0 }
      if (r.status === 'pending') cur.pending = Number(r.cnt)
      else cur.failed = Number(r.cnt)
      map.set(r.edgeDeviceId, cur)
    }
    return map
  }

  /**
   * Pending entries dla cron-retry — szuka po wszystkich budynkach,
   * tylko te z attempts < MAX i nie failed. Caller filtruje po online status.
   */
  async pendingForRetry(maxAge: { olderThanMs: number }, limit = 100): Promise<OutboxEntry[]> {
    const cutoff = new Date(Date.now() - maxAge.olderThanMs)
    return this.prisma.edgeSyncOutboxEntry.findMany({
      where: {
        deliveredAt: null,
        failedAt: null,
        attempts: { lt: OUTBOX_MAX_ATTEMPTS },
        OR: [
          { lastAttemptAt: null },
          { lastAttemptAt: { lt: cutoff } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: {
        id: true, buildingId: true, edgeDeviceId: true,
        action: true, payload: true, attempts: true, createdAt: true,
      },
    })
  }

  /** 8-znakowy random alfanumeryczny — kolizja po 10^14 prób, bezpieczne. */
  private generateId(): string {
    return randomBytes(6).toString('base64url').slice(0, 8)
  }

  /**
   * Cleanup delivered entries starszych niż 30 dni — żeby tabela nie rosła
   * w nieskończoność (~10 events/dzień produkcyjnie = ~3.6k/rok, ale po 5
   * latach to już 18k → DROP). Failed entries zostawiamy permanentnie jako
   * audit-log (admin może chcieć zobaczyć dlaczego coś deadletter-em padło).
   *
   * Cron co 24h o 03:00 server-time — szuczna pora żeby uniknąć clash-u
   * z innymi cron-ami (5min sync, 1min outbox-retry).
   */
  @Interval(24 * 60 * 60 * 1000)
  async cleanupOldDelivered() {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const result = await this.prisma.edgeSyncOutboxEntry.deleteMany({
      where: {
        deliveredAt: { not: null, lt: cutoff },
      },
    })
    if (result.count > 0) {
      this.logger.log(`outbox cleanup: deleted ${result.count} delivered entries older than 30 days`)
    }
  }
}
