/**
 * Testy „Przepustki wyjazdowej" (exit grace pass) — czysta logika, bez SQLite.
 *
 * Uruchamianie (bez jest-a w Edge — node:test; UWAGA: `nest build` EXCLUDE-uje
 * `**\/*spec.ts` w tsconfig.build.json, więc spec kompilujemy standalone —
 * moduł jest czysty, bez zależności):
 *   node node_modules/typescript/bin/tsc --module commonjs --target es2022 \
 *     --moduleResolution node --esModuleInterop --strict \
 *     --outDir /tmp/exit-grace-test apps/edge/src/devices/cameras/exit-grace.util.spec.ts
 *   node --test /tmp/exit-grace-test/exit-grace.util.spec.js
 *
 * Pokrycie (wg zakresu w docs/exit-grace-pass.md):
 *   create/nadpisanie okna, consume (single-use), expiry, OPEN_AND_FLAG,
 *   DENY, near-miss-nie-otwiera (Levenshtein 1 tylko warning),
 *   confidence-za-niski, parsing configu, kierunek z linków LPR→AP.
 */
import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import {
  DEFAULT_EXIT_GRACE,
  parseExitGraceConfig,
  normalizeConfidence,
  confidenceAcceptable,
  resolveCameraExitDirection,
  decideExit,
  isLevenshteinOne,
  findNearMissPlate,
  type ExitPassRow,
  type ExitGraceConfig,
} from './exit-grace.util'

const T0 = Date.parse('2026-07-30T10:00:00Z')
const MIN = 60_000

function pass(over: Partial<ExitPassRow> = {}): ExitPassRow {
  return {
    plate: 'XY12345',
    enteredAt: T0,
    expiresAt: T0 + 15 * MIN,
    cameraDeviceId: 'cam-in',
    usedAt: null,
    ...over,
  }
}

const cfgFlag: ExitGraceConfig = { enabled: true, minutes: 15, afterExpiry: 'OPEN_AND_FLAG' }
const cfgDeny: ExitGraceConfig = { enabled: true, minutes: 15, afterExpiry: 'DENY' }

// ── Konfiguracja ────────────────────────────────────────────────────────────

test('parseExitGraceConfig: default = WYŁĄCZONE, 15 min, OPEN_AND_FLAG', () => {
  assert.deepEqual(parseExitGraceConfig(undefined), DEFAULT_EXIT_GRACE)
  assert.deepEqual(parseExitGraceConfig(null), DEFAULT_EXIT_GRACE)
  assert.deepEqual(parseExitGraceConfig('junk'), DEFAULT_EXIT_GRACE)
  assert.equal(DEFAULT_EXIT_GRACE.enabled, false)
})

test('parseExitGraceConfig: clamp minut 5–120, enabled tylko literalne true', () => {
  assert.equal(parseExitGraceConfig({ enabled: true, minutes: 1 }).minutes, 5)
  assert.equal(parseExitGraceConfig({ enabled: true, minutes: 999 }).minutes, 120)
  assert.equal(parseExitGraceConfig({ enabled: true, minutes: 30 }).minutes, 30)
  assert.equal(parseExitGraceConfig({ enabled: true, minutes: 'abc' }).minutes, 15)
  assert.equal(parseExitGraceConfig({ enabled: 'true' }).enabled, false)
  assert.equal(parseExitGraceConfig({ enabled: 1 }).enabled, false)
})

test('parseExitGraceConfig: afterExpiry tylko DENY|OPEN_AND_FLAG', () => {
  assert.equal(parseExitGraceConfig({ afterExpiry: 'DENY' }).afterExpiry, 'DENY')
  assert.equal(parseExitGraceConfig({ afterExpiry: 'OPEN_AND_FLAG' }).afterExpiry, 'OPEN_AND_FLAG')
  assert.equal(parseExitGraceConfig({ afterExpiry: 'BLOW_UP' }).afterExpiry, 'OPEN_AND_FLAG')
})

// ── Confidence ──────────────────────────────────────────────────────────────

test('normalizeConfidence: skala 0–100 → 0–1; 0/brak → null (nieznane)', () => {
  assert.equal(normalizeConfidence(95), 0.95)
  assert.equal(normalizeConfidence(0.85), 0.85)
  assert.equal(normalizeConfidence(100), 1)
  assert.equal(normalizeConfidence(0), null)
  assert.equal(normalizeConfidence(null), null)
  assert.equal(normalizeConfidence(undefined), null)
  assert.equal(normalizeConfidence(NaN), null)
})

test('confidence-za-niski: poniżej progu odrzucamy; null (kamera nie raportuje) akceptujemy', () => {
  assert.equal(confidenceAcceptable(0.75, 0.8), false)
  assert.equal(confidenceAcceptable(0.8, 0.8), true)
  assert.equal(confidenceAcceptable(0.95, 0.8), true)
  assert.equal(confidenceAcceptable(null, 0.8), true)
})

// ── Kierunek kamery z linków ────────────────────────────────────────────────

