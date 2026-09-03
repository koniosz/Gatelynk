/**
 * Testy jednostkowe drivera NUKI (SmartLockService) — mock HTTP przez lokalny
 * serwer node:http (bez nock/undici-mock — zero nowych zależności).
 *
 * Uruchamianie (bez jest-a w Edge — node:test na skompilowanym dist,
 * jak guest-restrictions.util.spec):
 *   pnpm --filter @gatelynk/edge build
 *   node --test apps/edge/dist/devices/smart-lock/smart-lock.service.spec.js
 *
 * Pokrycie: sukces (204 + poprawny path/body/Bearer), 401 (czytelny komunikat
 * o tokenie), timeout, 404, getState mapping, brak configu.
 */
import { test, after } from 'node:test'
import * as assert from 'node:assert/strict'
import * as http from 'http'
import { AddressInfo } from 'net'
import { SmartLockService, mapNukiState } from './smart-lock.service'

// ── Stub Nuki API ────────────────────────────────────────────────────────────

interface SeenRequest {
  method: string
  url: string
  auth: string | undefined
  body: string
}

const seen: SeenRequest[] = []
let mode: 'ok' | 'unauthorized' | 'notfound' | 'hang' | 'unavailable' = 'ok'

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    seen.push({
      method: req.method ?? '',
      url: req.url ?? '',
      auth: req.headers.authorization,
      body,
    })
    if (mode === 'hang') return // nigdy nie odpowiadamy → timeout klienta
    if (mode === 'unauthorized') {
      res.writeHead(401).end(JSON.stringify({ detailMessage: 'invalid token' }))
      return
    }
    if (mode === 'notfound') {
      res.writeHead(404).end()
      return
    }
    if (mode === 'unavailable') {
      res.writeHead(503).end()
      return
    }
    if (req.method === 'POST' && /\/smartlock\/\d+\/action$/.test(req.url ?? '')) {
      res.writeHead(204).end()
      return
    }
    if (req.method === 'GET' && /\/smartlock\/\d+$/.test(req.url ?? '')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          smartlockId: 123456789,
          name: 'Drzwi testowe',
          state: { state: 1, batteryCritical: false, keypadBatteryCritical: null },
        }),
      )
      return
    }
    res.writeHead(400).end()
  })
})

const listening = new Promise<number>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
})

after(() => server.close())

// ── Fabryka serwisu z fake Store/EventLog ────────────────────────────────────

function makeService(port: number, cfgOverride: Record<string, unknown> = {}) {
  const store = {
    getDeviceConfigs: () => [
      {
        deviceId: 'lock-1',
        type: 'SMART_LOCK',
        config: {
          name: 'Drzwi testowe',
          smartlockId: '123456789',
          apiToken: 'test-token-0123456789',
          apiBaseUrl: `http://127.0.0.1:${port}`,
          timeoutMs: 500,
          ...cfgOverride,
        },
        enabled: true,
        role: 'LPR',
        aiAnalysisEnabled: true,
      },
    ],
  }
  const noop = () => undefined
  const eventLog = { success: noop, error: noop, warn: noop, info: noop }
  return new SmartLockService(store as any, eventLog as any)
}

// ── Testy ────────────────────────────────────────────────────────────────────

test('unlatch: sukces — POST /smartlock/{id}/action, action=3, Bearer token', async () => {
  const port = await listening
  mode = 'ok'
  seen.length = 0
  const svc = makeService(port)
  await svc.unlatch('lock-1') // nie rzuca
  assert.equal(seen.length, 1)
  assert.equal(seen[0].method, 'POST')
  assert.equal(seen[0].url, '/smartlock/123456789/action')
  assert.equal(seen[0].auth, 'Bearer test-token-0123456789')
  assert.deepEqual(JSON.parse(seen[0].body), { action: 3 })
})

test('unlatch: 401 → czytelny komunikat o tokenie', async () => {
  const port = await listening
  mode = 'unauthorized'
  const svc = makeService(port)
  await assert.rejects(
    () => svc.unlatch('lock-1'),
    (err: Error) => {
      assert.match(err.message, /401/)
      assert.match(err.message, /token/i)
      return true
    },
  )
})

test('unlatch: timeout → komunikat o braku odpowiedzi Nuki', async () => {
  const port = await listening
  mode = 'hang'
  const svc = makeService(port) // timeoutMs=500
  await assert.rejects(
    () => svc.unlatch('lock-1'),
    (err: Error) => {
      assert.match(err.message, /nie odpowiada|timeout/i)
      return true
    },
  )
  mode = 'ok'
})

test('unlatch: 404 → komunikat o smartlockId', async () => {
  const port = await listening
  mode = 'notfound'
  const svc = makeService(port)
  await assert.rejects(() => svc.unlatch('lock-1'), /404/)
})

