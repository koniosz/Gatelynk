/**
 * UniFi Network Controller REST client.
 *
 * Wspiera dwie ścieżki:
 *   • UniFi OS (UDM, CloudKey Gen2) — `/api/auth/login` + prefix `/proxy/network/`
 *   • Self-host / standalone        — `/api/login`      + bezpośrednio `/api/...`
 *
 * Auth: session cookie (`unifises` na self-host, `TOKEN` na UniFi OS).
 * Trzymamy ostatnie cookie + CSRF token w pamięci. Przy 401 robimy re-login.
 *
 * NIE używamy axios — zostajemy przy nativeFetch (Node 22) żeby uniknąć
 * dodatkowej zależności i zachować spójność z resztą Edge (np. tunnel.service).
 *
 * TLS: kontrolery UniFi mają self-signed cert. Edge ma globalnie wyłączoną
 * weryfikację TLS (`NODE_TLS_REJECT_UNAUTHORIZED=0` w main.ts) — działamy w LAN-only.
 */

export type UnifiControllerType = 'unifi-os' | 'standalone'

export interface UnifiClientOpts {
  controllerUrl: string
  controllerType: UnifiControllerType
  username: string
  password: string
  site?: string
}

/** Wycinek odpowiedzi `/stat/device` dla switcha — pomijamy 80% pól, których nie używamy. */
export interface UnifiSwitchDevice {
  /** Mongo ObjectId — używany w URL-u PUT do device-update. */
  _id: string
  mac: string
  model: string
  name?: string
  type: string
  state: number          // 1 = connected/online
  uptime?: number
  version?: string
  ip?: string
  port_table: UnifiPortInfo[]
  /** Per-port overrides ustawione przez admina (PoE off, custom name, …). */
  port_overrides?: UnifiPortOverride[]
}

export interface UnifiPortInfo {
  port_idx: number       // 1-based
  name: string
  enable: boolean        // hardware-level enable
  up: boolean            // link up
  speed: number          // 0/10/100/1000/2500/10000
  full_duplex?: boolean
  poe_caps?: number
  poe_class?: string
  poe_enable?: boolean
  poe_mode?: 'auto' | 'off' | 'passive24' | 'passthrough' | string
  poe_power?: string     // wat, np. "5.4"
  poe_current?: string   // mA
  poe_voltage?: string   // V
  rx_bytes?: number
  tx_bytes?: number
  rx_packets?: number
  tx_packets?: number
  /** MAC pierwszego widocznego klienta na porcie (jeśli switch ma mac-table). */
  sfp_found?: boolean
}

export interface UnifiPortOverride {
  port_idx: number
  name?: string
  poe_mode?: 'auto' | 'off' | 'passive24' | 'passthrough'
  portconf_id?: string
}

export class UnifiClient {
  private cookie: string | null = null
  private csrf: string | null = null
  private readonly base: string
  private readonly apiPrefix: string
  private readonly loginPath: string

  constructor(private readonly opts: UnifiClientOpts) {
    this.base = opts.controllerUrl.replace(/\/+$/, '')
    if (opts.controllerType === 'unifi-os') {
      this.apiPrefix = '/proxy/network/api'
      this.loginPath = '/api/auth/login'
    } else {
      this.apiPrefix = '/api'
      this.loginPath = '/api/login'
    }
  }

  get site(): string {
    return this.opts.site ?? 'default'
  }

  private async login(): Promise<void> {
    const res = await fetch(`${this.base}${this.loginPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: this.opts.username,
        password: this.opts.password,
        remember: false,
      }),
    })
    if (!res.ok) {
      throw new Error(`UniFi login failed: HTTP ${res.status} ${await res.text().catch(() => '')}`)
    }
    // Set-Cookie header — Node 22 fetch wystawia go w `getSetCookie()` (RFC 6265 multi-cookie).
    const cookies = (res.headers as any).getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean) as string[]
    // Trzymamy tylko nazwa=wartość (pomijamy Path/HttpOnly/Secure attrs).
    this.cookie = cookies
      .map((c: string) => c.split(';')[0])
      .filter(Boolean)
      .join('; ')
    // UniFi OS dorzuca CSRF token w nagłówku odpowiedzi.
    this.csrf = res.headers.get('x-csrf-token') ?? res.headers.get('x-updated-csrf-token') ?? null
  }

  private async request<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    retried = false,
  ): Promise<T> {
    if (!this.cookie) await this.login()

    const url = `${this.base}${this.apiPrefix}${path}`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Cookie: this.cookie ?? '',
    }
    if (this.csrf && method !== 'GET') headers['X-CSRF-Token'] = this.csrf

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    // CSRF rotation — UniFi OS może odesłać nowy token w odpowiedzi.
    const newCsrf = res.headers.get('x-updated-csrf-token')
    if (newCsrf) this.csrf = newCsrf

    if (res.status === 401 || res.status === 403) {
      if (retried) {
        throw new Error(`UniFi auth failed after re-login: HTTP ${res.status}`)
      }
      // Cookie expired — relogin i retry.
      this.cookie = null
      this.csrf = null
      return this.request<T>(method, path, body, true)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`UniFi ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`)
    }

    const payload = await res.json() as { data?: T; meta?: { rc: string; msg?: string } }
    if (payload?.meta?.rc && payload.meta.rc !== 'ok') {
      throw new Error(`UniFi ${path} rc=${payload.meta.rc} ${payload.meta.msg ?? ''}`)
    }
    return (payload?.data ?? payload) as T
  }

  /**
   * Pobiera wszystkie urządzenia adopted w site-cie. Filtrujemy po MAC żeby
   * znaleźć interesujący switch (jeden controller może mieć wiele switchy).
   */
  async getDevices(): Promise<UnifiSwitchDevice[]> {
    return this.request<UnifiSwitchDevice[]>('GET', `/s/${this.site}/stat/device`)
  }

  async findSwitchByMac(mac: string): Promise<UnifiSwitchDevice | null> {
    const wanted = mac.toLowerCase().replace(/[^0-9a-f]/g, '')
    const all = await this.getDevices()
    return all.find((d) => (d.mac ?? '').toLowerCase().replace(/[^0-9a-f]/g, '') === wanted) ?? null
  }

  /**
   * Aktualizuje per-port overrides dla danego switcha. UniFi REST przyjmuje
   * pełną listę `port_overrides` w PUT (cała lista jest replace, NIE merge).
   *
   * Caller musi przekazać kompletny zestaw — typowo: bierzemy bieżące
   * `device.port_overrides`, podmieniamy/dorzucamy wpis dla `port_idx`,
   * przekazujemy z powrotem.
   */
  async putPortOverrides(deviceObjectId: string, overrides: UnifiPortOverride[]): Promise<void> {
    await this.request<unknown>(
      'PUT',
      `/s/${this.site}/rest/device/${deviceObjectId}`,
      { port_overrides: overrides },
    )
  }
}

/** Helper: scala istniejące overrides ze zmianami w jednej (port_idx) pozycji. */
export function mergePortOverride(
  current: UnifiPortOverride[],
  portIdx: number,
  patch: Partial<UnifiPortOverride>,
): UnifiPortOverride[] {
  const idx = current.findIndex((o) => o.port_idx === portIdx)
  if (idx === -1) {
    return [...current, { port_idx: portIdx, ...patch }]
  }
  const next = [...current]
  next[idx] = { ...next[idx], ...patch, port_idx: portIdx }
  return next
}
