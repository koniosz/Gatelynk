/**
 * Fast-path keyword routing (2026-05-18).
 *
 * Bypass dla najczęstszych pytań — bezpośrednio mapuje natural language
 * przez regex na konkretny tool call, formatuje odpowiedź szablonem.
 * Cel: <1s response time dla 60-80% codziennych zapytań.
 *
 * **Kiedy bypass działa:**
 *  - Pytanie pasuje do jednego z patternów poniżej
 *  - User nie podał ambiguous follow-up (np. "a w nocy?", "tylko czarne")
 *  - History pusty (fresh question) — multi-turn dialog idzie do LLM
 *
 * **Kiedy LLM dostaje query:**
 *  - Brak match w patterns
 *  - History > 0 (follow-up requiring context)
 *  - Complex query (multi-tool, semantic ambiguity)
 *
 * Każdy pattern handler musi:
 *  1. Zwrócić strukturę z tool exec result
 *  2. Lub null jeśli nie pasuje (Edge fallback do LLM)
 *
 * Performance: regex match + sqlite SELECT = ~5-20ms total. Vs LLM ~30-120s.
 */
import { TOOLS } from './assistant.tools'
import type { StoreService } from '../store/store.service'

export interface FastPathResult {
  answer: string
  trace: Array<{
    name: string
    args: Record<string, unknown>
    resultPreview: string
    durationMs: number
  }>
}

/**
 * Czas-słowa → range string (taki sam jak akceptuje parseRangeMs w tools).
 * Mapping rozszerzony — łapie literówki i alternatywy.
 */
function extractRange(q: string): string {
  if (/(godzin\w*|hour|hr|now|teraz)/i.test(q)) return '1h'
  if (/(rano|morning|przedpolud)\w*/i.test(q)) return '12h'
  if (/(dzi[sś]\w*|today|dzisiaj|dzisiej)\w*/i.test(q)) return '24h'
  if (/(wczoraj\w*|yesterday)/i.test(q)) return '48h'
  if (/(tygod\w*|week|w\s+tygodniu)/i.test(q)) return '7d'
  if (/(2\s*tygod\w*|dwa\s*tygod\w*|14\s*dni|fortnight)/i.test(q)) return '14d'
  if (/(miesi[aą]c\w*|month|miesi[ee]czn\w*)/i.test(q)) return '30d'
  if (/(rok\w*|year|roczn\w*)/i.test(q)) return '365d'
  // "ostatnio", "kiedyś", "wcześniej", "previously" — szerokie okno bo user
  // explicit nie wskazuje "dziś"/"wczoraj".
  if (/(ostatnio|kiedy[sś]?|wcze[sś]niej|previously|recently|earlier|last\s+time)/i.test(q))
    return '30d'
  return '24h' // default
}

/**
 * Wykrywa carrier name w pytaniu. Lista oparta na realnych ekspedytorach
 * obsługujących Polskę (2026). Substring match case-insensitive.
 */
const KNOWN_CARRIERS = [
  'DHL', 'InPost', 'DPD', 'Glovo', 'GLS', 'UPS', 'FedEx', 'TNT',
  'Pocztex', 'Poczta', 'Allegro One', 'Allegro',
  'Frisco', 'Pyszne', 'Wolt', 'Uber Eats', 'Bolt',
  'Kashmir', 'Kimi Sushi', 'Sakana', 'La Patata',  // restauracje z whitelist
  'Ogrodnicy', 'Frisco', 'Serwis rowerowy',         // service
]

function extractCarrier(q: string): string | null {
  // Normalizuj: lower-case + usuń spacje/myślniki. Łapie wariacje pisowni:
  // "La Patata" ↔ "lapatata" ↔ "la-patata".
  const norm = (s: string) => s.toLowerCase().replace(/[\s\-_]+/g, '')
  const normQ = norm(q)
  for (const c of KNOWN_CARRIERS) {
    if (normQ.includes(norm(c))) return c
  }
  return null
}

/** Liczba w pytaniu typu "5 ostatnich", "ostatnie 10". Default 5. */
function extractLimit(q: string, defaultN = 5): number {
  const m = q.match(/(\d+)/)
  if (!m) return defaultN
  const n = parseInt(m[1], 10)
  return n > 0 && n <= 50 ? n : defaultN
}

