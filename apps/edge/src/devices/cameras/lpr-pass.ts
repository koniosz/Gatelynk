/**
 * Decyzja w TRAKCIE serii klatek (2026-09-29) — zamiast „pobierz 5 klatek,
 * potem policz", głosujemy po każdej klatce i strzelamy, gdy tylko wynik jest
 * pewny. Czysta logika, bez I/O — testowana standalone (`lpr-pass.spec.ts`).
 *
 * Dlaczego (VN, WE1MH70): od zdarzenia kamery do decyzji mijało ~3,7 s
 * (5 klatek co 500 ms + wspólny OCR), a i tak w 52 % przejazdów tablica była
 * czytelna tylko na 2 z 5 klatek — okno czytelności jest krótkie, więc rzadkie
 * próbkowanie je gubi. Teraz klatki lecą bez przerw (~4–5/s), a rejestr osiedla
 * jest silnym priorem: dwie klatki wskazujące TĘ SAMĄ tablicę z rejestru to
 * wystarczający dowód, żeby otworzyć — losowy błąd OCR nie trafia dwa razy
 * w tablicę z rejestru.
 */

export interface PassCandidate {
  plate: string
  confidence: number
}

/** Zwraca tablicę z rejestru kamery (ścisłe lub OCR-fuzzy dopasowanie) albo null. */
export type WhitelistResolver = (plate: string) => string | null

export interface EarlyDecision {
  plate: string
  confidence: number
  frames: number
}

interface Group {
  /** Ostateczna pisownia: z rejestru (gdy dopasowana) albo najczęstsza z OCR. */
  whitelisted: string | null
  frames: Set<number>
  bestConf: number
  spellings: Map<string, number>
}

/** Dwie klatki z rejestru — albo jedna bardzo pewna (odczyt z powiększenia). */
export const EARLY_MIN_FRAMES = 2
export const EARLY_MIN_CONF = 0.4
export const EARLY_SINGLE_FRAME_CONF = 0.85
/** Premia za każdą kolejną zgodną klatkę — jak w `voteAcrossFrames`. */
const AGREEMENT_BONUS = 0.15

/** Znaki mylone przez OCR sprowadzone do jednej klasy — do scalania głosów. */
export function canonicalKey(plate: string): string {
  return plate.replace(/[OQ]/g, '0').replace(/I/g, '1').replace(/S/g, '5').replace(/Z/g, '2').replace(/B/g, '8')
}

export class PassAccumulator {
  private readonly groups = new Map<string, Group>()

  add(frameIdx: number, candidates: PassCandidate[], resolve: WhitelistResolver) {
    for (const { plate, confidence } of candidates) {
      if (!plate) continue
      const wl = resolve(plate)
      const key = wl ? `W:${wl}` : `K:${canonicalKey(plate)}`
      let g = this.groups.get(key)
      if (!g) {
        g = { whitelisted: wl, frames: new Set(), bestConf: 0, spellings: new Map() }
        this.groups.set(key, g)
      }
      g.frames.add(frameIdx)
      g.bestConf = Math.max(g.bestConf, confidence)
      g.spellings.set(plate, (g.spellings.get(plate) ?? 0) + 1)
    }
  }

  /**
   * Wczesna decyzja: JEDNA tablica z rejestru z ≥2 zgodnymi klatkami (albo
   * jedną bardzo pewną). Dwie różne tablice z rejestru spełniające warunek =
   * niejednoznaczność → czekamy na koniec okna (nie otwieramy „na chybił trafił").
   */
  earlyDecision(): EarlyDecision | null {
    const hits: EarlyDecision[] = []
    for (const g of this.groups.values()) {
      if (!g.whitelisted) continue
      const n = g.frames.size
      const ok = (n >= EARLY_MIN_FRAMES && g.bestConf >= EARLY_MIN_CONF)
        || (n >= 1 && g.bestConf >= EARLY_SINGLE_FRAME_CONF)
      if (ok) hits.push({ plate: g.whitelisted, confidence: this.score(g), frames: n })
    }
    if (hits.length !== 1) return null
    return hits[0]
  }

  /** Wynik na koniec okna — kształt zgodny z dawnym `voteAcrossFrames`. */
  final(): { best: PassCandidate | null; agreedFrames: number; candidates: Array<PassCandidate & { frames: number }> } {
    const scored = [...this.groups.values()]
      .map((g) => ({ plate: this.spelling(g), confidence: this.score(g), frames: g.frames.size }))
      .sort((a, b) => b.confidence - a.confidence || b.frames - a.frames)
    const top = scored[0]
    return {
      best: top ? { plate: top.plate, confidence: top.confidence } : null,
      agreedFrames: top?.frames ?? 0,
      candidates: scored.slice(0, 5),
    }
  }

  get size(): number { return this.groups.size }

  private score(g: Group): number {
    return Math.min(1, g.bestConf + AGREEMENT_BONUS * (g.frames.size - 1))
  }

  private spelling(g: Group): string {
    if (g.whitelisted) return g.whitelisted
    let best = ''
    let n = -1
    for (const [s, c] of g.spellings) if (c > n) { best = s; n = c }
    return best
  }
}
