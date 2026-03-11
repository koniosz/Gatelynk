'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'

const PLAN_LABELS: Record<string, { name: string; desc: string }> = {
  starter:  { name: 'Starter',  desc: 'do 50 lokali, 1 budynek' },
  standard: { name: 'Standard', desc: 'do 200 lokali, 5 budynków' },
  pro:      { name: 'Pro',      desc: 'nielimitowane lokale i budynki' },
}

export default function ActivateLicensePage() {
  const router = useRouter()
  const [key, setKey] = useState('')
  const [result, setResult] = useState<any>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleActivate = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await api.post('/license/activate', { key })
      setResult(res.data)
    } catch (err: any) {
      setError(err.response?.data?.message ?? 'Nieprawidłowy klucz')
    } finally {
      setLoading(false)
    }
  }

  if (result) {
    const plan = PLAN_LABELS[result.plan.code]
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-sm p-8 text-center">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <span className="text-3xl">✓</span>
          </div>
          <h2 className="text-xl font-bold text-gray-900 mb-2">Licencja aktywowana!</h2>
          <p className="text-gray-600 mb-1">Plan: <strong>{plan.name}</strong></p>
          <p className="text-gray-500 text-sm mb-6">{plan.desc}</p>
          <button
            onClick={() => router.push('/dashboard')}
            className="w-full bg-blue-600 text-white py-2 rounded-lg font-medium hover:bg-blue-700"
          >
            Przejdź do panelu
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm p-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Aktywuj licencję</h1>
        <p className="text-gray-500 mb-8">Wpisz klucz licencyjny aby rozpocząć</p>

        <form onSubmit={handleActivate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Klucz licencyjny</label>
            <input
              type="text"
              value={key}
              onChange={(e) => setKey(e.target.value.toUpperCase())}
              placeholder="GL-STRT-XXXX-XXXX-2026"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
            <p className="text-xs text-gray-400 mt-1">Format: GL-STRT-XXXX-XXXX-2026</p>
          </div>
          {error && <p className="text-red-600 text-sm">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white py-2 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Sprawdzanie...' : 'Aktywuj'}
          </button>
        </form>
      </div>
    </div>
  )
}
