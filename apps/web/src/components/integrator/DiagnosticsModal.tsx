'use client'
/**
 * DiagnosticsModal (Sesja 5) — uruchom test-matrix per device w wybranym obiekcie.
 *
 * Flow:
 *   1. User wybiera obiekt z dropdown
 *   2. Backend Cloud → Edge GET /devices/tree (już istnieje przez `/edge/buildings/:id/device-tree`)
 *   3. Pokazuje listę urządzeń, każdy z przyciskiem „Test"
 *   4. Klik → POST /integrator/buildings/:id/devices/:deviceId/test-matrix (nowy endpoint Sesja 5)
 *   5. Wynik (TestMatrix) → kolorowa siatka capabilities z latency
 *
 * Backend audit-loguje DIAGNOSTICS_RUN per test.
 */
import { useEffect, useState } from 'react'
import {
  X, Stethoscope, Play, CheckCircle2, XCircle, AlertTriangle, Server,
} from 'lucide-react'
import { integratorApi } from '@/lib/integrator-api'
import { Spinner } from '@/components/integrator/property/shared/Spinner'

interface DeviceTreeNode {
  deviceId: string
  name: string
  ipAddress?: string | null
  manufacturer?: string
  model?: string
  online?: boolean
}

interface DeviceTreeGroup {
  type: string
  label: string
  icon: string
  devices: DeviceTreeNode[]
}

interface TestMatrixEntry {
  supported: boolean
  tested: boolean
  ok?: boolean
  detail?: string
  hint?: string
  error?: string
  latencyMs?: number
}

interface TestMatrix {
  deviceId: string
  online: boolean
  startedAt: number
  finishedAt: number
  capabilities: Record<string, TestMatrixEntry>
}

interface Props {
  open: boolean
  onClose: () => void
  buildings: Array<{ id: number; name: string; address: string }>
}

