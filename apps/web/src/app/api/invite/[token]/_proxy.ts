/**
 * Reusable proxy do backend Nest-a (`/api/invite/*`). Plik prefixed `_` żeby
 * Next App Router nie traktował go jako route.
 *
 * `NEXT_PUBLIC_API_URL` jest publiczne (eksportowane do client bundle), tu
 * używamy go server-side w Next API routes — to OK.
 */
import { NextRequest, NextResponse } from 'next/server'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000/api'

export async function proxyInvite(
  method: 'GET' | 'POST',
  token: string,
  path: string,
  req: NextRequest,
): Promise<NextResponse> {
  const url = `${API_BASE}/invite/${encodeURIComponent(token)}${path}`
  const body = method === 'POST' ? await req.text() : undefined
  // Real client IP — Fly proxy ustawia Fly-Client-IP, Cloudflare X-Forwarded-For.
  const xff =
    req.headers.get('fly-client-ip') ??
    req.headers.get('x-forwarded-for') ??
    ''
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (xff) headers['X-Forwarded-For'] = xff
  const res = await fetch(url, { method, headers, body, cache: 'no-store' })
  const text = await res.text()
  return new NextResponse(text, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('content-type') ?? 'application/json' },
  })
}
