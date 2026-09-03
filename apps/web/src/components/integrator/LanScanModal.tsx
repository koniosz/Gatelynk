'use client'
/**
 * LanScanModal — wykrywanie urządzeń w sieci LAN klienta (Sesja 4).
 *
 * Flow:
 *   1. User wybiera obiekt z dropdown-a
 *   2. Klik „Skanuj" → POST /integrator/buildings/:id/lan-scan
 *   3. Polling GET /integrator/buildings/:id/lan-scan/:runId co 1.5s
 *   4. Progress bar 0→100% (linear vs 15s timeout)
 *   5. Po zakończeniu: grid found candidates
 *      - matched (heurystyka driver z Edge): zielony border
 *      - unmatched: gray border
 *   6. Each candidate ma akcję „Przypisz" → POST /intercoms lub /lpr-cameras
 *      (już istniejące endpointy — Sesja 2 wzorzec)
 *
 * Edge nie potrzebuje zmiany — proxy POST/GET /devices/discover już istnieje.
 */
import { useEffect, useState } from 'react'
import {
  X, Search, RotateCw, CheckCircle2, AlertTriangle, Plus, Bell, Car,
  Building2 as BuildingIcon, Network, RefreshCw,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { integratorApi } from '@/lib/integrator-api'
import { Spinner } from '@/components/integrator/property/shared/Spinner'

interface DiscoveryCandidate {
  ip: string
  port?: number
  hostname?: string
  mac?: string
  vendor?: string
  model?: string
  friendlyName?: string
  suggestedType?: 'INTERCOM' | 'CAMERA' | 'LPR_CAMERA' | string
  suggestedDriverId?: string | null
  foundVia: 'mdns' | 'knxnet-ip' | string
}

interface DiscoveryRun {
  id: string
  status: 'running' | 'done' | 'error'
  candidates: DiscoveryCandidate[]
  startedAt: number
  finishedAt?: number
  timeoutMs: number
  error?: string
}

interface BuildingOption {
  id: number
  name: string
  address: string
}

interface Props {
  open: boolean
  onClose: () => void
  buildings: BuildingOption[]
  /** Pre-selected building (when triggered from PropertyPage). */
  initialBuildingId?: number
}

export function LanScanModal({ open, onClose, buildings, initialBuildingId }: Props) {
  const [buildingId, setBuildingId] = useState<number | null>(initialBuildingId ?? null)
  const [scanning, setScanning] = useState(false)
  const [run, setRun] = useState<DiscoveryRun | null>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [assigningKey, setAssigningKey] = useState<string | null>(null)

  // Reset state gdy modal się otwiera/zamyka
  useEffect(() => {
    if (!open) {
      setRun(null)
      setProgress(0)
      setError(null)
      setScanning(false)
    }
  }, [open])

  // Auto-select pierwszy obiekt jak nie ma initial
  useEffect(() => {
    if (open && !buildingId && buildings.length > 0) {
      setBuildingId(initialBuildingId ?? buildings[0].id)
    }
  }, [open, buildings, buildingId, initialBuildingId])

  const startScan = async () => {
    if (!buildingId) return
    setScanning(true)
    setError(null)
    setRun(null)
    setProgress(0)

    let progressTimer: ReturnType<typeof setInterval> | null = null
    try {
      const startRes = await integratorApi.post<{ runId: string }>(
        `/integrator/buildings/${buildingId}/lan-scan`,
        { protocols: ['mdns', 'knxnet-ip'], timeoutMs: 15000 },
      )
      const { runId } = startRes.data
      const startedAt = Date.now()
      progressTimer = setInterval(() => {
        setProgress(Math.min(98, Math.round((Date.now() - startedAt) / 15000 * 100)))
      }, 300)

      // Polling — max 20 prób co 1s
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        const r = await integratorApi.get<DiscoveryRun>(
          `/integrator/buildings/${buildingId}/lan-scan/${runId}`,
        )
        setRun(r.data)
        if (r.data.status === 'done' || r.data.status === 'error') break
      }
      setProgress(100)
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
        ?? 'Błąd skanu — Edge może być offline'
      setError(msg)
    } finally {
      if (progressTimer) clearInterval(progressTimer)
      setScanning(false)
    }
  }

  const assignCandidate = async (
    c: DiscoveryCandidate,
    category: 'INTERCOM' | 'LPR_CAMERA',
  ) => {
    if (!buildingId) return
    const key = `${c.ip}-${category}`
    setAssigningKey(key)
    try {
      const name = c.friendlyName || c.hostname || c.ip
      if (category === 'INTERCOM') {
        await integratorApi.post(`/integrator/buildings/${buildingId}/intercoms`, {
          name,
          model: c.model ?? null,
        })
      } else {
        await integratorApi.post(`/integrator/buildings/${buildingId}/lpr-cameras`, {
          name,
          manufacturer: c.vendor ?? 'Hikvision',
          model: c.model ?? null,
        })
      }
      alert(`Dodano „${name}" jako ${category === 'INTERCOM' ? 'domofon' : 'kamerę LPR'} w obiekcie. Skonfiguruj IP/login w detal obiektu.`)
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Nie udało się przypisać'
      alert(msg)
    } finally {
      setAssigningKey(null)
    }
  }

  if (!open) return null

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-ink/40 backdrop-blur-sm flex items-center justify-center p-6"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-surface border border-border rounded-r3 w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden"
      >
        {/* Header */}
        <header className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <Network size={18} strokeWidth={1.8} className="text-brand" />
            <h2 className="text-[14px] font-semibold text-ink">Skaner LAN</h2>
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-ink p-1 rounded-r1 hover:bg-surface-2"
          >
            <X size={16} />
          </button>
        </header>

        <div className="p-5 overflow-y-auto">
          {/* Step 1 — wybór obiektu */}
          <div className="mb-5">
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-2 mb-2">
              1. Obiekt do przeskanowania
            </label>
            <div className="flex gap-2">
              <select
                value={buildingId ?? ''}
                onChange={(e) => setBuildingId(parseInt(e.target.value, 10))}
                disabled={scanning}
                className="flex-1 bg-surface border border-border rounded-r2 px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-brand"
              >
                <option value="" disabled>— wybierz obiekt —</option>
                {buildings.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} — {b.address}
                  </option>
                ))}
              </select>
              <button
                onClick={startScan}
                disabled={!buildingId || scanning}
                className="inline-flex items-center gap-2 bg-brand text-white text-[13px] font-medium px-4 py-2 rounded-r2 hover:bg-brand-600 disabled:opacity-50 transition-colors"
              >
                {scanning ? <Spinner size={14} className="text-white" /> : <Search size={14} />}
                {scanning ? 'Skanowanie…' : run ? 'Skanuj ponownie' : 'Skanuj'}
              </button>
            </div>
            <p className="text-[11px] text-muted-2 mt-2">
              Edge wywoła mDNS browse + KNXnet/IP SEARCH przez 15 s. Znalezione urządzenia pojawią się poniżej.
            </p>
          </div>

          {/* Progress */}
          {scanning && (
            <div className="mb-5">
              <div className="flex items-center justify-between text-[11px] text-muted mb-1">
                <span>Postęp skanu</span>
                <span>{progress}%</span>
              </div>
              <div className="h-1.5 bg-surface-2 rounded-r1 overflow-hidden">
                <div
                  className="h-full bg-brand transition-all duration-200"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="mb-5 bg-danger-50 border border-danger/30 rounded-r2 p-3 flex items-center gap-2 text-[13px] text-danger">
              <AlertTriangle size={14} />
              {error}
            </div>
          )}

          {/* Results */}
          {run && (
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-2 mb-2 flex items-center gap-2">
                2. Znalezione urządzenia
                <span className="text-muted normal-case font-normal">
                  ({run.candidates.length} ·{' '}
                  <span className="text-success">
                    {run.candidates.filter((c) => c.suggestedDriverId).length} dopasowanych
                  </span>)
                </span>
              </label>
              {run.candidates.length === 0 ? (
                <div className="text-center py-8 text-muted">
                  <Network size={28} strokeWidth={1.5} className="mx-auto mb-2 text-muted-2" />
                  <p className="text-[13px]">Nic nie znaleziono — sprawdź czy urządzenia są w tej samej sieci LAN co Edge</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {run.candidates.map((c) => (
                    <CandidateRow
                      key={`${c.ip}-${c.mac ?? c.foundVia}`}
                      candidate={c}
                      assigningKey={assigningKey}
                      onAssign={assignCandidate}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Empty state (przed pierwszym scan-em) */}
          {!run && !scanning && !error && (
            <div className="text-center py-12 text-muted">
              <Search size={36} strokeWidth={1.5} className="mx-auto mb-3 text-muted-2" />
              <p className="text-[13px] font-medium text-ink-2">Wybierz obiekt i kliknij Skanuj</p>
              <p className="text-[11px] mt-1">
                Discovery wykorzystuje mDNS (_shelly._tcp, _http._tcp) + KNXnet/IP SEARCH
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function CandidateRow({
  candidate: c, assigningKey, onAssign,
}: {
  candidate: DiscoveryCandidate
  assigningKey: string | null
  onAssign: (c: DiscoveryCandidate, cat: 'INTERCOM' | 'LPR_CAMERA') => void
}) {
  const matched = !!c.suggestedDriverId
  const ICONS: Record<string, LucideIcon> = {
    INTERCOM:   Bell,
    LPR_CAMERA: Car,
    CAMERA:     Car,
  }
  const TypeIcon = c.suggestedType && ICONS[c.suggestedType] ? ICONS[c.suggestedType] : BuildingIcon

  return (
    <div
      className={`flex items-center gap-3 p-3 bg-surface border rounded-r2 ${
        matched ? 'border-success/40' : 'border-border'
      }`}
    >
      <div className={`w-9 h-9 rounded-r2 flex items-center justify-center flex-shrink-0 ${
        matched ? 'bg-success-50' : 'bg-surface-2'
      }`}>
        {matched ? (
          <CheckCircle2 size={16} className="text-success" strokeWidth={2} />
        ) : (
          <TypeIcon size={16} className="text-muted" strokeWidth={1.8} />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-ink">
          {c.friendlyName || c.hostname || c.ip}
        </div>
        <div
          className="text-[11px] text-muted"
          style={{ fontFamily: 'var(--font-plex-mono, monospace)' }}
        >
          {c.ip}{c.port ? `:${c.port}` : ''}
          {c.mac ? ` · ${c.mac}` : ''}
          {' · '}{c.foundVia}
          {c.suggestedDriverId ? ` · ${c.suggestedDriverId}` : ''}
        </div>
      </div>
      <div className="flex gap-1 flex-shrink-0">
        {c.suggestedType === 'INTERCOM' && (
          <AssignBtn
            label="Domofon"
            icon={Bell}
            loading={assigningKey === `${c.ip}-INTERCOM`}
            onClick={() => onAssign(c, 'INTERCOM')}
          />
        )}
        {(c.suggestedType === 'CAMERA' || c.suggestedType === 'LPR_CAMERA') && (
          <AssignBtn
            label="Kamera LPR"
            icon={Car}
            loading={assigningKey === `${c.ip}-LPR_CAMERA`}
            onClick={() => onAssign(c, 'LPR_CAMERA')}
          />
        )}
        {!c.suggestedType && (
          <span className="text-[11px] text-muted-2 italic px-2">brak kategorii</span>
        )}
      </div>
    </div>
  )
}

function AssignBtn({ label, icon: Icon, loading, onClick }: {
  label: string; icon: LucideIcon; loading: boolean; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-r1 bg-brand-50 text-brand border border-brand/30 hover:bg-brand-50/80 disabled:opacity-50 transition-colors"
    >
      {loading ? <Spinner size={11} /> : <Plus size={11} strokeWidth={2.5} />}
      {label}
    </button>
  )
}
