/**
 * Testy decyzji w trakcie serii klatek — czysta logika.
 *   node node_modules/typescript/bin/tsc --module commonjs --target es2022 \
 *     --moduleResolution node --esModuleInterop --strict --types node \
 *     --outDir /tmp/lpr-pass-test apps/edge/src/devices/cameras/lpr-pass.spec.ts
 *   node --test /tmp/lpr-pass-test/lpr-pass.spec.js
 */
import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { PassAccumulator, canonicalKey } from './lpr-pass'

const WL = new Set(['WE1MH70', 'WA4883L'])
const resolve = (p: string) => {
  if (WL.has(p)) return p
  for (const w of WL) if (canonicalKey(w) === canonicalKey(p)) return w   // OCR-fuzzy jak na Edge
  return null
}

test('dwie klatki z tą samą tablicą z rejestru → decyzja bez czekania na resztę', () => {
  const acc = new PassAccumulator()
  acc.add(0, [{ plate: 'WE1MH70', confidence: 0.55 }], resolve)
  assert.equal(acc.earlyDecision(), null, 'po jednej klatce o średniej pewności — jeszcze nie')
  acc.add(1, [{ plate: 'WE1MH70', confidence: 0.6 }], resolve)
  const d = acc.earlyDecision()
  assert.ok(d && d.plate === 'WE1MH70' && d.frames === 2)
})

test('jedna klatka, ale bardzo pewna (odczyt z powiększenia) → decyzja od razu', () => {
  const acc = new PassAccumulator()
  acc.add(0, [{ plate: 'WA4883L', confidence: 0.9 }], resolve)
  assert.ok(acc.earlyDecision()?.plate === 'WA4883L')
})

test('błąd OCR (O zamiast 0) scala się z poprawnym odczytem tej samej tablicy', () => {
  const acc = new PassAccumulator()
  acc.add(0, [{ plate: 'WE1MH7O', confidence: 0.5 }], resolve)
  acc.add(1, [{ plate: 'WE1MH70', confidence: 0.5 }], resolve)
  const d = acc.earlyDecision()
  assert.ok(d && d.plate === 'WE1MH70' && d.frames === 2, 'dwie pisownie = jeden głos na tablicę z rejestru')
})

test('tablica SPOZA rejestru nigdy nie daje wczesnej decyzji, ale wygrywa na koniec okna', () => {
  const acc = new PassAccumulator()
  for (let i = 0; i < 3; i++) acc.add(i, [{ plate: 'DJ1023F', confidence: 0.7 }], resolve)
  assert.equal(acc.earlyDecision(), null)
  const f = acc.final()
  assert.equal(f.best?.plate, 'DJ1023F')
  assert.equal(f.agreedFrames, 3)
  assert.ok((f.best?.confidence ?? 0) > 0.7, 'premia za zgodne klatki')
})

test('dwie RÓŻNE tablice z rejestru spełniające próg → niejednoznaczne, bez wczesnego otwarcia', () => {
  const acc = new PassAccumulator()
  acc.add(0, [{ plate: 'WE1MH70', confidence: 0.9 }, { plate: 'WA4883L', confidence: 0.9 }], resolve)
  assert.equal(acc.earlyDecision(), null)
})

test('na koniec okna pisownia z rejestru wygrywa nad surową z OCR', () => {
  const acc = new PassAccumulator()
  acc.add(0, [{ plate: 'WE1MH7O', confidence: 0.6 }], resolve)
  acc.add(1, [{ plate: 'WE1MH7O', confidence: 0.6 }], resolve)
  assert.equal(acc.final().best?.plate, 'WE1MH70')
})

test('pusta seria → brak wyniku', () => {
  const acc = new PassAccumulator()
  assert.equal(acc.earlyDecision(), null)
  assert.equal(acc.final().best, null)
})
