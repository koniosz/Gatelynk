import { NextRequest } from 'next/server'
import { proxyInvite } from '../_proxy'

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  return proxyInvite('POST', token, '/report', req)
}
