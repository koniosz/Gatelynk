'use client'
/**
 * IntegratorSmartLockCard — zamki Nuki na drzwiach mieszkań (2026-07).
 *
 * AccessPoint category='UNIT_DOOR' przypisany do lokalu (unitId). Token API
 * Nuki jest **pass-through** na Edge (device SMART_LOCK, driver nuki-web-api)
 * — NIE trafia do Postgresa; stąd banner i wymóg Edge online przy dodawaniu
 * / edycji tokenu (backend rzuca 502 z czytelnym polskim message).
 *
 * Endpointy (kontrakt backendu — `integrator.service.ts`):
 *   GET    /integrator/buildings/:id/smart-locks
 *          → [{ apId, label, unitId, unitLabel, deviceUuid, isActive, createdAt }]
 *   GET    /integrator/buildings/:id/smart-locks/units → [{ id, label, houseType }]
 *   POST   /integrator/buildings/:id/smart-locks  body { name, unitId, smartlockId, apiToken }
 *   PATCH  /integrator/buildings/:id/smart-locks/:apId  body { name?, isActive?, apiToken?, smartlockId? }
 *   DELETE /integrator/buildings/:id/smart-locks/:apId
 *   POST   /integrator/buildings/:id/smart-locks/:apId/test
 *          → { ok, name, state, stateLabel, batteryCritical, ... } (502 = message wprost)
 */
import { useCallback, useEffect, useState } from 'react'
import { integratorApi } from '@/lib/integrator-api'

interface SmartLockRow {
  apId: number
  label: string
  unitId: number | null
  unitLabel: string | null
  deviceUuid: string | null
  isActive: boolean
  createdAt: string
}

interface UnitOption {
  id: number
  label: string
  houseType: string | null
}

interface TestResult {
  ok?: boolean
  name?: string
  state?: number
  stateLabel?: string
  batteryCritical?: boolean
}

interface Props {
  buildingId: number
}

