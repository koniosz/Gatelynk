/**
 * AccessPointExecutorService — główna „brama" trigerów wszystkich AccessPoint-ów.
 *
 * Refactor 2026-06-01. Po refactorze cała ścieżka LPR_MATCH / PIN_VALID /
 * MANUAL / SCHEDULE / INTERCOM_CALL ma jeden entrypoint:
 *
 *     executor.fire(apId, { trigger: 'LPR_MATCH', plate: '...', actor?, meta? })
 *
 * Wewnątrz:
 *   1. Czytamy AccessPoint z lokalnego storu (`store.apsGetById`). 404 jeśli
 *      brak / `is_active=0`.
 *   2. Rezolvujemy driver przez OutputDriverRegistry po typie urządzenia.
 *      Brak drivera → emit event do Cloud (audyt) z `reason='driver_unavailable'`,
 *      zwracamy `{ opened: false }`. NIE crashujemy.
 *   3. `driver.pulse(outputDeviceUuid, outputIndex, durationMs)`.
 *   4. Audyt: tunelem wysyłamy `ACCESS_POINT_FIRED` event do Cloud, który
 *      mapuje na `AccessEvent` (REMOTE_OPEN / PIN_USED / LPR_MATCH /
 *      MANUAL_OPEN / SCHEDULED_OPEN) z `accessPointId`. Brak WS → wpada do
 *      `event_queue` (SyncService.flush po reconnect).
 *
 * Fallback legacy: jeśli AP nie ma `outputDeviceUuid`/`outputIndex` (sprzed
 * backfill-u), używamy `legacy_device_id`+`legacy_relay_index` (snapshot z
 * `deviceId`+`relayIndex` modelu Cloud) i routujemy przez IntercomService —
 * dokładnie jak stara ścieżka.
 */
import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common'
import { StoreService, AccessPointRow } from '../store/store.service'
import { OutputDriverRegistryService } from './output-driver-registry.service'
import { IntercomService } from '../devices/intercom/intercom.service'
import { EventLogService } from '../event-log/event-log.service'

export type AccessPointTrigger =
  | 'LPR_MATCH'
  | 'PIN_VALID'
  | 'MANUAL'
  | 'SCHEDULE'
  | 'INTERCOM_CALL'
  // 2026-07-30 — przepustka wyjazdowa (docs/exit-grace-pass.md): otwarcie
  // wyjazdu dla pojazdu spoza whitelisty z ważną (lub przeterminowaną przy
  // OPEN_AND_FLAG) przepustką. Audyt w Cloud idzie przez LPR_READ (reason
  // exit_pass/overstay), nie przez ACCESS_POINT_FIRED.
  | 'EXIT_PASS'

export interface FireContext {
  trigger: AccessPointTrigger
  /** Identyfikator źródła — np. 'RESIDENT:123', 'GUEST:42', 'PIN:****6', 'SCHEDULE:7'. */
  actor?: string
  /** LPR plate snapshot — wyłącznie dla LPR_MATCH. */
  plate?: string
  /** Ad-hoc metadata przekazywana do Cloud (`AccessEvent.meta`). */
  meta?: Record<string, any>
}

export interface FireResult {
  opened: boolean
  reason?: string
  apId: number
  driver?: string
}

@Injectable()
export class AccessPointExecutorService {
  private readonly logger = new Logger(AccessPointExecutorService.name)

  /**
   * Lazy injected via setter — TunnelModule importuje AccessPointsModule,
   * więc nie możemy bezpośrednio inject-ować TunnelService (cykl).
   */
  private tunnelSend:
    | ((event: string, data: Record<string, any>, deviceId?: string) => boolean)
    | null = null

  constructor(
    private readonly store: StoreService,
    @Inject(forwardRef(() => OutputDriverRegistryService))
    private readonly registry: OutputDriverRegistryService,
    private readonly intercom: IntercomService,
    private readonly eventLog: EventLogService,
  ) {}

  setTunnelSend(
    fn: (event: string, data: Record<string, any>, deviceId?: string) => boolean,
  ) {
    this.tunnelSend = fn
  }

