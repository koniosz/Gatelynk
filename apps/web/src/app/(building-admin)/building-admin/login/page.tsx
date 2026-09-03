'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { buildingAdminApi, setBaToken } from '@/lib/building-admin-api'

// 2026-07-18: redesign ekranu logowania BA — brandowy dark look przeniesiony
// ze splasha aplikacji mobilnej (GlassSplashView): granatowy gradient
// #06080F→#16203A z niebieską poświatą, znak GateLynk w szklanym kaflu
// z pulsującym glow, wordmark + kicker „BUILDING OPERATING SYSTEM".
// Logika logowania bez zmian.

const BRAND_BLUE = '#3B5BFF'

export default function BuildingAdminLoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true); setError(null)
    try {
      const r = await buildingAdminApi.post('/building-admin/auth/login', { email, password })
      setBaToken(r.data.access_token)
      // 2026-07-18: po loginie ZAWSZE hub „Moje obiekty" — czytelny wybór
      // wspólnoty/osiedla + zbiorcze „do zrobienia" per obiekt. Także przy
      // jednym budynku (hub pełni rolę ekranu podsumowania).
      router.push('/building-admin/home')
    } catch (err: any) {
      setError(err?.response?.data?.message ?? 'Nieprawidłowy email lub hasło')
    } finally { setLoading(false) }
  }

  return (
    <div
      className="relative min-h-screen flex items-center justify-center p-4 overflow-hidden"
      style={{ background: 'linear-gradient(180deg, #06080F 0%, #0B1020 45%, #16203A 100%)' }}
    >
      {/* Niebieska poświata za logo — jak RadialGradient w splashu mobilnym */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(circle 340px at 50% 28%, rgba(59,91,255,0.16), transparent 70%)' }}
      />

      <div className="relative w-full max-w-sm gl-fade-in">
        {/* ── Logo w szklanym kaflu z pulsującym glow */}
        <div className="flex flex-col items-center mb-8">
          <div
            className="gl-pulse flex items-center justify-center w-[104px] h-[104px] rounded-[28px]"
            style={{
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.16)',
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/gatelynk-mark.png" alt="GateLynk" className="w-14 h-14" />
          </div>

          <h1 className="mt-6 text-3xl font-extrabold" style={{ color: '#F4F6FB' }}>GateLynk</h1>
          <p className="mt-2 text-[11px] font-semibold" style={{ color: '#7C8AAA', letterSpacing: '3.2px' }}>
            BUILDING OPERATING SYSTEM
          </p>
          <p className="mt-3 text-sm" style={{ color: 'rgba(244,246,251,0.55)' }}>
            Panel administratora — zarządzanie budynkiem
          </p>
        </div>

        {/* ── Formularz w ciemnej szklanej karcie */}
        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-3xl p-7 backdrop-blur-md"
          style={{
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.10)',
            boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
          }}
        >
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
              autoComplete="email"
              className="gl-input w-full rounded-xl px-3.5 py-2.5 text-sm text-white outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: '#7C8AAA' }}>Hasło</label>
            <input
              type="password" value={password} onChange={(e) => setPassword(e.target.value)} required
              autoComplete="current-password"
              className="gl-input w-full rounded-xl px-3.5 py-2.5 text-sm text-white outline-none"
            />
          </div>

          <button
            type="submit" disabled={loading}
            className="w-full text-white text-sm font-semibold py-2.5 rounded-xl transition disabled:opacity-50"
            style={{ background: BRAND_BLUE, boxShadow: '0 10px 26px rgba(59,91,255,0.35)' }}
          >
            {loading ? 'Logowanie…' : 'Zaloguj się'}
          </button>

          <p className="text-center pt-1">
            <Link
              href="/building-admin/forgot-password"
              className="text-xs transition hover:opacity-80"
              style={{ color: '#7C8AAA' }}
            >
              Nie pamiętasz hasła?
            </Link>
          </p>
        </form>
      </div>

      <style jsx global>{`
        @keyframes glPulse {
          0%   { box-shadow: 0 6px 22px rgba(59, 91, 255, 0.20); transform: scale(1); }
          100% { box-shadow: 0 6px 34px rgba(59, 91, 255, 0.45); transform: scale(1.04); }
        }
        .gl-pulse {
          animation: glPulse 1.4s ease-in-out infinite alternate;
        }
        @keyframes glFadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .gl-fade-in {
          animation: glFadeIn 0.5s ease-out both;
        }
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
