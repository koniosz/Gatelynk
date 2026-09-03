import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { fetchInviteServer } from '@/lib/invite-api'
import { Invite } from '@/components/invite/types'
import { InvitePage } from '@/components/invite/InvitePage'
import { InviteRevoked, InviteExpired, InviteUnknown } from './errors'

interface Props {
  params: Promise<{ token: string }>
}

/**
 * SSR strony zaproszenia. Server-side fetch backend `GET /api/invite/:token`.
 *
 * Edge cases (zgodnie ze spec):
 *   • 404 NotFound → `InviteUnknown` (zaślepka „nie istnieje")
 *   • 410 Gone CANCELLED → `InviteRevoked` (zaproszenie odwołane przez hosta)
 *   • 410 Gone EXPIRED → `InviteExpired`
 *   • 429 RateLimit → not-found z opisem
 *   • OK → render `InvitePage`
 *
 * `windowStatus = UPCOMING` (przed startsAt) renderuje normalnie ale `AccessList`
 * disabled-uje przyciski i `Countdown` pokazuje „Dostęp aktywny od X".
 */
export default async function InvitePageRoute({ params }: Props) {
  const { token } = await params
  const hdr = await headers()
  const clientIp = hdr.get('fly-client-ip') ?? hdr.get('x-forwarded-for') ?? undefined

  const res = await fetchInviteServer(token, clientIp)

  if (res.status === 404) return <InviteUnknown />
  if (res.status === 410) {
    const code = (res.data as { code?: string })?.code ?? ''
    return code === 'CANCELLED' ? <InviteRevoked /> : <InviteExpired />
  }
  if (!res.ok) {
    notFound()
  }

  const invite = res.data as Invite
  return <InvitePage invite={invite} />
}
