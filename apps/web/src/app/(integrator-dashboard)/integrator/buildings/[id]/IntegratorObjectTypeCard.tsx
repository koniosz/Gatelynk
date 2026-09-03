'use client'
/**
 * IntegratorObjectTypeCard (FAZA b — 2026-06-02).
 *
 * Karta konfiguracji typu obiektu: dropdown 5 typów + checkboxy feature flag.
 * Endpointy:
 *   GET   /integrator/buildings/:id/object-type   — load
 *   PATCH /integrator/buildings/:id/object-type   — save
 *
 * UX:
 *   • Zmiana typu auto-fill features z `DEFAULT_FEATURES[type]` (z możliwością
 *     override). Jeżeli user wprowadził custom features, a potem zmienił typ,
 *     features resetują się do nowych defaultów — taka jest decyzja produktowa
 *     żeby nie mieszać sygnałów.
 *   • Save → toast „Zapisano" lub error.
 */
import { useEffect, useState } from 'react'
import { integratorApi } from '@/lib/integrator-api'
import {
  DEFAULT_FEATURES,
  FEATURE_LABELS,
  OBJECT_TYPE_LABELS,
  type BuildingFeatures,
  type ObjectType,
} from '@/components/integrator/property/types'

interface Props {
  buildingId: string
  onSaved?: () => void
}

const ORDERED_TYPES: ObjectType[] = ['BUILDING', 'HOUSING_ESTATE', 'MIXED_USE', 'CAMPUS', 'PARKING']
const ORDERED_FLAGS: (keyof BuildingFeatures)[] = [
  'has_concierge',
  'has_central_mailbox',
  'delivery_to_door',
  'has_security_guard',
  'has_common_parking',
]

export function IntegratorObjectTypeCard({ buildingId, onSaved }: Props) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState(false)

  const [objectType, setObjectType] = useState<ObjectType>('BUILDING')
  const [features, setFeatures] = useState<BuildingFeatures>(DEFAULT_FEATURES.BUILDING)

  // Initial fetch
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await integratorApi.get(`/integrator/buildings/${buildingId}/object-type`)
        if (cancelled) return
        const data = res.data as {
          id: number
          objectType: ObjectType
          features: BuildingFeatures
        }
        setObjectType(data.objectType)
        setFeatures(data.features)
      } catch (err: any) {
        if (!cancelled) setError(err?.response?.data?.message ?? err.message ?? 'Błąd ładowania')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [buildingId])

  const handleTypeChange = (next: ObjectType) => {
    setObjectType(next)
    // Auto-fill features z defaultów dla nowego typu.
    setFeatures({ ...DEFAULT_FEATURES[next] })
    setOk(false)
  }

  const handleFlagToggle = (flag: keyof BuildingFeatures) => {
    setFeatures((prev) => ({ ...prev, [flag]: !prev[flag] }))
    setOk(false)
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    setOk(false)
    try {
      await integratorApi.patch(`/integrator/buildings/${buildingId}/object-type`, {
        objectType,
        features,
      })
      setOk(true)
      onSaved?.()
      setTimeout(() => setOk(false), 3000)
    } catch (err: any) {
      setError(err?.response?.data?.message ?? err.message ?? 'Błąd zapisu')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="bg-card rounded-r3 border border-border-2 p-5 mb-4">
        <p className="text-[13px] text-muted">Ładowanie konfiguracji obiektu…</p>
      </div>
    )
  }

  return (
    <div className="bg-card rounded-r3 border border-border-2 p-5 mb-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-[15px] font-semibold text-ink">Typ obiektu i funkcje</h3>
          <p className="text-[12px] text-muted mt-0.5">
            Określa zachowanie panelu, mieszkańca i konsjerża. Zmiana typu wypełni funkcje
            domyślnymi wartościami — możesz je nadpisać poniżej.
          </p>
        </div>
      </div>

      <div className="space-y-4">
        {/* Typ obiektu */}
        <div>
          <label className="block text-[12px] font-medium text-ink-2 mb-1.5">Typ obiektu</label>
          <select
            value={objectType}
            onChange={(e) => handleTypeChange(e.target.value as ObjectType)}
            disabled={saving}
            className="w-full bg-input border border-border-2 rounded-r2 px-3 py-2 text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-brand"
          >
            {ORDERED_TYPES.map((t) => (
              <option key={t} value={t}>
                {OBJECT_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>

        {/* Features */}
        <div>
          <p className="block text-[12px] font-medium text-ink-2 mb-2">Funkcje obiektu</p>
          <div className="space-y-1.5">
            {ORDERED_FLAGS.map((flag) => (
              <label
                key={flag}
                className="flex items-center gap-2.5 px-2 py-1.5 rounded-r2 hover:bg-muted-1/40 cursor-pointer select-none"
              >
                <input
                  type="checkbox"
                  checked={features[flag]}
                  onChange={() => handleFlagToggle(flag)}
                  disabled={saving}
                  className="w-4 h-4 accent-brand cursor-pointer"
                />
                <span className="text-[13px] text-ink">{FEATURE_LABELS[flag]}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Errors / OK */}
        {error && (
          <div className="text-[12px] text-red-600 bg-red-50 border border-red-200 rounded-r2 px-3 py-2">
            {error}
          </div>
        )}
        {ok && (
          <div className="text-[12px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-r2 px-3 py-2">
            Zapisano konfigurację obiektu.
          </div>
        )}

        {/* Save button */}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="bg-brand text-white text-[13px] font-medium px-4 py-2 rounded-r2 hover:bg-brand-600 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {saving ? 'Zapisywanie…' : 'Zapisz zmiany'}
          </button>
        </div>
      </div>
    </div>
  )
}
