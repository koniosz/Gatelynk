// PR-5 (2026-07-05) — tolerancyjny parser CSV dla importu mieszkańców.
//
// Zero zależności zewnętrznych. Tolerancje:
//   • separator wykrywany automatycznie: `;` (Excel PL) / `,` / tab,
//   • BOM (UTF-8) na początku pliku,
//   • pola w cudzysłowach (w tym `""` escape i separator wewnątrz),
//   • CRLF i LF,
//   • polskie nagłówki z diakrytykami i bez („imię"/„imie", „nr lokalu"...),
//   • puste linie pomijane.

export interface ParsedCsvRow {
  /** 1-based numer wiersza DANYCH (bez nagłówka) — do raportu błędów. */
  rowNumber: number
  firstName: string
  lastName: string
  email: string
  phone: string
  unitNumber: string
  street: string
}

export interface ParsedCsv {
  rows: ParsedCsvRow[]
  /** Nagłówki nierozpoznane przez aliasy — informacyjnie do UI. */
  unknownHeaders: string[]
  /** Które z wymaganych kolumn znaleziono. */
  matchedColumns: string[]
  delimiter: string
}

type ColumnKey = 'firstName' | 'lastName' | 'email' | 'phone' | 'unitNumber' | 'street'

// Aliasy nagłówków — porównanie po normalizacji (lowercase, bez diakrytyków,
// bez kropek, pojedyncze spacje).
const HEADER_ALIASES: Record<ColumnKey, string[]> = {
  firstName: ['imie', 'first name', 'firstname', 'first_name'],
  lastName: ['nazwisko', 'last name', 'lastname', 'surname', 'last_name'],
  email: ['email', 'e-mail', 'mail', 'adres email', 'adres e-mail', 'e mail'],
  phone: [
    'telefon', 'phone', 'tel', 'nr telefonu', 'numer telefonu',
    'nr tel', 'komorka', 'telefon komorkowy',
  ],
  unitNumber: [
    'lokal', 'mieszkanie', 'nr lokalu', 'numer lokalu', 'nr mieszkania',
    'numer mieszkania', 'numer', 'nr', 'dom', 'nr domu', 'numer domu',
    'apartament', 'unit', 'lokal nr', 'nr lok',
  ],
  street: ['ulica', 'street', 'adres', 'ul'],
}

function normalizeHeader(h: string): string {
  return h
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l')
    .replace(/[."']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Wykrycie separatora po pierwszej niepustej linii (poza cudzysłowami). */
function detectDelimiter(firstLine: string): string {
  const counts: Record<string, number> = { ';': 0, ',': 0, '\t': 0 }
  let inQuotes = false
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes
    else if (!inQuotes && ch in counts) counts[ch]++
  }
  // Excel PL zapisuje średnikami — preferencja przy remisie.
  if (counts[';'] >= counts[','] && counts[';'] >= counts['\t'] && counts[';'] > 0) return ';'
  if (counts['\t'] > counts[',']) return '\t'
  return ','
}

/** Parsowanie CSV na tablicę wierszy pól (obsługa cudzysłowów + escape ""). */
function parseCsvText(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else field += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      row.push(field); field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      rows.push(row); row = []
    } else {
      field += ch
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  // pomiń całkiem puste linie
  return rows.filter((r) => r.some((f) => f.trim() !== ''))
}

export function parseResidentsCsv(rawText: string): ParsedCsv {
  const text = rawText.replace(/^\uFEFF/, '')
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? ''
  const delimiter = detectDelimiter(firstLine)
  const table = parseCsvText(text, delimiter)
  if (table.length === 0) {
    return { rows: [], unknownHeaders: [], matchedColumns: [], delimiter }
  }

  const headerCells = table[0].map(normalizeHeader)
  const columnAt = new Map<number, ColumnKey>()
  const unknownHeaders: string[] = []
  const used = new Set<ColumnKey>()
  for (let i = 0; i < headerCells.length; i++) {
    const h = headerCells[i]
    let matched: ColumnKey | null = null
    for (const key of Object.keys(HEADER_ALIASES) as ColumnKey[]) {
      if (used.has(key)) continue
      if (HEADER_ALIASES[key].includes(h)) { matched = key; break }
    }
    if (matched) { columnAt.set(i, matched); used.add(matched) }
    else if (h) unknownHeaders.push(table[0][i].trim())
  }

  const rows: ParsedCsvRow[] = []
  for (let r = 1; r < table.length; r++) {
    const cells = table[r]
    const row: ParsedCsvRow = {
      rowNumber: r,
      firstName: '', lastName: '', email: '', phone: '', unitNumber: '', street: '',
    }
    for (const [idx, key] of columnAt) {
      row[key] = (cells[idx] ?? '').trim()
    }
    rows.push(row)
  }

  return { rows, unknownHeaders, matchedColumns: [...used], delimiter }
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
