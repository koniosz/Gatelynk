import { Injectable, Logger } from '@nestjs/common'
import { StoreService } from '../store/store.service'

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name)
  // TunnelService injected lazily via setter to avoid circular dep
  private tunnelSend?: (event: string, data: any, deviceId?: string) => boolean

  constructor(private store: StoreService) {}

  setTunnelSend(fn: (event: string, data: any, deviceId?: string) => boolean) {
    this.tunnelSend = fn
  }

  // ── Flush queued events to cloud ─────────────────────────────────────────────
  flush() {
    if (!this.tunnelSend) return
    const pending = this.store.dequeue(100)
    if (pending.length === 0) return

    this.logger.log(`Flushing ${pending.length} queued event(s)`)
    const sent: number[] = []

    for (const item of pending) {
      try {
        const payload = item.payload as any
        const deviceId = payload.deviceId
        delete payload.deviceId
        // tunnelSend zwraca false jeśli WS w międzyczasie padł — wtedy
        // wiadomość wpada z powrotem do `event_queue` (z nowym ID), więc
        // nie ackQueue-ujemy oryginalnego rzędu, żeby nie znikł cicho.
        const delivered = this.tunnelSend(item.eventType, payload, deviceId)
        if (delivered) sent.push(item.id)
      } catch (err: any) {
        this.logger.warn(`Failed to flush event ${item.id}: ${err.message}`)
      }
    }

    this.store.ackQueue(sent)
    this.logger.log(`Flushed ${sent.length}/${pending.length} events`)
  }

  // ── Backfill LPR reads (lokalny → cloud) ─────────────────────────────────────
  /**
   * Po reconnect WS Edge ma w `lpr_reads` rzędy z `synced_to_cloud = 0` —
   * były dodane gdy:
   *   • WS było down (offline)
   *   • Edge restartował się zanim zdążył wysłać
   *   • bezpośredni `tunnel.sendEvent` wrócił `false` z innego powodu
   *
   * Tu je wyciągamy i wystawiamy ponownie. Cloud ma partial unique index na
   * `(buildingId, cameraDeviceId, edgeReadId)` + `ON CONFLICT DO NOTHING`,
   * więc jeśli któryś z odczytów już tam jest — duplikat jest no-op.
   *
   * Ograniczenie 500 rzędów na rundę: dla budynku z dużym ruchem (np. 200
   * detekcji/dzień, tydzień offline = 1400 rzędów) backfill rozłoży się na
   * ~3 wywołania. Każda kolejna runda nastąpi przy najbliższym `flush()`
   * (czyli na heartbeat co 30s) dopóki nie zostanie zero unsynced.
   */
  backfillUnsyncedLprReads(maxPerRun = 500): number {
    if (!this.tunnelSend) return 0
    const pending = this.store.lprListUnsyncedReads(maxPerRun)
    if (pending.length === 0) return 0

    this.logger.log(`Backfilling ${pending.length} unsynced LPR read(s)`)
    const synced: number[] = []

    for (const r of pending) {
      const payload = {
        cameraDeviceId: r.cameraDeviceId,
        plate: r.plate,
        matched: r.matched,
        owner: r.owner,
        gateOpened: r.gateOpened,
        reason: r.reason,
        confidence: r.confidence,
        direction: r.direction,
        vehicleColor: r.vehicleColor,
        vehicleBrand: r.vehicleBrand,
        vehicleType: r.vehicleType,
        vehicleSubtype: r.vehicleSubtype,
        hasImage: !!r.imagePath,
        edgeReadId: r.id,
        ts: r.ts,
      }
      try {
        const delivered = this.tunnelSend('LPR_READ', payload, r.cameraDeviceId)
        if (delivered) {
          synced.push(r.id)
        } else {
          // WS padł w trakcie backfilli — przerywamy, reszta zostaje
          // unsynced i pójdzie w kolejnej rundzie.
          this.logger.warn('Tunnel disconnected mid-backfill — stopping')
          break
        }
      } catch (err: any) {
        this.logger.warn(`Failed to backfill LPR read ${r.id}: ${err.message}`)
      }
    }

    this.store.lprMarkReadsSynced(synced)
    const remaining = this.store.lprUnsyncedCount()
    this.logger.log(`Backfilled ${synced.length}/${pending.length} LPR reads (${remaining} still pending)`)
    return synced.length
  }
}
