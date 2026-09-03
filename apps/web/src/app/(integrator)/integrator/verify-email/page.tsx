'use client'
/**
 * Verify Email Page (Sesja 6) — landing po kliku w link z maila.
 *
 * URL: /integrator/verify-email?token=ec_xxxx
 *
 * Flow:
 *   1. Czytamy `token` z query string
 *   2. POST /integrator/me/email-change/verify { token }
 *   3. Sukces → redirect do /integrator/login z toast „Email zmieniony, zaloguj się"
 *   4. Błąd → friendly message + link „Wróć do panelu"
 *
 * Public — bez JWT. Token sam autoryzuje (TTL 24h, one-time use).
 */
import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { CheckCircle2, AlertTriangle, Mail, ArrowRight } from 'lucide-react'
import { integratorApi } from '@/lib/integrator-api'
import { Spinner } from '@/components/integrator/property/shared/Spinner'

// Next.js wymaga Suspense boundary dla useSearchParams() podczas SSG.
export default function VerifyEmailPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center p-6 bg-bg">
        <Spinner size={36} />
      </div>
    }>
      <VerifyEmailContent />
    </Suspense>
  )
}

function VerifyEmailContent() {
  const router = useRouter()
  const params = useSearchParams()
  const token = params.get('token')
  const [state, setState] = useState<'verifying' | 'success' | 'error'>('verifying')
  const [newEmail, setNewEmail] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => {
    if (!token) {
      setState('error')
      setErrorMsg('Brak tokenu weryfikacyjnego w URL-u')
      return
    }
    integratorApi.post<{ verified: boolean; newEmail: string }>(
      '/integrator/me/email-change/verify',
      { token },
    )
      .then((r) => {
        setNewEmail(r.data.newEmail)
        setState('success')
        // Auto-redirect po 5 sek do logina (user musi się ponownie zalogować)
        setTimeout(() => router.push('/integrator/login'), 5000)
      })
      .catch((err: unknown) => {
        const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
          ?? 'Nieprawidłowy lub wygasły token'
        setErrorMsg(msg)
        setState('error')
      })
  }, [token, router])

  return (
    <div
      className="min-h-screen flex items-center justify-center p-6 bg-bg"
      style={{ fontFamily: 'var(--font-plex-sans, system-ui)' }}
    >
      <div className="bg-surface border border-border rounded-r3 max-w-md w-full p-8 text-center">
        {state === 'verifying' && (
          <>
            <Spinner size={36} className="mx-auto mb-4" />
            <h1 className="text-[16px] font-semibold text-ink mb-1">Weryfikacja…</h1>
            <p className="text-[13px] text-muted">Sprawdzamy token, chwilę cierpliwości.</p>
          </>
        )}

        {state === 'success' && (
          <>
            <CheckCircle2 size={48} strokeWidth={1.5} className="text-success mx-auto mb-4" />
            <h1 className="text-[16px] font-semibold text-ink mb-1">Email zmieniony</h1>
            <p className="text-[13px] text-muted mb-1">
              Twój nowy adres logowania:
            </p>
            <p className="text-[14px] font-medium text-ink mb-4 flex items-center justify-center gap-1.5">
              <Mail size={14} className="text-brand" />
              {newEmail}
            </p>
            <p className="text-[11px] text-muted-2 mb-5">
              Za chwilę zostaniesz przekierowany na stronę logowania (lub kliknij poniżej).
            </p>
            <Link
              href="/integrator/login"
              className="inline-flex items-center gap-2 bg-brand text-white text-[13px] font-medium px-4 py-2 rounded-r2 hover:bg-brand-600 transition-colors"
            >
              Zaloguj się ponownie
              <ArrowRight size={13} />
            </Link>
          </>
        )}

        {state === 'error' && (
          <>
            <AlertTriangle size={48} strokeWidth={1.5} className="text-danger mx-auto mb-4" />
            <h1 className="text-[16px] font-semibold text-ink mb-1">Nie udało się zweryfikować</h1>
            <p className="text-[13px] text-muted mb-4">{errorMsg}</p>
            <p className="text-[11px] text-muted-2 mb-5 leading-relaxed">
              Typowe powody: link wygasł (24h TTL), token już użyty, albo nowy adres jest zajęty.
              Wróć do Panel Integratora → Ustawienia → Konto i spróbuj ponownie.
            </p>
            <Link
              href="/integrator/login"
              className="inline-flex items-center gap-2 text-[13px] text-brand hover:text-brand-600 font-medium"
            >
              Wróć do logowania
              <ArrowRight size={13} />
            </Link>
          </>
        )}
      </div>
    </div>
  )
}
