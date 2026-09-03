'use client'
/**
 * PR-1 (2026-07) — karta „Edge / kod aktywacyjny" w panelu Integratora.
 *
 * Przeniesienie funkcji z legacy panelu superadmina
 * (`(dashboard)/buildings/[id]/page.tsx`, tab „edge"):
 *   • generowanie jednorazowego kodu aktywacyjnego (EDGE / EDGE_AI, 24h TTL)
 *   • lista EdgeDevice: nazwa, status (online/aktywowany/pending kod),
 *     lastSeenAt, IP, wersja
 *   • usunięcie / dezaktywacja urządzenia (także pending z kodem)
 *
 * Endpointy integratorskie (IntegratorJwtAuthGuard + tenant-check po adminId):
 *   GET    /integrator/buildings/:id/edge-devices
 *   POST   /integrator/buildings/:id/edge-devices/activation-code
 *   DELETE /integrator/buildings/:id/edge-devices/:deviceId
 */
import { useState } from 'react'
import { integratorApi } from '@/lib/integrator-api'

export interface EdgeDeviceRow {
  id: string
  type: string
  name: string | null
  isActivated: boolean
  activatedAt?: string | null
  lastSeenAt: string | null
  ipAddress: string | null
  version: string | null
  online: boolean
  activationCode?: string | null
  activationCodeExpiresAt?: string | null
  outbox?: { pending: number; failed: number }
  wizardUrlHint?: string | null
}

interface GenResult {
  code: string
  deviceId: string
  expiresAt: string
}

interface Props {
  buildingId: number
  edges: EdgeDeviceRow[]
  /** Reload listy po generacji / usunięciu (parent robi refetch). */
  onChanged: () => void
}

