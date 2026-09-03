/**
 * HTTP Digest Authentication helper (RFC 2617 / RFC 7616, qop=auth).
 *
 * Works with axios for cameras/intercoms that reject Basic Auth
 * (Hikvision, Dahua, Axis, most post-2017 firmware).
 *
 * Strategy:
 *   1. Send request unauthenticated.
 *   2. On 401 with `WWW-Authenticate: Digest …`, parse the challenge,
 *      compute the response hash, retry once with `Authorization: Digest …`.
 *   3. If the first request succeeds (no auth required) or some other code
 *      comes back, return the response as-is.
 *
 * Returns the axios response or throws (same contract as axios.request).
 */
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios'
import { createHash, randomBytes } from 'crypto'

const md5 = (s: string) => createHash('md5').update(s).digest('hex')

type Parsed = Record<string, string>

/** Parse a WWW-Authenticate: Digest … challenge into a dictionary. */
function parseDigestChallenge(header: string): Parsed {
  // Strip the leading "Digest "
  const body = header.replace(/^Digest\s+/i, '')
  const out: Parsed = {}
  // Split on commas that are NOT inside quoted strings
  const parts = body.match(/(\w+)=("([^"]*)"|([^,]*))/g) ?? []
  for (const p of parts) {
    const eq = p.indexOf('=')
    if (eq === -1) continue
    const k = p.slice(0, eq).trim()
    let v = p.slice(eq + 1).trim()
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    out[k] = v
  }
  return out
}

/** Build an `Authorization: Digest …` value for the given challenge. */
function buildAuthHeader(
  ch: Parsed,
  method: string,
  uri: string,
  username: string,
  password: string,
): string {
  const realm     = ch['realm'] ?? ''
  const nonce     = ch['nonce'] ?? ''
  const qop       = (ch['qop'] ?? '').split(',').map(s => s.trim()).find(Boolean) // pick first, usually "auth"
  const opaque    = ch['opaque']
  const algorithm = (ch['algorithm'] ?? 'MD5').toUpperCase()
  const cnonce    = randomBytes(8).toString('hex')
  const nc        = '00000001'

  // HA1 = MD5(user:realm:pass)  — MD5-sess adds :nonce:cnonce
  let ha1 = md5(`${username}:${realm}:${password}`)
  if (algorithm === 'MD5-SESS') ha1 = md5(`${ha1}:${nonce}:${cnonce}`)

  const ha2 = md5(`${method.toUpperCase()}:${uri}`)

  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`)

  const parts = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `algorithm=${algorithm}`,
    `response="${response}"`,
  ]
  if (qop) {
    parts.push(`qop=${qop}`)
    parts.push(`nc=${nc}`)
    parts.push(`cnonce="${cnonce}"`)
  }
  if (opaque) parts.push(`opaque="${opaque}"`)

  return 'Digest ' + parts.join(', ')
}

/** Extract the request-URI (path + query) from a full URL. */
function pathOf(fullUrl: string): string {
  try {
    const u = new URL(fullUrl)
    return u.pathname + u.search
  } catch {
    return fullUrl
  }
}

/**
 * Perform an HTTP request that may be guarded by either Basic or Digest auth.
 * - Tries the request with no auth first, so non-authed endpoints still work.
 * - On 401 with a Digest challenge, computes the response and retries once.
 * - On 401 with a Basic challenge, retries once using Basic auth.
 */
export async function requestWithDigest(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  username: string,
  password: string,
  opts: Omit<AxiosRequestConfig, 'url' | 'method' | 'auth'> = {},
): Promise<AxiosResponse> {
  // ── Attempt 1: no auth, accept any status so we can read 401 challenge ──
  const base: AxiosRequestConfig = {
    ...opts,
    url,
    method,
    validateStatus: () => true,
  }

  const first = await axios.request(base)
  if (first.status !== 401) {
    // Success OR a non-auth error — just return it; caller decides
    return first
  }

  const wwwAuth = first.headers['www-authenticate'] ?? first.headers['WWW-Authenticate']
  if (!wwwAuth) throw new Error(`401 Unauthorized and no WWW-Authenticate header (url=${url})`)

  const headerStr = Array.isArray(wwwAuth) ? wwwAuth[0] : String(wwwAuth)

  // ── Basic challenge → just retry with Basic auth ──
  if (/^\s*Basic/i.test(headerStr)) {
    return axios.request({
      ...opts,
      url,
      method,
      auth: { username, password },
      validateStatus: opts.validateStatus ?? ((s) => s === 200),
    })
  }

  // ── Digest challenge → parse, compute, retry ──
  if (/^\s*Digest/i.test(headerStr)) {
    const challenge = parseDigestChallenge(headerStr)
    const uri = pathOf(url)
    const authHeader = buildAuthHeader(challenge, method, uri, username, password)

    return axios.request({
      ...opts,
      url,
      method,
      headers: { ...(opts.headers ?? {}), Authorization: authHeader },
      validateStatus: opts.validateStatus ?? ((s) => s === 200),
    })
  }

  throw new Error(`Unsupported auth scheme: ${headerStr.split(' ')[0]} (url=${url})`)
}
