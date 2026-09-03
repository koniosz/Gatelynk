'use client'
import { useState } from 'react'
import { Invite } from './types'
import { Brand } from './Brand'
import { Hero } from './Hero'
import { AccessList } from './AccessList'
import { EmergencyPin } from './EmergencyPin'
import { Rules } from './Rules'
import { Footer } from './Footer'
import { Toast } from './Toast'

interface Props {
  invite: Invite
}

/**
 * Top-level client component który spina interactive sekcje (AccessList,
 * EmergencyPin) + dzielony Toast. SSR strona w `app/i/[token]/page.tsx`
 * przekazuje server-fetched `invite` props; reszta dzieje się client-side.
 *
 * Struktura wg handoffu guest-pass-2026-07: pasek marki → hero (z „Nawiguj"
 * w karcie) → Twoje wejścia → Awaryjny PIN → Dobrze wiedzieć (warunkowo,
 * dziś ukryte) → stopka. Sekcja mapy z poprzedniej iteracji usunięta —
 * nawigacja przeniesiona do hero zgodnie z finalnym wzorcem.
 */
export function InvitePage({ invite }: Props) {
  const [toast, setToast] = useState<{ msg: string; tone: 'ok' | 'fail' } | null>(null)

  const showToast = (msg: string, tone: 'ok' | 'fail' = 'ok') => {
    setToast({ msg, tone })
  }

  return (
    <div className="gli-stage">
      <div className="gli-page">
        <Brand />
        <Hero invite={invite} />
        <AccessList invite={invite} onToast={showToast} />
        <EmergencyPin token={invite.token} hasPin={invite.hasPin} onToast={showToast} />
        <Rules items={invite.rules} />
        <Footer invite={invite} />
      </div>
      <Toast msg={toast?.msg ?? null} tone={toast?.tone ?? 'ok'} onHide={() => setToast(null)} />
    </div>
  )
}
