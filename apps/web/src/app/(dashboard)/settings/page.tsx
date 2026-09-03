'use client'
import { useEffect, useState, useCallback } from 'react'
import { api } from '@/lib/api'

interface Integrator { id: number; name: string; email: string; createdAt: string }
interface BuildingAdmin {
  id: number; name: string; email: string; createdAt: string
  buildings: { building: { id: number; name: string } }[]
}
interface Concierge {
  id: number; name: string; email: string; createdAt: string
  building: { id: number; name: string }
}

const TABS = ['Integratorzy', 'Admin. budynku', 'Konsjerże'] as const
type Tab = typeof TABS[number]

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('Integratorzy')

  // ── Integratorzy ──────────────────────────────────────────────────────────
  const [integrators, setIntegrators] = useState<Integrator[]>([])
  const [intLoading, setIntLoading] = useState(true)

  // ── Administratorzy budynków ───────────────────────────────────────────────
  const [buildingAdmins, setBuildingAdmins] = useState<BuildingAdmin[]>([])
  const [baLoading, setBaLoading] = useState(true)

  // ── Konsjerże ─────────────────────────────────────────────────────────────
  const [concierges, setConcierges] = useState<Concierge[]>([])
  const [conLoading, setConLoading] = useState(true)

  // ── Reset hasła ───────────────────────────────────────────────────────────
  const [resetTarget, setResetTarget] = useState<{
    type: 'integrator' | 'building-admin' | 'concierge'
    id: number; name: string
  } | null>(null)
  const [resetPassword, setResetPassword] = useState('')
  const [resetSaving, setResetSaving] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)

  const loadAll = useCallback(async () => {
    const [intRes, baRes, conRes] = await Promise.allSettled([
      api.get('/integrators'),
      api.get('/building-admins'),
      api.get('/concierges'),
    ])
    if (intRes.status === 'fulfilled') setIntegrators(intRes.value.data)
    if (baRes.status === 'fulfilled') setBuildingAdmins(baRes.value.data)
    if (conRes.status === 'fulfilled') setConcierges(conRes.value.data)
    setIntLoading(false); setBaLoading(false); setConLoading(false)
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!resetTarget) return
    setResetSaving(true); setResetError(null)
    try {
      const ep =
        resetTarget.type === 'integrator' ? `/integrators/${resetTarget.id}/reset-password`
        : resetTarget.type === 'building-admin' ? `/building-admins/${resetTarget.id}/reset-password`
        : `/concierges/${resetTarget.id}/reset-password`
      await api.patch(ep, { newPassword: resetPassword })
      setResetTarget(null); setResetPassword('')
    } catch (err: any) {
      setResetError(err?.response?.data?.message ?? 'Błąd resetowania hasła')
    } finally { setResetSaving(false) }
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">⚙️ Ustawienia</h1>
        <p className="text-sm text-gray-400 mt-1">
          Globalny podgląd kont. Aby dodać nowego integratora, administratora lub konsjerża — przejdź do konkretnego budynku (zakładka 👥 Personel).
        </p>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200 mb-6 gap-1">
        {TABS.map((tab) => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition ${
              activeTab === tab
                ? 'bg-white border border-b-white border-gray-200 text-blue-600 -mb-px'
                : 'text-gray-500 hover:text-gray-700'
            }`}>
            {tab === 'Integratorzy' && '🔧 '}
            {tab === 'Admin. budynku' && '🏢 '}
            {tab === 'Konsjerże' && '🎩 '}
            {tab}
          </button>
        ))}
      </div>

      {/* ── TAB: Integratorzy ──────────────────────────────────────────────── */}
      {activeTab === 'Integratorzy' && (
        <>
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="mb-4">
              <h2 className="text-lg font-semibold text-gray-900">🔧 Konta integratorów</h2>
              <p className="text-sm text-gray-400 mt-0.5">
                Konfigurują domofony i kamery LPR. Mają dostęp do wszystkich budynków.
              </p>
            </div>

            {intLoading ? <LoadingRow /> : integrators.length === 0 ? (
              <EmptyState icon="🔧" msg="Brak kont integratorów" hint="Dodaj integratora z poziomu budynku (zakładka 👥 Personel)." />
            ) : (
              <div className="divide-y divide-gray-100 -mx-6">
                {integrators.map((int) => (
                  <PersonRow key={int.id} name={int.name} email={int.email} createdAt={int.createdAt}
                    onReset={() => { setResetTarget({ type: 'integrator', id: int.id, name: int.name }); setResetPassword(''); setResetError(null) }}
                    onDelete={async () => {
                      if (!confirm(`Usunąć konto integratora "${int.name}"?`)) return
                      await api.delete(`/integrators/${int.id}`); loadAll()
                    }} />
                ))}
              </div>
            )}
          </div>
          <PanelLink href="/integrator/login" label="Panel integratora" />
        </>
      )}

      {/* ── TAB: Administratorzy budynków ──────────────────────────────────── */}
      {activeTab === 'Admin. budynku' && (
        <>
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="mb-4">
              <h2 className="text-lg font-semibold text-gray-900">🏢 Administratorzy budynków</h2>
              <p className="text-sm text-gray-400 mt-0.5">
                Zarządzają przypisanymi budynkami: mieszkańcy, lokale, klatki i powiadomienia.
              </p>
            </div>

            {baLoading ? <LoadingRow /> : buildingAdmins.length === 0 ? (
              <EmptyState icon="🏢" msg="Brak administratorów budynków" hint="Dodaj administratora z poziomu budynku (zakładka 👥 Personel)." />
            ) : (
              <>
                {buildingAdmins.some((ba) => ba.buildings.length === 0) && (
                  <div className="mb-4 flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
                    <span>⚠️</span>
                    <span>Poniżej znajdują się konta bez przypisanego budynku (np. po usunięciu budynku). Możesz je bezpiecznie usunąć, aby odblokować ich adres e-mail.</span>
                  </div>
                )}
                <div className="divide-y divide-gray-100 -mx-6">
                  {[...buildingAdmins].sort((a, b) => a.buildings.length - b.buildings.length).map((ba) => {
                    const isOrphaned = ba.buildings.length === 0
                    return (
                      <div key={ba.id} className={`px-6 py-3 hover:bg-gray-50 ${isOrphaned ? 'bg-amber-50/50' : ''}`}>
                        <div className="flex items-start justify-between">
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-medium text-gray-900">{ba.name}</p>
                              {isOrphaned && (
                                <span className="text-xs bg-amber-100 text-amber-700 border border-amber-200 px-2 py-0.5 rounded-full">
                                  ⚠️ Brak budynku
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-gray-400">{ba.email}</p>
                            <div className="flex flex-wrap gap-1 mt-1.5">
                              {ba.buildings.map((b) => (
                                <span key={b.building.id}
                                  className="text-xs bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded-full">
                                  {b.building.name}
                                </span>
                              ))}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 ml-3 flex-shrink-0">
                            <span className="text-xs text-gray-400 whitespace-nowrap">
                              od {new Date(ba.createdAt).toLocaleDateString('pl-PL')}
                            </span>
                            <button onClick={() => { setResetTarget({ type: 'building-admin', id: ba.id, name: ba.name }); setResetPassword(''); setResetError(null) }}
                              className="text-xs text-gray-400 hover:text-blue-600 transition px-2 py-1 rounded hover:bg-blue-50">
                              🔑 Resetuj
                            </button>
                            <button onClick={async () => {
                              if (!confirm(`Usunąć konto administratora "${ba.name}" (${ba.email})?`)) return
                              await api.delete(`/building-admins/${ba.id}`); loadAll()
                            }} className="text-xs text-gray-400 hover:text-red-600 transition">🗑️</button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </div>
          <PanelLink href="/building-admin/login" label="Panel administratora budynku" />
        </>
      )}

      {/* ── TAB: Konsjerże ─────────────────────────────────────────────────── */}
      {activeTab === 'Konsjerże' && (
        <>
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="mb-4">
              <h2 className="text-lg font-semibold text-gray-900">🎩 Konta konsjerżów</h2>
              <p className="text-sm text-gray-400 mt-0.5">
                Mają wgląd w mieszkańców i lokale przypisanego budynku oraz mogą wysyłać powiadomienia.
              </p>
            </div>

            {conLoading ? <LoadingRow /> : concierges.length === 0 ? (
              <EmptyState icon="🎩" msg="Brak kont konsjerżów" hint="Dodaj konsjerża z poziomu budynku (zakładka 👥 Personel)." />
            ) : (
              <div className="divide-y divide-gray-100 -mx-6">
                {concierges.map((con) => (
                  <div key={con.id} className="px-6 py-3 hover:bg-gray-50">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-gray-900">{con.name}</p>
                        <p className="text-xs text-gray-400">{con.email}</p>
                        <span className="text-xs bg-gray-100 text-gray-600 border border-gray-200 px-2 py-0.5 rounded-full mt-1 inline-block">
                          🏢 {con.building.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-400">
                          od {new Date(con.createdAt).toLocaleDateString('pl-PL')}
                        </span>
                        <button onClick={() => { setResetTarget({ type: 'concierge', id: con.id, name: con.name }); setResetPassword(''); setResetError(null) }}
                          className="text-xs text-gray-400 hover:text-blue-600 transition px-2 py-1 rounded hover:bg-blue-50">
                          🔑 Resetuj
                        </button>
                        <button onClick={async () => {
                          if (!confirm(`Usunąć konto konsjerża "${con.name}"?`)) return
                          await api.delete(`/concierges/${con.id}`); loadAll()
                        }} className="text-xs text-gray-400 hover:text-red-600 transition">🗑️</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <PanelLink href="/concierge/login" label="Panel konsjerża" />
        </>
      )}

      {/* ── MODAL: Reset hasła ────────────────────────────────────────────── */}
      {resetTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setResetTarget(null) }}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <h3 className="text-lg font-bold text-gray-900 mb-1">🔑 Resetuj hasło</h3>
            <p className="text-sm text-gray-500 mb-4">{resetTarget.name}</p>
            <form onSubmit={handleResetPassword} className="space-y-3">
              {resetError && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-2">{resetError}</div>
              )}
              <div>
                <label className="block text-xs text-gray-600 mb-1">Nowe hasło *</label>
                <input required type="password" minLength={8} value={resetPassword}
                  onChange={(e) => setResetPassword(e.target.value)}
                  placeholder="min. 8 znaków" className={inputCls} autoFocus />
              </div>
              <div className="flex gap-2 pt-1">
                <button type="submit" disabled={resetSaving}
                  className="flex-1 bg-blue-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                  {resetSaving ? 'Zapisywanie...' : 'Zapisz nowe hasło'}
                </button>
                <button type="button" onClick={() => setResetTarget(null)}
                  className="flex-1 border border-gray-300 text-gray-700 text-sm font-medium py-2 rounded-lg hover:bg-gray-50">
                  Anuluj
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Helper components ─────────────────────────────────────────────────────────
function PersonRow({ name, email, createdAt, onReset, onDelete }: {
  name: string; email: string; createdAt: string
  onReset: () => void; onDelete: () => void
}) {
  return (
    <div className="px-6 py-3 flex items-center justify-between hover:bg-gray-50">
      <div>
        <p className="text-sm font-medium text-gray-900">{name}</p>
        <p className="text-xs text-gray-400">{email}</p>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-400">od {new Date(createdAt).toLocaleDateString('pl-PL')}</span>
        <button onClick={onReset}
          className="text-xs text-gray-400 hover:text-blue-600 transition px-2 py-1 rounded hover:bg-blue-50">
          🔑 Resetuj
        </button>
        <button onClick={onDelete} className="text-xs text-gray-400 hover:text-red-600 transition">🗑️</button>
      </div>
    </div>
  )
}

function LoadingRow() {
  return <p className="text-sm text-gray-400 py-4 text-center">Ładowanie...</p>
}

function EmptyState({ icon, msg, hint }: { icon: string; msg: string; hint?: string }) {
  return (
    <div className="text-center py-8">
      <p className="text-4xl mb-3">{icon}</p>
      <p className="text-gray-500 text-sm">{msg}</p>
      {hint && <p className="text-gray-400 text-xs mt-1">{hint}</p>}
    </div>
  )
}

function PanelLink({ href, label }: { href: string; label: string }) {
  return (
    <div className="mt-4 bg-gray-50 border border-gray-200 rounded-xl p-4">
      <p className="text-sm text-gray-600">
        <span className="font-medium">🌐 {label}</span> dostępny pod adresem:{' '}
        <code className="bg-white border border-gray-200 px-2 py-0.5 rounded text-xs font-mono text-blue-700">
          {href}
        </code>
      </p>
    </div>
  )
}

const inputCls = 'w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500'
