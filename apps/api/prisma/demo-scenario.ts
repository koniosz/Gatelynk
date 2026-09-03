/**
 * Faza 6 — E2E scenariusz Villa Natura.
 *
 * Skrypt uruchamiany po `db:seed:demo` jako manualny smoke test integracji:
 * resident ↔ admin ↔ concierge na żywym API. Każdy krok loguje OK/FAIL
 * z czytelnym opisem co poszło nie tak.
 *
 * Uruchomienie:
 *   pnpm --filter @gatelynk/api demo:scenario
 *
 * Zmienne środowiskowe:
 *   API_URL  — base URL API (default https://api.gatelynk.com/api)
 *   PASSWORD — hasło demo (default villa2024)
 *
 * Scenariusz (11 kroków) — sprawdza Faza 1-5 end-to-end:
 *   1. Resident login (anna)
 *   2. Resident POST vehicle (PENDING)
 *   3. BA login
 *   4. BA PATCH vehicle status APPROVED
 *   5. Resident GET vehicles → status APPROVED
 *   6. Resident POST guest → PIN
 *   7. Resident POST ticket type=CONCIERGE
 *   8. Concierge login
 *   9. Concierge GET tickets → contains nowy
 *  10. Concierge POST reply
 *  11. Resident GET ticket → reply visible
 */
const API_URL = process.env.API_URL ?? 'https://api.gatelynk.com/api'
const PASSWORD = process.env.PASSWORD ?? 'villa2024'

let passed = 0
let failed = 0

