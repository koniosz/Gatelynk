'use client'
/**
 * IntegratorPermissionsMatrix (FAZA e — 2026-06-02).
 *
 * Visual matrix 3 ról × N feature/AP. Integrator decyduje co BA/Concierge/
 * Resident widzą w tym budynku, bez ręcznej modyfikacji kodu per klient.
 *
 * Endpointy:
 *   GET   /integrator/buildings/:id/permissions
 *   PATCH /integrator/buildings/:id/permissions
 *   POST  /integrator/buildings/:id/permissions/reset
 *
 * Backend zwraca:
 *   - `permissions: { ba: {feat_*, ap_*}, concierge: {...}, resident: {...} }`
 *   - `accessPoints: [{ id, label, icon, category, isActive }]`
 *   - `systemFeatures: [{ key, label }]`
 *   - `roles: [{ key, label }]`
 *
 * UX:
 *   - Checkbox per komórka (role × feature/AP); state lokalny.
 *   - „Reset do defaultów" — POST reset, ładuje świeże permissions.
 *   - Presety modyfikują state w pamięci (jeszcze nie save).
 *   - „Zapisz" — PATCH z aktualnym state.
 */
import { useEffect, useState, useCallback } from 'react'
import { integratorApi } from '@/lib/integrator-api'

type Role = 'ba' | 'concierge' | 'resident'
type RolePermissions = Record<string, boolean>
interface BuildingFeaturePermissions {
  ba?: RolePermissions
  concierge?: RolePermissions
  resident?: RolePermissions
}

// FAZA 8.g (2026-06-03) — feature zależne od AI Engine. Wyłączenie
// `feat_ai_engine` automatycznie blokuje te przez kaskadę w backendzie
// (`hasPermission`). UI pokazuje badge "wymaga AI Engine" + ostrzeżenie
// przy odznaczeniu master-feature.
const AI_ENGINE_DEPENDENT_FEATURES = new Set([
  'vision_dashboard',
  'fall_detection',
  'brand_detection',
  'plate_ocr',
  'vision_ai',
])

interface SystemFeatureDef {
  key: string
  label: string
}

interface AccessPointDef {
  id: number
  label: string
  icon: string | null
  category: string | null
  isActive: boolean
}

interface RoleDef {
  key: Role
  label: string
}

interface PermissionsPayload {
  id: number
  objectType: string
  permissions: BuildingFeaturePermissions
  accessPoints: AccessPointDef[]
  systemFeatures: SystemFeatureDef[]
  roles: RoleDef[]
}

interface Props {
  buildingId: string
  onSaved?: () => void
}

/**
 * Domyślne wartości gdy backend nie zwrócił danej komórki — defense
 * (kongruentne z `hasPermission` w backendzie: `true` gdy nieskonfigurowane).
 * UI pokazuje to jako "default-on" (jaśniejszy checked, kursywa tooltip).
 */
function cellChecked(
  perms: BuildingFeaturePermissions,
  role: Role,
  key: string,
): boolean {
  const explicit = perms[role]?.[key]
  if (typeof explicit === 'boolean') return explicit
  return true
}

function cellIsExplicit(
  perms: BuildingFeaturePermissions,
  role: Role,
  key: string,
): boolean {
  return typeof perms[role]?.[key] === 'boolean'
}

