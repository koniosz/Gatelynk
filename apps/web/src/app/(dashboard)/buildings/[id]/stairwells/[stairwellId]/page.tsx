'use client'
import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { api } from '@/lib/api'
import Link from 'next/link'

const AKUVOX_MODELS = ['R29C', 'R29', 'E12W', 'E16', 'R20A', 'S539']

interface Relay { id: string; label: string }
interface Intercom {
  id: number
  manufacturer: string
  model: string | null
  ipAddress: string | null
  login: string | null
  password: string | null
  relays: Relay[] | null
}
interface Stairwell {
  id: number
  name: string
  intercom: Intercom | null
  units: { id: number; number: string; floor: number | null }[]
}

export default function StairwellDetailPage() {
  const { id: buildingId, stairwellId } = useParams()
  const [stairwell, setStairwell] = useState<Stairwell | null>(null)
  const [buildingName, setBuildingName] = useState('')

  // Formularz domofonu
  const [editIntercom, setEditIntercom] = useState(false)
  const [model, setModel] = useState('')
  const [ip, setIp] = useState('')
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [relays, setRelays] = useState<Relay[]>([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [swRes, bRes] = await Promise.all([
      api.get(`/buildings/${buildingId}/stairwells/${stairwellId}`),
      api.get(`/buildings/${buildingId}`),
    ])
    setStairwell(swRes.data)
    setBuildingName(bRes.data.name)
    const ic = swRes.data.intercom
    if (ic) {
      setModel(ic.model ?? '')
      setIp(ic.ipAddress ?? '')
      setLogin(ic.login ?? '')
      setPassword(ic.password ?? '')
      setRelays(Array.isArray(ic.relays) ? ic.relays : [])
    }
  }, [buildingId, stairwellId])

  useEffect(() => { load() }, [load])

  const openEdit = () => {
    if (!stairwell) return
    const ic = stairwell.intercom
    setModel(ic?.model ?? '')
    setIp(ic?.ipAddress ?? '')
    setLogin(ic?.login ?? '')
    setPassword(ic?.password ?? '')
    setRelays(Array.isArray(ic?.relays) ? (ic.relays as Relay[]) : [])
    setSaveError(null)
    setEditIntercom(true)
  }

  const addRelay = () => setRelays((r) => [...r, { id: crypto.randomUUID(), label: '' }])
  const removeRelay = (rid: string) => setRelays((r) => r.filter((x) => x.id !== rid))
  const updateRelayLabel = (rid: string, label: string) =>
    setRelays((r) => r.map((x) => (x.id === rid ? { ...x, label } : x)))

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true); setSaveError(null)
    try {
      await api.put(`/buildings/${buildingId}/stairwells/${stairwellId}/intercom`, {
        model: model || null,
        ipAddress: ip || null,
        login: login || null,
        password: password || null,
        relays: relays.filter((r) => r.label.trim()),
      })
      setEditIntercom(false)
      load()
    } catch (err: any) {
      setSaveError(err?.response?.data?.message ?? 'Błąd zapisu')
    } finally { setSaving(false) }
  }

  if (!stairwell) return <p className="text-gray-400">Ładowanie...</p>

  const ic = stairwell.intercom

  return (
    <div className="max-w-2xl">
      {/* Nagłówek */}
      <div className="mb-6">
        <Link href={`/buildings/${buildingId}`} className="text-sm text-gray-400 hover:text-gray-600">
          ← {buildingName || 'Budynek'}
        </Link>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-2xl">🏛️</span>
          <h1 className="text-2xl font-bold text-gray-900">{stairwell.name}</h1>
        </div>
        <p className="text-gray-400 text-sm mt-0.5">Klatka schodowa</p>
      </div>

      {/* Lokale */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-4">
        <h3 className="font-semibold text-gray-800 mb-3">🏠 Lokale w klatce ({stairwell.units?.length ?? 0})</h3>
        {stairwell.units?.length > 0 ? (
          <div className="divide-y divide-gray-100 -mx-5">
            {stairwell.units.map((u) => (
              <Link key={u.id} href={`/buildings/${buildingId}/units/${u.id}`}
                className="flex items-center justify-between px-5 py-2.5 hover:bg-gray-50 transition text-sm">
                <span className="font-medium text-gray-900">{u.number}</span>
                {u.floor !== null && <span className="text-gray-400 text-xs">Piętro {u.floor}</span>}
              </Link>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-400">Brak przypisanych lokali</p>
        )}
      </div>

      {/* Domofon Akuvox */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-800">📟 Domofon Akuvox</h3>
          {!editIntercom && (
            <button onClick={openEdit}
              className="text-sm text-blue-600 hover:text-blue-800 font-medium">
              {ic ? '✏️ Edytuj' : '+ Skonfiguruj'}
            </button>
          )}
        </div>

        {editIntercom ? (
          <form onSubmit={handleSave} className="space-y-4">
            {saveError && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3">{saveError}</div>
            )}

            {/* Model */}
            <div>
              <label className="block text-xs text-gray-600 mb-1">Model Akuvox</label>
              <select value={model} onChange={(e) => setModel(e.target.value)} className={inputCls}>
                <option value="">— Wybierz model —</option>
                {AKUVOX_MODELS.map((m) => <option key={m}>{m}</option>)}
              </select>
            </div>

            {/* IP */}
            <div>
              <label className="block text-xs text-gray-600 mb-1">Adres IP</label>
              <input type="text" value={ip} onChange={(e) => setIp(e.target.value)}
                placeholder="np. 192.168.1.100" className={inputCls} />
            </div>

            {/* Login / Hasło */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-600 mb-1">Login</label>
                <input type="text" value={login} onChange={(e) => setLogin(e.target.value)}
                  placeholder="np. admin" className={inputCls} />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Hasło</label>
                <input type="text" value={password} onChange={(e) => setPassword(e.target.value)}
                  placeholder="hasło" className={inputCls} />
              </div>
            </div>

            {/* Elektrozaczepy */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-gray-600 font-medium">⚡ Elektrozaczepy / Przekaźniki</label>
                <button type="button" onClick={addRelay}
                  className="text-xs text-blue-600 hover:text-blue-800 font-medium">
                  + Dodaj
                </button>
              </div>
              {relays.length === 0 && (
                <p className="text-xs text-gray-400 italic">Brak zdefiniowanych przekaźników</p>
              )}
              <div className="space-y-2">
                {relays.map((r) => (
                  <div key={r.id} className="flex gap-2 items-center">
                    <span className="text-xs text-gray-400 w-5 text-right flex-shrink-0">
                      {relays.indexOf(r) + 1}.
                    </span>
                    <input type="text" value={r.label}
                      onChange={(e) => updateRelayLabel(r.id, e.target.value)}
                      placeholder="np. Wejście główne, Brama garażowa..."
                      className={inputCls} />
                    <button type="button" onClick={() => removeRelay(r.id)}
                      className="text-gray-400 hover:text-red-500 text-lg flex-shrink-0 w-6">×</button>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex gap-3 pt-1">
              <button type="submit" disabled={saving}
                className="flex-1 bg-blue-600 text-white text-sm font-medium py-2.5 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {saving ? 'Zapisywanie...' : 'Zapisz konfigurację'}
              </button>
              <button type="button" onClick={() => setEditIntercom(false)}
                className="flex-1 border border-gray-300 text-gray-700 text-sm font-medium py-2.5 rounded-lg hover:bg-gray-50">
                Anuluj
              </button>
            </div>
          </form>
        ) : ic ? (
          <div className="space-y-2">
            <InfoRow label="Producent" value="Akuvox" />
            {ic.model && <InfoRow label="Model" value={ic.model} />}
            {ic.ipAddress && <InfoRow label="Adres IP" value={ic.ipAddress} />}
            {ic.login && <InfoRow label="Login" value={ic.login} />}
            {ic.password && <InfoRow label="Hasło" value={'•'.repeat(ic.password.length)} />}
            {Array.isArray(ic.relays) && ic.relays.length > 0 && (
              <div className="pt-2">
                <p className="text-xs text-gray-500 mb-1.5">⚡ Elektrozaczepy:</p>
                <div className="flex flex-wrap gap-2">
                  {(ic.relays as Relay[]).map((r, i) => (
                    <span key={r.id} className="text-xs bg-yellow-50 text-yellow-700 border border-yellow-200 px-2 py-1 rounded-full">
                      {i + 1}. {r.label}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-gray-400">
            Domofon nie został jeszcze skonfigurowany.{' '}
            <button onClick={openEdit} className="text-blue-600 hover:underline">Skonfiguruj teraz</button>
          </p>
        )}
      </div>
    </div>
  )
}

const inputCls = 'w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500'

function InfoRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-center justify-between text-sm py-0.5">
      <span className="text-gray-500">{label}</span>
      <span className="font-medium text-gray-900">{value ?? <span className="text-gray-400 font-normal">—</span>}</span>
    </div>
  )
}