export function IntegratorSmartLockCard({ buildingId }: Props) {
  const [locks, setLocks] = useState<SmartLockRow[]>([])
  const [units, setUnits] = useState<UnitOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  // Formularz dodawania
  const [formName, setFormName] = useState('Drzwi mieszkania')
  const [formUnitId, setFormUnitId] = useState('')
  const [formSmartlockId, setFormSmartlockId] = useState('')
  const [formApiToken, setFormApiToken] = useState('')
  const [creating, setCreating] = useState(false)

  // Edycja per wiersz
  const [editingApId, setEditingApId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [editSmartlockId, setEditSmartlockId] = useState('')
  const [editApiToken, setEditApiToken] = useState('')
  const [savingApId, setSavingApId] = useState<number | null>(null)

  // Test per wiersz
  const [testingApId, setTestingApId] = useState<number | null>(null)
  const [testResults, setTestResults] = useState<Record<number, { result?: TestResult; error?: string }>>({})

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3500)
  }

  const load = useCallback(() => {
    integratorApi
      .get<SmartLockRow[]>(`/integrator/buildings/${buildingId}/smart-locks`)
      .then((r) => setLocks(r.data ?? []))
      .catch((err) => setError(err?.response?.data?.message ?? 'Błąd ładowania zamków'))
      .finally(() => setLoading(false))
    integratorApi
      .get<UnitOption[]>(`/integrator/buildings/${buildingId}/smart-locks/units`)
      .then((r) => setUnits(r.data ?? []))
      .catch(() => { /* select pokaże pustą listę — błąd i tak wyjdzie przy POST */ })
  }, [buildingId])

  useEffect(() => { load() }, [load])

  const create = async () => {
    setError(null)
    if (!formUnitId) { setError('Wybierz lokal, do którego przypisany jest zamek'); return }
    if (!/^\d{5,20}$/.test(formSmartlockId.trim())) {
      setError('Smartlock ID musi być liczbą (znajdziesz je w Nuki Web)')
      return
    }
    if (formApiToken.trim().length < 10) { setError('Podaj token API Nuki (Nuki Web → API)'); return }
    setCreating(true)
    try {
      await integratorApi.post(`/integrator/buildings/${buildingId}/smart-locks`, {
        name: formName.trim() || 'Drzwi mieszkania',
        unitId: Number(formUnitId),
        smartlockId: formSmartlockId.trim(),
        apiToken: formApiToken.trim(),
      })
      showToast('Zamek dodany — token przekazany na Edge')
      setFormName('Drzwi mieszkania')
      setFormUnitId('')
      setFormSmartlockId('')
      setFormApiToken('')
      load()
    } catch (err: any) {
      setError(err?.response?.data?.message ?? 'Nie udało się dodać zamka')
    } finally {
      setCreating(false)
    }
  }

  const startEdit = (lock: SmartLockRow) => {
    setEditingApId(lock.apId)
    setEditName(lock.label)
    setEditSmartlockId('')
    setEditApiToken('')
  }

  const saveEdit = async (lock: SmartLockRow) => {
    const body: Record<string, string> = {}
    const name = editName.trim()
    if (name && name !== lock.label) body.name = name
    if (editSmartlockId.trim()) body.smartlockId = editSmartlockId.trim()
    if (editApiToken.trim()) body.apiToken = editApiToken.trim()
    if (Object.keys(body).length === 0) { setEditingApId(null); return }
    if (body.smartlockId && !/^\d{5,20}$/.test(body.smartlockId)) {
      setError('Smartlock ID musi być liczbą')
      return
    }
    setSavingApId(lock.apId)
    setError(null)
    try {
      await integratorApi.patch(`/integrator/buildings/${buildingId}/smart-locks/${lock.apId}`, body)
      showToast('Zamek zaktualizowany')
      setEditingApId(null)
      load()
    } catch (err: any) {
      setError(err?.response?.data?.message ?? 'Nie udało się zapisać zmian')
    } finally {
      setSavingApId(null)
    }
  }

  const toggleActive = async (lock: SmartLockRow) => {
    setSavingApId(lock.apId)
    setError(null)
    try {
      await integratorApi.patch(`/integrator/buildings/${buildingId}/smart-locks/${lock.apId}`, {
        isActive: !lock.isActive,
      })
      setLocks((prev) => prev.map((l) => (l.apId === lock.apId ? { ...l, isActive: !lock.isActive } : l)))
      showToast(!lock.isActive ? 'Zamek aktywowany' : 'Zamek dezaktywowany')
    } catch (err: any) {
      setError(err?.response?.data?.message ?? 'Nie udało się zmienić aktywności')
    } finally {
      setSavingApId(null)
    }
  }

  const remove = async (lock: SmartLockRow) => {
    if (!confirm(`Usunąć zamek „${lock.label}"${lock.unitLabel ? ` (${lock.unitLabel})` : ''}? Urządzenie i token zostaną skasowane także na Edge.`)) return
    setSavingApId(lock.apId)
    setError(null)
    try {
      await integratorApi.delete(`/integrator/buildings/${buildingId}/smart-locks/${lock.apId}`)
      setLocks((prev) => prev.filter((l) => l.apId !== lock.apId))
      showToast('Zamek usunięty')
    } catch (err: any) {
      setError(err?.response?.data?.message ?? 'Nie udało się usunąć zamka')
    } finally {
      setSavingApId(null)
    }
  }

  const test = async (lock: SmartLockRow) => {
    setTestingApId(lock.apId)
    setTestResults((prev) => ({ ...prev, [lock.apId]: {} }))
    try {
      const r = await integratorApi.post<TestResult>(
        `/integrator/buildings/${buildingId}/smart-locks/${lock.apId}/test`,
      )
      setTestResults((prev) => ({ ...prev, [lock.apId]: { result: r.data } }))
    } catch (err: any) {
      setTestResults((prev) => ({
        ...prev,
        [lock.apId]: { error: err?.response?.data?.message ?? 'Test zamka nie powiódł się' },
      }))
    } finally {
      setTestingApId(null)
    }
  }

  return (
    <section className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 mb-6">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">🔐 Zamki Nuki (drzwi mieszkań)</h2>
          <p className="text-xs text-gray-500 mt-1">
            Zamek przypisany do lokalu — mieszkaniec i jego goście otwierają drzwi mieszkania
            z aplikacji / guest passa. Sterowanie przez Nuki Web API z bramki Edge.
          </p>
        </div>
        {toast && (
          <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-lg shrink-0">
            ✓ {toast}
          </div>
        )}
      </div>

      <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg mb-4">
        🔐 Token API Nuki jest przekazywany bezpośrednio na bramkę Edge i NIE jest zapisywany
        w chmurze. Dodanie/edycja tokenu wymaga, aby Edge był online.
      </div>

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg mb-3">
          ⚠ {error}
        </div>
      )}

      {/* ── Lista zamków ── */}
      {loading ? (
        <div className="text-sm text-gray-500 mb-4">Ładowanie…</div>
      ) : locks.length === 0 ? (
        <div className="text-xs text-gray-400 italic px-2 py-3 mb-2">
          Brak zamków. Dodaj pierwszy zamek formularzem poniżej.
        </div>
      ) : (
        <div className="border border-gray-100 rounded-lg overflow-hidden mb-4">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <th className="px-3 py-2">Nazwa / Lokal</th>
                <th className="px-3 py-2 w-36">Urządzenie</th>
                <th className="px-3 py-2 w-28">Status</th>
                <th className="px-3 py-2 w-28">Dodano</th>
                <th className="px-3 py-2 w-56">Akcje</th>
              </tr>
            </thead>
            <tbody>
              {locks.map((lock) => {
                const isEditing = editingApId === lock.apId
                const isSaving = savingApId === lock.apId
                const isTesting = testingApId === lock.apId
                const testRes = testResults[lock.apId]
                return (
                  <tr key={lock.apId} className="border-t border-gray-100 hover:bg-gray-50 align-top">
                    <td className="px-3 py-2.5">
                      {isEditing ? (
                        <div className="space-y-1.5">
                          <input
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            disabled={isSaving}
                            className="w-full text-sm px-2 py-1 border border-blue-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-200"
                            placeholder="Nazwa zamka"
                          />
                          <input
                            type="text"
                            inputMode="numeric"
                            value={editSmartlockId}
                            onChange={(e) => setEditSmartlockId(e.target.value.replace(/\D/g, ''))}
                            disabled={isSaving}
                            className="w-full text-xs px-2 py-1 border border-gray-300 rounded font-mono focus:outline-none focus:ring-2 focus:ring-blue-200"
                            placeholder="Nowe Smartlock ID (puste = bez zmiany)"
                          />
                          <input
                            type="password"
                            value={editApiToken}
                            onChange={(e) => setEditApiToken(e.target.value)}
                            disabled={isSaving}
                            autoComplete="new-password"
                            className="w-full text-xs px-2 py-1 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-200"
                            placeholder="Nowy token API (puste = bez zmiany)"
                          />
                        </div>
                      ) : (
                        <>
                          <div className="font-medium text-gray-900">{lock.label}</div>
                          <div className="text-xs text-gray-500">
                            {lock.unitLabel ?? <span className="italic text-gray-400">bez lokalu</span>}
                          </div>
                        </>
                      )}
                      {testRes?.result && (
                        <div className={`text-xs px-2 py-1 rounded border mt-1.5 ${testRes.result.batteryCritical
                          ? 'text-amber-700 bg-amber-50 border-amber-200'
                          : 'text-emerald-700 bg-emerald-50 border-emerald-200'}`}
                        >
                          ✓ {testRes.result.name ? `${testRes.result.name} — ` : ''}
                          {testRes.result.stateLabel ?? 'połączono'}
                          {testRes.result.batteryCritical && ' · ⚠ krytyczny poziom baterii'}
                        </div>
                      )}
                      {testRes?.error && (
                        <div className="text-xs text-red-700 bg-red-50 border border-red-200 px-2 py-1 rounded mt-1.5">
                          ✗ {testRes.error}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-gray-500 font-mono">
                      {lock.deviceUuid ? `${lock.deviceUuid.slice(0, 8)}…` : '—'}
                    </td>
                    <td className="px-3 py-2.5">
                      {lock.isActive ? (
                        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />Aktywny
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-600 border border-gray-200">
                          <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />Nieaktywny
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-gray-600 whitespace-nowrap">
                      {new Date(lock.createdAt).toLocaleDateString('pl-PL')}
                    </td>
                    <td className="px-3 py-2.5">
                      {isEditing ? (
                        <div className="flex flex-wrap gap-1">
                          <button
                            onClick={() => saveEdit(lock)}
                            disabled={isSaving}
                            className="text-xs px-2 py-1 rounded bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100 disabled:opacity-40"
                          >
                            {isSaving ? 'Zapisuję…' : '✓ Zapisz'}
                          </button>
                          <button
                            onClick={() => setEditingApId(null)}
                            disabled={isSaving}
                            className="text-xs px-2 py-1 rounded bg-white border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                          >
                            ✕ Anuluj
                          </button>
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          <button
                            onClick={() => test(lock)}
                            disabled={isTesting || isSaving}
                            className="text-xs px-2 py-1 rounded bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100 disabled:opacity-40"
                          >
                            {isTesting ? 'Testuję…' : '🔎 Testuj'}
                          </button>
                          <button
                            onClick={() => startEdit(lock)}
                            disabled={isSaving}
                            className="text-xs px-2 py-1 rounded bg-white border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                          >
                            ✎ Edytuj
                          </button>
                          <button
                            onClick={() => toggleActive(lock)}
                            disabled={isSaving}
                            className="text-xs px-2 py-1 rounded bg-white border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                          >
                            {lock.isActive ? '⏸ Dezaktywuj' : '▶ Aktywuj'}
                          </button>
                          <button
                            onClick={() => remove(lock)}
                            disabled={isSaving}
                            className="text-xs px-2 py-1 rounded bg-rose-50 border border-rose-200 text-rose-700 hover:bg-rose-100 disabled:opacity-40"
                          >
                            🗑 Usuń
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Formularz dodawania ── */}
      <div className="border border-gray-100 rounded-lg p-3 bg-gray-50/50">
        <div className="text-sm font-semibold text-gray-800 mb-2">➕ Dodaj zamek</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs font-medium text-gray-600">Nazwa</span>
            <input
              type="text"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              disabled={creating}
              className="mt-1 w-full text-sm px-2 py-1.5 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-200"
              placeholder="Drzwi mieszkania"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-gray-600">Lokal *</span>
            <select
              value={formUnitId}
              onChange={(e) => setFormUnitId(e.target.value)}
              disabled={creating}
              className="mt-1 w-full text-sm px-2 py-1.5 border border-gray-300 rounded bg-white focus:outline-none focus:ring-2 focus:ring-blue-200"
            >
              <option value="">— wybierz lokal —</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label}
                  {u.houseType ? ` · ${u.houseType}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-gray-600">Smartlock ID (z Nuki Web) *</span>
            <input
              type="text"
              inputMode="numeric"
              value={formSmartlockId}
              onChange={(e) => setFormSmartlockId(e.target.value.replace(/\D/g, ''))}
              disabled={creating}
              className="mt-1 w-full text-sm px-2 py-1.5 border border-gray-300 rounded font-mono focus:outline-none focus:ring-2 focus:ring-blue-200"
              placeholder="np. 17958229592"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-gray-600">Token API Nuki *</span>
            <input
              type="password"
              value={formApiToken}
              onChange={(e) => setFormApiToken(e.target.value)}
              disabled={creating}
              autoComplete="new-password"
              className="mt-1 w-full text-sm px-2 py-1.5 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-200"
              placeholder="Nuki Web → menu API → Generate token"
            />
          </label>
        </div>
        <div className="mt-3">
          <button
            onClick={create}
            disabled={creating}
            className="text-sm px-4 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {creating ? 'Dodaję (Edge)…' : 'Dodaj zamek'}
          </button>
        </div>
      </div>
    </section>
  )
}
