/**
 * Time formatting w strefie czasowej Edge (urządzenia w budynku), NIE
 * w strefie browsera admina.
 *
 * Dlaczego: dane (LPR reads, vision detections, access events, anomaly events)
 * pochodzą z Edge w budynku (Mac Mini), który stoi w Polsce. Admin loguje się
 * z dowolnego miejsca świata — gdy widzi „13:36", to zawsze ma być czas LOKALNY
 * BUDYNKU, nie jego browsera. Inaczej admin z UK widziałby `13:36` jako `12:36`
 * i mylił się porównując notatki z konsjerżem na miejscu.
 *
 * **Strefa hardcoded `Europe/Warsaw`** — Villa Natura + wszystkie obecne i
 * planowane PL deployments. Gdy przyjdzie pierwszy klient zagraniczny, dodamy
 * `Building.timezone` w bazie + zaczerpniemy z props/contextu zamiast hardcode.
 *
 * `ts` accepts ISO 8601 string (`2026-05-27T11:36:05.123Z`) lub epoch ms (number)
 * — typowy backend zwraca string, Edge SQLite trzyma ms; format helper przyjmuje
 * oba.
 */

const BUILDING_TIMEZONE = 'Europe/Warsaw' as const

type Variant =
  | 'datetime'      // "27.05.2026, 13:36" — default dla list/tabel
  | 'datetime-sec'  // "27.05.2026, 13:36:05" — szczegóły / modal
  | 'short'         // "27.05, 13:36" — kompakt do wąskich kolumn
  | 'time'          // "13:36" — gdy data jest oczywista z kontekstu
  | 'time-sec'      // "13:36:05"
  | 'date'          // "27.05.2026"

const formatters: Partial<Record<Variant, Intl.DateTimeFormat>> = {}

function getFormatter(variant: Variant): Intl.DateTimeFormat {
  // Cache instancje — `Intl.DateTimeFormat` jest stosunkowo drogi przy konstrukcji
  // (10-50ms), a w jednej tabeli LPR robimy go 50-500x.
  const cached = formatters[variant]
  if (cached) return cached
  const opts: Intl.DateTimeFormatOptions = { timeZone: BUILDING_TIMEZONE }
  switch (variant) {
    case 'datetime':
      Object.assign(opts, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      break
    case 'datetime-sec':
      Object.assign(opts, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      break
    case 'short':
      Object.assign(opts, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      break
    case 'time':
      Object.assign(opts, { hour: '2-digit', minute: '2-digit' })
      break
    case 'time-sec':
      Object.assign(opts, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      break
    case 'date':
      Object.assign(opts, { day: '2-digit', month: '2-digit', year: 'numeric' })
      break
  }
  const f = new Intl.DateTimeFormat('pl-PL', opts)
  formatters[variant] = f
  return f
}

export function formatBuildingTime(ts: string | number | Date, variant: Variant = 'datetime'): string {
  const d = ts instanceof Date ? ts : new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return getFormatter(variant).format(d)
}

/** Strefa czasowa używana do renderowania — dla badge-y informacyjnych w UI. */
export const buildingTimezone = BUILDING_TIMEZONE