export function IntegratorEdgeActivationCard({ buildingId, edges, onChanged }: Props) {
  const [showGenForm, setShowGenForm] = useState(false)
  const [genType, setGenType] = useState<'EDGE' | 'EDGE_AI'>('EDGE')
  const [genName, setGenName] = useState('')
  const [genLoading, setGenLoading] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  const [genResult, setGenResult] = useState<GenResult | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const generate = async (e: React.FormEvent) => {
    e.preventDefault()
    setGenLoading(true)
    setGenError(null)
    try {
      const res = await integratorApi.post(
        `/integrator/buildings/${buildingId}/edge-devices/activation-code`,
        { type: genType, name: genName.trim() || undefined },
      )
      setGenResult(res.data as GenResult)
      onChanged()
    } catch (err: any) {
      setGenError(err?.response?.data?.message ?? 'Błąd generowania kodu')
    } finally {
      setGenLoading(false)
    }
  }

  const remove = async (d: EdgeDeviceRow) => {
    const label = d.name ?? d.id
    const warning = d.isActivated
      ? `Usunąć urządzenie "${label}"?\n\nUrządzenie straci połączenie z chmurą (dezaktywacja) — ponowne podłączenie będzie wymagało nowego kodu aktywacyjnego.`
      : `Usunąć oczekujące urządzenie "${label}"?\n\nWygenerowany kod aktywacyjny przestanie działać.`
    if (!confirm(warning)) return
    setDeletingId(d.id)
    try {
      await integratorApi.delete(`/integrator/buildings/${buildingId}/edge-devices/${d.id}`)
      onChanged()
    } catch (err: any) {
      alert(err?.response?.data?.message ?? 'Błąd usuwania urządzenia')
    } finally {
      setDeletingId(null)
    }
  }

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard może być zablokowany bez https — ignoruj */ }
  }

  return (
    <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <header className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-semibold text-gray-900">🔑 Edge / kod aktywacyjny</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Wygeneruj jednorazowy kod (ważny 24h) i wpisz go w Edge UI
            (<span className="font-mono">http://&lt;edge&gt;:4000/ui</span>) podczas instalacji.
          </p>
        </div>
        <button
          onClick={() => { setShowGenForm((v) => !v); setGenResult(null); setGenError(null); setGenName('') }}
          className="bg-blue-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-blue-700 shrink-0"
        >
          {showGenForm ? 'Zamknij' : '+ Generuj kod aktywacyjny'}
        </button>
      </header>

      {showGenForm && !genResult && (
        <form onSubmit={generate} className="m-4 p-4 bg-blue-50 border border-blue-200 rounded-xl space-y-3">
          <h3 className="text-sm font-semibold text-blue-800">Nowe urządzenie Edge</h3>
          {genError && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2">{genError}</div>
          )}
          <div>
            <label className="block text-xs text-gray-600 mb-1">Typ urządzenia</label>
            <div className="flex gap-2">
              {(['EDGE', 'EDGE_AI'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setGenType(t)}
                  className={`flex-1 text-sm px-3 py-2 rounded-lg border transition font-medium ${
                    genType === t
                      ? t === 'EDGE_AI'
                        ? 'bg-violet-50 border-violet-400 text-violet-700'
                        : 'bg-white border-blue-400 text-blue-700'
                      : 'border-gray-200 text-gray-500 hover:border-gray-300 bg-white'
                  }`}
                >
                  {t === 'EDGE' ? '🖥️ GateLynk Edge' : '🤖 GateLynk Edge AI'}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Nazwa urządzenia (opcjonalnie)</label>
            <input
              value={genName}
              onChange={(e) => setGenName(e.target.value)}
              placeholder={`GateLynk ${genType === 'EDGE_AI' ? 'Edge AI' : 'Edge'}`}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={genLoading}
              className="flex-1 bg-blue-600 text-white text-sm py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {genLoading ? 'Generowanie…' : 'Generuj kod'}
            </button>
            <button
              type="button"
              onClick={() => setShowGenForm(false)}
              className="flex-1 border border-gray-300 text-gray-700 text-sm py-2 rounded-lg hover:bg-gray-50"
            >
              Anuluj
            </button>
          </div>
        </form>
      )}

      {genResult && (
        <div className="m-4 p-4 bg-green-50 border border-green-200 rounded-xl">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-green-800">✅ Kod aktywacyjny wygenerowany</h3>
            <button
              onClick={() => { setShowGenForm(false); setGenResult(null) }}
              className="text-xs text-gray-400 hover:text-gray-600"
            >
              ✕ Zamknij
            </button>
          </div>
          <p className="text-xs text-green-700 mb-3">
            Wprowadź ten kod na urządzeniu GateLynk Edge podczas pierwszego uruchomienia.
            Kod jest jednorazowy — po użyciu znika z listy poniżej.
          </p>
          <div className="bg-white border border-green-300 rounded-lg p-3 text-center">
            <p className="text-xl font-mono font-bold tracking-widest text-gray-900 break-all">{genResult.code}</p>
          </div>
          <p className="text-xs text-gray-400 mt-2 text-center">
            Ważny do: {new Date(genResult.expiresAt).toLocaleString('pl-PL')}
          </p>
          <button
            onClick={() => copyCode(genResult.code)}
            className="mt-2 w-full border border-green-300 text-green-700 text-xs py-1.5 rounded-lg hover:bg-green-100"
          >
            {copied ? '✓ Skopiowano' : '📋 Kopiuj kod'}
          </button>
        </div>
      )}

      {edges.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-8">
          Brak urządzeń Edge — wygeneruj kod aktywacyjny, aby dodać pierwsze.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-100">
            <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
              <th className="px-4 py-2">Nazwa / ID</th>
              <th className="px-4 py-2 w-40">Status</th>
              <th className="px-4 py-2">IP w LAN</th>
              <th className="px-4 py-2">Wersja</th>
              <th className="px-4 py-2">Ostatnio widziany</th>
              <th className="px-4 py-2 w-40 text-right">Akcje</th>
            </tr>
          </thead>
          <tbody>
            {edges.map((d) => (
              <tr key={d.id} className="border-b border-gray-50 hover:bg-gray-50">
                <td className="px-4 py-3">
                  <div className="font-medium text-gray-900 flex items-center gap-2">
                    <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${d.online ? 'bg-green-500' : 'bg-gray-300'}`} />
                    {d.name ?? <span className="text-gray-400 italic">—</span>}
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                      d.type === 'EDGE_AI' ? 'bg-violet-100 text-violet-700' : 'bg-blue-100 text-blue-700'
                    }`}>
                      {d.type === 'EDGE_AI' ? '🤖 Edge AI' : '🖥️ Edge'}
                    </span>
                  </div>
                  <div className="text-xs text-gray-400 font-mono mt-0.5">{d.id.slice(0, 12)}…</div>
                </td>
                <td className="px-4 py-3">
                  {d.online ? (
                    <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-medium">● Online</span>
                  ) : d.isActivated ? (
                    <span className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded font-medium">Offline</span>
                  ) : d.activationCode ? (
                    <div>
                      <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-medium">⏳ Czeka na aktywację</span>
                      <div className="text-xs text-amber-600 font-mono mt-1 break-all">{d.activationCode}</div>
                      {d.activationCodeExpiresAt && (
                        <div className="text-[10px] text-gray-400">
                          do {new Date(d.activationCodeExpiresAt).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' })}
                        </div>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-gray-400">Nieaktywne</span>
                  )}
                </td>
                <td className="px-4 py-3 text-gray-600 font-mono text-xs">
                  {d.ipAddress ?? <span className="text-gray-400 italic">—</span>}
                </td>
                <td className="px-4 py-3 text-gray-600 text-xs">
                  {d.version ?? <span className="text-gray-400 italic">—</span>}
                </td>
                <td className="px-4 py-3 text-gray-600 text-xs">
                  {d.lastSeenAt
                    ? new Date(d.lastSeenAt).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' })
                    : <span className="text-gray-400 italic">—</span>}
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  {d.wizardUrlHint && (
                    <a
                      href={d.wizardUrlHint}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs px-2 py-1 rounded bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100 mr-2"
                      title="Otwórz wizard dodawania urządzenia (wymaga LAN / Tailscale)"
                    >
                      🧙 Wizard ↗
                    </a>
                  )}
                  <button
                    onClick={() => remove(d)}
                    disabled={deletingId === d.id}
                    className="text-xs px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-40"
                    title={d.isActivated ? 'Usuń / dezaktywuj urządzenie' : 'Usuń oczekujący kod'}
                  >
                    {deletingId === d.id ? '…' : '🗑 Usuń'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
