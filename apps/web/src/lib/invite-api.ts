/**
 * Helper do `/api/invite/*` endpointów. Używany:
 *   • SSR strony `app/i/[token]/page.tsx` — server-side fetch w `getInvite()`
 *   • Next API routes proxy `app/api/invite/[token]/*` — przekazują requests
 *     dalej do backend NestJS (Fly.io / localhost dev).
 *
 * Public — NIE wymaga auth. Token w URL = capability.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000/api'

export async function fetchInviteServer(token: string, clientIp?: string): Promise<{
  ok: boolean
  status: number
  data: unknown
}> {
  const res = await fetch(`${API_BASE}/invite/${encodeURIComponent(token)}`, {
    cache: 'no-store',
    headers: clientIp ? { 'X-Forwarded-For': clientIp } : undefined,
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}
