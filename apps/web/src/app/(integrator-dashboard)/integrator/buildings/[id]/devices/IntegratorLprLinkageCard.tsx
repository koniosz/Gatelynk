'use client'
/**
 * Sekcja „Powiazanie LPR -> AccessPoint" w panelu Integratora.
 *
 * FAZA c (2026-06-02): refactor na multi-link per kamera.
 *
 * Kazda kamera moze byc powiazana z N punktami dostepu, z direction IN/OUT
 * per powiazanie (typowo: jedna kamera wjazdowa otwierajaca wjazd + wyjazd
 * jako safety). Endpointy:
 *   GET    /integrator/buildings/:id/lpr-camera-ap-links
 *   POST   /integrator/buildings/:id/access-points/:apId/cameras
 *          body { cameraDeviceUuid, direction }
 *   PATCH  /integrator/buildings/:id/access-points/:apId/cameras/:linkId
 *          body { direction }
 *   DELETE /integrator/buildings/:id/access-points/:apId/cameras/:linkId
 *
 * Legacy fallback (config.linkedAccessPointId) dziala nadal po Edge stronie;
 * tutaj go juz nie pokazujemy bo nowe linki zastepuja ten flow.
 */
import { useCallback, useEffect, useState } from 'react'
import { integratorApi } from '@/lib/integrator-api'

interface AccessPointLite {
  id: number
  label: string
}

interface MirrorDeviceLite {
  id: number
  deviceUuid: string
  type: string
  driverId: string | null
  config: Record<string, any>
  displayLabel: string | null
}

interface LprCameraRow {
  deviceUuid: string
  displayLabel: string | null
  ipAddress: string | null
  manufacturer: string | null
  model: string | null
}

type Direction = 'IN' | 'OUT'

interface LprApLink {
  id: number
  cameraDeviceUuid: string
  accessPointId: number
  direction: Direction | string
  buildingId: number
}

interface Props {
  buildingId: number
}

