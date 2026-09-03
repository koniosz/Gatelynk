'use client'
/**
 * Domownicy (2026-08-09) — publiczna strona akceptacji zaproszenia domownika.
 *
 * URL z ShareLink-a mieszkańca: /accept-household?token=<64 hex>
 * (HouseholdInvitationsService.create → inviteUrl).
 *
 * Flow (wzór 1:1 z /accept-invitation, PR-6): GET preview → nagłówek (kto
 * zaprasza, budynek, lokal) → formularz: imię/nazwisko (prefill z zaproszenia,
 * edytowalne) + WŁASNY e-mail + hasło → POST accept → sukces + instrukcja
 * „Pobierz aplikację GateLynk i zaloguj się".
 *
 * Różnica vs admin flow: tam Resident już istnieje (e-mail znany, pole
 * disabled), tu Resident POWSTAJE przy akceptacji — e-mail wpisuje domownik.
 * Strona publiczna (token = autoryzacja), poza route-groupami paneli.
 */
import { Suspense, useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000/api'

interface Preview {
  valid: boolean
  status: string
  expiresAt: string
  inviteeName: string
  relationLabel: string | null
  inviterName: string
  buildingName: string
  unitLabel: string
}

export default function AcceptHouseholdPage() {
  return (
    <Suspense fallback={<Shell><p className="text-sm text-gray-500">Ładowanie…</p></Shell>}>
      <AcceptHouseholdInner />
    </Suspense>
  )
}

function AcceptHouseholdInner() {
  const params = useSearchParams()
  const token = params.get('token') ?? ''

  const [preview, setPreview] = useState<Preview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [busy, setBusy] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [done, setDone] = useState<{ email: string; buildingName: string } | null>(null)

  useEffect(() => {
    if (!token) {
      setLoadError('Brak tokenu zaproszenia — otwórz link z wiadomości.')
      return
    }
    fetch(`${API_URL}/household-invitations/preview?token=${encodeURIComponent(token)}`)
      .then(async (res) => {
        const data = await res.json()
        if (!res.ok) throw new Error(data?.message ?? 'Zaproszenie nie istnieje')
        setPreview(data)
        // Prefill imienia/nazwiska z zaproszenia — domownik może poprawić.
        const parts: string[] = (data.inviteeName ?? '').trim().split(/\s+/)
        setFirstName(parts[0] ?? '')
        setLastName(parts.slice(1).join(' '))
      })
      .catch((err) => setLoadError(err.message))
  }, [token])

  const submit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitError(null)
    if (!firstName.trim()) {
      setSubmitError('Podaj swoje imię.')
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setSubmitError('Podaj poprawny adres e-mail.')
      return
    }
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
      const res = await fetch(
        `${API_URL}/household-invitations/accept?token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: email.trim(),
            password,
            firstName: firstName.trim(),
            lastName: lastName.trim() || undefined,
          }),
        },
      )
      const data = await res.json()
      if (!res.ok) {
        throw new Error(
          Array.isArray(data?.message) ? data.message.join('; ') : data?.message ?? 'Nie udało się utworzyć konta',
        )
      }
      setDone({ email: data.email, buildingName: data.buildingName })
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Nie udało się utworzyć konta')
    } finally {
      setBusy(false)
    }
  }, [token, firstName, lastName, email, password, password2])

  if (loadError) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-gray-900 mb-2">Zaproszenie nieaktywne</h1>
        <p className="text-sm text-gray-600">{loadError}</p>
        <p className="text-xs text-gray-400 mt-4">
          Poproś osobę, która Cię zaprosiła, o nowe zaproszenie z aplikacji GateLynk.
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
        <h1 className="text-lg font-semibold text-gray-900 mb-2">Konto gotowe!</h1>
        <p className="text-sm text-gray-600 mb-4">
          Jesteś teraz mieszkańcem obiektu <strong>{done.buildingName}</strong>
          {' '}({preview.unitLabel}).
        </p>
        <ol className="text-sm text-gray-700 text-left space-y-2 bg-gray-50 rounded-lg p-4 mb-4 list-decimal list-inside">
          <li>Pobierz aplikację <strong>GateLynk</strong> z App Store</li>
          <li>Zaloguj się adresem <strong>{done.email}</strong> i nowym hasłem</li>
          <li>Otwieraj bramę i furtkę, dodawaj pojazdy i zapraszaj gości</li>
        </ol>
        <p className="text-xs text-gray-400">Możesz zamknąć tę stronę.</p>
      </Shell>
    )
  }

  if (!preview.valid) {
    const wasUsed = preview.status === 'ACCEPTED'
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-gray-900 mb-2">
          {wasUsed ? 'Zaproszenie wykorzystane' : 'Zaproszenie nieaktywne'}
        </h1>
        <p className="text-sm text-gray-600">
          {wasUsed
            ? 'To zaproszenie zostało już użyte — jeśli to Ty, zaloguj się w aplikacji GateLynk.'
            : `Link był ważny do ${new Date(preview.expiresAt).toLocaleDateString('pl-PL')} lub został anulowany. Poproś ${preview.inviterName} o nowe zaproszenie z aplikacji.`}
        </p>
      </Shell>
    )
  }

  return (
    <Shell>
      <div className="text-4xl mb-3">👨‍👩‍👧</div>
      <h1 className="text-lg font-semibold text-gray-900 mb-1">
        Cześć, {preview.inviteeName}!
      </h1>
      <p className="text-sm text-gray-600 mb-5">
        <strong>{preview.inviterName}</strong> zaprasza Cię jako domownika w obiekcie{' '}
        <strong>{preview.buildingName}</strong> ({preview.unitLabel}).
        Podaj swój e-mail i ustaw hasło do aplikacji GateLynk.
      </p>

      <form onSubmit={submit} className="text-left space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Imię</label>
            <input
              type="text"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Nazwisko</label>
            <input
              type="text"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Twój adres e-mail (login)</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            placeholder="np. anna@przyklad.pl"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            required
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Hasło (min. 8 znaków)</label>
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
          {busy ? 'Tworzenie konta…' : 'Utwórz konto domownika'}
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
