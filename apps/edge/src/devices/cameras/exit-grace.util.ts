/**
 * exit-grace.util — czysta (bez NestJS/SQLite) logika „Przepustki wyjazdowej"
 * (Exit Grace Pass, koncepcja: docs/exit-grace-pass.md, 2026-07-30).
 *
 * Zasada: pojazd SPOZA białej listy, który wjechał na osiedle (kamera IN,
 * LPR no-match), dostaje efemeryczną przepustkę na wyjazd. Kamera OUT przy
 * no-match sprawdza przepustkę:
 *   • ważna (≤ okno, default 15 min)  → OTWÓRZ + zużyj (single-use),
 *   • wygasła                         → polityka `afterExpiry`:
 *       - OPEN_AND_FLAG (default) → otwórz + zdarzenie OVERSTAY (nikt nie
 *         zostaje uwięziony przy szlabanie),
 *       - DENY → nie otwieraj (kierowca dzwoni domofonem),
 *   • brak przepustki                 → zachowanie jak dotychczas (nic).
 *
 * Wydzielone do czystego modułu żeby dało się testować bez better-sqlite3
 * (wzorzec `guest-restrictions.util.ts` — node:test na skompilowanym dist):
 *
 *   pnpm --filter @gatelynk/edge build
 *   node --test apps/edge/dist/devices/cameras/exit-grace.util.spec.js
 *
 * UWAGA bezpieczeństwo: przepustka działa WYŁĄCZNIE na kierunek OUT —
 * niczego nie wpuszcza, więc nie osłabia whitelisty wjazdu.
 */

// ── Konfiguracja (Building.features.exitGrace, sync przez BUILDING_CONFIG_UPDATE) ──

export interface ExitGraceConfig {
  /** Default WYŁĄCZONE — po deployu nic się nie zmienia do włączenia w panelu. */
  enabled: boolean
  /** Okno ważności przepustki w minutach (5–120, default 15). */
  minutes: number
  /** Co po upływie okna przy próbie wyjazdu. Decyzja właściciela: OPEN_AND_FLAG. */
  afterExpiry: 'OPEN_AND_FLAG' | 'DENY'
}

export const EXIT_GRACE_MIN_MINUTES = 5
export const EXIT_GRACE_MAX_MINUTES = 120

export const DEFAULT_EXIT_GRACE: ExitGraceConfig = {
  enabled: false,
  minutes: 15,
  afterExpiry: 'OPEN_AND_FLAG',
}

/**
 * Sanityzacja configu z payloadu BUILDING_CONFIG_UPDATE (JSON z Cloud —
 * nie ufamy kształtowi). Nieznane/braki → defaulty; minutes clamp 5–120.
 */
export function parseExitGraceConfig(raw: unknown): ExitGraceConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_EXIT_GRACE }
  const o = raw as Record<string, unknown>
  const minutesNum = Number(o.minutes)
  const minutes = Number.isFinite(minutesNum)
    ? Math.min(EXIT_GRACE_MAX_MINUTES, Math.max(EXIT_GRACE_MIN_MINUTES, Math.round(minutesNum)))
    : DEFAULT_EXIT_GRACE.minutes
  const afterExpiry: ExitGraceConfig['afterExpiry'] =
    o.afterExpiry === 'DENY' ? 'DENY' : 'OPEN_AND_FLAG'
  return {
    enabled: o.enabled === true,
    minutes,
    afterExpiry,
  }
}

// ── Confidence OCR ──────────────────────────────────────────────────────────

/**
 * Hikvision `confidenceLevel` przychodzi w skali 0–100 (DeepinView),
 * ale trzymamy tolerancję na firmware raportujący 0–1. Brak tagu → parser
 * daje 0 → traktujemy jako „nieznane" (null).
 */
export function normalizeConfidence(raw: number | null | undefined): number | null {
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return null
  return raw > 1 ? Math.min(1, raw / 100) : raw
}

/**
 * Minimalny próg confidence — żeby misread nie tworzył/nie konsumował
 * przepustki (koncepcja §2). `null` (kamera nie raportuje confidence) →
 * akceptujemy: kamera i tak filtruje po swoim MinTrustLevel
 * (patrz `setConfidence` w hikvision-lpr.service).
 */
export function confidenceAcceptable(confidence: number | null, threshold: number): boolean {
  if (confidence == null) return true
  return confidence >= threshold
}

// ── Kierunek kamery (z linków LPR→AP, jak reszta flow LPR) ──────────────────

