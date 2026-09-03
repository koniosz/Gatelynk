'use client'
import { Suspense, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { buildingAdminApi } from '@/lib/building-admin-api'

// 2026-07-18: reset hasła BA — krok 2 (link z maila `?token=`). Dwa pola
// (nowe hasło + powtórz), walidacja min 8 znaków i zgodności; po sukcesie
// przycisk powrotu do logowania. useSearchParams wymaga Suspense boundary
// (Next CSR bailout), stąd wrapper.

function ResetPasswordInner() {
  const params = useSearchParams()
  const token = params.get('token') ?? ''

  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password.length < 8) { setError('Hasło musi mieć co najmniej 8 znaków.'); return }
    if (password !== password2) { setError('Hasła nie są identyczne.'); return }
    setLoading(true); setError(null)
    try {
      await buildingAdminApi.post('/building-admin/auth/reset-password', { token, password })
      setDone(true)
    } catch (err: any) {
      setError(err?.response?.data?.message ?? 'Nie udało się zresetować hasła. Spróbuj ponownie.')
    } finally { setLoading(false) }
  }

  return (
    <div className="relative w-full max-w-sm gl-fade-in">
      <div className="flex flex-col items-center mb-8">
        <div
          className="gl-pulse flex items-center justify-center w-[104px] h-[104px] rounded-[28px]"
          style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.16)' }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/gatelynk-mark.png" alt="GateLynk" className="w-14 h-14" />
        </div>
        <h1 className="mt-6 text-2xl font-extrabold" style={{ color: '#F4F6FB' }}>Nowe hasło</h1>
        <p className="mt-3 text-sm text-center" style={{ color: 'rgba(244,246,251,0.55)' }}>
          Ustaw nowe hasło do konta administratora.
        </p>
      </div>

      <div
        className="rounded-3xl p-7 backdrop-blur-md"
        style={{
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.10)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
        }}
      >
        {!token ? (
          <div className="text-center space-y-4">
            <div className="text-4xl">⚠️</div>
            <p className="text-sm leading-relaxed" style={{ color: 'rgba(244,246,251,0.85)' }}>
              Brak tokenu resetu w adresie. Otwórz link z wiadomości e-mail albo poproś o nowy.
            </p>
            <Link
              href="/building-admin/forgot-password"
              className="inline-block w-full text-white text-sm font-semibold py-2.5 rounded-xl transition"
              style={{ background: '#3B5BFF', boxShadow: '0 10px 26px rgba(59,91,255,0.35)' }}
            >
              Poproś o nowy link
            </Link>
          </div>
        ) : done ? (
          <div className="text-center space-y-4">
            <div className="text-4xl">✅</div>
            <p className="text-sm leading-relaxed" style={{ color: 'rgba(244,246,251,0.85)' }}>
              Hasło zostało zmienione. Możesz się teraz zalogować nowym hasłem.
            </p>
            <Link
              href="/building-admin/login"
              className="inline-block w-full text-white text-sm font-semibold py-2.5 rounded-xl transition"
              style={{ background: '#3B5BFF', boxShadow: '0 10px 26px rgba(59,91,255,0.35)' }}
            >
              Przejdź do logowania
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div
                className="text-sm rounded-xl p-3 text-center"
                style={{
                  background: 'rgba(255,69,58,0.12)',
                  border: '1px solid rgba(255,69,58,0.35)',
                  color: '#FF9E96',
                }}
              >
                {error}
              </div>
            )}

            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: '#7C8AAA' }}>
                Nowe hasło (min. 8 znaków)
              </label>
              <input
                type="password" value={password} onChange={(e) => setPassword(e.target.value)} required
                autoComplete="new-password" autoFocus minLength={8}
                className="gl-input w-full rounded-xl px-3.5 py-2.5 text-sm text-white outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: '#7C8AAA' }}>
                Powtórz nowe hasło
              </label>
              <input
                type="password" value={password2} onChange={(e) => setPassword2(e.target.value)} required
                autoComplete="new-password" minLength={8}
                className="gl-input w-full rounded-xl px-3.5 py-2.5 text-sm text-white outline-none"
              />
            </div>

            <button
              type="submit" disabled={loading}
              className="w-full text-white text-sm font-semibold py-2.5 rounded-xl transition disabled:opacity-50"
              style={{ background: '#3B5BFF', boxShadow: '0 10px 26px rgba(59,91,255,0.35)' }}
            >
              {loading ? 'Zapisywanie…' : 'Ustaw nowe hasło'}
            </button>

            <p className="text-center pt-1">
              <Link href="/building-admin/login" className="text-xs" style={{ color: '#7C8AAA' }}>
                ← Wróć do logowania
              </Link>
            </p>
          </form>
        )}
      </div>
    </div>
  )
}

export default function BaResetPasswordPage() {
  return (
    <div
      className="relative min-h-screen flex items-center justify-center p-4 overflow-hidden"
      style={{ background: 'linear-gradient(180deg, #06080F 0%, #0B1020 45%, #16203A 100%)' }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(circle 340px at 50% 28%, rgba(59,91,255,0.16), transparent 70%)' }}
      />

      <Suspense fallback={null}>
        <ResetPasswordInner />
      </Suspense>

      <style jsx global>{`
        @keyframes glPulse {
          0%   { box-shadow: 0 6px 22px rgba(59, 91, 255, 0.20); transform: scale(1); }
          100% { box-shadow: 0 6px 34px rgba(59, 91, 255, 0.45); transform: scale(1.04); }
        }
        .gl-pulse { animation: glPulse 1.4s ease-in-out infinite alternate; }
        @keyframes glFadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .gl-fade-in { animation: glFadeIn 0.5s ease-out both; }
        .gl-input {
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.12);
          transition: border-color 0.15s ease, box-shadow 0.15s ease;
        }
        .gl-input:focus {
          border-color: rgba(59, 91, 255, 0.7);
          box-shadow: 0 0 0 3px rgba(59, 91, 255, 0.25);
        }
        .gl-input:-webkit-autofill,
        .gl-input:-webkit-autofill:hover,
        .gl-input:-webkit-autofill:focus {
          -webkit-text-fill-color: #fff;
          -webkit-box-shadow: 0 0 0 1000px #0e1424 inset;
          caret-color: #fff;
        }
      `}</style>
    </div>
  )
}