export function IntegratorLprLinkageCard({ buildingId }: Props) {
  const [cameras, setCameras] = useState<LprCameraRow[]>([])
  const [accessPoints, setAccessPoints] = useState<AccessPointLite[]>([])
  const [links, setLinks] = useState<LprApLink[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [savingLinkId, setSavingLinkId] = useState<number | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([
      integratorApi.get<{ mirrorDevices: MirrorDeviceLite[] }>(`/integrator/buildings/${buildingId}/devices`),
      integratorApi.get<AccessPointLite[]>(`/integrator/buildings/${buildingId}/access-points`),
      integratorApi.get<LprApLink[]>(`/integrator/buildings/${buildingId}/lpr-camera-ap-links`),
    ])
      .then(([devRes, apsRes, linksRes]) => {
        const cams = (devRes.data.mirrorDevices ?? [])
          .filter((m) => m.type === 'LPR_CAMERA')
          .map<LprCameraRow>((m) => {
            const cfg = m.config ?? {}
            return {
              deviceUuid: m.deviceUuid,
              displayLabel: m.displayLabel ?? (cfg.name as string | undefined) ?? null,
              ipAddress: (cfg.ipAddress as string | undefined) ?? null,
              manufacturer: (cfg.manufacturer as string | undefined) ?? null,
              model: (cfg.model as string | undefined) ?? null,
            }
          })
        setCameras(cams)
        setAccessPoints(apsRes.data)
        setLinks(linksRes.data ?? [])
      })
      .catch((err: unknown) => {
        const e2 = err as { response?: { data?: { message?: string } } }
        setError(e2.response?.data?.message ?? 'Blad ladowania danych')
      })
      .finally(() => setLoading(false))
  }, [buildingId])

  useEffect(() => { load() }, [load])

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3500)
  }

  const linksForCamera = (deviceUuid: string) =>
    links.filter((l) => l.cameraDeviceUuid === deviceUuid)

  const addLink = async (deviceUuid: string, apId: number) => {
    try {
      const res = await integratorApi.post<LprApLink>(
        `/integrator/buildings/${buildingId}/access-points/${apId}/cameras`,
        { cameraDeviceUuid: deviceUuid, direction: 'IN' },
      )
      setLinks((prev) => [...prev, res.data])
      showToast('Powiazanie dodane')
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } }
      showToast(`Blad: ${e2.response?.data?.message ?? 'nieznany'}`)
    }
  }

  const removeLink = async (link: LprApLink) => {
    setSavingLinkId(link.id)
    try {
      await integratorApi.delete(
        `/integrator/buildings/${buildingId}/access-points/${link.accessPointId}/cameras/${link.id}`,
      )
      setLinks((prev) => prev.filter((l) => l.id !== link.id))
      showToast('Powiazanie usuniete')
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } }
      showToast(`Blad: ${e2.response?.data?.message ?? 'nieznany'}`)
    } finally {
      setSavingLinkId(null)
    }
  }

  const updateDirection = async (link: LprApLink, direction: Direction) => {
    setSavingLinkId(link.id)
    try {
      const res = await integratorApi.patch<LprApLink>(
        `/integrator/buildings/${buildingId}/access-points/${link.accessPointId}/cameras/${link.id}`,
        { direction },
      )
      setLinks((prev) => prev.map((l) => (l.id === link.id ? res.data : l)))
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } }
      showToast(`Blad: ${e2.response?.data?.message ?? 'nieznany'}`)
    } finally {
      setSavingLinkId(null)
    }
  }

  return (
    <section
      style={{
        marginTop: 24,
        background: '#fff',
        border: '1px solid #e5e7eb',
        borderRadius: 12,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '14px 18px',
          borderBottom: '1px solid #f3f4f6',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: '#111827', margin: 0 }}>
            Powiazanie LPR -&gt; punkt dostepu (multi-link)
          </h2>
          <p style={{ fontSize: 12, color: '#6b7280', margin: '4px 0 0 0', lineHeight: 1.4 }}>
            Kazda kamera moze otwierac N punktow z direction IN/OUT. Edge przy LPR_MATCH
            fire-uje wszystkie powiazane AP. Brak powiazania = fallback do legacy configu.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          style={{
            fontSize: 12,
            padding: '6px 12px',
            border: '1px solid #e5e7eb',
            borderRadius: 6,
            background: '#fff',
            color: '#374151',
            cursor: loading ? 'wait' : 'pointer',
          }}
        >
          Odswiez
        </button>
      </div>

      {error && (
        <div style={{ padding: 12, background: '#fef2f2', color: '#b91c1c', fontSize: 13 }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 28, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
          Ladowanie…
        </div>
      ) : cameras.length === 0 ? (
        <div style={{ padding: 28, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
          Brak kamer LPR w mirrorze. Dodaj przez Edge wizard.
        </div>
      ) : (
        <div style={{ padding: 16, display: 'grid', gap: 14 }}>
          {cameras.map((cam) => (
            <CameraCard
              key={cam.deviceUuid}
              cam={cam}
              accessPoints={accessPoints}
              links={linksForCamera(cam.deviceUuid)}
              savingLinkId={savingLinkId}
              onAddLink={(apId) => addLink(cam.deviceUuid, apId)}
              onRemoveLink={removeLink}
              onUpdateDirection={updateDirection}
            />
          ))}
        </div>
      )}

      {toast && (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            background: '#111827',
            color: '#fff',
            fontSize: 13,
            padding: '8px 16px',
            borderRadius: 8,
            zIndex: 90,
            boxShadow: '0 10px 25px rgba(0,0,0,0.25)',
          }}
        >
          {toast}
        </div>
      )}
    </section>
  )
}

