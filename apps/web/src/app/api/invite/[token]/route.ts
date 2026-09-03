import { NextRequest, NextResponse } from 'next/server'
import { proxyInvite } from './_proxy'

/**
 * Proxy GET /api/invite/:token z Next-a do backend Nest-a. Patrz `_proxy.ts`.
 * Forward X-Forwarded-For dla rate limit + audit po backend stronie.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  return proxyInvite('GET', token, '', req)
}