test('unlatch: 503 → komunikat o niedostępności', async () => {
  const port = await listening
  mode = 'unavailable'
  const svc = makeService(port)
  await assert.rejects(() => svc.unlatch('lock-1'), /503|niedostępne/)
})

test('getState: sukces — mapowanie stanu na polski label', async () => {
  const port = await listening
  mode = 'ok'
  seen.length = 0
  const svc = makeService(port)
  const state = await svc.getState('lock-1')
  assert.equal(state.ok, true)
  assert.equal(state.smartlockId, '123456789')
  assert.equal(state.name, 'Drzwi testowe')
  assert.equal(state.state, 1)
  assert.equal(state.stateLabel, 'Zamknięty')
  assert.equal(state.lockState, 1)
  assert.equal(state.lockStateLabel, 'Zamknięty')
  assert.equal(state.batteryCritical, false)
  assert.equal(seen[0].method, 'GET')
  assert.equal(seen[0].url, '/smartlock/123456789')
})

// ── mapNukiState — czyste mapowanie kodów → PL (bez HTTP) ────────────────────

test('mapNukiState: kody rygla → poprawne polskie labely', () => {
  assert.equal(mapNukiState({ state: { state: 0 } }).lockStateLabel, 'Nieskalibrowany')
  assert.equal(mapNukiState({ state: { state: 1 } }).lockStateLabel, 'Zamknięty')
  assert.equal(mapNukiState({ state: { state: 3 } }).lockStateLabel, 'Otwarty')
  assert.equal(mapNukiState({ state: { state: 4 } }).lockStateLabel, 'Rygluje…')
  assert.equal(mapNukiState({ state: { state: 5 } }).lockStateLabel, 'Otwarty (klamka)')
  assert.equal(mapNukiState({ state: { state: 6 } }).lockStateLabel, 'Otwarty')
  assert.equal(mapNukiState({ state: { state: 254 } }).lockStateLabel, 'Silnik zablokowany')
  assert.equal(mapNukiState({ state: { state: 255 } }).lockStateLabel, 'Nieznany')
})

test('mapNukiState: nieznany/błędny kod rygla → fallback, brak crasha', () => {
  assert.equal(mapNukiState({ state: { state: 99 } }).lockStateLabel, 'Stan 99')
  // Brak pola state → null + „Nieznany"
  const empty = mapNukiState({})
  assert.equal(empty.lockState, null)
  assert.equal(empty.lockStateLabel, 'Nieznany')
  // Payload null → nie rzuca
  assert.equal(mapNukiState(null).lockStateLabel, 'Nieznany')
  // state jako nie-liczba (np. string z popsutego API) → null
  assert.equal(mapNukiState({ state: { state: 'locked' } }).lockState, null)
})

test('mapNukiState: czujnik drzwi (doorState) → PL, z pominięciem braku czujnika', () => {
  assert.equal(mapNukiState({ state: { doorState: 2 } }).doorStateLabel, 'Drzwi zamknięte')
  assert.equal(mapNukiState({ state: { doorState: 3 } }).doorStateLabel, 'Drzwi otwarte')
  assert.equal(mapNukiState({ state: { doorState: 5 } }).doorStateLabel, 'Kalibracja czujnika…')
  // 0 (unavailable) / 1 (deactivated) = brak aktywnego czujnika → null (nie pokazujemy)
  assert.equal(mapNukiState({ state: { doorState: 0 } }).doorStateLabel, null)
  assert.equal(mapNukiState({ state: { doorState: 1 } }).doorStateLabel, null)
  // Brak pola doorState → null
  assert.equal(mapNukiState({ state: { state: 1 } }).doorState, null)
  assert.equal(mapNukiState({ state: { state: 1 } }).doorStateLabel, null)
  // Nieznany kod czujnika → bezpieczny fallback
  assert.equal(mapNukiState({ state: { doorState: 42 } }).doorStateLabel, 'Drzwi: stan nieznany')
})

test('mapNukiState: bateria krytyczna przepisana z payloadu', () => {
  const m = mapNukiState({ state: { state: 1, batteryCritical: true, keypadBatteryCritical: false } })
  assert.equal(m.batteryCritical, true)
  assert.equal(m.keypadBatteryCritical, false)
})

test('getState: 401 → rzuca z czytelnym komunikatem', async () => {
  const port = await listening
  mode = 'unauthorized'
  const svc = makeService(port)
  await assert.rejects(() => svc.getState('lock-1'), /401/)
  mode = 'ok'
})

test('brak configu / brak tokenu → czytelne błędy', async () => {
  const port = await listening
  const svc = makeService(port)
  await assert.rejects(() => svc.unlatch('nie-istnieje'), /nie jest skonfigurowany/)
  const noToken = makeService(port, { apiToken: undefined })
  await assert.rejects(() => noToken.unlatch('lock-1'), /brak tokenu/i)
})
