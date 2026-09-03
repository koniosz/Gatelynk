'use client'
/**
 * IntegratorCameraSettingsCard (FAZA 8.h — 2026-06-03).
 *
 * Per-kamera ustawienia:
 *   1. Role: STANDARD (zwykła kamera wizyjna) vs LPR (rozpoznawanie tablic).
 *      Domyślnie LPR — historyczne kamery były wszystkie LPR. Zmiana role
 *      wpływa na: VisionDetectService (jak liczy detekcje), klasyfikację UI
 *      (sekcje "Kamery wizyjne" / "Kamery LPR"), oraz dostępność do AP-linkingu
 *      (tylko LPR mogą być powiązane z AccessPoint przez LPR linkage card).
 *
 *   2. AI Analysis enabled: per-kamera włącznik analizy AI (YOLO).
 *      Default ON dla istniejących kamer (migration). Wyłączenie znaczy że
 *      VisionDetectService.listCameras() POMIJA tę kamerę co 60s. Przydatne
 *      np. gdy klient nie chce monitoringu w prywatnej części osiedla, ale
 *      kamera musi tam być z innych powodów (LPR przy wjeździe).
 *
 * Endpointy:
 *   GET   /integrator/buildings/:id/lpr-cameras  → lista (zawiera role + aiAnalysisEnabled)
 *   PATCH /integrator/buildings/:id/cameras/:cameraId  body { role?, aiAnalysisEnabled? }
 *
 * Cascade do Edge: PATCH triggeruje CAMERA_CONFIG_UPDATE przez tunnel + outbox.
 * Edge SQLite zapisuje do `device_config.role` + `device_config.ai_analysis_enabled`.
 * VisionDetectService.listCameras() filter `aiAnalysisEnabled !== false`.
 *
 * UI — 2 sekcje:
 *   • "Kamery wizyjne" (role=STANDARD) — typowo do general monitoring
 *   • "Kamery LPR"     (role=LPR)     — z ANPR (Hikvision DeepinView itp.)
 *
 * Per row:
 *   - Nazwa + model + IP
 *   - Dropdown role (STANDARD / LPR) — zmienia sekcję po zapisaniu
 *   - Checkbox "Analizuj AI" (aiAnalysisEnabled)
 *   - Status "edge sync" (zielony gdy edgeDeviceId is set, szary gdy bez)
 */
import { useCallback, useEffect, useState } from 'react'
import { integratorApi } from '@/lib/integrator-api'

type CameraRole = 'STANDARD' | 'LPR'

interface CameraRow {
  id: number
  buildingId: number
  name: string | null
  manufacturer: string | null
  model: string | null
  ipAddress: string | null
  edgeDeviceId: string | null
  linkedIntercomEdgeId: string | null
  linkedRelayIndex: number | null
  role: CameraRole
  aiAnalysisEnabled: boolean
  /** FAZA 8.h.1 — typ z Edge mirror, NULL gdy Cloud-only. Używany żeby
   *  pokazać badge "mismatch" gdy Cloud role='LPR' ale Edge widzi 'CAMERA'. */
  edgeMirrorType?: 'CAMERA' | 'LPR_CAMERA' | null
}

const ROLE_LABELS: Record<CameraRole, string> = {
  STANDARD: 'Kamera wizyjna',
  LPR: 'Kamera LPR (rozpoznawanie tablic)',
}

interface Props {
  buildingId: number
}

export function IntegratorCameraSettingsCard({ buildingId }: Props) {
  const [cameras, setCameras] = useState<CameraRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<number | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    integratorApi
      .get<CameraRow[]>(`/integrator/buildings/${buildingId}/lpr-cameras`)
      .then((r) => setCameras(r.data ?? []))
      .catch((err) => setError(err?.response?.data?.message ?? 'Błąd ładowania kamer'))
      .finally(() => setLoading(false))
  }, [buildingId])

  useEffect(() => { load() }, [load])

  const patch = async (cameraId: number, body: Partial<Pick<CameraRow, 'role' | 'aiAnalysisEnabled'>>) => {
    setSavingId(cameraId)
    setError(null)
    try {
      const r = await integratorApi.patch<CameraRow>(
        `/integrator/buildings/${buildingId}/cameras/${cameraId}`,
        body,
      )
      setCameras((prev) => prev.map((c) => (c.id === cameraId ? { ...c, ...r.data } : c)))
      setToast(body.role ? `Zmieniono rolę na ${ROLE_LABELS[body.role]}` : `Analiza AI: ${body.aiAnalysisEnabled ? 'włączona' : 'wyłączona'}`)
      setTimeout(() => setToast(null), 3000)
    } catch (err: any) {
      setError(err?.response?.data?.message ?? 'Nie udało się zapisać zmiany')
    } finally {
      setSavingId(null)
    }
  }

  if (loading) {
    return (
      <section className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 mb-6">
        <h2 className="text-base font-semibold text-gray-900 mb-3">📹 Kamery — role i analiza AI</h2>
        <div className="text-sm text-gray-500">Ładowanie…</div>
      </section>
    )
  }

  if (cameras.length === 0) {
    return (
      <section className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 mb-6">
        <h2 className="text-base font-semibold text-gray-900 mb-3">📹 Kamery — role i analiza AI</h2>
        <div className="text-sm text-gray-500 italic">
          Brak kamer. Dodaj kamerę przez Edge wizard, potem wróć tu skonfigurować rolę i analizę AI.
        </div>
      </section>
    )
  }

  const standardCams = cameras.filter((c) => c.role === 'STANDARD')
  const lprCams = cameras.filter((c) => c.role === 'LPR')

  return (
    <section className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 mb-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-gray-900">📹 Kamery — role i analiza AI</h2>
          <p className="text-xs text-gray-500 mt-1">
            Wybierz typ kamery (wizyjna lub LPR) oraz czy ma być analizowana przez Edge AI (YOLO).
          </p>
        </div>
        {toast && (
          <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-lg">
            ✓ {toast}
          </div>
        )}
      </div>

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg mb-3">
          ⚠ {error}
        </div>
      )}

      <CameraGroup
        title="Kamery wizyjne"
        emoji="📷"
        cameras={standardCams}
        savingId={savingId}
        emptyHint="Żadna kamera nie ma roli STANDARD. Wszystkie są oznaczone jako LPR."
        onPatch={patch}
      />

      <div className="h-4" />

      <CameraGroup
        title="Kamery LPR (rozpoznawanie tablic)"
        emoji="🚗"
        cameras={lprCams}
        savingId={savingId}
        emptyHint="Żadna kamera nie ma roli LPR. Zmień rolę kamery powyżej jeśli ma ANPR."
        onPatch={patch}
      />
    </section>
  )
}

