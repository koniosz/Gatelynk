'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { conciergeApi } from '@/lib/concierge-api'

export default function ConciergeNotificationsPage() {
  const [residents, setResidents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [residentId, setResidentId] = useState('')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const router = useRouter()

  useEffect(() => {
    conciergeApi.get('/concierge/building/residents')
      .then((r) => setResidents(r.data))
      .catch(() => router.push('/concierge/login'))
      .finally(() => setLoading(false))
  }, [router])

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault()
    setSending(true); setResult(null)
    try {
      const dto: any = { title, body }
      if (residentId) dto.residentId = +residentId
      const r = await conciergeApi.post('/concierge/building/notifications', dto)
      const sent = r.data.sent ?? 1
      setResult({
        ok: true,
        msg: residentId ? 'Powiadomienie wysłane!' : `Wysłano do ${sent} mieszkańców`,
      })
      setTitle(''); setBody(''); setResidentId('')
    } catch (err: any) {
      setResult({ ok: false, msg: err?.response?.data?.message ?? 'Błąd wysyłania' })
    } finally { setSending(false) }
  }

  if (loading) return <p className="text-gray-400">Ładowanie...</p>

  return (
    <div className="max-w-lg">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">🔔 Wyślij powiadomienie</h1>

      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <form onSubmit={handleSend} className="space-y-4">
          {result && (
            <div className={`text-sm rounded-lg p-3 border ${
              result.ok
                ? 'bg-green-50 border-green-200 text-green-700'
                : 'bg-red-50 border-red-200 text-red-700'
            }`}>
              {result.msg}
            </div>
          )}

          <div>
            <label className="block text-xs text-gray-600 mb-1">Odbiorca</label>
            <select value={residentId} onChange={(e) => setResidentId(e.target.value)}
              className={inp}>
              <option value="">— Wszyscy mieszkańcy —</option>
              {residents.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.firstName} {r.lastName} ({r.email})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-gray-600 mb-1">Tytuł *</label>
            <input required value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="Temat powiadomienia" className={inp} />
          </div>

          <div>
            <label className="block text-xs text-gray-600 mb-1">Treść *</label>
            <textarea required value={body} onChange={(e) => setBody(e.target.value)}
              placeholder="Treść wiadomości..." rows={5}
              className={`${inp} resize-none`} />
          </div>

          <button type="submit" disabled={sending}
            className="w-full bg-blue-600 text-white text-sm font-medium py-2.5 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition">
            {sending ? 'Wysyłanie...' : '🔔 Wyślij powiadomienie'}
          </button>
        </form>
      </div>
    </div>
  )
}

const inp = 'w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500'