function CameraCard({
  cam,
  accessPoints,
  links,
  savingLinkId,
  onAddLink,
  onRemoveLink,
  onUpdateDirection,
}: {
  cam: LprCameraRow
  accessPoints: AccessPointLite[]
  links: LprApLink[]
  savingLinkId: number | null
  onAddLink: (apId: number) => void
  onRemoveLink: (link: LprApLink) => void
  onUpdateDirection: (link: LprApLink, direction: Direction) => void
}) {
  const [adding, setAdding] = useState(false)
  const [newApId, setNewApId] = useState<number | ''>('')

  const linkedApIds = new Set(links.map((l) => l.accessPointId))
  const availableAps = accessPoints.filter((ap) => !linkedApIds.has(ap.id))

  const handleAdd = () => {
    if (typeof newApId !== 'number') return
    onAddLink(newApId)
    setAdding(false)
    setNewApId('')
  }

  return (
    <div
      style={{
        border: '1px solid #e5e7eb',
        borderRadius: 10,
        padding: 14,
        background: '#fff',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>
            {cam.displayLabel ?? <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>(bez etykiety)</span>}
          </div>
          <div style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace', marginTop: 2 }}>
            {cam.deviceUuid.slice(0, 16)}…
          </div>
          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
            {[cam.ipAddress, cam.manufacturer, cam.model].filter(Boolean).join(' · ') || '—'}
          </div>
        </div>
        <span
          style={{
            fontSize: 10,
            padding: '2px 6px',
            borderRadius: 4,
            background: links.length > 0 ? '#ecfdf5' : '#fef3c7',
            color: links.length > 0 ? '#065f46' : '#92400e',
            border: links.length > 0 ? '1px solid #a7f3d0' : '1px solid #fcd34d',
            whiteSpace: 'nowrap',
          }}
        >
          {links.length} powiazan
        </span>
      </div>

      {links.length > 0 && (
        <div
          style={{
            marginTop: 12,
            display: 'grid',
            gap: 6,
            background: '#f9fafb',
            border: '1px solid #f3f4f6',
            borderRadius: 8,
            padding: 8,
          }}
        >
          {links.map((link) => {
            const ap = accessPoints.find((a) => a.id === link.accessPointId)
            const isSaving = savingLinkId === link.id
            return (
              <div
                key={link.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 12,
                  padding: '4px 8px',
                  background: '#fff',
                  borderRadius: 6,
                  border: '1px solid #e5e7eb',
                }}
              >
                <span style={{ flex: 1, fontWeight: 500, color: '#111827' }}>
                  {ap?.label ?? `AP #${link.accessPointId} (?)`}
                </span>
                <select
                  value={link.direction}
                  onChange={(e) => onUpdateDirection(link, e.target.value as Direction)}
                  disabled={isSaving}
                  style={{
                    fontSize: 11,
                    padding: '3px 6px',
                    border: '1px solid #d1d5db',
                    borderRadius: 4,
                    background: '#fff',
                    color: '#111827',
                  }}
                >
                  <option value="IN">IN (wjazd)</option>
                  <option value="OUT">OUT (wyjazd)</option>
                </select>
                <button
                  type="button"
                  onClick={() => onRemoveLink(link)}
                  disabled={isSaving}
                  style={{
                    fontSize: 11,
                    padding: '3px 8px',
                    border: '1px solid #fca5a5',
                    borderRadius: 4,
                    background: '#fff',
                    color: '#b91c1c',
                    cursor: isSaving ? 'wait' : 'pointer',
                  }}
                >
                  Usun
                </button>
              </div>
            )
          })}
        </div>
      )}

      <div style={{ marginTop: 10 }}>
        {adding ? (
          <div style={{ display: 'flex', gap: 6 }}>
            <select
              value={newApId === '' ? '' : String(newApId)}
              onChange={(e) => setNewApId(e.target.value === '' ? '' : parseInt(e.target.value, 10))}
              style={{
                flex: 1,
                fontSize: 12,
                padding: '6px 10px',
                border: '1px solid #d1d5db',
                borderRadius: 6,
                background: '#fff',
                color: '#111827',
              }}
            >
              <option value="">— Wybierz punkt dostepu —</option>
              {availableAps.map((ap) => (
                <option key={ap.id} value={ap.id}>
                  {ap.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleAdd}
              disabled={typeof newApId !== 'number'}
              style={{
                fontSize: 12,
                padding: '6px 14px',
                border: '1px solid #1d4ed8',
                borderRadius: 6,
                background: typeof newApId !== 'number' ? '#93c5fd' : '#2563eb',
                color: '#fff',
                cursor: typeof newApId !== 'number' ? 'not-allowed' : 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              Dodaj
            </button>
            <button
              type="button"
              onClick={() => { setAdding(false); setNewApId('') }}
              style={{
                fontSize: 12,
                padding: '6px 10px',
                border: '1px solid #d1d5db',
                borderRadius: 6,
                background: '#fff',
                color: '#374151',
                cursor: 'pointer',
              }}
            >
              Anuluj
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            disabled={availableAps.length === 0}
            style={{
              fontSize: 12,
              padding: '6px 12px',
              border: '1px dashed #d1d5db',
              borderRadius: 6,
              background: '#fff',
              color: availableAps.length === 0 ? '#9ca3af' : '#374151',
              cursor: availableAps.length === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            {availableAps.length === 0 ? 'Brak wolnych AP' : '+ Dodaj powiazanie'}
          </button>
        )}
      </div>
    </div>
  )
}