function CameraGroup({
  title,
  emoji,
  cameras,
  savingId,
  emptyHint,
  onPatch,
}: {
  title: string
  emoji: string
  cameras: CameraRow[]
  savingId: number | null
  emptyHint: string
  onPatch: (cameraId: number, body: Partial<Pick<CameraRow, 'role' | 'aiAnalysisEnabled'>>) => void
}) {
  return (
    <div>
      <div className="text-sm font-semibold text-gray-800 mb-2">
        {emoji} {title} <span className="text-gray-400 font-normal">({cameras.length})</span>
      </div>
      {cameras.length === 0 ? (
        <div className="text-xs text-gray-400 italic px-2 py-3">{emptyHint}</div>
      ) : (
        <div className="border border-gray-100 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <th className="px-3 py-2">Nazwa / Model</th>
                <th className="px-3 py-2 w-40">IP</th>
                <th className="px-3 py-2 w-44">Rola</th>
                <th className="px-3 py-2 w-44">Analiza AI</th>
                <th className="px-3 py-2 w-32">Sync z Edge</th>
              </tr>
            </thead>
            <tbody>
              {cameras.map((cam) => {
                const isSaving = savingId === cam.id
                // FAZA 8.h.1 — mismatch: Cloud role='LPR' ale Edge raportuje 'CAMERA'
                // (lub odwrotnie). Defense-in-depth — pokaż hint że role w Cloud
                // nie pasuje do tego co widzi Edge.
                const mismatchHint = cam.edgeMirrorType === 'CAMERA' && cam.role === 'LPR'
                  ? 'Edge widzi tę kamerę jako wizyjną — zmień rolę na STANDARD'
                  : cam.edgeMirrorType === 'LPR_CAMERA' && cam.role === 'STANDARD'
                  ? 'Edge widzi tę kamerę jako LPR — zmień rolę na LPR'
                  : null
                return (
                  <tr key={cam.id} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-gray-900">{cam.name ?? `Kamera #${cam.id}`}</div>
                      <div className="text-xs text-gray-500">
                        {cam.manufacturer ?? '—'} {cam.model ?? ''}
                      </div>
                      {mismatchHint && (
                        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1 rounded mt-1.5">
                          ⚠ {mismatchHint}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-gray-700 font-mono">
                      {cam.ipAddress ?? '—'}
                    </td>
                    <td className="px-3 py-2.5">
                      <select
                        className="w-full px-2 py-1 text-xs border border-gray-300 rounded disabled:opacity-50 disabled:cursor-not-allowed"
                        value={cam.role}
                        disabled={isSaving}
                        onChange={(e) => onPatch(cam.id, { role: e.target.value as CameraRole })}
                      >
                        <option value="STANDARD">Wizyjna</option>
                        <option value="LPR">LPR (ANPR)</option>
                      </select>
                    </td>
                    <td className="px-3 py-2.5">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-blue-600 cursor-pointer disabled:cursor-not-allowed"
                          checked={cam.aiAnalysisEnabled}
                          disabled={isSaving}
                          onChange={(e) => onPatch(cam.id, { aiAnalysisEnabled: e.target.checked })}
                        />
                        <span className="text-xs text-gray-700">
                          {cam.aiAnalysisEnabled ? 'Włączona' : 'Wyłączona'}
                        </span>
                      </label>
                    </td>
                    <td className="px-3 py-2.5">
                      {cam.edgeDeviceId ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-emerald-50 text-emerald-700 border border-emerald-200">
                          ● powiązana
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-500 border border-gray-200">
                          ○ tylko Cloud
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