test('resolveCameraExitDirection: IN/OUT/MIXED/null', () => {
  assert.equal(resolveCameraExitDirection([]), null)
  assert.equal(resolveCameraExitDirection([{ direction: 'IN' }]), 'IN')
  assert.equal(resolveCameraExitDirection([{ direction: 'OUT' }, { direction: 'OUT' }]), 'OUT')
  assert.equal(resolveCameraExitDirection([{ direction: 'IN' }, { direction: 'OUT' }]), 'MIXED')
  // nieznana wartość traktowana jak IN (bezpieczniej: nie otwiera wyjazdu)
  assert.equal(resolveCameraExitDirection([{ direction: 'weird' }]), 'IN')
})

// ── decideExit: happy path + expiry + single-use ────────────────────────────

test('OPEN: ważna przepustka (≤ okno) otwiera z reason=exit_pass i dwellMinutes', () => {
  const d = decideExit(pass(), cfgFlag, T0 + 12 * MIN)
  assert.equal(d.action, 'OPEN')
  assert.equal(d.reason, 'exit_pass')
  if (d.action === 'OPEN') {
    assert.equal(d.dwellMinutes, 12)
    assert.equal(d.enteredAt, T0)
  }
})

test('OPEN: granica okna — dokładnie expiresAt jeszcze otwiera', () => {
  const d = decideExit(pass(), cfgFlag, T0 + 15 * MIN)
  assert.equal(d.action, 'OPEN')
})

test('nadpisanie: nowszy wjazd (świeższy expiresAt) wygrywa — decyzja liczy się od nowego okna', () => {
  // Symulacja INSERT OR REPLACE: ta sama tablica wjechała drugi raz później.
  const overwritten = pass({ enteredAt: T0 + 30 * MIN, expiresAt: T0 + 45 * MIN, usedAt: null })
  const d = decideExit(overwritten, cfgFlag, T0 + 40 * MIN)
  assert.equal(d.action, 'OPEN')
  if (d.action === 'OPEN') assert.equal(d.dwellMinutes, 10)
})

test('consume/single-use: zużyta przepustka (used_at) NIE otwiera ponownie', () => {
  const d = decideExit(pass({ usedAt: T0 + 5 * MIN }), cfgFlag, T0 + 6 * MIN)
  assert.deepEqual(d, { action: 'NONE', reason: 'pass_used' })
})

test('brak przepustki → NONE/no_pass (zachowanie jak dziś)', () => {
  assert.deepEqual(decideExit(null, cfgFlag, T0), { action: 'NONE', reason: 'no_pass' })
  assert.deepEqual(decideExit(undefined, cfgFlag, T0), { action: 'NONE', reason: 'no_pass' })
})

// ── Polityka po wygaśnięciu ─────────────────────────────────────────────────

test('OPEN_AND_FLAG: po oknie NADAL otwiera, reason=overstay (audyt + push)', () => {
  const d = decideExit(pass(), cfgFlag, T0 + 25 * MIN)
  assert.equal(d.action, 'OPEN_FLAG')
  assert.equal(d.reason, 'overstay')
  if (d.action === 'OPEN_FLAG') assert.equal(d.dwellMinutes, 25)
})

test('DENY: po oknie nie otwiera, reason=overstay_denied', () => {
  const d = decideExit(pass(), cfgDeny, T0 + 25 * MIN)
  assert.equal(d.action, 'DENY')
  assert.equal(d.reason, 'overstay_denied')
})

test('DENY: w oknie polityka nie ma znaczenia — otwiera normalnie', () => {
  const d = decideExit(pass(), cfgDeny, T0 + 5 * MIN)
  assert.equal(d.action, 'OPEN')
})

// ── Near-miss (Levenshtein 1) — tylko warning, nie otwiera ──────────────────

test('isLevenshteinOne: substytucja / insercja / delecja = true', () => {
  assert.equal(isLevenshteinOne('WO71843', 'W071843'), true)  // O↔0 substytucja
  assert.equal(isLevenshteinOne('XY1234', 'XY12345'), true)   // delecja na końcu
  assert.equal(isLevenshteinOne('XY12345', 'XYX12345'), true) // insercja w środku
})

test('isLevenshteinOne: identyczne / odległość 2+ = false', () => {
  assert.equal(isLevenshteinOne('XY12345', 'XY12345'), false)
  assert.equal(isLevenshteinOne('XY12345', 'XX12344'), false) // 2 substytucje
  assert.equal(isLevenshteinOne('XY12345', 'XY123'), false)   // 2 delecje
  assert.equal(isLevenshteinOne('AB', 'BA'), false)           // transpozycja = 2 ops
})

test('findNearMissPlate: znajduje kandydata o odległości 1, pomija exact i dalekie', () => {
  assert.equal(findNearMissPlate('W071843', ['AB1234', 'WO71843']), 'WO71843')
  assert.equal(findNearMissPlate('W071843', ['W071843']), null) // exact ≠ near-miss
  assert.equal(findNearMissPlate('W071843', ['ZZ9999']), null)
  assert.equal(findNearMissPlate('W071843', []), null)
})
