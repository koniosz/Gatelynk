/**
 * Przyjazd śmieciarki z klatek wizji (2026-10-02) — czysta logika, bez I/O.
 * Testy: `waste-truck.util.spec.ts` (node:test, kompilacja standalone).
 *
 * Pojedyncza klatka to za mało (dostawczak bywa klasyfikowany jako śmieciarka
 * z pewnością 0.5), dlatego wizyta jest POTWIERDZONA dopiero, gdy w ciągu
 * `confirmWindowMs` pojawi się druga kwalifikująca klatka — z dowolnej kamery
 * (śmieciarka przejeżdża przez osiedle, widzą ją kolejne kamery). Pomiar VN
 * 2026-10-02: 08:39 (napis firmy) + 08:43 (inna kamera, MIXED 0.5) → wizyta
 * potwierdzona o 08:43; 25.09 jedna klatka bez potwierdzenia → brak wizyty.
 */

export interface WasteFrame {
  id: number
  ts: number
  cameraDeviceId: string
  wasteCategory: string | null
  wasteConf: number | null
  wasteOperator: string | null
}

export interface WasteVisit {
  startTs: number
  /** Moment drugiej kwalifikującej klatki — od tej chwili wizyta jest pewna. */
  confirmedTs: number
  endTs: number
  frames: WasteFrame[]
}

export const WASTE_MIN_CONF = 0.5

/** Klatka się liczy, gdy model rozpoznał frakcję z pewnością ≥0.5 albo napis firmy. */
export function isWasteFrame(f: WasteFrame): boolean {
  if (f.wasteOperator && f.wasteOperator.trim()) return true
  return !!f.wasteCategory && (f.wasteConf ?? 0) >= WASTE_MIN_CONF
}

export function findWasteVisits(
  frames: WasteFrame[],
  opts: { gapMs?: number; confirmWindowMs?: number } = {},
): WasteVisit[] {
  const gapMs = opts.gapMs ?? 20 * 60_000
  const confirmWindowMs = opts.confirmWindowMs ?? 10 * 60_000
  const list = frames.filter(isWasteFrame).sort((a, b) => a.ts - b.ts)
  const out: WasteVisit[] = []
  let cur: WasteFrame[] = []

  const flush = () => {
    if (cur.length < 2) { cur = []; return }
    let confirmedTs: number | null = null
    for (let i = 1; i < cur.length && confirmedTs == null; i++) {
      if (cur[i].ts - cur[i - 1].ts <= confirmWindowMs) confirmedTs = cur[i].ts
    }
    if (confirmedTs != null) {
      out.push({ startTs: cur[0].ts, confirmedTs, endTs: cur[cur.length - 1].ts, frames: cur })
    }
    cur = []
  }

  for (const f of list) {
    if (cur.length && f.ts - cur[cur.length - 1].ts > gapMs) flush()
    cur.push(f)
  }
  flush()
  return out
}
