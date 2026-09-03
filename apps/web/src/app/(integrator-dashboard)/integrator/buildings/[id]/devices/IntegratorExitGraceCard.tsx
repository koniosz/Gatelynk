'use client'
/**
 * 2026-07-30 — Przepustka wyjazdowa (exit grace pass, docs/exit-grace-pass.md).
 *
 * Karta w panelu Integratora (devices obiektu): toggle enabled + okno w
 * minutach (5–120) + polityka po wygaśnięciu (OPEN_AND_FLAG / DENY).
 * Zapis → PATCH /integrator/buildings/:id/exit-grace → Building.features.exitGrace
 * + push BUILDING_CONFIG_UPDATE do Edge (konsument: HikvisionLprService).
 *
 * Default WYŁĄCZONE — do czasu włączenia tutaj Edge zachowuje się jak dotąd.
 */
import { useCallback, useEffect, useState } from 'react'
import { integratorApi } from '@/lib/integrator-api'

interface ExitGraceConfig {
  enabled: boolean
  minutes: number
  afterExpiry: 'OPEN_AND_FLAG' | 'DENY'
}

interface ExitGraceResponse {
  buildingId: number
  exitGrace: ExitGraceConfig
  limits: { minMinutes: number; maxMinutes: number }
}

export function IntegratorExitGraceCard({ buildingId }: { buildingId: number }) {
  const [config, setConfig] = useState<ExitGraceConfig | null>(null)
  const [limits, setLimits] = useState({ minMinutes: 5, maxMinutes: 120 })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [dirty, setDirty] = useState(false)

  const load = useCallback(() => {
    integratorApi
      .get(`/integrator/buildings/${buildingId}/exit-grace`)
      .then((r) => {
        const data = r.data as ExitGraceResponse
        setConfig(data.exitGrace)
        if (data.limits) setLimits(data.limits)
      })
      .catch((err) => setError(err?.response?.data?.message ?? 'Błąd ładowania konfiguracji'))
      .finally(() => setLoading(false))
  }, [buildingId])

  useEffect(() => { load() }, [load])

  const update = (patch: Partial<ExitGraceConfig>) => {
    setConfig((prev) => (prev ? { ...prev, ...patch } : prev))
    setDirty(true)
    setSavedAt(null)
  }

  const save = async () => {
    if (!config) return
    const minutes = Math.min(limits.maxMinutes, Math.max(limits.minMinutes, Math.round(config.minutes)))
    setSaving(true)
    setError(null)
    try {
      const r = await integratorApi.patch(`/integrator/buildings/${buildingId}/exit-grace`, {
        enabled: config.enabled,
        minutes,
        afterExpiry: config.afterExpiry,
      })
      setConfig((r.data as { exitGrace: ExitGraceConfig }).exitGrace)
      setDirty(false)
      setSavedAt(Date.now())
    } catch (err: any) {
      setError(err?.response?.data?.message ?? 'Błąd zapisu')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-base font-semibold text-gray-800">
            🎫 Przepustka wyjazdowa
            {config?.enabled ? (
              <span className="ml-2 text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 align-middle">
                WŁĄCZONA
              </span>
            ) : (
              <span className="ml-2 text-xs font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 align-middle">
                wyłączona
              </span>
            )}
          </h3>
          <p className="mt-1 text-sm text-gray-500 max-w-2xl">
            Pojazd spoza białej listy (taxi, dostawca), który wjechał na osiedle, może
            wyjechać: kamera wyjazdowa rozpoznaje tablicę i otwiera szlaban w oknie czasowym
            liczonym od wjazdu. Działa wyłącznie na kierunek WYJAZD — niczego nie wpuszcza.
            Decyzja zapada na Edge (offline-first).
          </p>
        </div>
      </div>

      {loading ? (
        <div className="mt-4 text-sm text-gray-400">Ładowanie…</div>
      ) : config ? (
        <div className="mt-4 space-y-4">
          <label className="flex items-center gap-3 text-sm text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(e) => update({ enabled: e.target.checked })}
              className="h-4 w-4 rounded border-gray-300"
            />
            <span>
              Włącz przepustkę wyjazdową dla tego obiektu
            </span>
          </label>

          <div className="grid gap-4 sm:grid-cols-2 max-w-xl">
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
                Okno wyjazdu (minuty)
              </label>
              <input
                type="number"
                min={limits.minMinutes}
                max={limits.maxMinutes}
                value={config.minutes}
                onChange={(e) => update({ minutes: Number(e.target.value) })}
                disabled={!config.enabled}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-400"
              />
              <p className="mt-1 text-xs text-gray-400">
                {limits.minMinutes}–{limits.maxMinutes} min, domyślnie 15
              </p>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
                Po upływie okna
              </label>
              <select
                value={config.afterExpiry}
                onChange={(e) => update({ afterExpiry: e.target.value as ExitGraceConfig['afterExpiry'] })}
                disabled={!config.enabled}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-400"
              >
                <option value="OPEN_AND_FLAG">Otwórz + oznacz OVERSTAY (rekomendowane)</option>
                <option value="DENY">Nie otwieraj (kierowca dzwoni domofonem)</option>
              </select>
              <p className="mt-1 text-xs text-gray-400">
                {config.afterExpiry === 'DENY'
                  ? 'Uwaga: auto zablokowane przy szlabanie blokuje wyjazd wszystkim.'
                  : 'Szlaban otwiera się, admin dostaje powiadomienie o przekroczeniu czasu.'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={save}
              disabled={saving || !dirty}
              className="text-sm px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? 'Zapisywanie…' : '💾 Zapisz'}
            </button>
            {savedAt && !dirty && (
              <span className="text-sm text-emerald-600">✓ Zapisano — Edge dostaje konfigurację przez tunel</span>
            )}
            {error && <span className="text-sm text-rose-600">✗ {error}</span>}
          </div>

          <p className="text-xs text-gray-400 max-w-2xl">
            Wymagane: kamery LPR powiązane z punktami dostępu z kierunkiem IN (wjazd)
            i OUT (wyjazd) — patrz karta „Powiązania LPR" wyżej. Wyjazd na przepustce i
            przekroczenia czasu widoczne w feedzie „Wejścia (audit)".
          </p>
        </div>
      ) : (
        error && <div className="mt-4 text-sm text-rose-600">{error}</div>
      )}
    </div>
  )
}