/**
 * Kierunek bierzemy z `lpr_camera_ap_links.direction` (nie z tagu <direction>
 * kamery — linki są źródłem prawdy dla całego LPR). Kamera z linkami
 * wyłącznie IN → 'IN'; wyłącznie OUT → 'OUT'; mieszane → 'MIXED' (exit-grace
 * pomija taką kamerę — nie da się jednoznacznie stwierdzić wjazd/wyjazd);
 * brak linków → null (legacy single-link config, exit-grace nieaktywne).
 */
export function resolveCameraExitDirection(
  links: Array<{ direction: string }>,
): 'IN' | 'OUT' | 'MIXED' | null {
  if (links.length === 0) return null
  const dirs = new Set(links.map((l) => (l.direction === 'OUT' ? 'OUT' : 'IN')))
  if (dirs.size > 1) return 'MIXED'
  return dirs.has('OUT') ? 'OUT' : 'IN'
}

// ── Decyzja wyjazdowa ───────────────────────────────────────────────────────

/** Wiersz `exit_passes` (Edge SQLite). plate = plate_norm (PK). */
export interface ExitPassRow {
  plate: string
  enteredAt: number
  expiresAt: number
  cameraDeviceId: string
  usedAt: number | null
}

export type ExitDecision =
  | { action: 'OPEN'; reason: 'exit_pass'; enteredAt: number; expiresAt: number; dwellMinutes: number }
  | { action: 'OPEN_FLAG'; reason: 'overstay'; enteredAt: number; expiresAt: number; dwellMinutes: number }
  | { action: 'DENY'; reason: 'overstay_denied'; enteredAt: number; expiresAt: number; dwellMinutes: number }
  | { action: 'NONE'; reason: 'no_pass' | 'pass_used' }

/**
 * Decyzja przy no-match na kamerze OUT.
 *
 *   • brak wiersza          → NONE/no_pass (zachowanie jak dziś)
 *   • used_at != null       → NONE/pass_used (single-use; auto które wyjechało
 *                             i wróciło podlega normalnym regułom)
 *   • now ≤ expiresAt       → OPEN/exit_pass
 *   • now  > expiresAt      → wg polityki: OPEN_FLAG/overstay | DENY/overstay_denied
 */
export function decideExit(
  pass: ExitPassRow | null | undefined,
  cfg: ExitGraceConfig,
  nowMs: number,
): ExitDecision {
  if (!pass) return { action: 'NONE', reason: 'no_pass' }
  if (pass.usedAt != null) return { action: 'NONE', reason: 'pass_used' }
  const dwellMinutes = Math.max(0, Math.round((nowMs - pass.enteredAt) / 60_000))
  const base = { enteredAt: pass.enteredAt, expiresAt: pass.expiresAt, dwellMinutes }
  if (nowMs <= pass.expiresAt) {
    return { action: 'OPEN', reason: 'exit_pass', ...base }
  }
  return cfg.afterExpiry === 'DENY'
    ? { action: 'DENY', reason: 'overstay_denied', ...base }
    : { action: 'OPEN_FLAG', reason: 'overstay', ...base }
}

// ── Near-miss (Levenshtein 1) — TYLKO warning w logu, NIE otwiera ───────────

/**
 * Czy odległość edycyjna a↔b wynosi DOKŁADNIE 1 (jedna substytucja,
 * insercja lub delecja). Identyczne stringi → false (exact match jest
 * obsłużony wcześniej osobną ścieżką).
 */
export function isLevenshteinOne(a: string, b: string): boolean {
  if (a === b) return false
  const la = a.length
  const lb = b.length
  if (Math.abs(la - lb) > 1) return false
  if (la === lb) {
    // dokładnie jedna substytucja
    let diffs = 0
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i]) {
        diffs++
        if (diffs > 1) return false
      }
    }
    return diffs === 1
  }
  // |la - lb| == 1 → jedna insercja/delecja
  const [shorter, longer] = la < lb ? [a, b] : [b, a]
  let i = 0
  let j = 0
  let skipped = false
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++
      j++
    } else {
      if (skipped) return false
      skipped = true
      j++ // pomiń jeden znak w dłuższym
    }
  }
  return true // reszta (ostatni znak dłuższego) to dozwolona jedyna różnica
}

/**
 * Znajdź near-miss (odległość 1) wśród aktywnych przepustek. Zwraca
 * pierwszą pasującą tablicę albo null. Wynik służy WYŁĄCZNIE do warninga
 * w logu (tuning OCR w przyszłości) — świadomie NIE otwieramy bramy.
 */
export function findNearMissPlate(plate: string, candidates: string[]): string | null {
  for (const c of candidates) {
    if (isLevenshteinOne(plate, c)) return c
  }
  return null
}
