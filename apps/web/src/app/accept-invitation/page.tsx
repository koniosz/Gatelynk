'use client'
/**
 * PR-6 (2026-07-05) — publiczna strona akceptacji zaproszenia mieszkańca.
 *
 * URL z maila: /accept-invitation?token=<64 hex> (InvitationsService.send).
 * Flow: GET /api/invitations/preview?token → nagłówek (imię, budynek, lokal)
 *       → formularz hasła → POST /api/invitations/accept?token {password}
 *       → sukces + instrukcja logowania w aplikacji iOS.
 *
 * Strona jest publiczna (token = autoryzacja) — poza route-groupami paneli,
 * bez sidebara. Suspense wymagany przez Next dla useSearchParams.
 */
import { Suspense, useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000/api'

interface Preview {
  valid: boolean
  status: string
  expiresAt: string
  residentName: string
  email: string
  buildingName: string
  unitLabel: string
  alreadyActive: boolean
}

export default function AcceptInvitationPage() {
  return (
    <Suspense fallback={<Shell><p className="text-sm text-gray-500">Ładowanie…</p></Shell>}>
      <AcceptInvitationInner />
    </Suspense>
  )
}

function AcceptInvitationInner() {
  const params = useSearchParams()
  const token = params.get('token') ?? ''

  const [preview, setPreview] = useState<Preview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [busy, setBusy] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (!token) {
      setLoadError('Brak tokenu zaproszenia — otwórz link z wiadomości e-mail.')
      return
    }
    fetch(`${API_URL}/invitations/preview?token=${encodeURIComponent(token)}`)
      .then(async (res) => {
        const data = await res.json()
        if (!res.ok) throw new Error(data?.message ?? 'Zaproszenie nie istnieje')
        setPreview(data)
      })
      .catch((err) => setLoadError(err.message))
  }, [token])

  const submit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitError(null)
    if (password.length < 8) {
      setSubmitError('Hasło musi mieć co najmniej 8 znaków.')
      return
    }
    if (password !== password2) {
      setSubmitError('Hasła nie są identyczne.')
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`${API_URL}/invitations/accept?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.message ?? 'Nie udało się aktywować konta')
      setDone(true)
    } catch (err: any) {
      setSubmitError(err.message)
    } finally {
      setBusy(false)
    }
  }, [token, password, password2])

  if (loadError) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-gray-900 mb-2">Zaproszenie nieaktywne</h1>
        <p className="text-sm text-gray-600">{loadError}</p>
        <p className="text-xs text-gray-400 mt-4">
          Poproś administratora budynku o nowe zaproszenie.
        </p>
      </Shell>
    )
  }

  if (!preview) {
    return <Shell><p className="text-sm text-gray-500">Sprawdzanie zaproszenia…</p></Shell>
  }

  if (done) {
    return (
      <Shell>
        <div className="text-4xl mb-3">✅</div>
        <h1 className="text-lg font-semibold text-gray-900 mb-2">Konto aktywne!</h1>
        <p className="text-sm text-gray-600 mb-4">
          Twoje konto w obiekcie <strong>{preview.buildingName}</strong> jest gotowe.
        </p>
        <ol className="text-sm text-gray-700 text-left space-y-2 bg-gray-50 rounded-lg p-4 mb-4 list-decimal list-inside">
          <li>Pobierz aplikację <strong>GateLynk</strong> z App Store</li>
          <li>Zaloguj się adresem <strong>{preview.email}</strong> i nowym hasłem</li>
          <li>Otwieraj bramę i furtkę, dodawaj pojazdy i zapraszaj gości</li>
        </ol>
        <p className="text-xs text-gray-400">Możesz zamknąć tę stronę.</p>
      </Shell>
    )
  }

  if (preview.alreadyActive && preview.status !== 'PENDING') {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-gray-900 mb-2">Konto już aktywne</h1>
        <p className="text-sm text-gray-600">
          To zaproszenie zostało już wykorzystane — zaloguj się w aplikacji GateLynk
          adresem <strong>{preview.email}</strong>.
        </p>
      </Shell>
    )
  }

  if (!preview.valid) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-gray-900 mb-2">Zaproszenie wygasło</h1>
        <p className="text-sm text-gray-600">
          Link był ważny do {new Date(preview.expiresAt).toLocaleDateString('pl-PL')}.
          Poproś administratora budynku <strong>{preview.buildingName}</strong> o nowe zaproszenie.
        </p>
      </Shell>
    )
  }

  return (
    <Shell>
      <div className="text-4xl mb-3">🏠</div>
      <h1 className="text-lg font-semibold text-gray-900 mb-1">
        Witaj, {preview.residentName}!
      </h1>
      <p className="text-sm text-gray-600 mb-5">
        Aktywujesz konto mieszkańca w obiekcie <strong>{preview.buildingName}</strong>
        {' '}({preview.unitLabel}). Ustaw hasło do aplikacji GateLynk.
      </p>

      <form onSubmit={submit} className="text-left space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Adres e-mail (login)</label>
          <input
            type="email"
            value={preview.email}
            disabled
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Nowe hasło (min. 8 znaków)</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            required
            minLength={8}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Powtórz hasło</label>
          <input
            type="password"
            value={password2}
            onChange={(e) => setPassword2(e.target.value)}
            autoComplete="new-password"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            required
            minLength={8}
          />
        </div>
        {submitError && (
          <p className="text-sm text-red-600">{submitError}</p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg px-4 py-2.5 transition-colors disabled:opacity-50"
        >
          {busy ? 'Aktywowanie…' : 'Ustaw hasło i aktywuj konto'}
        </button>
        <p className="text-[11px] text-gray-400 text-center">
          Link ważny do {new Date(preview.expiresAt).toLocaleDateString('pl-PL')}
        </p>
      </form>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 max-w-md w-full p-8 text-center">
        {children}
        <p className="text-[11px] text-gray-300 mt-6">GateLynk — system zarządzania obiektem</p>
      </div>
    </div>
  )
}
