'use client'
import { useEffect, useState } from 'react'
import { Invite } from './types'
import { IconNavigate } from './icons'

interface Props {
  invite: Invite
}

/**
 * Hero glass — wzorzec `guest-pass-2026-07/handoff_guest_invite`:
 * awatar hosta + „Zaprasza Cię …" + powitanie, karta (Adres / Mieszkanie /
 * Ważność dostępu + pełnowymiarowy przycisk „Nawiguj" WEWNĄTRZ karty),
 * pod kartą zielony licznik live („wygasa za …" / „aktywny od …" / „wygasł").
 */
export function Hero({ invite }: Props) {
  // Deep-link liczony PO hydracji (navigator.userAgent) — SSR renderuje
  // Google Maps (uniwersalny fallback), klient Apple podmienia na Apple Maps.
  // useEffect zamiast inline-check → brak hydration mismatch na atrybucie href.
  const [navUrl, setNavUrl] = useState(() => mapsDeepLink(invite.estate, false))
  useEffect(() => {
    const isApple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent)
    if (isApple) setNavUrl(mapsDeepLink(invite.estate, true))
  }, [invite.estate])

  return (
    <div className="gli-hero">
      <div className="gli-invite-row">
        <div className="gli-host-avatar">{invite.host.initials}</div>
        <div className="gli-invite-meta">
          <p className="gli-invite-host">
            Zaprasza Cię <strong>{invite.host.firstName} {invite.host.lastName}</strong>
          </p>
          <p className="gli-invite-greeting">Cześć, {invite.guest.firstName}</p>
        </div>
      </div>

      <div className="gli-invite-card">
        <div className="gli-invite-item">
          <div className="gli-label">Adres</div>
          <div className="gli-value">
            {invite.estate.name}
            <br />
            {invite.estate.address}
          </div>
        </div>
        {invite.estate.apartment && (
          <div className="gli-invite-item">
            <div className="gli-label">Mieszkanie</div>
            <div className="gli-value">{invite.estate.apartment}</div>
          </div>
        )}
        <div className="gli-invite-item gli-full">
          <div className="gli-label">Ważność dostępu</div>
          <div className="gli-value">{formatWindow(invite.window.startsAt, invite.window.endsAt)}</div>
        </div>
        <a
          className="gli-nav-inline"
          href={navUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          <IconNavigate />
          Nawiguj
        </a>
      </div>

      <Countdown
        startsAt={invite.window.startsAt}
        endsAt={invite.window.endsAt}
        windowStatus={invite.windowStatus}
      />
    </div>
  )
}

/**
 * Deep-link do map z adresem osiedla. Apple Maps na urządzeniach Apple
 * (maps.apple.com uniwersalnie otwiera natywną apkę), Google Maps wszędzie
 * indziej. Backend nie ma coords (TODO Building.lat/lng) — szukamy po adresie.
 */
function mapsDeepLink(estate: Invite['estate'], apple: boolean): string {
  const query = estate.coords
    ? `${estate.coords.lat},${estate.coords.lng}`
    : `${estate.name} ${estate.address}`
  const q = encodeURIComponent(query)
  return apple ? `https://maps.apple.com/?q=${q}` : `https://maps.google.com/?q=${q}`
}

function Countdown({
  startsAt,
  endsAt,
  windowStatus,
}: {
  startsAt: string
  endsAt: string
  windowStatus: Invite['windowStatus']
}) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000) // co 30s — odświeża „za 4 g. 12 min"
    return () => clearInterval(t)
  }, [])

  const start = new Date(startsAt).getTime()
  const end = new Date(endsAt).getTime()

  let tone: 'ok' | 'warn' | 'bad' = 'ok'
  let content: React.ReactNode
  if (windowStatus === 'EXPIRED' || now >= end) {
    tone = 'bad'
    content = <span>Dostęp wygasł</span>
  } else if (windowStatus === 'UPCOMING' && now < start) {
    tone = 'warn'
    content = (
      <span>
        Dostęp aktywny od <strong>{formatStart(start)}</strong>
      </span>
    )
  } else {
    content = (
      <span>
        Dostęp aktywny — wygasa za <strong>{formatRemaining(end - now)}</strong>
      </span>
    )
  }

  const cls = tone === 'bad' ? 'gli-countdown gli-bad' : tone === 'warn' ? 'gli-countdown gli-warn' : 'gli-countdown'
  return (
    <div className={cls}>
      <span className="gli-pulse" />
      {content}
    </div>
  )
}

function formatWindow(start: string, end: string): string {
  const s = new Date(start)
  const e = new Date(end)
  const sameDay = s.toDateString() === e.toDateString()
  const dateFmt = new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'long' })
  const timeFmt = new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit' })

  const today = new Date()
  const isToday = s.toDateString() === today.toDateString()
  const prefix = isToday ? 'Dziś, ' : ''

  if (sameDay) {
    return `${prefix}${dateFmt.format(s)} · ${timeFmt.format(s)} → ${timeFmt.format(e)}`
  }
  return `${dateFmt.format(s)} ${timeFmt.format(s)} → ${dateFmt.format(e)} ${timeFmt.format(e)}`
}

/** „od 14:00" (dziś) albo „od 12 lipca, 14:00" (inny dzień). */
function formatStart(ts: number): string {
  const d = new Date(ts)
  const time = new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit' }).format(d)
  if (d.toDateString() === new Date().toDateString()) return time
  const date = new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'long' }).format(d)
  return `${date}, ${time}`
}

function formatRemaining(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000))
  if (totalMin < 60) return `${totalMin} min`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return `${h} g. ${m} min`
}
