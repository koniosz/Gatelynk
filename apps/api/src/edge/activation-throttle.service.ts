import { Injectable, Logger } from '@nestjs/common'

/**
 * PR-1 (2026-07) — ręczny in-memory rate-limiter dla publicznego
 * `POST /api/edge/activate`.
 *
 * Dlaczego nie `@nestjs/throttler`: świadoma decyzja, żeby NIE dodawać nowej
 * zależności npm — API żyje na pojedynczej instancji Fly, więc lokalna pamięć
 * procesu wystarcza (brak potrzeby współdzielonego store'a Redis). Gdy
 * kiedykolwiek pojawi się druga instancja, trzeba przejść na throttler z
 * centralnym storage — patrz TODO w raporcie PR-1.
 *
 * Limity (sliding window, per klucz):
 *   • 5 prób / 60 s
 *   • 30 prób / 3600 s
 * liczone OSOBNO per IP i per kod aktywacyjny — atakujący z botnetu (wiele IP,
 * jeden kod) wpada na limit per-kod, a skanujący kody z jednego IP na per-IP.
 *
 * Pamięć: timestamps trzymamy max 1 h; sweep przy każdym wywołaniu (tanie)
 * + twardy cap na liczbę kluczy (ochrona przed memory-flood spoofowanymi IP:
 * po przekroczeniu capu nowe klucze są odrzucane — fail-closed, bo to endpoint
 * używany raz na aktywację urządzenia, nie ścieżka user-facing).
 */

const WINDOW_MINUTE_MS = 60_000
const WINDOW_HOUR_MS = 3_600_000
const LIMIT_PER_MINUTE = 5
const LIMIT_PER_HOUR = 30
const MAX_TRACKED_KEYS = 10_000

@Injectable()
export class ActivationThrottleService {
  private readonly logger = new Logger(ActivationThrottleService.name)
  /** klucz (`ip:<addr>` | `code:<kod>`) → posortowane timestampy prób (ms) */
  private readonly hits = new Map<string, number[]>()
  private lastSweep = 0

  /**
   * Rejestruje próbę i zwraca czy jest dozwolona. Wywołanie NAJPIERW
   * rejestruje (żeby odrzucone próby też liczyły się do okna — inaczej
   * atakujący spamujący 429 nigdy nie powiększa swojego okna).
   */
  consume(ip: string, activationCode: string): boolean {
    const now = Date.now()
    this.sweepIfDue(now)

    const ipAllowed = this.consumeKey(`ip:${ip}`, now)
    // Pusty kod nie tworzy klucza per-kod (walidacja DTO i tak odrzuci) —
    // ale IP już zaliczyło próbę.
    const codeAllowed = activationCode
      ? this.consumeKey(`code:${activationCode}`, now)
      : true

    const allowed = ipAllowed && codeAllowed
    if (!allowed) {
      this.logger.warn(
        `Activation throttled — ip=${ip} code=${activationCode ? activationCode.slice(0, 8) + '…' : '(empty)'} ` +
        `(ipAllowed=${ipAllowed} codeAllowed=${codeAllowed})`,
      )
    }
    return allowed
  }

  private consumeKey(key: string, now: number): boolean {
    let arr = this.hits.get(key)
    if (!arr) {
      if (this.hits.size >= MAX_TRACKED_KEYS) {
        // Memory-flood guard: nie śledzimy nowych kluczy → fail-closed.
        this.logger.warn(`Throttle map full (${MAX_TRACKED_KEYS} keys) — rejecting new key ${key.slice(0, 24)}`)
        return false
      }
      arr = []
      this.hits.set(key, arr)
    }
    // Wytnij wpisy starsze niż największe okno (1 h)
    const hourCutoff = now - WINDOW_HOUR_MS
    while (arr.length > 0 && arr[0] < hourCutoff) arr.shift()

    arr.push(now)

    if (arr.length > LIMIT_PER_HOUR) return false
    const minuteCutoff = now - WINDOW_MINUTE_MS
    let inMinute = 0
    for (let i = arr.length - 1; i >= 0 && arr[i] >= minuteCutoff; i--) inMinute++
    return inMinute <= LIMIT_PER_MINUTE
  }

  /** Pełny sweep mapy co ~5 min — usuwa klucze bez prób w ostatniej godzinie. */
  private sweepIfDue(now: number) {
    if (now - this.lastSweep < 5 * 60_000) return
    this.lastSweep = now
    const cutoff = now - WINDOW_HOUR_MS
    for (const [key, arr] of this.hits) {
      if (arr.length === 0 || arr[arr.length - 1] < cutoff) this.hits.delete(key)
    }
  }
}
