/**
 * Testy łagodnego dopasowania tablic (plate-fuzzy.util) — czysta logika.
 *
 * Uruchamianie (jak exit-grace.util.spec.ts — node:test, spec kompilowany
 * standalone, bo `nest build` wyklucza `**\/*spec.ts`):
 *   node node_modules/typescript/bin/tsc --module commonjs --target es2022 \
 *     --moduleResolution node --esModuleInterop --strict \
 *     --outDir /tmp/plate-fuzzy-test apps/edge/src/devices/cameras/plate-fuzzy.util.spec.ts
 *   node --test /tmp/plate-fuzzy-test/plate-fuzzy.util.spec.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lenientCost, lenientPlateMatch } from './plate-fuzzy.util'

const WHITELIST = ['WE387YT', 'WE8HL14', 'WD5005P', 'WE1MF60', 'WN1234A']

test('WE38711 (Y→1, T→1) dopasowuje się do WE387YT kosztem 2', () => {
  const r = lenientPlateMatch(['WE38711'], WHITELIST)
  assert.equal(r.ambiguous, false)
  assert.deepEqual(r.match, { plate: 'WE387YT', raw: 'WE38711', cost: 2 })
})

test('odczyt dokładny ma koszt 0', () => {
  assert.equal(lenientCost('WE387YT', 'WE387YT'), 0)
  const r = lenientPlateMatch(['WE387YT'], WHITELIST)
  assert.equal(r.match?.plate, 'WE387YT')
  assert.equal(r.match?.cost, 0)
})

test('twarda różnica (znaki spoza klas pomyłek) → brak dopasowania', () => {
  assert.equal(lenientCost('WE387KT', 'WE387YT'), null)
  assert.equal(lenientPlateMatch(['WE387KT'], WHITELIST).match, null)
})

test('trzy pomyłki w tablicy 7-znakowej → za dużo', () => {
  // W→N, Y→1, T→1 = koszt 3 > budżet 2
  assert.equal(lenientPlateMatch(['NE38711'], WHITELIST).match, null)
})

test('inna długość → brak dopasowania', () => {
  assert.equal(lenientCost('WE3871', 'WE387YT'), null)
  assert.equal(lenientPlateMatch(['WE3871'], WHITELIST).match, null)
})

test('krótsza tablica (6 znaków) toleruje tylko 1 pomyłkę', () => {
  const wl = ['WA123B']
  assert.equal(lenientPlateMatch(['WA1238'], wl).match?.plate, 'WA123B') // B→8: 1
  assert.equal(lenientPlateMatch(['WA1Z38'], wl).match, null)            // 2→Z + B→8: 2
})

test('dwie tablice z rejestru w budżecie → niejednoznaczne, nie zgadujemy', () => {
  const wl = ['WE387YT', 'WE387IT'] // obie w koszcie ≤2 od WE38711
  const r = lenientPlateMatch(['WE38711'], wl)
  assert.equal(r.match, null)
  assert.equal(r.ambiguous, true)
})

test('trafienie dokładne wygrywa z drugą tablicą w budżecie', () => {
  const wl = ['WE38711', 'WE387YT']
  const r = lenientPlateMatch(['WE38711'], wl)
  assert.equal(r.ambiguous, false)
  assert.equal(r.match?.plate, 'WE38711')
  assert.equal(r.match?.cost, 0)
})

test('kandydaci alternatywni z głosowania też są sprawdzani, wygrywa najtańszy', () => {
  const r = lenientPlateMatch(['WE3871I', 'WE387Y1'], WHITELIST)
  assert.equal(r.match?.plate, 'WE387YT')
  assert.equal(r.match?.raw, 'WE387Y1') // koszt 1 < koszt 2
})

test('za krótkie śmieci OCR są ignorowane', () => {
  assert.equal(lenientPlateMatch(['WE38', ''], WHITELIST).match, null)
})
