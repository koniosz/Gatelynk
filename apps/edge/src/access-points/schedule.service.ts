/**
 * ScheduleService — cron runner dla AccessPointSchedule.
 *
 * Refactor 2026-06-01. Każdy AccessPoint może mieć N harmonogramów
 * (`access_point_schedules`). Co minutę skanujemy wszystkie enabled,
 * parsujemy cronExpr przez `cron-parser` i odpalamy executor.fire dla każdego,
 * który wpada w okno [lastFiredAt..now+5s] (i jeszcze nie został wystrzelony
 * dla tego okna).
 *
 * Decyzje:
 *   • Drift > 2 min → nie wykonujemy retroaktywnie. Cron to „best effort"
 *     — jeśli Edge spał godzinę, nie chcemy odpalić 60 razy z rzędu „otwórz
 *     o pełnej godzinie". `windowLowerBound = max(lastFiredAt, now - 2min)`.
 *   • lastFiredAt aktualizujemy IMMEDIATELY przed `executor.fire` — chroni
 *     przed double-fire jeśli minę poprzedniego ticku padło z błędem i fire
 *     został odroczony.
 *   • Errors per-schedule są swallowane — jeden zepsuty cron-expr nie blokuje
 *     pozostałych. Logujemy WARN do event_log.
 *
 * Resync z Cloud:
 *   • `lastFiredAt` jest LOKALNE — Cloud go nie zna, nie wysyła. Po reconnect
 *     WS Cloud robi SCHEDULE_SYNC_ALL → `apsScheduleReplaceAll` zachowuje
 *     lokalne lastFiredAt dla każdego rzędu (per-id snapshot przed
 *     DELETE/INSERT).
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { Interval } from '@nestjs/schedule'
import { parseExpression } from 'cron-parser'
import { StoreService } from '../store/store.service'
import { AccessPointExecutorService } from './access-point-executor.service'
import { EventLogService } from '../event-log/event-log.service'

@Injectable()
export class ScheduleService implements OnModuleInit {
  private readonly logger = new Logger(ScheduleService.name)

  /** Tolerancja drift — okno cron-a, w którym jeszcze fire-ujemy. */
  private static readonly DRIFT_TOLERANCE_MS = 2 * 60_000 // 2 min

  /** Bufor naprzód — gdy cron wypada np. 18:00:00.500 a my mamy 17:59:59.700,
   *  liczymy że to ten sam slot (cron-parser jest deterministyczny). */
  private static readonly LOOKAHEAD_MS = 5_000

  constructor(
    private readonly store: StoreService,
    private readonly executor: AccessPointExecutorService,
    private readonly eventLog: EventLogService,
  ) {}

  onModuleInit() {
    // Pierwszy tick w ~1s — żeby przy świeżym boot-cie nie czekać minutę
    // na pierwsze sprawdzenie cron-ów.
    setTimeout(() => this.tick().catch(() => undefined), 1000)
  }

  @Interval(60_000)
  async tick() {
    const schedules = this.store.apsScheduleListEnabled()
    if (schedules.length === 0) return
    const now = Date.now()
    for (const sch of schedules) {
      try {
        const wasFired = await this.tryFire(sch.id, sch.cronExpr, sch.accessPointId, sch.label, sch.lastFiredAt, now)
        if (wasFired) {
          this.logger.log(`Schedule #${sch.id} (AP #${sch.accessPointId}, "${sch.cronExpr}") fired`)
        }
      } catch (err: any) {
        this.logger.warn(`Schedule #${sch.id} tick failed: ${err.message}`)
        this.eventLog.warn('SCHEDULE', `⚠️ Schedule #${sch.id} failed: ${err.message}`, {
          scheduleId: sch.id,
          accessPointId: sch.accessPointId,
          cronExpr: sch.cronExpr,
        })
      }
    }
  }

  /**
   * Liczy okno [windowStart, now+lookahead] i sprawdza czy cron ma wpis w tym
   * oknie. Jeśli tak — odpala executor i markuje fired.
   *
   * Zwraca true gdy odpaliliśmy fire — caller logger.
   */
  private async tryFire(
    scheduleId: number,
    cronExpr: string,
    accessPointId: number,
    label: string | null,
    lastFiredAt: number | null,
    now: number,
  ): Promise<boolean> {
    const driftFloor = now - ScheduleService.DRIFT_TOLERANCE_MS
    const windowStart = Math.max(lastFiredAt ?? 0, driftFloor)
    const windowEnd = now + ScheduleService.LOOKAHEAD_MS

    let nextRunMs: number | null = null
    try {
      // currentDate = windowStart, endDate = windowEnd. parseExpression iteruje
      // od currentDate w przód. Pierwszy „next" w oknie = nasz cron-tick.
      const it = parseExpression(cronExpr, {
        currentDate: new Date(windowStart),
        endDate: new Date(windowEnd),
        utc: false,
      })
      const next = it.next()
      nextRunMs = next.getTime()
    } catch (err: any) {
      throw new Error(`bad cron "${cronExpr}": ${err.message}`)
    }

    // Brak iteracji = cron nie wypada w tym oknie.
    if (nextRunMs === null) return false
    // Defensive — parseExpression nie powinno zwrócić rzędu poza endDate,
    // ale podwójnie weryfikujemy.
    if (nextRunMs > windowEnd) return false

    // FIRE: oznacz `lastFiredAt` PRZED awaitem żeby double-tick (60s + 5s
    // overlap) nie odpalił dwa razy.
    this.store.apsMarkScheduleFired(scheduleId, nextRunMs)

    const ctx = {
      trigger: 'SCHEDULE' as const,
      actor: `SCHEDULE:${scheduleId}`,
      meta: {
        scheduleId,
        cronExpr,
        scheduleLabel: label,
        scheduledForMs: nextRunMs,
      },
    }
    await this.executor.fire(accessPointId, ctx)
    return true
  }
}
