import { BadRequestException, Controller, Get, Header, Query, Res } from '@nestjs/common'
import { Response } from 'express'
import { EventLogService } from './event-log.service'
import { StoreService } from '../store/store.service'

/**
 * Endpointy panelu logów:
 *   GET /logs              — last 500 (in-memory ring buffer, JSON)
 *   GET /logs/stream       — SSE stream (live)
 *   GET /logs/export       — pobieranie persystentnego archiwum z sqlite z time-range
 *
 * Export semantyka:
 *   `range`  = `24h` | `3d` | `7d` (default `24h`). Konkretne wartości w godzinach
 *              żeby nie liczyć kalendarza (1d ≠ 24h gdy DST/leap second, ale dla
 *              audytu wystarczy okno czasowe).
 *   `format` = `txt` | `json` | `csv` (default `txt`). TXT to standardowy
 *              `YYYY-MM-DD HH:MM:SS [LEVEL] [CATEGORY] message — detail`,
 *              idealny do attach do bug reportu.
 *   `levels` = comma-separated (`error,warning`). Bez filtra → wszystko.
 */
@Controller('logs')
export class EventLogController {
  constructor(
    private logs: EventLogService,
    private store: StoreService,
  ) {}

  /** Last 500 entries as JSON (in-memory ring buffer — live tail). */
  @Get()
  history() {
    return this.logs.getHistory()
  }

  /** SSE stream — browser connects with EventSource('/logs/stream') */
  @Get('stream')
  stream(@Res() res: Response) {
    this.logs.addClient(res)
  }

  /**
   * Pobieranie archiwum logów z time-range.
   *
   * Streamowanie: dla 7-dniowego okna może być ~14k wpisów = ~3 MB. Zwracamy
   * `res.send()` całość — sqlite SELECT robi to w jednej transakcji szybko
   * (indeks `event_log_ts_idx`). Header `Content-Disposition: attachment`
   * wymusza pobranie zamiast wyświetlenia w przeglądarce.
   */
  @Get('export')
  @Header('Cache-Control', 'no-store')
  exportLogs(
    @Query('range') range: string = '24h',
    @Query('format') format: string = 'txt',
    @Query('levels') levelsRaw: string | undefined,
    @Res() res: Response,
  ): void {
    const windowMs = parseRange(range)
    const sinceMs = Date.now() - windowMs
    const levels = levelsRaw
      ? levelsRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined

    const rows = this.store.eventLogQuery({ sinceMs, levels })

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const baseFilename = `gatelynk-edge-logs_${range}_${stamp}`

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="${baseFilename}.json"`)
      res.send(JSON.stringify({
        exportedAt: new Date().toISOString(),
        range,
        sinceMs,
        entriesCount: rows.length,
        entries: rows.map((r) => ({
          ts: new Date(r.ts).toISOString(),
          level: r.level,
          category: r.category,
          message: r.message,
          detail: r.detail,
        })),
      }, null, 2))
      return
    }

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="${baseFilename}.csv"`)
      const csvEscape = (v: string | null) => {
        if (v == null) return ''
        if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`
        return v
      }
      const lines: string[] = ['ts,level,category,message,detail']
      for (const r of rows) {
        lines.push([
          new Date(r.ts).toISOString(),
          r.level,
          r.category,
          csvEscape(r.message),
          csvEscape(r.detail),
        ].join(','))
      }
      res.send(lines.join('\n'))
      return
    }

    // Default txt — najczytelniejszy dla człowieka, kopiuj-wklej do bug reportu.
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${baseFilename}.log"`)
    const lines: string[] = [
      `# GateLynk Edge — event log export`,
      `# Exported: ${new Date().toISOString()}`,
      `# Range:    ${range} (since ${new Date(sinceMs).toISOString()})`,
      `# Levels:   ${levels ? levels.join(',') : 'all'}`,
      `# Entries:  ${rows.length}`,
      '',
    ]
    for (const r of rows) {
      const ts = formatTimestamp(r.ts)
      const lvl = r.level.toUpperCase().padEnd(7)
      const cat = `[${r.category}]`
      let line = `${ts} [${lvl.trim()}] ${cat} ${r.message}`
      if (r.detail) {
        // Single-line detail, no newlines in main row — multi-line detail goes on
        // continuation lines with indent for grep-friendly format.
        const cleanDetail = r.detail.replace(/\n/g, '\\n')
        line += `\n    └── ${cleanDetail}`
      }
      lines.push(line)
    }
    res.send(lines.join('\n'))
  }
}

/** Parses `24h`/`3d`/`7d` etc. into milliseconds. Throws BadRequest on invalid input. */
function parseRange(input: string): number {
  const match = input.match(/^(\d+)([hd])$/)
  if (!match) {
    throw new BadRequestException(
      `Invalid range "${input}". Use e.g. "24h", "3d", "7d".`,
    )
  }
  const n = parseInt(match[1], 10)
  const unit = match[2]
  const ms = unit === 'd' ? n * 24 * 3600_000 : n * 3600_000
  // Hard cap 30 dni (sqlite retention to 7d, ale bądź defensywny przy parsie)
  if (ms <= 0 || ms > 30 * 24 * 3600_000) {
    throw new BadRequestException(`Range "${input}" out of bounds (1h..30d)`)
  }
  return ms
}

/** `YYYY-MM-DD HH:MM:SS` w lokalnej strefie. */
function formatTimestamp(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return [
    d.getFullYear(), '-', pad(d.getMonth() + 1), '-', pad(d.getDate()),
    ' ',
    pad(d.getHours()), ':', pad(d.getMinutes()), ':', pad(d.getSeconds()),
  ].join('')
}