export function DiagnosticsModal({ open, onClose, buildings }: Props) {
  const [buildingId, setBuildingId] = useState<number | null>(null)
  const [tree, setTree] = useState<DeviceTreeGroup[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, TestMatrix>>({})
  const [runningKey, setRunningKey] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setTree(null); setResults({}); setError(null); setRunningKey(null)
    }
  }, [open])

  useEffect(() => {
    if (open && !buildingId && buildings.length > 0) setBuildingId(buildings[0].id)
  }, [open, buildings, buildingId])

  // Pobierz drzewo urządzeń gdy zmienia się obiekt
  useEffect(() => {
    if (!buildingId || !open) return
    setLoading(true)
    setError(null)
    setTree(null)
    integratorApi.get<DeviceTreeGroup[]>(`/edge/buildings/${buildingId}/device-tree`)
      .then((r) => setTree(r.data))
      .catch((err) => {
        const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
          ?? 'Brak odpowiedzi z Edge — sprawdź czy Edge jest online'
        setError(msg)
      })
      .finally(() => setLoading(false))
  }, [buildingId, open])

  const runTest = async (deviceId: string) => {
    if (!buildingId) return
    setRunningKey(deviceId)
    try {
      const r = await integratorApi.post<TestMatrix>(
        `/integrator/buildings/${buildingId}/devices/${deviceId}/test-matrix`,
      )
      setResults((prev) => ({ ...prev, [deviceId]: r.data }))
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Błąd testu'
      alert(msg)
    } finally {
      setRunningKey(null)
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
        <header className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <Stethoscope size={18} strokeWidth={1.8} className="text-warn" />
            <h2 className="text-[14px] font-semibold text-ink">Diagnostyka urządzeń</h2>
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-ink p-1 rounded-r1 hover:bg-surface-2"
          >
            <X size={16} />
          </button>
        </header>

        <div className="p-5 overflow-y-auto">
          {/* Wybór obiektu */}
          <div className="mb-5">
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-2 mb-2">
              Obiekt
            </label>
            <select
              value={buildingId ?? ''}
              onChange={(e) => setBuildingId(parseInt(e.target.value, 10))}
              disabled={loading || !!runningKey}
              className="w-full bg-surface border border-border rounded-r2 px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-brand"
            >
              <option value="" disabled>— wybierz obiekt —</option>
              {buildings.map((b) => (
                <option key={b.id} value={b.id}>{b.name} — {b.address}</option>
              ))}
            </select>
          </div>

          {loading && (
            <div className="flex items-center gap-2 py-6 text-muted text-[13px]">
              <Spinner size={14} /> Pobieranie urządzeń z Edge…
            </div>
          )}

          {error && (
            <div className="bg-danger-50 border border-danger/30 rounded-r2 p-3 flex items-center gap-2 text-[13px] text-danger">
              <AlertTriangle size={14} />
              {error}
            </div>
          )}

          {tree && tree.length === 0 && (
            <div className="text-center py-8 text-muted">
              <Server size={28} strokeWidth={1.5} className="mx-auto mb-2 text-muted-2" />
              <p className="text-[13px]">Edge nie ma żadnych skonfigurowanych urządzeń</p>
            </div>
          )}

          {tree && tree.map((group) => (
            <div key={group.type} className="mb-4">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-2 mb-2">
                {group.label}
              </h3>
              <div className="space-y-2">
                {group.devices.map((dev) => (
                  <DeviceRow
                    key={dev.deviceId}
                    dev={dev}
                    result={results[dev.deviceId]}
                    running={runningKey === dev.deviceId}
                    onRunTest={() => runTest(dev.deviceId)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function DeviceRow({ dev, result, running, onRunTest }: {
  dev: DeviceTreeNode
  result?: TestMatrix
  running: boolean
  onRunTest: () => void
}) {
  return (
    <div className="bg-surface border border-border rounded-r2 p-3">
      <div className="flex items-center gap-3">
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${dev.online ? 'bg-success' : 'bg-muted-2'}`}
        />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-ink">{dev.name}</div>
          <div
            className="text-[11px] text-muted"
            style={{ fontFamily: 'var(--font-plex-mono, monospace)' }}
          >
            {dev.ipAddress ?? 'Brak IP'}
            {dev.manufacturer ? ` · ${dev.manufacturer}` : ''}
            {dev.model ? ` ${dev.model}` : ''}
          </div>
        </div>
        <button
          onClick={onRunTest}
          disabled={running}
          className="inline-flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-r2 bg-warn-50 text-warn border border-warn/40 hover:bg-warn-50/80 disabled:opacity-50 transition-colors"
        >
          {running ? <Spinner size={12} /> : <Play size={12} strokeWidth={2} />}
          {running ? 'Testowanie…' : result ? 'Powtórz' : 'Test'}
        </button>
      </div>

      {result && (
        <div className="mt-3 pt-3 border-t border-border space-y-1">
          {Object.entries(result.capabilities)
            .filter(([, v]) => v.supported)
            .map(([key, v]) => (
              <CapabilityRow key={key} name={key} entry={v} />
            ))}
        </div>
      )}
    </div>
  )
}

const CAPABILITY_LABELS: Record<string, string> = {
  network:     'Sieć (TCP)',
  auth:        'Uwierzytelnienie',
  ping:        'HTTP ping',
  snapshot:    'Snapshot',
  restart:     'Restart',
  openDoor:    'Otwórz przekaźnik',
  toggle:      'Włącz/wyłącz',
  rtsp:        'RTSP',
  mjpeg:       'MJPEG live',
  lprPushList: 'LPR — sync listy',
  lprEvents:   'LPR — eventy ANPR',
}

function CapabilityRow({ name, entry }: { name: string; entry: TestMatrixEntry }) {
  const status: 'ok' | 'fail' | 'pending' =
    entry.tested && entry.ok ? 'ok'
    : entry.tested && entry.ok === false ? 'fail'
    : 'pending'

  const Icon = status === 'ok' ? CheckCircle2 : status === 'fail' ? XCircle : AlertTriangle
  const color = status === 'ok' ? 'text-success' : status === 'fail' ? 'text-danger' : 'text-warn'

  const detail = entry.tested && entry.ok
    ? `${entry.detail ?? ''}${entry.latencyMs ? ` (${entry.latencyMs} ms)` : ''}`
    : entry.error ?? entry.hint ?? '—'

  return (
    <div className="flex items-center gap-3 py-1 text-[12px]">
      <Icon size={13} strokeWidth={2} className={`${color} flex-shrink-0`} />
      <div className="font-medium text-ink-2 w-48 flex-shrink-0">
        {CAPABILITY_LABELS[name] ?? name}
      </div>
      <div className="text-muted text-[11px] flex-1 min-w-0 truncate">{detail}</div>
    </div>
  )
}
