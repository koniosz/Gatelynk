/**
 * lpr-camera-probe — narzędzie na dzień instalacji (MVP „stare kamery", 2026-07).
 *
 * Odpalasz w LAN klienta (na Edge Mac Mini albo laptopie instalatora),
 * podajesz IP + login + hasło kamery, a skrypt wykrywa:
 *
 *   • model / firmware / serial (ISAPI /System/deviceInfo)
 *   • czy kamera wspiera ANPR (vehicleDetect config + Event/triggers)
 *   • czy da się zarejestrować HTTP host notification (push eventów do Edge)
 *   • czy działa alertStream (nasłuch przez N sekund)
 *   • czy oddaje snapshot JPEG (ISAPI + generyczne ścieżki)
 *   • czy odpowiada RTSP (OPTIONS na :554) + gotowy URL RTSP
 *
 * i wypisuje werdykt: PEŁNY LPR / TYLKO PODGLĄD / NIEKOMPATYBILNA
 * + rekomendację jak zarejestrować urządzenie w Edge.
 *
 * Uruchamianie (zero zależności — czysty node, bez npm install):
 *
 *   node lpr-camera-probe.ts --ip 192.168.1.64 --user admin --pass 'Haslo123!'
 *   node lpr-camera-probe.ts --ip 192.168.1.64 --user admin --pass 'x' --port 80 --listen 8 --json
 *
 * Wymaga Node ≥ 22.18 (natywny strip typów z .ts). Starszy node:
 *   npx tsx lpr-camera-probe.ts --ip ...
 *
 * Skrypt jest READ-ONLY — wykonuje wyłącznie GET-y i RTSP OPTIONS,
 * niczego w kamerze nie zmienia. Bezpieczny na produkcji.
 */
import * as http from 'node:http'
import * as https from 'node:https'
import * as net from 'node:net'
import { createHash, randomBytes } from 'node:crypto'

// ── CLI args ─────────────────────────────────────────────────────────────────
interface Args {
  ip: string
  user: string
  pass: string
  port: number
  rtspPort: number
  channel: number
  listen: number
  json: boolean
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const ip = get('ip')
  const user = get('user') ?? 'admin'
  const pass = get('pass') ?? get('password')
  if (!ip || !pass) {
    console.error(`Użycie: node lpr-camera-probe.ts --ip <IP> --user <login> --pass <hasło>
Opcje:  --port 80  --rtsp-port 554  --channel 1  --listen 8 (sek. nasłuchu alertStream, 0=pomiń)  --json`)
    process.exit(2)
  }
  return {
    ip,
    user,
    pass,
    port: Number(get('port') ?? 80),
    rtspPort: Number(get('rtsp-port') ?? 554),
    channel: Number(get('channel') ?? 1),
    listen: Number(get('listen') ?? 8),
    json: argv.includes('--json'),
  }
}

// ── Minimal HTTP z Digest (RFC 2617) + Basic fallback ───────────────────────
const md5 = (s: string) => createHash('md5').update(s).digest('hex')

function parseDigest(header: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of header.replace(/^Digest\s+/i, '').match(/(\w+)=("[^"]*"|[^,]*)/g) ?? []) {
    const eq = p.indexOf('=')
    let v = p.slice(eq + 1).trim()
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    out[p.slice(0, eq).trim()] = v
  }
  return out
}

