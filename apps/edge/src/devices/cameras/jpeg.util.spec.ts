/**
 * Testy `isCompleteJpeg` — czysta logika, bez zależności.
 *   node node_modules/typescript/bin/tsc --module commonjs --target es2022 \
 *     --moduleResolution node --esModuleInterop --strict \
 *     --outDir /tmp/jpeg-util-test apps/edge/src/devices/cameras/jpeg.util.spec.ts
 *   node --test /tmp/jpeg-util-test/jpeg.util.spec.js
 */
import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { isCompleteJpeg } from './jpeg.util'

const SOI = [0xff, 0xd8]
const EOI = [0xff, 0xd9]
const body = (n: number) => Array.from({ length: n }, (_, i) => (i * 37) % 251)

test('kompletny JPEG: SOI na początku, EOI na końcu', () => {
  assert.equal(isCompleteJpeg(Uint8Array.from([...SOI, ...body(500), ...EOI])), true)
})

test('EOI + krótki padding po nim → nadal kompletny', () => {
  assert.equal(isCompleteJpeg(Uint8Array.from([...SOI, ...body(500), ...EOI, 0, 0, 0, 0])), true)
})

test('ucięty przez bufor urządzenia (brak EOI) → niekompletny', () => {
  assert.equal(isCompleteJpeg(Uint8Array.from([...SOI, ...body(724_801 - 2)])), false)
})

test('EOI tylko w środku (miniatura EXIF), koniec ucięty → niekompletny', () => {
  assert.equal(isCompleteJpeg(Uint8Array.from([...SOI, ...body(100), ...EOI, ...body(5000)])), false)
})

test('nie-JPEG (HTML z web UI kasety) i pusty bufor → niekompletny', () => {
  assert.equal(isCompleteJpeg(Uint8Array.from(Buffer.from('<html>…</html>'))), false)
  assert.equal(isCompleteJpeg(new Uint8Array(0)), false)
  assert.equal(isCompleteJpeg(null), false)
})
