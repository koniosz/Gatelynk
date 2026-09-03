/**
 * nuki-probe — test Nuki Web API na żywym zamku (zero-dep, node:https).
 *
 * Na dzień, gdy właściciel dostarczy token API (Nuki Web → menu API → Generate
 * API token, scope: smartlock + smartlock.action).
 *
 * Użycie (z katalogu monorepo albo skopiowany na Edge):
 *   npx tsx apps/edge/tools/nuki-probe.ts --token <TOKEN> [--smartlockId <ID>]
 *   npx tsx apps/edge/tools/nuki-probe.ts --token <TOKEN> --smartlockId <ID> --unlatch
 *
 *   # alternatywnie po zbudowaniu Edge (tsc skompiluje tools razem z src?
 *   # NIE — tools/ jest poza src; uruchamiaj przez tsx/ts-node):
 *   node --experimental-strip-types apps/edge/tools/nuki-probe.ts --token ... (Node 22.6+)
 *
 * Co robi:
 *   1. GET /smartlock            — lista zamków dostępnych dla tokenu
 *      (gdy nie podasz --smartlockId, wypisze listę i zakończy).
 *   2. GET /smartlock/{id}       — stan zamka (state, bateria, firmware).
 *   3. --unlatch                 — POST /smartlock/{id}/action {action:3}
 *      (FIZYCZNIE OTWIERA ZAPADKĘ!) — wymaga interaktywnego potwierdzenia
 *      wpisaniem „TAK" (pomiń prompt flagą --yes, np. przez SSH bez TTY).
 *
 * Flagi:
 *   --token <t>        token API Nuki (wymagany)
 *   --smartlockId <id> ID zamka (opcjonalny — bez niego tylko lista)
 *   --unlatch          wykonaj otwarcie zapadki (z potwierdzeniem)
 *   --yes              pomiń potwierdzenie przy --unlatch
 *   --base <url>       override API base (default https://api.nuki.io)
 */
import * as https from 'https'
import * as http from 'http'
import * as readline from 'readline'
import { URL } from 'url'

// ── CLI args ─────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return undefined
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : undefined
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

const token = arg('token')
const smartlockId = arg('smartlockId')
const base = (arg('base') ?? 'https://api.nuki.io').replace(/\/+$/, '')
const doUnlatch = flag('unlatch')
const skipConfirm = flag('yes')

if (!token) {
  console.error('Użycie: nuki-probe --token <TOKEN> [--smartlockId <ID>] [--unlatch] [--yes]')
  process.exit(2)
}

// ── HTTP helper (zero-dep) ───────────────────────────────────────────────────

const NUKI_STATES: Record<number, string> = {
  0: 'niezkalibrowany', 1: 'zamknięty', 2: 'odblokowywanie…', 3: 'otwarty (unlocked)',
  4: 'zamykanie…', 5: 'zapadka otwarta (unlatched)', 6: "otwarty (lock'n'go)",
  7: 'otwieranie zapadki…', 254: 'silnik zablokowany', 255: 'niezdefiniowany',
}

function request(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${base}${path}`)
    const lib = url.protocol === 'http:' ? http : https
    const payload = body !== undefined ? JSON.stringify(body) : undefined
    const req = lib.request(
      url,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: 10_000,
      },
      (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          let data: any = null
          try { data = raw ? JSON.parse(raw) : null } catch { data = raw }
          resolve({ status: res.statusCode ?? 0, data })
        })
      },
    )
    req.on('timeout', () => { req.destroy(new Error('timeout 10 s — Nuki API nie odpowiada')) })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function explainStatus(status: number): string {
  switch (status) {
    case 401: return 'token błędny/wygasły — wygeneruj nowy w Nuki Web → API'
    case 403: return 'token nie ma uprawnień do tego zamka'
    case 404: return 'zamek nie istnieje — sprawdź smartlockId'
    case 503: return 'zamek offline albo awaria Nuki'
    default: return `HTTP ${status}`
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise<string>((res) => rl.question(question, res))
  rl.close()
  return answer.trim().toUpperCase() === 'TAK'
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`nuki-probe → ${base}\n`)

  // 1. Lista zamków dla tokenu
  const list = await request('GET', '/smartlock')
  if (list.status !== 200) {
    console.error(`✗ GET /smartlock → ${explainStatus(list.status)}`)
    process.exit(1)
  }
  const locks: any[] = Array.isArray(list.data) ? list.data : []
  console.log(`✓ Token OK — dostępne zamki (${locks.length}):`)
  for (const l of locks) {
    const st = l?.state?.state
    console.log(
      `   • smartlockId=${l.smartlockId}  "${l.name}"  stan: ${NUKI_STATES[st] ?? st}` +
      `${l?.state?.batteryCritical ? '  ⚠️ BATERIA KRYTYCZNA' : ''}`,
    )
  }

  if (!smartlockId) {
    console.log('\nPodaj --smartlockId <ID> żeby sprawdzić stan konkretnego zamka (+ --unlatch dla testu otwarcia).')
    return
  }

  // 2. Stan konkretnego zamka
  const state = await request('GET', `/smartlock/${smartlockId}`)
  if (state.status !== 200) {
    console.error(`✗ GET /smartlock/${smartlockId} → ${explainStatus(state.status)}`)
    process.exit(1)
  }
  const s = state.data
  console.log(`\n✓ Zamek "${s.name}" (smartlockId=${smartlockId}):`)
  console.log(`   stan:              ${NUKI_STATES[s?.state?.state] ?? s?.state?.state}`)
  console.log(`   bateria krytyczna: ${s?.state?.batteryCritical ?? '?'}`)
  console.log(`   ładunek baterii:   ${s?.state?.batteryCharge ?? '?'}%`)
  console.log(`   firmware:          ${s?.firmwareVersion ?? '?'}`)

  // 3. Opcjonalny unlatch
  if (!doUnlatch) {
    console.log('\nTest otwarcia: dodaj --unlatch (FIZYCZNIE otworzy zapadkę).')
    return
  }
  if (!skipConfirm) {
    const ok = await confirm(
      `\n⚠️  UWAGA: za chwilę FIZYCZNIE otworzę zapadkę zamka "${s.name}". Wpisz TAK aby kontynuować: `,
    )
    if (!ok) {
      console.log('Anulowano.')
      return
    }
  }
  console.log('→ POST /smartlock/…/action {action: 3} (unlatch)…')
  const act = await request('POST', `/smartlock/${smartlockId}/action`, { action: 3 })
  if (act.status >= 200 && act.status < 300) {
    console.log('✓ Unlatch przyjęty przez Nuki (204). Zapadka powinna się otworzyć w ~1-3 s.')
    // Krótki poll stanu — pokazujemy przejście 7 (otwieranie) → 5 (unlatched) → 1/3.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 2000))
      const st = await request('GET', `/smartlock/${smartlockId}`)
      const v = st.data?.state?.state
      console.log(`   stan po ${(i + 1) * 2}s: ${NUKI_STATES[v] ?? v}`)
      if (v === 1 || v === 3) break
    }
  } else {
    console.error(`✗ Unlatch → ${explainStatus(act.status)} ${JSON.stringify(act.data ?? '')}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(`✗ ${err.message}`)
  process.exit(1)
})
