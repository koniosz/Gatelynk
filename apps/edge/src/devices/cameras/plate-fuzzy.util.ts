/**
 * Łagodne dopasowanie tablicy do rejestru (2026-09-15) — czysta logika.
 *
 * Powód: 13.09 17:51 mieszkaniec (WE387YT) wjechał tuż za poprzednim autem,
 * kamera zebrała JEDNĄ czytelną klatkę i odczytała „WE38711" (Y→1, T→1).
 * Ścisły OCR-fuzzy w HikvisionLprService zna tylko pary o podobnym kształcie
 * (0/O, 1/I/L, 5/S, 8/B…), a odczyt jednoklatkowy w ogóle nie wchodził do
 * rejestru — przejazd zniknął z panelu i z pusha.
 *
 * Ten moduł liczy KOSZT różnicy między odczytem a każdą tablicą z rejestru:
 *   • znak identyczny → 0,
 *   • znaki z tej samej klasy pomyłek OCR → 1,
 *   • cokolwiek innego → dopasowanie odrzucone (twarda różnica).
 * Wynik jest akceptowany tylko, gdy DOKŁADNIE JEDNA tablica z rejestru mieści
 * się w budżecie (2 pomyłki dla tablic 7-znakowych, 1 dla krótszych).
 * Dwie tablice w budżecie = niejednoznaczność = brak dopasowania.
 *
 * UŻYCIE: wyłącznie do oznaczania odczytu jako „prawdopodobny" (powiadomienie,
 * wpis w historii). NIGDY do otwierania bramy — bramę otwiera tylko odczyt
 * ścisły albo ścisły OCR-fuzzy.
 */

/** Klasy znaków mylonych przez OCR — wariant łagodny (szerszy niż OCR_EQUIV_SETS). */
export const LENIENT_EQUIV_SETS: readonly (readonly string[])[] = [
  ['0', 'O', 'Q', 'D', 'U'],
  ['1', 'I', 'L', 'T', 'Y', '7'],
  ['5', 'S'],
  ['8', 'B', '3'],
  ['2', 'Z'],
  ['6', 'G'],
  ['4', 'A'],
  ['E', 'F'],
  ['W', 'V', 'N', 'M'],
  ['K', 'X'],
  ['H', 'N', 'M'],
  ['C', 'G'],
  ['P', 'R'],
]

const CONFUSABLE_PAIRS: Set<string> = (() => {
  const s = new Set<string>()
  for (const set of LENIENT_EQUIV_SETS) {
    for (const a of set) for (const b of set) if (a !== b) s.add(a + b)
  }
  return s
})()

export function isConfusable(a: string, b: string): boolean {
  return a === b || CONFUSABLE_PAIRS.has(a + b)
}

/** Koszt różnicy albo null, gdy tablice różnią się długością lub twardo. */
export function lenientCost(candidate: string, plate: string): number | null {
  if (candidate.length !== plate.length) return null
  let cost = 0
  for (let i = 0; i < candidate.length; i++) {
    const a = candidate[i]
    const b = plate[i]
    if (a === b) continue
    if (!CONFUSABLE_PAIRS.has(a + b)) return null
    cost += 1
  }
  return cost
}

export interface LenientMatch {
  /** Tablica z rejestru. */
  plate: string
  /** Który z kandydatów OCR dał to dopasowanie. */
  raw: string
  cost: number
}

export interface LenientMatchOutcome {
  match: LenientMatch | null
  /** Więcej niż jedna tablica z rejestru mieściła się w budżecie — nie zgadujemy. */
  ambiguous: boolean
}

export function maxCostFor(plate: string): number {
  return plate.length >= 7 ? 2 : 1
}

/**
 * @param candidates znormalizowane odczyty OCR (najlepszy + alternatywy z głosowania)
 * @param whitelist  znormalizowane tablice z rejestru kamery
 */
export function lenientPlateMatch(
  candidates: readonly string[],
  whitelist: readonly string[],
  opts: { minLength?: number } = {},
): LenientMatchOutcome {
  const minLength = opts.minLength ?? 5
  const seen = new Set<string>()
  const hits = new Map<string, LenientMatch>()

  for (const rawCandidate of candidates) {
    const candidate = (rawCandidate ?? '').toUpperCase()
    if (!candidate || candidate.length < minLength || seen.has(candidate)) continue
    seen.add(candidate)
    for (const plate of whitelist) {
      if (!plate || plate.length < minLength) continue
      const cost = lenientCost(candidate, plate)
      if (cost === null || cost > maxCostFor(plate)) continue
      const prev = hits.get(plate)
      if (!prev || cost < prev.cost) hits.set(plate, { plate, raw: candidate, cost })
    }
  }

  if (hits.size === 0) return { match: null, ambiguous: false }
  if (hits.size > 1) {
    // Wyjątek: kandydat trafia jedną tablicę DOKŁADNIE (koszt 0) — to zwykłe
    // dopasowanie ścisłe, którego nie unieważnia druga tablica w budżecie.
    const exact = [...hits.values()].filter((h) => h.cost === 0)
    if (exact.length === 1) return { match: exact[0], ambiguous: false }
    return { match: null, ambiguous: true }
  }
  return { match: [...hits.values()][0], ambiguous: false }
}
