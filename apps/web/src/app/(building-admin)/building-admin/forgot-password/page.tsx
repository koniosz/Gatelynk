'use client'
import { useState } from 'react'
import Link from 'next/link'
import { buildingAdminApi } from '@/lib/building-admin-api'

// 2026-07-18: reset hasła BA — krok 1 (podanie maila). Design spójny
// z ekranem logowania (brandowy dark + pulsujące logo). Backend ZAWSZE
// zwraca ok:true (bez enumeracji kont), więc po submit pokazujemy
// neutralny komunikat „jeśli konto istnieje — mail wysłany".

export default function BaForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true); setError(null)
    try {
      await buildingAdminApi.post('/building-admin/auth/forgot-password', { email })
      setSent(true)
    } catch {
      setError('Nie udało się wysłać żądania. Spróbuj ponownie za chwilę.')
    } finally { setLoading(false) }
  }

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

      <div className="relative w-full max-w-sm gl-fade-in">
        <div className="flex flex-col items-center mb-8">
          <div
            className="gl-pulse flex items-center justify-center w-[104px] h-[104px] rounded-[28px]"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.16)' }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/gatelynk-mark.png" alt="GateLynk" className="w-14 h-14" />
          </div>
          <h1 className="mt-6 text-2xl font-extrabold" style={{ color: '#F4F6FB' }}>Reset hasła</h1>
          <p className="mt-3 text-sm text-center" style={{ color: 'rgba(244,246,251,0.55)' }}>
            Podaj adres email konta administratora — wyślemy link do ustawienia nowego hasła.
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
          {sent ? (
            <div className="text-center space-y-4">
              <div className="text-4xl">📬</div>
              <p className="text-sm leading-relaxed" style={{ color: 'rgba(244,246,251,0.85)' }}>
                Jeśli konto o adresie <span className="font-semibold text-white">{email}</span> istnieje,
                wysłaliśmy na nie link do resetu hasła. Sprawdź skrzynkę (także folder spam).
              </p>
              <p className="text-xs" style={{ color: '#7C8AAA' }}>
                Link jest ważny przez 60 minut.
              </p>
              <Link
                href="/building-admin/login"
                className="inline-block w-full text-white text-sm font-semibold py-2.5 rounded-xl transition"
                style={{ background: '#3B5BFF', boxShadow: '0 10px 26px rgba(59,91,255,0.35)' }}
              >
                Wróć do logowania
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
                <label className="block text-xs font-medium mb-1.5" style={{ color: '#7C8AAA' }}>Email</label>
                <input
                  type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
                  autoComplete="email" autoFocus
                  className="gl-input w-full rounded-xl px-3.5 py-2.5 text-sm text-white outline-none"
                />
              </div>

              <button
                type="submit" disabled={loading}
                className="w-full text-white text-sm font-semibold py-2.5 rounded-xl transition disabled:opacity-50"
                style={{ background: '#3B5BFF', boxShadow: '0 10px 26px rgba(59,91,255,0.35)' }}
              >
                {loading ? 'Wysyłanie…' : 'Wyślij link resetu'}
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
