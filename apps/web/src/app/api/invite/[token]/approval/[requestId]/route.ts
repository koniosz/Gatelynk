import { NextRequest } from 'next/server'
import { proxyInvite } from '../../_proxy'

/**
 * Polling statusu prośby o zatwierdzenie (UNIT_DOOR z `approvalRequired`).
 * Proxy do backendu `GET /api/invite/:token/approval/:requestId` —
 * frontend (`AccessList`) odpytuje co 2.5 s aż status ≠ PENDING.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ token: string; requestId: string }> },
) {
  const { token, requestId } = await ctx.params
  return proxyInvite('GET', token, `/approval/${encodeURIComponent(requestId)}`, req)
}
