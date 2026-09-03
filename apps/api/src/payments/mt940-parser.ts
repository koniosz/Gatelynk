// mt940-parser.ts — własny, tolerancyjny parser wyciągów bankowych MT940 (PL).
//
// Format MT940 jest liniowy: pola zaczynają się od `:NN:` / `:NNa:`, linie
// kontynuacji nie zaczynają się od `:`. Interesują nas:
//   :20:  — referencja wyciągu
//   :25:  — numer rachunku
//   :28C: — numer wyciągu
//   :60F: — saldo otwarcia
//   :61:  — transakcja (data waluty YYMMDD, kierunek C/D, kwota z przecinkiem)
//   :86:  — szczegóły transakcji (tytuł, nadawca)
//   :62F: — saldo zamknięcia
//
// Polskie banki różnią się formatem subpól w :86: — mBank/PKO używają `~NN`,
// ING `<NN` (każde subpole w osobnej linii), niektóre `^NN`. Parsujemy
// tolerancyjnie: zawsze zachowujemy surowy opis (rawDetails), a subpola
// ~20–~25 (tytuł), ~32/~33 (nadawca), ~38 (rachunek nadawcy) wyciągamy
// best-effort. Brak subpól => title/senderName zostają null, rawDetails
// służy do heurystyk dopasowania.

export interface Mt940Transaction {
  /** Data waluty z :61: (YYMMDD → 20YY-MM-DD, UTC) */
  valueDate: Date
  /** C = uznanie (wpłata), D = obciążenie; storna RC/RD mapowane na C/D z reversal=true */
  direction: 'C' | 'D'
  reversal: boolean
  amount: number
  /** Referencja bankowa (fragment po `//`) albo referencja klienta z :61: */
  reference: string | null
  /** Pełna, sklejona zawartość :86: (bez separatorów subpól) */
  rawDetails: string
  /** Tytuł przelewu — subpola 20–25 jeśli obecne */
  title: string | null
  /** Nazwa nadawcy — subpola 32–33 jeśli obecne */
  senderName: string | null
  /** Rachunek nadawcy — subpole 38 jeśli obecne */
  senderAccount: string | null
}

export interface Mt940Statement {
  reference: string | null
  accountNumber: string | null
  statementNumber: string | null
  openingBalance: number | null
  closingBalance: number | null
  currency: string | null
  transactions: Mt940Transaction[]
}

/**
 * Dekoduje surowy bufor pliku MT940 do stringa. Polskie banki eksportują
 * często w windows-1250 — próbujemy najpierw ścisłego UTF-8, przy błędzie
 * dekodujemy jako cp1250 (Node TextDecoder z pełnym ICU wspiera 'windows-1250').
 */
export function decodeMt940Buffer(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    try {
      return new TextDecoder('windows-1250').decode(buf)
    } catch {
      // Node bez pełnego ICU — fallback latin1 (znaki PL zniekształcone, ale parsowalne)
      return buf.toString('latin1')
    }
  }
}

interface RawField {
  tag: string
  value: string // wraz z liniami kontynuacji, rozdzielone '\n'
}

/** Tnie zawartość na pola :NN(a): z liniami kontynuacji. Obsługuje CRLF i CR. */
function tokenizeFields(content: string): RawField[] {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const fields: RawField[] = []
  let current: RawField | null = null

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    // koniec bloku SWIFT ("-") albo pusta linia — nie zamyka pola na siłę,
    // ale samotny "-" ignorujemy
    if (line.trim() === '-') continue
    const m = line.match(/^:(\d{2}[A-Z]?):(.*)$/)
    if (m) {
      if (current) fields.push(current)
      current = { tag: m[1], value: m[2] }
    } else if (current) {
      current.value += '\n' + line
    }
    // linie przed pierwszym polem (nagłówki {1:...}) — ignorowane
  }
  if (current) fields.push(current)
  return fields
}

/** Parsuje kwotę "1234,56" / "1234," / "1234" → number */
function parseAmount(s: string): number {
  const normalized = s.replace(/\./g, '').replace(',', '.')
  const n = parseFloat(normalized)
  return Number.isFinite(n) ? n : 0
}

/** Parsuje YYMMDD → Date (UTC, 20YY). Zwraca null przy nonsensownej dacie. */
function parseYYMMDD(s: string): Date | null {
  if (!/^\d{6}$/.test(s)) return null
  const y = 2000 + parseInt(s.slice(0, 2), 10)
  const mo = parseInt(s.slice(2, 4), 10)
  const d = parseInt(s.slice(4, 6), 10)
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return new Date(Date.UTC(y, mo - 1, d))
}

// :61: — data waluty (6n), opcjonalna data księgowania (4n), kierunek
// (RC/RD/EC/ED/CR/DR/C/D — dłuższe najpierw!), opcjonalna litera funds-code,
// kwota z przecinkiem, reszta (kod transakcji + referencje).
const LINE_61 = /^(\d{6})(\d{4})?(RC|RD|EC|ED|CR|DR|C|D)([A-Z])?(\d{1,15},\d{0,2}|\d{1,15})(.*)$/s

