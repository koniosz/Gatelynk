import { Injectable, Logger } from '@nestjs/common'
import { Interval } from '@nestjs/schedule'
import { Response } from 'express'
import { StoreService } from '../store/store.service'

export type LogLevel = 'info' | 'success' | 'warning' | 'error' | 'debug'

export interface LogEntry {
  id: number
  ts: string          // ISO timestamp
  level: LogLevel
  category: string    // e.g. 'RELAY', 'TUNNEL', 'HTTP', 'DEVICE'
  message: string
  detail?: string     // optional JSON / extra info
}

@Injectable()
export class EventLogService {
  private readonly fallbackLogger = new Logger(EventLogService.name)
  private counter = 0
  private readonly MAX = 500

  // StoreService jest @Global() — bez extra imports. Wszystkie wpisy idą też
  // do sqlite `event_log` table (persystencja, download z UI per 24h/3d/7d).
  constructor(private readonly store: StoreService) {}
  /**
   * Defensywny limit pojedynczego `detail` payload — chroni frontend (panel
   * Edge `/ui`) przed dławieniem się na wpisie 3+ MB.
   *
   * Naprawia bug 2026-05-14: LPR/intercom services czasem logują pełen XML
   * response z ISAPI / snapshot binarny jako `detail`. Pojedynczy 3MB entry w
   * buforze powodował, że `innerHTML = entries.map(buildLogRow).join('')`
   * w `index.html` blokował main thread na 5-10 sekund (regex replace
   * `escHtml` na 3MB stringu + layout reflow). Strona „zawieszała się".
   *
   * 4096 chars wystarczy do diagnostyki (HTTP request + 100-200 znaków
   * odpowiedzi). Pełny payload nadal trafia do `console.log` (Nest Logger)
   * i jest zachowany w log file PM2 / launchd.
   */
  private readonly MAX_DETAIL_LEN = 4096
  private buffer: LogEntry[] = []
  private clients: Response[] = []

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Konwertuje detail do stringa i obcina powyżej `MAX_DETAIL_LEN`. Suffix
   * `…(truncated, X total bytes)` informuje że płatność jest większa.
   */
  private formatDetail(detail: any): string | undefined {
    if (detail === undefined || detail === null) return undefined
    const raw = typeof detail === 'string' ? detail : JSON.stringify(detail)
    if (raw.length <= this.MAX_DETAIL_LEN) return raw
    return raw.slice(0, this.MAX_DETAIL_LEN) +
      `\n…(truncated, ${raw.length} total bytes)`
  }

  log(level: LogLevel, category: string, message: string, detail?: any) {
    const tsMs = Date.now()
    const entry: LogEntry = {
      id: ++this.counter,
      ts: new Date(tsMs).toISOString(),
      level,
      category,
      message,
      detail: this.formatDetail(detail),
    }

    // Circular buffer (in-memory, dla SSE catch-up po reconnect)
    this.buffer.push(entry)
    if (this.buffer.length > this.MAX) this.buffer.shift()

    // Persistent — sqlite `event_log` table. Try/catch żeby błąd zapisu (np. disk
    // full) nie psuł live SSE. Fail-soft: log do Nest Logger jako fallback.
    try {
      this.store.eventLogInsert({
        ts: tsMs,
        level,
        category,
        message,
        detail: entry.detail ?? null,
      })
    } catch (err: any) {
      this.fallbackLogger.warn(`event_log insert failed: ${err.message}`)
    }

    // Push to all SSE clients
    const payload = `data: ${JSON.stringify(entry)}\n\n`
    this.clients = this.clients.filter((c) => {
      try { c.write(payload); return true } catch { return false }
    })
  }

  info(category: string, message: string, detail?: any)    { this.log('info',    category, message, detail) }
  success(category: string, message: string, detail?: any) { this.log('success', category, message, detail) }
  warn(category: string, message: string, detail?: any)    { this.log('warning', category, message, detail) }
  error(category: string, message: string, detail?: any)   { this.log('error',   category, message, detail) }
  debug(category: string, message: string, detail?: any)   { this.log('debug',   category, message, detail) }

  getHistory(): LogEntry[] {
    return [...this.buffer]
  }

  // ── SSE subscription ────────────────────────────────────────────────────────

  addClient(res: Response) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.flushHeaders()

    // Send last 50 entries immediately as catch-up
    const catchUp = this.buffer.slice(-50)
    for (const e of catchUp) {
      res.write(`data: ${JSON.stringify(e)}\n\n`)
    }

    this.clients.push(res)
    res.on('close', () => {
      this.clients = this.clients.filter((c) => c !== res)
    })
  }

  // ── Retention sweep ─────────────────────────────────────────────────────────
  /**
   * 7-dniowe retention dla persystentnego `event_log`. Wystarczy do diagnostyki
   * + UI ma „pobierz logi z 7d" jako maksymalne okno. Dłuższe archiwum trzyma
   * Cloud (gdy dorobimy sync) lub pm2 log file (out.log / error.log).
   *
   * @Interval co godzinę (jak `HikvisionLprService.retentionSweep` dla lpr_reads).
   */
  @Interval(60 * 60 * 1000)
  retentionSweep() {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    try {
      const removed = this.store.eventLogSweepOld(cutoff)
      if (removed > 0) {
        this.fallbackLogger.log(`event_log retention: removed ${removed} row(s) older than 7 days`)
      }
    } catch (err: any) {
      this.fallbackLogger.warn(`event_log sweep failed: ${err.message}`)
    }
  }
}