export function IntegratorPermissionsMatrix({ buildingId, onSaved }: Props) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)

  const [data, setData] = useState<PermissionsPayload | null>(null)
  const [edited, setEdited] = useState<BuildingFeaturePermissions>({})

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await integratorApi.get(`/integrator/buildings/${buildingId}/permissions`)
      const payload = res.data as PermissionsPayload
      setData(payload)
      setEdited({
        ba: { ...(payload.permissions.ba ?? {}) },
        concierge: { ...(payload.permissions.concierge ?? {}) },
        resident: { ...(payload.permissions.resident ?? {}) },
      })
    } catch (err: any) {
      setError(err?.response?.data?.message ?? err.message ?? 'Błąd ładowania')
    } finally {
      setLoading(false)
    }
  }, [buildingId])

  useEffect(() => {
    load()
  }, [load])

  const toggleCell = (role: Role, key: string) => {
    setOk(null)
    setEdited((prev) => {
      const next: BuildingFeaturePermissions = {
        ba: { ...(prev.ba ?? {}) },
        concierge: { ...(prev.concierge ?? {}) },
        resident: { ...(prev.resident ?? {}) },
      }
      const cur = cellChecked(next, role, key)
      next[role]![key] = !cur
      return next
    })
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    setOk(null)
    try {
      await integratorApi.patch(`/integrator/buildings/${buildingId}/permissions`, {
        permissions: edited,
      })
      setOk('Zapisano uprawnienia.')
      onSaved?.()
      // Reload żeby normalize z backendu (np. filtruje klucze które nie pasują).
      await load()
      setTimeout(() => setOk(null), 3000)
    } catch (err: any) {
      setError(err?.response?.data?.message ?? err.message ?? 'Błąd zapisu')
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    if (!confirm('Przywrócić uprawnienia do wartości domyślnych dla tego typu obiektu?')) return
    setResetting(true)
    setError(null)
    setOk(null)
    try {
      await integratorApi.post(`/integrator/buildings/${buildingId}/permissions/reset`)
      setOk('Przywrócono defaulty dla obiektu.')
      onSaved?.()
      await load()
      setTimeout(() => setOk(null), 3000)
    } catch (err: any) {
      setError(err?.response?.data?.message ?? err.message ?? 'Błąd resetu')
    } finally {
      setResetting(false)
    }
  }

  // Preset: włącz wszystko BA. Lokalne — wymaga „Zapisz" potem.
  const presetAllBa = () => {
    if (!data) return
    setOk(null)
    setEdited((prev) => {
      const next: BuildingFeaturePermissions = {
        ba: { ...(prev.ba ?? {}) },
        concierge: { ...(prev.concierge ?? {}) },
        resident: { ...(prev.resident ?? {}) },
      }
      for (const f of data.systemFeatures) {
        next.ba![`feat_${f.key}`] = true
      }
      for (const ap of data.accessPoints) {
        next.ba![`ap_${ap.id}`] = true
      }
      return next
    })
  }

  // Preset: ukryj alarmy Resident (fall_detection, notifications).
  const presetHideAlertsResident = () => {
    setOk(null)
    setEdited((prev) => ({
      ...prev,
      resident: {
        ...(prev.resident ?? {}),
        feat_fall_detection: false,
        feat_notifications: false,
      },
    }))
  }

  // Preset: tylko płatności dla mieszkańca (np. obiekt komercyjny).
  const presetPaymentsOnlyResident = () => {
    if (!data) return
    setOk(null)
    setEdited((prev) => {
      const r: RolePermissions = {}
      for (const f of data.systemFeatures) {
        r[`feat_${f.key}`] = false
      }
      r.feat_payments = true
      r.feat_notifications = true
      return { ...prev, resident: r }
    })
  }

  if (loading) {
    return (
      <div className="bg-card rounded-r3 border border-border-2 p-5 mb-4">
        <p className="text-[13px] text-muted">Ładowanie uprawnień…</p>
      </div>
    )
  }

  if (error && !data) {
    return (
      <div className="bg-card rounded-r3 border border-red-200 p-5 mb-4">
        <p className="text-[13px] text-red-600">{error}</p>
        <button
          onClick={load}
          className="mt-3 text-[12px] text-brand underline"
        >
          Spróbuj ponownie
        </button>
      </div>
    )
  }

  if (!data) return null

  return (
    <div className="bg-card rounded-r3 border border-border-2 p-5 mb-4">
      <div className="flex items-start justify-between mb-4 gap-4">
        <div>
          <h3 className="text-[15px] font-semibold text-ink">Uprawnienia per rola</h3>
          <p className="text-[12px] text-muted mt-0.5">
            Zaznacz które funkcje i punkty dostępu są widoczne dla danej roli w tym budynku.
            Niezdefiniowana komórka = domyślnie widoczna.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap justify-end">
          <button
            type="button"
            onClick={presetAllBa}
            disabled={saving || resetting}
            className="text-[12px] text-ink-2 bg-input border border-border-2 rounded-r2 px-2.5 py-1 hover:bg-muted-1/40"
          >
            Włącz wszystko BA
          </button>
          <button
            type="button"
            onClick={presetHideAlertsResident}
            disabled={saving || resetting}
            className="text-[12px] text-ink-2 bg-input border border-border-2 rounded-r2 px-2.5 py-1 hover:bg-muted-1/40"
          >
            Ukryj alarmy Resident
          </button>
          <button
            type="button"
            onClick={presetPaymentsOnlyResident}
            disabled={saving || resetting}
            className="text-[12px] text-ink-2 bg-input border border-border-2 rounded-r2 px-2.5 py-1 hover:bg-muted-1/40"
          >
            Resident: tylko płatności
          </button>
        </div>
      </div>

      {/* FAZA 8.g — banner gdy AI Engine wyłączony dla którejś roli */}
      {(['ba','concierge','resident'] as Role[]).some((r) => edited[r]?.['feat_ai_engine'] === false) && (
        <div className="mb-3 text-[12px] bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2 rounded-r2">
          <strong>Uwaga:</strong> wyłączenie <em>AI Engine</em> automatycznie blokuje
          funkcje zależne: Vision dashboard, Wykrywanie upadków, Brand detection,
          OCR tablic. Backend zwróci <code>FEATURE_DISABLED</code> dla tych funkcji
          nawet jeśli mają zaznaczony checkbox.
        </div>
      )}

      {/* MATRIX */}
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="text-left text-muted">
              <th className="font-medium pb-2 pr-3 w-1/2">Funkcja / Punkt dostępu</th>
              {data.roles.map((r) => (
                <th key={r.key} className="font-medium pb-2 px-2 text-center">
                  {r.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* SEKCJA: System features */}
            <tr>
              <td colSpan={1 + data.roles.length} className="pt-3 pb-1.5">
                <div className="text-[11px] uppercase tracking-wider text-muted font-semibold">
                  Funkcje systemu
                </div>
              </td>
            </tr>
            {data.systemFeatures.map((f) => {
              const key = `feat_${f.key}`
              const isAiEngineMaster = f.key === 'ai_engine'
              const isAiEngineDependent = AI_ENGINE_DEPENDENT_FEATURES.has(f.key)
              // Computed: gdy `feat_ai_engine` jest jawnie wyłączony dla danej
              // roli, ML feature są wyszarzone (backend tak zwróci `false`
              // niezależnie od ich własnej wartości). Pokazujemy to wizualnie.
              const aiEngineExplicitFalse = (role: Role): boolean =>
                edited[role]?.['feat_ai_engine'] === false
              return (
                <tr
                  key={key}
                  className={
                    'border-t border-border-2/60 hover:bg-muted-1/30 ' +
                    (isAiEngineMaster ? 'bg-blue-50/30' : '')
                  }
                >
                  <td className="py-1.5 pr-3 text-ink">
                    <span className="inline-flex items-center gap-2 flex-wrap">
                      {f.label}
                      {isAiEngineMaster && (
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 border border-blue-200"
                          title="Wyłączenie tej funkcji blokuje: Vision dashboard, Wykrywanie upadków, Brand detection, OCR tablic"
                        >
                          MASTER
                        </span>
                      )}
                      {isAiEngineDependent && (
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200"
                          title="Funkcja działa tylko gdy AI Engine jest włączony (kaskada)"
                        >
                          wymaga AI Engine
                        </span>
                      )}
                    </span>
                  </td>
                  {data.roles.map((r) => {
                    const checked = cellChecked(edited, r.key, key)
                    const explicit = cellIsExplicit(edited, r.key, key)
                    const cascaded = isAiEngineDependent && aiEngineExplicitFalse(r.key)
                    return (
                      <td key={r.key} className="py-1.5 px-2 text-center">
                        <input
                          type="checkbox"
                          checked={cascaded ? false : checked}
                          onChange={() => toggleCell(r.key, key)}
                          disabled={saving || resetting || cascaded}
                          title={
                            cascaded
                              ? 'Wyłączone kaskadowo — AI Engine jest wyłączony dla tej roli'
                              : explicit
                                ? ''
                                : 'Domyślnie (nieskonfigurowane)'
                          }
                          className={
                            'w-4 h-4 accent-brand cursor-pointer ' +
                            (explicit ? '' : 'opacity-60') +
                            (cascaded ? ' opacity-40 cursor-not-allowed' : '')
                          }
                        />
                      </td>
                    )
                  })}
                </tr>
              )
            })}

            {/* SEKCJA: Access Points */}
            {data.accessPoints.length > 0 && (
              <>
                <tr>
                  <td colSpan={1 + data.roles.length} className="pt-4 pb-1.5">
                    <div className="text-[11px] uppercase tracking-wider text-muted font-semibold">
                      Punkty dostępu
                    </div>
                  </td>
                </tr>
                {data.accessPoints.map((ap) => {
                  const key = `ap_${ap.id}`
                  return (
                    <tr
                      key={key}
                      className="border-t border-border-2/60 hover:bg-muted-1/30"
                    >
                      <td className="py-1.5 pr-3 text-ink">
                        <span className="inline-flex items-center gap-2">
                          {ap.label}
                          {ap.category && (
                            <span className="text-[10px] text-muted-2 uppercase">
                              {ap.category}
                            </span>
                          )}
                          {!ap.isActive && (
                            <span className="text-[10px] text-amber-600">(nieaktywny)</span>
                          )}
                        </span>
                      </td>
                      {data.roles.map((r) => {
                        const checked = cellChecked(edited, r.key, key)
                        const explicit = cellIsExplicit(edited, r.key, key)
                        return (
                          <td key={r.key} className="py-1.5 px-2 text-center">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleCell(r.key, key)}
                              disabled={saving || resetting}
                              title={explicit ? '' : 'Domyślnie (nieskonfigurowane)'}
                              className={
                                'w-4 h-4 accent-brand cursor-pointer ' +
                                (explicit ? '' : 'opacity-60')
                              }
                            />
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </>
            )}
          </tbody>
        </table>
      </div>

      {/* Errors / OK */}
      {error && (
        <div className="mt-4 text-[12px] text-red-600 bg-red-50 border border-red-200 rounded-r2 px-3 py-2">
          {error}
        </div>
      )}
      {ok && (
        <div className="mt-4 text-[12px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-r2 px-3 py-2">
          {ok}
        </div>
      )}

      {/* Actions */}
      <div className="mt-4 flex justify-between items-center">
        <button
          type="button"
          onClick={handleReset}
          disabled={saving || resetting}
          className="text-[12px] text-ink-2 bg-input border border-border-2 rounded-r2 px-3 py-2 hover:bg-muted-1/40 disabled:opacity-60"
        >
          {resetting ? 'Resetowanie…' : 'Reset do defaultów'}
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || resetting}
          className="bg-brand text-white text-[13px] font-medium px-4 py-2 rounded-r2 hover:bg-brand-600 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {saving ? 'Zapisywanie…' : 'Zapisz uprawnienia'}
        </button>
      </div>
    </div>
  )
}