  /**
   * Główna entry-point. Caller powinien zignorować wyjątki (catch + log) bo
   * fire-and-forget audyt + opener. Zwracamy meaningful result żeby wyższe
   * warstwy (executor LPR / akuvox event handler) mogły wiedzieć czy „pulled
   * the trigger" się powiódł.
   */
  async fire(apId: number, ctx: FireContext): Promise<FireResult> {
    const ap = this.store.apsGetById(apId)
    if (!ap) {
      this.logger.warn(`fire(#${apId}): AP not found in local store`)
      this.eventLog.warn('ACCESS_POINT', `⚠️ Fire #${apId} ignored — AP not in local store`, {
        apId,
        trigger: ctx.trigger,
      })
      return { opened: false, reason: 'not_found', apId }
    }
    if (!ap.isActive) {
      this.logger.debug(`fire(#${apId}): AP inactive — skip`)
      this.audit(ap, ctx, { opened: false, reason: 'inactive' })
      return { opened: false, reason: 'inactive', apId }
    }

    // 1) Wybór drivera + outputu — preferujemy nowy binding, fallback legacy.
    const binding = this.resolveBinding(ap)
    if (!binding) {
      this.logger.warn(
        `fire(#${apId}): no output binding (outputDeviceUuid=${ap.outputDeviceUuid}, legacy=${ap.legacyDeviceId})`,
      )
      this.audit(ap, ctx, { opened: false, reason: 'no_binding' })
      return { opened: false, reason: 'no_binding', apId }
    }

    // 2) Pulse — driver-engine albo legacy intercom fallback.
    try {
      if (binding.kind === 'driver') {
        await binding.driver.pulse(binding.deviceUuid, binding.outputIndex, ap.durationMs)
        this.logger.log(
          `fire(#${apId}) OK via ${binding.driver.describe()} → ${binding.deviceUuid}:${binding.outputIndex} (trigger=${ctx.trigger})`,
        )
      } else {
        // Legacy fallback — leciemy przez intercom.execute jak przed refactor-em.
        await this.intercom.execute('OPEN_DOOR', {
          deviceId: binding.deviceUuid,
          doorIndex: binding.outputIndex,
          source: this.sourceForTrigger(ctx.trigger),
        })
        this.logger.log(
          `fire(#${apId}) OK via LEGACY intercom → ${binding.deviceUuid}:${binding.outputIndex} (trigger=${ctx.trigger})`,
        )
      }
      this.audit(ap, ctx, { opened: true, driver: binding.kind === 'driver' ? binding.driver.describe() : 'legacy-intercom' })
      return {
        opened: true,
        apId,
        driver: binding.kind === 'driver' ? binding.driver.describe() : 'legacy-intercom',
      }
    } catch (err: any) {
      this.logger.error(`fire(#${apId}) FAIL: ${err.message}`)
      this.eventLog.error(
        'ACCESS_POINT',
        `❌ Fire #${apId} (${ap.label}) failed: ${err.message}`,
        { apId, trigger: ctx.trigger, driver: binding.kind, deviceUuid: binding.deviceUuid },
      )
      this.audit(ap, ctx, { opened: false, reason: `gate_error: ${err.message}` })
      return { opened: false, reason: `gate_error: ${err.message}`, apId }
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────────
  private resolveBinding(ap: AccessPointRow):
    | { kind: 'driver'; driver: import('./output-driver-registry.service').OutputDriver; deviceUuid: string; outputIndex: number }
    | { kind: 'legacy'; deviceUuid: string; outputIndex: number }
    | null
  {
    // Preferuj nowy binding.
    if (ap.outputDeviceUuid && ap.outputIndex !== null && ap.outputIndex !== undefined) {
      const driver = this.registry.resolve(ap.outputDeviceUuid)
      if (driver) {
        return {
          kind: 'driver',
          driver,
          deviceUuid: ap.outputDeviceUuid,
          outputIndex: ap.outputIndex,
        }
      }
      // Binding ustawiony, ale driver się nie zarezolwował (urządzenie nieznane
      // albo typ bez dispatchera) → spróbuj legacy intercom jako fallback.
    }
    if (ap.legacyDeviceId && ap.legacyRelayIndex !== null && ap.legacyRelayIndex !== undefined) {
      return {
        kind: 'legacy',
        deviceUuid: ap.legacyDeviceId,
        outputIndex: ap.legacyRelayIndex,
      }
    }
    return null
  }

  private sourceForTrigger(trigger: AccessPointTrigger): 'HTTP' | 'PIN' | 'LPR' | 'OTHER' {
    switch (trigger) {
      case 'LPR_MATCH':
      case 'EXIT_PASS':
        return 'LPR'
      case 'PIN_VALID':
        return 'PIN'
      case 'MANUAL':
      case 'SCHEDULE':
      case 'INTERCOM_CALL':
      default:
        return 'OTHER'
    }
  }

  /**
   * Emituje tunelem ACCESS_POINT_FIRED z meta opisem trigera + akcji.
   * Cloud-side handler mapuje na AccessEvent:
   *   LPR_MATCH    → AccessEventType.LPR_MATCH
   *   PIN_VALID    → PIN_USED
   *   MANUAL       → REMOTE_OPEN / MANUAL_OPEN (zależnie od actora)
   *   SCHEDULE     → SCHEDULED_OPEN (nowy enum, Faza refactor)
   *   INTERCOM_CALL→ INTERCOM_CALL
   *
   * Brak WS — sendEvent zakolejkuje w event_queue → SyncService.flush po reconnect.
   */
  private audit(
    ap: AccessPointRow,
    ctx: FireContext,
    res: { opened: boolean; reason?: string; driver?: string },
  ) {
    if (!this.tunnelSend) return
    this.tunnelSend(
      'ACCESS_POINT_FIRED',
      {
        apId: ap.id,
        buildingId: ap.buildingId,
        label: ap.label,
        trigger: ctx.trigger,
        actor: ctx.actor ?? null,
        plate: ctx.plate ?? null,
        opened: res.opened,
        reason: res.reason ?? null,
        driver: res.driver ?? null,
        outputDeviceUuid: ap.outputDeviceUuid,
        outputIndex: ap.outputIndex,
        ts: Date.now(),
        meta: ctx.meta ?? null,
      },
      ap.outputDeviceUuid ?? ap.legacyDeviceId ?? undefined,
    )
  }
}