function digestHeader(ch: Record<string, string>, method: string, uri: string, user: string, pass: string): string {
  const realm = ch.realm ?? ''
  const nonce = ch.nonce ?? ''
  const qop = (ch.qop ?? '').split(',').map((s) => s.trim()).find(Boolean)
  const cnonce = randomBytes(8).toString('hex')
  const nc = '00000001'
  let ha1 = md5(`${user}:${realm}:${pass}`)
  if ((ch.algorithm ?? '').toUpperCase() === 'MD5-SESS') ha1 = md5(`${ha1}:${nonce}:${cnonce}`)
  const ha2 = md5(`${method}:${uri}`)
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`)
  let h = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`
  if (qop) h += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`
  if (ch.opaque) h += `, opaque="${ch.opaque}"`
  if (ch.algorithm) h += `, algorithm=${ch.algorithm}`
  return h
}

interface HttpResult {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
  error?: string
}

function rawRequest(url: string, extraHeaders: Record<string, string>, timeoutMs: number, maxBody = 2_000_000): Promise<HttpResult> {
  return new Promise((resolve) => {
    const u = new URL(url)
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers: extraHeaders,
        rejectUnauthorized: false,
        timeout: timeoutMs,
      } as https.RequestOptions,
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size <= maxBody) chunks.push(c)
          else { res.destroy(); }
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
        res.on('error', (e) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), error: String(e) }))
      },
    )
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    req.on('error', (e: any) => resolve({ status: 0, headers: {}, body: Buffer.alloc(0), error: e?.code ?? e?.message ?? String(e) }))
    req.end()
  })
}

/** GET z automatycznym Digest (i Basic fallback) — nigdy nie rzuca. */
async function get(url: string, user: string, pass: string, timeoutMs = 6000): Promise<HttpResult> {
  const first = await rawRequest(url, {}, timeoutMs)
  if (first.status !== 401) return first
  const www = String(first.headers['www-authenticate'] ?? '')
  if (/^Digest/i.test(www)) {
    const u = new URL(url)
    const auth = digestHeader(parseDigest(www), 'GET', u.pathname + u.search, user, pass)
    const second = await rawRequest(url, { Authorization: auth }, timeoutMs)
    if (second.status !== 401) return second
  }
  // Basic fallback (starsze firmware / włączone Basic w security settings)
  const basic = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
  return rawRequest(url, { Authorization: basic }, timeoutMs)
}

// ── RTSP OPTIONS probe ───────────────────────────────────────────────────────
function rtspOptions(ip: string, port: number, timeoutMs = 4000): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok: boolean, detail: string) => {
      if (done) return
      done = true
      socket.destroy()
      resolve({ ok, detail })
    }
    const socket = net.createConnection({ host: ip, port, family: 4 })
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => {
      socket.write(`OPTIONS rtsp://${ip}:${port}/ RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: gatelynk-probe\r\n\r\n`)
    })
    let buf = ''
    socket.on('data', (d) => {
      buf += d.toString('utf8')
      if (buf.includes('\r\n\r\n') || buf.length > 500) {
        const line = buf.split('\r\n')[0]
        finish(/^RTSP\/1\.[01]/.test(line), line.slice(0, 80))
      }
    })
    socket.on('timeout', () => finish(false, 'timeout'))
    socket.on('error', (e: any) => finish(false, e?.code ?? String(e)))
  })
}

// ── alertStream nasłuch ──────────────────────────────────────────────────────
async function listenAlertStream(base: string, user: string, pass: string, seconds: number): Promise<{
  opened: boolean
  events: number
  anprEvents: number
  detail: string
}> {
  const url = `${base}/ISAPI/Event/notification/alertStream`
  // Challenge najpierw (alertStream zawsze wymaga auth na Hikvision).
  const challenge = await rawRequest(url, {}, 5000, 100)
  let authHeader: Record<string, string> = {}
  if (challenge.status === 401) {
    const www = String(challenge.headers['www-authenticate'] ?? '')
    if (/^Digest/i.test(www)) {
      const u = new URL(url)
      authHeader = { Authorization: digestHeader(parseDigest(www), 'GET', u.pathname, user, pass) }
    } else {
      authHeader = { Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') }
    }
  } else if (challenge.status === 0) {
    return { opened: false, events: 0, anprEvents: 0, detail: challenge.error ?? 'connection failed' }
  }

  return new Promise((resolve) => {
    const u = new URL(url)
    const mod = u.protocol === 'https:' ? https : http
    let events = 0
    let anprEvents = 0
    let opened = false
    let detail = ''
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname,
        method: 'GET',
        headers: authHeader,
        rejectUnauthorized: false,
      } as https.RequestOptions,
      (res) => {
        opened = res.statusCode === 200
        detail = `HTTP ${res.statusCode}, Content-Type: ${res.headers['content-type'] ?? '?'}`
        if (!opened) { res.resume(); return }
        res.on('data', (c: Buffer) => {
          const s = c.toString('utf8')
          const m = s.match(/<eventType>([^<]+)<\/eventType>/gi)
          if (m) {
            events += m.length
            anprEvents += m.filter((x) => /anpr|vehicle/i.test(x)).length
          }
        })
      },
    )
    req.on('error', (e: any) => { detail = e?.code ?? String(e) })
    req.end()
    setTimeout(() => {
      req.destroy()
      resolve({ opened, events, anprEvents, detail })
    }, seconds * 1000)
  })
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function xmlTag(body: string, tag: string): string | null {
  const m = body.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'))
  return m ? m[1].trim() : null
}

function isJpeg(b: Buffer): boolean {
  return b.length > 1000 && b[0] === 0xff && b[1] === 0xd8
}