function ok(msg: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`)
  passed++
}
function bad(msg: string, err?: unknown) {
  console.log(`  \x1b[31m✗\x1b[0m ${msg}${err ? ` — ${err}` : ''}`)
  failed++
}

interface ApiResponse<T = any> { ok: boolean; status: number; data: T }

async function api<T = any>(method: string, path: string, opts?: {
  token?: string; body?: unknown
}): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts?.token) headers.Authorization = `Bearer ${opts.token}`
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  })
  let data: any = null
  try { data = await res.json() } catch { /* may be empty */ }
  return { ok: res.ok, status: res.status, data: data as T }
}

async function main() {
  console.log(`🎬 Demo scenariusz Villa Natura (api=${API_URL})\n`)

  // ── Krok 1: Resident login ─────────────────────────────────────────────
  console.log('1. Resident (anna) login…')
  const r1 = await api<{ access_token: string; resident: { id: number } }>('POST', '/resident/auth/login', {
    body: { email: 'anna@villanatura.demo', password: PASSWORD },
  })
  if (!r1.ok || !r1.data.access_token) {
    bad(`Resident login (status=${r1.status})`, JSON.stringify(r1.data))
    return summary()
  }
  const residentToken = r1.data.access_token
  const residentId = r1.data.resident.id
  ok(`Resident JWT (id=${residentId})`)

  // ── Krok 2: Resident POST vehicle ──────────────────────────────────────
  console.log('2. Resident POST vehicle…')
  const plate = `DEMO${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`
  const r2 = await api<{ id: number; status: string }>('POST', '/resident/vehicles', {
    token: residentToken,
    body: { make: 'Demo', model: 'Scenariusz', color: 'srebrny', licensePlate: plate, kind: 'RESIDENT' },
  })
  if (!r2.ok) { bad(`POST vehicle (status=${r2.status})`, JSON.stringify(r2.data)); return summary() }
  if (r2.data.status !== 'PENDING') { bad(`Vehicle status oczekiwane PENDING, dostałem ${r2.data.status}`); return summary() }
  const vehicleId = r2.data.id
  ok(`Vehicle id=${vehicleId} plate=${plate} status=PENDING`)

  // ── Krok 3: BA login ───────────────────────────────────────────────────
  console.log('3. BA (Anna Zielińska) login…')
  const r3 = await api<{ access_token: string; buildingAdmin?: { id: number; buildingIds?: number[] } }>('POST', '/building-admin/auth/login', {
    body: { email: 'ba@villanatura.demo', password: PASSWORD },
  })
  if (!r3.ok || !r3.data.access_token) { bad(`BA login (status=${r3.status})`, JSON.stringify(r3.data)); return summary() }
  const baToken = r3.data.access_token
  const buildingId = r3.data.buildingAdmin?.buildingIds?.[0]
  if (!buildingId) { bad('BA buildingIds puste — brak assignment-u'); return summary() }
  ok(`BA JWT (buildingId=${buildingId})`)

  // ── Krok 4: BA approve vehicle ─────────────────────────────────────────
  console.log('4. BA PATCH vehicle status approve…')
  const r4 = await api<{ status: string }>('PATCH', `/building-admin/buildings/${buildingId}/vehicles/${vehicleId}/status`, {
    token: baToken,
    body: { action: 'approve' },
  })
  if (!r4.ok) { bad(`PATCH vehicle status (${r4.status})`, JSON.stringify(r4.data)); return summary() }
  if (r4.data.status !== 'APPROVED') { bad(`Vehicle status oczekiwane APPROVED, dostałem ${r4.data.status}`); return summary() }
  ok(`Vehicle ${vehicleId} → APPROVED`)

  // ── Krok 5: Resident widzi APPROVED ────────────────────────────────────
  console.log('5. Resident GET vehicles…')
  const r5 = await api<any[]>('GET', '/resident/vehicles', { token: residentToken })
  if (!r5.ok) { bad(`GET vehicles (${r5.status})`); return summary() }
  const myVehicle = (r5.data as any[]).find((v) => v.id === vehicleId)
  if (!myVehicle) { bad(`Vehicle ${vehicleId} nie wrócił z GET`); return summary() }
  if (myVehicle.status !== 'APPROVED') { bad(`Vehicle status u rezydenta = ${myVehicle.status}, oczekiwane APPROVED`); return summary() }
  ok(`Resident widzi vehicle ${vehicleId} z status APPROVED`)

  // ── Krok 6: Resident POST guest ────────────────────────────────────────
  console.log('6. Resident POST guest…')
  const validTo = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  const r6 = await api<{ id: number; pin: string }>('POST', '/resident/guests', {
    token: residentToken,
    body: { name: 'Demo Scenario Guest', vehiclePlate: 'WI88888', validTo },
  })
  if (!r6.ok) { bad(`POST guest (${r6.status})`, JSON.stringify(r6.data)); return summary() }
  if (!r6.data.pin || r6.data.pin.length !== 6) { bad(`Guest PIN nieprawidłowy: ${r6.data.pin}`); return summary() }
  ok(`Guest id=${r6.data.id} PIN=${r6.data.pin}`)

  // ── Krok 7: Resident POST ticket CONCIERGE ─────────────────────────────
  console.log('7. Resident POST ticket type=CONCIERGE…')
  const ticketTitle = `Demo scenariusz ${Date.now()}`
  const r7 = await api<{ id: number; type?: string }>('POST', '/resident/tickets', {
    token: residentToken,
    body: { category: 'OTHER', title: ticketTitle, body: 'E2E test scenariusza Fazy 6.', type: 'CONCIERGE' },
  })
  if (!r7.ok) { bad(`POST ticket (${r7.status})`, JSON.stringify(r7.data)); return summary() }
  const ticketId = r7.data.id
  ok(`Ticket id=${ticketId} type=CONCIERGE`)

  // ── Krok 8: Concierge login ───────────────────────────────────────────
  console.log('8. Concierge login…')
  const r8 = await api<{ access_token: string; concierge: { id: number; buildingId: number } }>('POST', '/concierge/auth/login', {
    body: { email: 'concierge@villanatura.demo', password: PASSWORD },
  })
  if (!r8.ok || !r8.data.access_token) { bad(`Concierge login (${r8.status})`, JSON.stringify(r8.data)); return summary() }
  const conciergeToken = r8.data.access_token
  ok(`Concierge JWT (id=${r8.data.concierge.id} buildingId=${r8.data.concierge.buildingId})`)

  // ── Krok 9: Concierge GET tickets ──────────────────────────────────────
  console.log('9. Concierge GET tickets…')
  const r9 = await api<any[]>('GET', '/concierge/building/tickets', { token: conciergeToken })
  if (!r9.ok) { bad(`Concierge GET tickets (${r9.status})`); return summary() }
  const myTicket = (r9.data as any[]).find((t) => t.id === ticketId)
  if (!myTicket) { bad(`Ticket ${ticketId} nie pojawił się w concierge feed`); return summary() }
  if (myTicket.type !== 'CONCIERGE') { bad(`Ticket type=${myTicket.type}, oczekiwane CONCIERGE`); return summary() }
  ok(`Concierge widzi ticket ${ticketId}`)

  // ── Krok 10: Concierge reply ────────────────────────────────────────────
  console.log('10. Concierge POST reply…')
  const replyBody = 'Sprawdzę paczkę przy najbliższym obchodzie. Pozdrawiam, Marek.'
  const r10 = await api<{ id: number }>('POST', `/concierge/building/tickets/${ticketId}/replies`, {
    token: conciergeToken,
    body: { body: replyBody },
  })
  if (!r10.ok) { bad(`Concierge POST reply (${r10.status})`, JSON.stringify(r10.data)); return summary() }
  ok(`Reply id=${r10.data.id}`)

  // ── Krok 11: Resident widzi reply ──────────────────────────────────────
  console.log('11. Resident GET ticket → reply visible…')
  const r11 = await api<{ replies: any[] }>('GET', `/resident/tickets/${ticketId}`, { token: residentToken })
  if (!r11.ok) { bad(`Resident GET ticket (${r11.status})`); return summary() }
  const conciergeReply = (r11.data.replies ?? []).find((rep) => rep.body === replyBody)
  if (!conciergeReply) { bad('Reply nie pojawił się u rezydenta'); return summary() }
  if (conciergeReply.authorType !== 'CONCIERGE') { bad(`Reply authorType=${conciergeReply.authorType}, oczekiwane CONCIERGE`); return summary() }
  ok(`Resident widzi reply (authorType=CONCIERGE)`)

  summary()
}

function summary() {
  console.log(`\n${'='.repeat(50)}`)
  console.log(`  Wynik: \x1b[32m${passed} OK\x1b[0m  \x1b[31m${failed} FAIL\x1b[0m`)
  console.log('='.repeat(50))
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('💥 Scenariusz crash:', err)
  process.exit(2)
})
