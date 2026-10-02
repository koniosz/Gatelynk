/**
 *   node node_modules/typescript/bin/tsc --module commonjs --target es2022 \
 *     --moduleResolution node --esModuleInterop --strict --types node \
 *     --outDir /tmp/waste-test apps/edge/src/devices/cameras/waste-truck.util.spec.ts
 *   node --test /tmp/waste-test/waste-truck.util.spec.js
 */
import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { findWasteVisits, isWasteFrame, type WasteFrame } from './waste-truck.util'

const MIN = 60_000
const T0 = Date.UTC(2026, 9, 2, 6, 39) // 08:39 Warszawa
let seq = 0
const f = (minutes: number, p: Partial<WasteFrame> = {}): WasteFrame => ({
  id: ++seq, ts: T0 + minutes * MIN, cameraDeviceId: p.cameraDeviceId ?? 'cam-a',
  wasteCategory: p.wasteCategory ?? null, wasteConf: p.wasteConf ?? null, wasteOperator: p.wasteOperator ?? null,
})

test('VN 2026-10-02: napis firmy + druga kamera 4 min później → wizyta potwierdzona o drugiej klatce', () => {
  const visits = findWasteVisits([
    f(0, { wasteOperator: 'MIEJSKIE', cameraDeviceId: 'cam-test2' }),
    f(4, { wasteCategory: 'MIXED', wasteConf: 0.5, cameraDeviceId: 'cam-fire1' }),
  ])
  assert.equal(visits.length, 1)
  assert.equal(visits[0].startTs, T0)
  assert.equal(visits[0].confirmedTs, T0 + 4 * MIN)
})

test('pojedyncza klatka (nawet pewna) nie jest wizytą', () => {
  assert.equal(findWasteVisits([f(0, { wasteCategory: 'MIXED', wasteConf: 1 })]).length, 0)
})

test('klatki z niską pewnością i bez napisu firmy się nie liczą', () => {
  assert.equal(isWasteFrame(f(0, { wasteCategory: 'PLASTIC', wasteConf: 0.3 })), false)
  assert.equal(findWasteVisits([
    f(0, { wasteCategory: 'PLASTIC', wasteConf: 0.3 }),
    f(1, { wasteCategory: 'PLASTIC', wasteConf: 0.3 }),
  ]).length, 0)
})

test('dwie klatki daleko od siebie (> okno potwierdzenia) nie potwierdzają wizyty', () => {
  assert.equal(findWasteVisits([
    f(0, { wasteCategory: 'MIXED', wasteConf: 0.9 }),
    f(15, { wasteCategory: 'MIXED', wasteConf: 0.9 }),
  ]).length, 0)
})

test('przerwa > 20 min rozdziela wizyty; każda potwierdzona osobno', () => {
  const visits = findWasteVisits([
    f(0, { wasteCategory: 'MIXED', wasteConf: 0.6 }), f(3, { wasteCategory: 'MIXED', wasteConf: 0.7 }),
    f(50, { wasteCategory: 'BIO', wasteConf: 0.8 }), f(52, { wasteOperator: 'MPO' }),
  ])
  assert.equal(visits.length, 2)
  assert.equal(visits[1].startTs, T0 + 50 * MIN)
  assert.equal(visits[1].confirmedTs, T0 + 52 * MIN)
})

test('kolejność wejściowa nie ma znaczenia', () => {
  const visits = findWasteVisits([
    f(4, { wasteCategory: 'MIXED', wasteConf: 0.5 }),
    f(0, { wasteOperator: 'MIEJSKIE' }),
  ])
  assert.equal(visits.length, 1)
  assert.equal(visits[0].startTs, T0)
})