function parse61(value: string): Omit<Mt940Transaction, 'rawDetails' | 'title' | 'senderName' | 'senderAccount'> | null {
  const firstLine = value.split('\n')[0]
  const rest = value.split('\n').slice(1).join('')
  const m = firstLine.match(LINE_61)
  if (!m) return null
  const [, dateStr, , dirRaw, , amountStr, tail] = m
  const valueDate = parseYYMMDD(dateStr)
  if (!valueDate) return null

  const reversal = dirRaw.startsWith('R') || dirRaw.startsWith('E')
  const direction: 'C' | 'D' = dirRaw.endsWith('C') || dirRaw === 'C' ? 'C' : 'D'

  // referencja: po '//' referencja bankowa; wcześniej Nxxx + ref klienta
  let reference: string | null = null
  const tailAll = (tail ?? '') + rest
  const slashIdx = tailAll.indexOf('//')
  if (slashIdx >= 0) {
    reference = tailAll.slice(slashIdx + 2).trim().split('\n')[0].slice(0, 64) || null
  }
  if (!reference) {
    // Nxxx<ref klienta> — utnij kod transakcji (litera + 3 znaki)
    const cust = tailAll.replace(/^[A-Z][A-Z0-9]{3}/, '').trim()
    if (cust && cust.toUpperCase() !== 'NONREF') reference = cust.slice(0, 64)
  }

  return { valueDate, direction, reversal, amount: parseAmount(amountStr), reference }
}

interface Details86 {
  rawDetails: string
  title: string | null
  senderName: string | null
  senderAccount: string | null
}

function parse86(value: string): Details86 {
  // wykryj separator subpól: ~NN / <NN / ^NN
  const sepMatch = value.match(/([~<^])(\d{2})/)
  const raw = value
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!sepMatch) {
    return { rawDetails: raw.slice(0, 1000), title: null, senderName: null, senderAccount: null }
  }

  const sep = sepMatch[1]
  // podziel na subpola: sep + 2 cyfry + treść
  const re = new RegExp(`\\${sep}(\\d{2})([^${sep === '^' ? '\\^' : sep}]*)`, 'g')
  const normalized = value.replace(/\n/g, sep === '<' ? '' : ' ') // ING: subpola w liniach zaczynających się od '<'
  const sub: Record<string, string> = {}
  let m: RegExpExecArray | null
  const source = sep === '<' ? value.replace(/\n</g, '<') : normalized
  while ((m = re.exec(source)) !== null) {
    const code = m[1]
    const text = m[2].replace(/\n/g, ' ').trim()
    sub[code] = (sub[code] ? sub[code] + ' ' : '') + text
  }

  const titleParts = ['20', '21', '22', '23', '24', '25']
    .map(c => sub[c])
    .filter((s): s is string => !!s && s.length > 0)
  const senderParts = ['32', '33']
    .map(c => sub[c])
    .filter((s): s is string => !!s && s.length > 0)

  const cleanRaw = raw.replace(new RegExp(`\\${sep}\\d{2}`, 'g'), ' ').replace(/\s+/g, ' ').trim()

  return {
    rawDetails: cleanRaw.slice(0, 1000),
    title: titleParts.length ? titleParts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 500) : null,
    senderName: senderParts.length ? senderParts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 200) : null,
    senderAccount: sub['38']?.trim().slice(0, 40) || null,
  }
}

/** Parsuje :60F:/:62F: — [C|D]YYMMDD3!a kwota → signed number */
function parseBalance(value: string): { amount: number; currency: string | null } | null {
  const m = value.trim().match(/^(C|D)(\d{6})([A-Z]{3})(\d{1,15},?\d{0,2})/)
  if (!m) return null
  const sign = m[1] === 'C' ? 1 : -1
  return { amount: sign * parseAmount(m[4]), currency: m[3] }
}

/**
 * Główna funkcja — parsuje zawartość pliku MT940 (jeden lub więcej wyciągów
 * w jednym pliku) do płaskiej listy transakcji.
 */
export function parseMt940(content: string): Mt940Statement {
  const fields = tokenizeFields(content)

  const stmt: Mt940Statement = {
    reference: null,
    accountNumber: null,
    statementNumber: null,
    openingBalance: null,
    closingBalance: null,
    currency: null,
    transactions: [],
  }

  let pending: ReturnType<typeof parse61> = null

  const flush = (details: Details86 | null) => {
    if (!pending) return
    stmt.transactions.push({
      ...pending,
      rawDetails: details?.rawDetails ?? '',
      title: details?.title ?? null,
      senderName: details?.senderName ?? null,
      senderAccount: details?.senderAccount ?? null,
    })
    pending = null
  }

  for (const f of fields) {
    switch (f.tag) {
      case '20':
        if (!stmt.reference) stmt.reference = f.value.trim().slice(0, 64) || null
        break
      case '25':
        if (!stmt.accountNumber) stmt.accountNumber = f.value.trim().replace(/\s/g, '').slice(0, 40) || null
        break
      case '28C':
      case '28':
        if (!stmt.statementNumber) stmt.statementNumber = f.value.trim().slice(0, 20) || null
        break
      case '60F':
      case '60M': {
        const b = parseBalance(f.value)
        if (b && stmt.openingBalance === null) {
          stmt.openingBalance = b.amount
          stmt.currency = stmt.currency ?? b.currency
        }
        break
      }
      case '62F':
      case '62M': {
        const b = parseBalance(f.value)
        if (b) stmt.closingBalance = b.amount
        break
      }
      case '61':
        flush(null) // poprzednia transakcja bez :86:
        pending = parse61(f.value)
        break
      case '86':
        if (pending) {
          flush(parse86(f.value))
        }
        break
      default:
        break
    }
  }
  flush(null)

  return stmt
}