const OK = '✅'
const WARN = '🟡'
const FAIL = '❌'

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2))
  const base = `http://${args.ip}${args.port !== 80 ? `:${args.port}` : ''}`
  const report: Record<string, any> = { ip: args.ip, base, checkedAt: new Date().toISOString() }
  const lines: string[] = []
  const log = (s: string) => { lines.push(s); if (!args.json) console.log(s) }

  log(`\n═══ GateLynk LPR camera probe — ${args.ip} ═══\n`)

  // 1. deviceInfo
  const di = await get(`${base}/ISAPI/System/deviceInfo`, args.user, args.pass)
  const diBody = di.body.toString('utf8')
  const isapiOk = di.status === 200 && diBody.includes('<DeviceInfo')
  const authFailed = di.status === 401 || di.status === 403
  report.isapi = { status: di.status, ok: isapiOk, error: di.error }
  if (isapiOk) {
    report.model = xmlTag(diBody, 'model')
    report.firmware = `${xmlTag(diBody, 'firmwareVersion') ?? '?'} ${xmlTag(diBody, 'firmwareReleasedDate') ?? ''}`.trim()
    report.serial = xmlTag(diBody, 'serialNumber')
    report.deviceType = xmlTag(diBody, 'deviceType')
    log(`${OK} ISAPI deviceInfo: model=${report.model} fw=${report.firmware} type=${report.deviceType}`)
  } else if (authFailed) {
    log(`${FAIL} ISAPI deviceInfo: HTTP ${di.status} — złe login/hasło (albo konto zablokowane po nieudanych próbach)`)
  } else if (di.status === 0) {
    log(`${FAIL} ISAPI deviceInfo: brak połączenia (${di.error}) — zły IP/port albo kamera nie-Hikvision bez ISAPI`)
  } else {
    log(`${WARN} ISAPI deviceInfo: HTTP ${di.status} — prawdopodobnie kamera innej marki (brak ISAPI)`)
  }

  // 2. ANPR capability — vehicleDetect config na obu znanych ścieżkach + triggery
  let anprConfig = false
  let anprConfigPath: string | null = null
  if (!authFailed && di.status !== 0) {
    for (const p of [
      `/ISAPI/Traffic/channels/${args.channel}/vehicleDetect`,
      `/ISAPI/Smart/Vehicle/${args.channel}/vehicleDetect`,
    ]) {
      const r = await get(`${base}${p}`, args.user, args.pass)
      const b = r.body.toString('utf8')
      const hit = r.status === 200 && /vehicleDetect|VehicleDetect|MinTrustLevel/i.test(b)
      log(`${hit ? OK : WARN} ANPR config ${p} → HTTP ${r.status}${hit ? ' (obsługiwane)' : ''}`)
      if (hit && !anprConfig) { anprConfig = true; anprConfigPath = p }
    }
  }

  let anprTrigger = false
  let triggerIds: string[] = []
  if (!authFailed && di.status !== 0) {
    const tr = await get(`${base}/ISAPI/Event/triggers`, args.user, args.pass)
    const b = tr.body.toString('utf8')
    if (tr.status === 200) {
      triggerIds = [...b.matchAll(/<id>([^<]+)<\/id>/gi)].map((m) => m[1])
      anprTrigger = triggerIds.some((t) => /vehicledetect|anpr/i.test(t)) || /vehicledetect|ANPR/i.test(b)
      log(`${anprTrigger ? OK : WARN} Event/triggers → HTTP 200, triggery: ${triggerIds.slice(0, 12).join(', ') || '(puste)'}${anprTrigger ? '' : ' — BRAK triggera VehicleDetect/ANPR'}`)
    } else {
      log(`${WARN} Event/triggers → HTTP ${tr.status}`)
    }
  }
  report.anpr = { config: anprConfig, configPath: anprConfigPath, trigger: anprTrigger, triggerIds }

  // 3. HTTP host notification (push eventów do Edge)
  let httpHostsOk = false
  if (!authFailed && di.status !== 0) {
    const hh = await get(`${base}/ISAPI/Event/notification/httpHosts`, args.user, args.pass)
    httpHostsOk = hh.status === 200
    log(`${httpHostsOk ? OK : WARN} Event/notification/httpHosts → HTTP ${hh.status}${httpHostsOk ? ' (kamera umie POST-ować eventy do Edge)' : ''}`)
  }
  report.httpHosts = httpHostsOk

  // 4. Snapshot
  let snapshotOk = false
  let snapshotUrl: string | null = null
  const streamId = args.channel < 100 ? args.channel * 100 + 1 : args.channel
  const snapCandidates = [
    `${base}/ISAPI/Streaming/channels/${streamId}/picture`,
    `${base}/ISAPI/Streaming/channels/1/picture`,
    // nie-Hikvision fallbacki (Dahua / generic):
    `${base}/cgi-bin/snapshot.cgi?channel=${args.channel}`,
    `${base}/snapshot.jpg`,
  ]
  for (const u of snapCandidates) {
    const r = await get(u, args.user, args.pass)
    if (r.status === 200 && isJpeg(r.body)) {
      snapshotOk = true
      snapshotUrl = u
      log(`${OK} Snapshot: ${u} → JPEG ${(r.body.length / 1024).toFixed(0)} KB`)
      break
    }
  }
  if (!snapshotOk) log(`${FAIL} Snapshot: żadna ze ścieżek nie oddała JPEG`)
  report.snapshot = { ok: snapshotOk, url: snapshotUrl }

  // 5. RTSP
  const rtsp = await rtspOptions(args.ip, args.rtspPort)
  const rtspUrl = `rtsp://${args.user}:****@${args.ip}:${args.rtspPort}/Streaming/Channels/${streamId}`
  log(`${rtsp.ok ? OK : FAIL} RTSP :${args.rtspPort} OPTIONS → ${rtsp.detail}`)
  if (rtsp.ok) log(`   URL: ${rtspUrl}  (sub-stream: .../Channels/${streamId + 1})`)
  report.rtsp = { ok: rtsp.ok, detail: rtsp.detail, url: rtspUrl }

  // 6. alertStream (opcjonalny nasłuch)
  if (args.listen > 0 && !authFailed && di.status !== 0) {
    log(`\n⏳ Nasłuch alertStream przez ${args.listen}s (przejedź autem przed kamerą, jeśli możesz)…`)
    const as = await listenAlertStream(base, args.user, args.pass, args.listen)
    log(`${as.opened ? OK : WARN} alertStream: ${as.detail} — eventów: ${as.events}, w tym ANPR/vehicle: ${as.anprEvents}`)
    report.alertStream = as
  }

  // ── Werdykt ────────────────────────────────────────────────────────────────
  const anpr = anprConfig || anprTrigger
  let verdict: string
  let recommendation: string
  if (authFailed) {
    verdict = 'BRAK DOSTĘPU'
    recommendation = 'Popraw login/hasło (konto admin kamery). Po 5+ nieudanych próbach Hikvision blokuje konto na ~30 min.'
  } else if (isapiOk && anpr && httpHostsOk) {
    verdict = 'PEŁNY LPR'
    recommendation = `Rejestruj w Edge jako LPR_CAMERA (driver hikvision-lpr). Edge sam skonfiguruje push eventów (httpHosts + trigger center). Po dodaniu sprawdź POST /lpr/<id>/camera-setup i zakładkę Odczyty.`
  } else if (isapiOk && anpr && !httpHostsOk) {
    verdict = 'LPR MOŻLIWY (wymaga ręcznej konfiguracji)'
    recommendation = 'Kamera ma ANPR, ale nie wystawia httpHosts przez ISAPI. Skonfiguruj "Notify Surveillance Center" + HTTP listening host ręcznie w panelu WWW kamery (Configuration → Event → Smart Event), cel: http://<EDGE_IP>:4000/events/lpr/hikvision/<deviceId>.'
  } else if (snapshotOk || rtsp.ok) {
    verdict = 'TYLKO PODGLĄD'
    recommendation = `Kamera nie wspiera ANPR — rejestruj w Edge jako CAMERA (typ „Kamera IP", nie „Kamera LPR"). Będzie działać podgląd/snapshot przypięty do punktu dostępu; tablice NIE będą czytane i brama NIE otworzy się automatycznie z tej kamery.`
  } else {
    verdict = 'NIEKOMPATYBILNA'
    recommendation = 'Brak ISAPI, snapshotu i RTSP. Sprawdź IP/VLAN/zasilanie; jeśli to inna marka — sprawdź dokumentację ONVIF/RTSP producenta albo wymień kamerę.'
  }
  report.verdict = verdict
  report.recommendation = recommendation

  log(`\n${'═'.repeat(56)}`)
  log(`WERDYKT: ${verdict}`)
  log(`→ ${recommendation}`)
  log('═'.repeat(56))

  if (args.json) console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

main().catch((e) => {
  console.error(`Probe failed: ${e?.message ?? e}`)
  process.exit(1)
})
