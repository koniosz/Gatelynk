/**
 * GateLynk SIP proxy/registrar dla domofonu Akuvox E18 (per-lokal calling).
 *
 * PROBLEM: E18 w trybie direct-IP dzwoni "IP→IP" i NIE niesie numeru
 * wewnętrznego (To user-part puste), więc nie da się odróżnić, do którego
 * lokalu dzwoni gość. Wybieranie `<id>@IP` przełącza E18 w tryb konta SIP →
 * "Account Unavailable" (brak rejestratora). Janus (janus.plugin.sip) przyjmuje
 * tylko bezpośrednie INVITE — nie jest rejestratorem.
 *
 * ROZWIĄZANIE: ten proces nasłuchuje SIP na osobnym porcie (domyślnie 5062),
 *   • REGISTER → zawsze 200 OK (fałszywy rejestrator → konto E18 "zarejestrowane",
 *     więc da się wybierać numery wewnętrzne bez prawdziwego serwera SIP),
 *   • INVITE/ACK/BYE/CANCEL → przekazuje do Janusa (192.168.1.127:5060) ZACHOWUJĄC
 *     user-part (= id lokalu), więc Edge/Cloud routuje punktowo do mieszkańców
 *     tego lokalu (dialedExtension → unit.id, już wdrożone).
 *
 * Media (RTP) lecą bezpośrednio E18↔Janus (proxy dotyka tylko sygnalizacji).
 * Fizyczny przycisk (direct-IP do :5060) działa jak dawniej — omija proxy.
 *
 * Konfiguracja E18: Account → SIP Server = <edge-ip>:5062 (ten proxy), dowolny
 * user/hasło, Register ON. Tenant "Phone" = id lokalu (np. 49). Patrz README.
 */
const sip = require('sip')
const proxy = require('sip/proxy')

const LISTEN_PORT = parseInt(process.env.SIP_PROXY_PORT || '5062', 10)
const BIND_ADDR = process.env.SIP_PROXY_ADDR || '0.0.0.0'
const JANUS_HOST = process.env.JANUS_HOST || '192.168.1.127'
const JANUS_PORT = parseInt(process.env.JANUS_PORT || '5060', 10)

function log(...a) {
  console.log(new Date().toISOString(), ...a)
}

function userOf(uri) {
  try {
    return sip.parseUri(uri).user || ''
  } catch {
    return ''
  }
}

/** Z SDP w wiadomości wyciąga kierunek audio (do logu diagnostycznego). */
function sdpDir(m) {
  const c = m && m.content
  if (!c || !/m=audio/.test(c)) return ''
  const dir =
    ['sendrecv', 'sendonly', 'recvonly', 'inactive'].find((d) =>
      new RegExp(`a=${d}`).test(c),
    ) || 'sendrecv?'
  return ` [audio ${dir}]`
}

proxy.start(
  {
    port: LISTEN_PORT,
    address: BIND_ADDR,
    udp: true,
    tcp: false,
    logger: {
      send: (m) => log('SIP >>', (m.method || `resp ${m.status} ${m.reason || ''}`) + sdpDir(m)),
      recv: (m) => log('SIP <<', (m.method || `resp ${m.status} ${m.reason || ''}`) + sdpDir(m)),
      error: (e) => log('SIP ERR', (e && e.message) || e),
    },
  },
  function (rq) {
    try {
      const method = rq.method

      // ── Fałszywy rejestrator: akceptuj każdy REGISTER ────────────────────
      if (method === 'REGISTER') {
        const rs = sip.makeResponse(rq, 200, 'OK')
        // Odbij Contact, żeby telefon uznał rejestrację za udaną.
        if (rq.headers.contact) rs.headers.contact = rq.headers.contact
        const fromUser = userOf((rq.headers.from || {}).uri)
        log(`REGISTER from "${fromUser}" → 200 OK`)
        proxy.send(rs)
        return
      }

      // ── Wszystko inne (INVITE/ACK/BYE/CANCEL/…) → forward do Janusa ───────
      // Numer lokalu = user-part Request-URI (fallback: To). Przepisujemy tylko
      // HOST na Janusa, user-part (id lokalu) zostaje → Edge go odczyta.
      const ext = userOf(rq.uri) || userOf((rq.headers.to || {}).uri) || ''
      // DIAG: kierunek audio w SDP (offer Akuvoxa) — czy domofon chce odbierać.
      if (rq.content && /m=audio/.test(rq.content)) {
        const dir =
          ['sendrecv', 'sendonly', 'recvonly', 'inactive'].find((d) =>
            new RegExp(`a=${d}`).test(rq.content),
          ) || 'sendrecv(default)'
        const codecs = (rq.content.match(/a=rtpmap:\d+ [^\r\n]+/g) || []).join(', ')
        log(`${method} SDP audio dir=${dir} | ${codecs}`)
      }
      rq.uri = `sip:${ext}@${JANUS_HOST}:${JANUS_PORT}`
      log(`${method} → Janus ext="${ext || '(none)'}"`)
      proxy.send(rq)
    } catch (e) {
      log('handler error:', (e && e.message) || e)
      try {
        proxy.send(sip.makeResponse(rq, 500, 'Proxy Error'))
      } catch {}
    }
  },
)

log(`GateLynk SIP proxy: udp ${BIND_ADDR}:${LISTEN_PORT} → Janus ${JANUS_HOST}:${JANUS_PORT}`)