/**
 * Format timestamp "YYYY-MM-DD HH:MM" dla user-facing odpowiedzi.
 * Edge backend zwraca z tools w formacie ISO — przepisujemy na PL friendly.
 */
function fmtTime(ts: number | string): string {
  const date = typeof ts === 'number' ? new Date(ts) : new Date(ts)
  return date.toLocaleString('pl-PL', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

// ─────────────────────────────────────────────────────────────────────────
// Pattern handlers — każdy może zwrócić FastPathResult lub null (fallback).
// ─────────────────────────────────────────────────────────────────────────

/**
 * "Kiedy ostatnio był (kurier) X?" → list_gate_openings(carrier=X, range=30d).
 * Bierze pierwszy z courierList — to chronologically najnowszy.
 */
async function handleLastVisitOfCarrier(q: string, store: StoreService): Promise<FastPathResult | null> {
  const isWhen = /(kiedy|when|o\s+kt[oó]rej|kiedy\s+ostatnio)/i.test(q)
  if (!isWhen) return null
  const carrier = extractCarrier(q)
  if (!carrier) return null

  const tool = TOOLS.find((t) => t.name === 'list_gate_openings')
  if (!tool) return null

  const args = { carrier, range: extractRange(q) }
  // Jeśli pytanie "ostatnio" bez explicit time → wymuś 30d (szukaj szeroko)
  if (/(ostatnio|kiedy[sś]?|recently|last\s+time)/i.test(q) && args.range === '24h') {
    args.range = '30d'
  }

  const start = Date.now()
  const result = (await tool.run(args, { store })) as Record<string, unknown>
  const durationMs = Date.now() - start

  const list = (result.courierList as string[] | undefined) ?? []
  if (list.length === 0) {
    return {
      answer: `Brak wizyt ${carrier} w okresie ${args.range}.`,
      trace: [{ name: tool.name, args, resultPreview: JSON.stringify(result).slice(0, 200), durationMs }],
    }
  }

  // courierList items: "2026-05-18T11:23:00Z WN9026S [Kurier Inpost, Ford, Transit, white, van, biały, InPost]"
  const latest = list[0]
  const tsMatch = latest.match(/^([\d-]+T[\d:]+Z)\s+(\S+)/)
  const ts = tsMatch ? tsMatch[1] : ''
  const plate = tsMatch ? tsMatch[2] : ''
  const tagsMatch = latest.match(/\[([^\]]+)\]/)
  const tags = tagsMatch ? tagsMatch[1] : ''

  const when = ts ? fmtTime(ts) : 'nieznany czas'
  const answer = list.length === 1
    ? `Ostatnia wizyta ${carrier}: **${when}**, tablica ${plate}${tags ? ` (${tags})` : ''}.`
    : `Ostatnia wizyta ${carrier}: **${when}**, tablica ${plate}${tags ? ` (${tags})` : ''}. ` +
      `Łącznie w okresie ${args.range}: ${list.length} wizyt.`

  return {
    answer,
    trace: [{
      name: tool.name, args,
      resultPreview: `courierVisits=${list.length}, latest=${latest.slice(0, 100)}`,
      durationMs,
    }],
  }
}

/**
 * "Ile dziś/wczoraj kurier(ów)?" → count gate openings.
 * Też: "ile bram otworzyło się", "ile wjazdów".
 */
async function handleCounts(q: string, store: StoreService): Promise<FastPathResult | null> {
  if (!/ile/i.test(q)) return null
  const range = extractRange(q)

  // "ile kurierów" / "ile bram" / "ile wjazdów"
  const isCourier = /kurier|courier/i.test(q)
  const isGates   = /bram|gate/i.test(q)
  const isEntries = /wjazd|entry|wjech\w*/i.test(q)
  if (!isCourier && !isGates && !isEntries) return null

  const tool = TOOLS.find((t) => t.name === 'list_gate_openings')
  if (!tool) return null

  const carrier = extractCarrier(q)
  const args: Record<string, unknown> = { range }
  if (carrier) args.carrier = carrier

  const start = Date.now()
  const result = (await tool.run(args, { store })) as Record<string, unknown>
  const durationMs = Date.now() - start

  const periodLabel = {
    '1h': 'w ostatniej godzinie', '12h': 'rano', '24h': 'dziś',
    '48h': 'wczoraj+dziś', '7d': 'w tygodniu', '14d': 'w 2 tygodniach',
    '30d': 'w miesiącu', '365d': 'w roku',
  }[range] ?? `w ostatnich ${range}`

  let answer: string
  if (isCourier) {
    const subject = carrier ? `${carrier}` : 'kurierów'
    answer = `${capitalize(periodLabel)} było **${result.courierVisits} wizyt** ${subject}.`
  } else if (isGates || isEntries) {
    answer = `${capitalize(periodLabel)} brama otworzyła się **${result.gateOpeningsTotal} razy** ` +
             `(${result.gateOpeningsByMethod}).`
  } else {
    return null
  }

  return {
    answer,
    trace: [{ name: tool.name, args, resultPreview: JSON.stringify(result).slice(0, 200), durationMs }],
  }
}

/**
 * "Pokaż/daj N ostatnich (wjazdów|odczytów|tablic)" → list_lpr_reads.
 */
async function handleLastN(q: string, store: StoreService): Promise<FastPathResult | null> {
  if (!/(poka[zż]|daj|list|show|wymie\w*)/i.test(q)) return null
  if (!/(ostatnich|ostatnie|last|recent)/i.test(q)) return null
  const isReads = /(odczyt|read|tablic|plate)\w*/i.test(q)
  const isEntries = /(wjazd|entry|wjech)\w*/i.test(q)
  if (!isReads && !isEntries) return null

  const limit = extractLimit(q, 5)
  const range = extractRange(q)
  const carrier = extractCarrier(q)

  if (isEntries) {
    // Wjazdy = gate openings z whitelist
    const tool = TOOLS.find((t) => t.name === 'list_gate_openings')
    if (!tool) return null
    const args: Record<string, unknown> = { range }
    if (carrier) args.carrier = carrier
    const start = Date.now()
    const result = (await tool.run(args, { store })) as Record<string, unknown>
    const durationMs = Date.now() - start
    const list = ((result.courierList as string[]) ?? []).slice(0, limit)
    if (list.length === 0) {
      return {
        answer: `Brak wjazdów w okresie ${range}${carrier ? ` (${carrier})` : ''}.`,
        trace: [{ name: tool.name, args, resultPreview: 'empty', durationMs }],
      }
    }
    const lines = list.map((entry, i) => {
      const ts = entry.match(/^(\S+)/)?.[1] ?? ''
      const plate = entry.match(/^\S+\s+(\S+)/)?.[1] ?? ''
      const tags = entry.match(/\[([^\]]+)\]/)?.[1] ?? ''
      return `${i + 1}. ${plate} (${fmtTime(ts)})${tags ? ` — ${tags}` : ''}`
    }).join('\n')
    return {
      answer: `Ostatnie ${list.length} wjazd${list.length === 1 ? '' : list.length < 5 ? 'y' : 'ów'}:\n${lines}`,
      trace: [{ name: tool.name, args, resultPreview: `${list.length} entries`, durationMs }],
    }
  }

  // isReads — wszystkie LPR reads (matched + unmatched).
  // BUG fix: list_lpr_reads ma rawLimit=args.limit, tzn. limituje sqlite SELECT
  // PRZED filtrem ts >= sinceMs. Jeśli limit=3 a 3 najnowsze są starsze niż
  // range → filtered.length = 0. Trzeba przekazać większy raw limit (30) i tu
  // post-slice. 30 jest tool-max-limit, nie eksploduje.
  const tool = TOOLS.find((t) => t.name === 'list_lpr_reads')
  if (!tool) return null
  const args: Record<string, unknown> = { range, limit: 30 }
  const start = Date.now()
  const result = (await tool.run(args, { store })) as Record<string, unknown>
  const durationMs = Date.now() - start
  const reads = ((result.reads as Array<Record<string, unknown>>) ?? []).slice(0, limit)
  if (reads.length === 0) {
    return {
      answer: `Brak odczytów w okresie ${range}.`,
      trace: [{ name: tool.name, args, resultPreview: 'empty', durationMs }],
    }
  }
  const lines = reads.map((r, i) => {
    const ts = r.ts as string
    const plate = r.plate as string
    const matched = r.matched as boolean
    const color = r.color as string | null
    const brand = r.brand as string | null
    const unit = r.unitLabel as string | null
    const tagsParts = [color, brand].filter(Boolean).join(', ')
    const tagsStr = tagsParts ? ` [${tagsParts}]` : ''
    const unitStr = unit ? ` (${unit})` : ''
    const matchStr = matched ? '' : ' [nieznana]'
    return `${i + 1}. ${plate}${unitStr}${tagsStr}${matchStr} — ${fmtTime(ts)}`
  }).join('\n')
  return {
    answer: `Ostatnie ${reads.length} odczyt${reads.length === 1 ? '' : 'ów'}:\n${lines}`,
    trace: [{ name: tool.name, args, resultPreview: `${reads.length} reads`, durationMs }],
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Główna funkcja routingowa. Testuje patterny po kolei, zwraca pierwszy hit.
 *
 * @param question normalized user question (trim, lower-case allowed)
 * @param store StoreService instance for SQL queries
 * @returns FastPathResult lub null gdy fallback do LLM
 */
export async function tryFastPath(
  question: string,
  store: StoreService,
): Promise<FastPathResult | null> {
  const q = question.trim()
  if (q.length < 4) return null

  // Test handlers w kolejności specyficzności (most-specific first):
  // 1. "Kiedy ostatnio X" — bardzo konkretny, lookup last visit
  const lastVisit = await handleLastVisitOfCarrier(q, store)
  if (lastVisit) return lastVisit

  // 2. "Ile ..." — count queries
  const counts = await handleCounts(q, store)
  if (counts) return counts

  // 3. "Pokaż N ostatnich ..." — list queries
  const lastN = await handleLastN(q, store)
  if (lastN) return lastN

  // 4. "Czy był/była X?" — yes/no carrier query → list_gate_openings(carrier=X)
  const yesNo = await handleYesNoCarrier(q, store)
  if (yesNo) return yesNo

  // Knowledge base searches idą do LLM bo wymagają semantic understanding +
  // odpowiedniego cytowania źródeł. Fast-path tylko dla strukturalnych query.

  // Brak match — fallback do LLM
  return null
}

/**
 * "Czy był/była/jechał (kurier) X (dzisiaj|wczoraj|w tygodniu)?" →
 * list_gate_openings({carrier:X, range:Y}). Yes/no question pattern.
 */
async function handleYesNoCarrier(q: string, store: StoreService): Promise<FastPathResult | null> {
  const carrier = extractCarrier(q)
  if (!carrier) return null

  // Trigger: czy/was/did/był/była LUB short follow-up "A X?", "I X?",
  // "And X?" — wszystko gdzie carrier wystąpił + pytanie ma <8 słów.
  // Logika: jeśli user wymienił carrier explicit, fast-path go obsłuży.
  const isYesNo  = /(czy|was|did|byl[ao]?)/i.test(q)
  const isShort  = q.trim().split(/\s+/).length <= 8
  const isFollow = /^(a|i|and|but|to)\s+/i.test(q.trim())
  if (!isYesNo && !(isShort && isFollow)) return null

  const tool = TOOLS.find((t) => t.name === 'list_gate_openings')
  if (!tool) return null

  const range = extractRange(q)
  const args = { carrier, range }
  const start = Date.now()
  const result = (await tool.run(args, { store })) as Record<string, unknown>
  const durationMs = Date.now() - start

  const list = (result.courierList as string[] | undefined) ?? []
  const periodLabel = {
    '1h': 'w ostatniej godzinie', '12h': 'rano', '24h': 'dziś',
    '48h': 'wczoraj', '7d': 'w tygodniu', '14d': 'w 2 tygodniach',
    '30d': 'w miesiącu', '365d': 'w roku',
  }[range] ?? `w ostatnich ${range}`

  if (list.length === 0) {
    return {
      answer: `Nie, ${carrier} nie był ${periodLabel}.`,
      trace: [{ name: tool.name, args, resultPreview: 'courierVisits=0', durationMs }],
    }
  }

  // Pokaż 1-3 wizyty z konkretnymi godzinami
  const top = list.slice(0, 3).map((entry) => {
    const ts = entry.match(/^(\S+)/)?.[1] ?? ''
    const plate = entry.match(/^\S+\s+(\S+)/)?.[1] ?? ''
    return `${fmtTime(ts)} (${plate})`
  }).join(', ')
  const more = list.length > 3 ? ` i ${list.length - 3} więcej` : ''
  return {
    answer: `Tak, ${carrier} ${periodLabel}: ${top}${more}.`,
    trace: [{ name: tool.name, args, resultPreview: `${list.length} visits`, durationMs }],
  }
}
