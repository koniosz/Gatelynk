'use client'
/**
 * DeviceTreeSection — „Sieć LAN — Urządzenia Edge" (handoff §5).
 *
 * Wykrywanie urządzeń przez Edge `/devices/tree` (relayed przez Cloud).
 * Renderuje grupy (INTERCOM, CAMERA, LPR_CAMERA, SWITCH, LAN_SWITCH, KNX_BRIDGE…)
 * jako collapsible sections. Każdy device-row pozwala:
 *   - Przypisać do modułu (Domofon/LPR) gdy nie ma assignment-u
 *   - Pokazać badge z nazwą record-u gdy już przypisany
 *   - Restart (dla restartable types)
 *   - Otworzyć panel kamery (http://IP)
 *   - Expand → relay panel + snapshot preview
 *
 * Refactor monolitu (linie 798-1110) — zachowuje całą logikę, zmienia tylko
 * styling (tokeny + Lucide).
 */
import { useCallback, useEffect, useState } from 'react'
import { Network, RefreshCw, Plus, Bell, Car, Camera, AlertCircle, Check, Unlock, X, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { integratorApi } from '@/lib/integrator-api'
import { Spinner } from './shared/Spinner'
import { SnapshotViewer } from './shared/SnapshotViewer'
import type { DeviceTreeGroup, DeviceTreeNode, Intercom, LprCamera, ActionState } from './types'

const CAMERA_TYPES = new Set(['INTERCOM', 'LPR_CAMERA', 'CAMERA'])
const RESTARTABLE_TYPES = new Set(['INTERCOM', 'CAMERA', 'LPR_CAMERA'])

type AssignCategory = 'INTERCOM' | 'LPR_CAMERA'

const CATEGORY_META: Record<AssignCategory, { label: string; icon: LucideIcon }> = {
  INTERCOM:   { label: 'Domofon',    icon: Bell },
  LPR_CAMERA: { label: 'Kamera LPR', icon: Car },
}

// FAZA 8.h (2026-06-03) — rozdzielenie typu kamery:
//   - INTERCOM     → przypisanie do modułu Domofony
//   - LPR_CAMERA   → przypisanie do modułu Kamery LPR (rozpoznawanie tablic)
//   - CAMERA       → zwykła kamera wizyjna; NIE wpinamy do LPR (poprzednio
//                    bug: lądowała w sekcji LPR przez `|| groupType === 'CAMERA'`).
//                    Per-camera rolę i flagę AI Analysis ustawia się w sekcji
//                    "Kamery wizyjne" w panelu Integratora.
function categoriesForGroup(groupType: string): AssignCategory[] {
  if (groupType === 'INTERCOM') return ['INTERCOM']
  if (groupType === 'LPR_CAMERA') return ['LPR_CAMERA']
  return []
}

const GROUP_ICONS: Record<string, LucideIcon> = {
  INTERCOM:   Bell,
  CAMERA:     Camera,
  LPR_CAMERA: Car,
}

interface SectionProps {
  buildingId: string
  intercoms: Intercom[]
  lprCameras: LprCamera[]
  onAssigned: () => void
}

export function DeviceTreeSection({ buildingId, intercoms, lprCameras, onAssigned }: SectionProps) {
  const [tree, setTree] = useState<DeviceTreeGroup[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await integratorApi.get(`/edge/buildings/${buildingId}/device-tree`)
      setTree(r.data)
      setOpenGroups(new Set((r.data as DeviceTreeGroup[]).map((g) => g.type)))
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Nie można pobrać drzewa urządzeń'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [buildingId])

  const toggleGroup = (type: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  const totalDevices = tree?.reduce((s, g) => s + g.devices.length, 0) ?? 0
  const totalOnline = tree?.reduce((s, g) => s + g.devices.filter((d) => d.online).length, 0) ?? 0

  return (
    <div className="bg-surface border border-border rounded-r3 mb-5 overflow-hidden">
      <header className="flex items-center justify-between px-5 py-4 border-b border-border">
        <div className="flex items-center gap-2.5">
          <Network size={18} strokeWidth={1.8} className="text-ink-2" />
          <h2 className="text-[14px] font-semibold text-ink">Sieć LAN — Urządzenia Edge</h2>
        </div>
        {tree && (
          <span className="text-[11px] text-muted">
            {totalDevices} urządzeń ·{' '}
            <span className="text-success font-medium">{totalOnline} online</span>
          </span>
        )}
      </header>

      <div className="p-5">
        <div className="flex items-center gap-3 mb-4">
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-r2 bg-brand text-white text-[13px] font-medium hover:bg-brand-600 disabled:opacity-50 transition-colors"
          >
            {loading ? <Spinner size={14} className="text-white" /> : <RefreshCw size={14} />}
            {loading ? 'Ładowanie…' : tree ? 'Odśwież' : 'Pobierz drzewo urządzeń'}
          </button>
        </div>

        {error && (
          <div className="bg-danger-50 border border-danger/30 rounded-r2 px-4 py-3 text-[13px] text-danger flex items-center gap-2 mb-4">
            <AlertCircle size={14} strokeWidth={2} />
            {error}
            <button onClick={load} className="ml-auto underline hover:opacity-80">Spróbuj ponownie</button>
          </div>
        )}

        {tree && tree.length === 0 && (
          <div className="text-center py-8 text-muted">
            <Network size={32} strokeWidth={1.5} className="mx-auto mb-3 text-muted-2" />
            <p className="text-[13px] font-medium">Brak urządzeń w Edge</p>
            <p className="text-[11px] text-muted-2 mt-1">Dodaj urządzenia w panelu GateLynk Edge UI</p>
          </div>
        )}

        {tree && tree.map((group) => {
          const isOpen = openGroups.has(group.type)
          const onlineCount = group.devices.filter((d) => d.online).length
          const GroupIcon = GROUP_ICONS[group.type] ?? Network
          return (
            <div key={group.type} className="mb-3 last:mb-0 border border-border rounded-r2 overflow-hidden">
              <button
                onClick={() => toggleGroup(group.type)}
                className="w-full flex items-center justify-between px-4 py-3 bg-surface-2 hover:bg-bg-2 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <GroupIcon size={14} strokeWidth={1.8} className="text-ink-2" />
                  <span className="text-[13px] font-semibold text-ink">{group.label}</span>
                  <span className="text-[11px] text-muted">({group.devices.length})</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[11px] text-success font-medium">
                    {onlineCount} / {group.devices.length} online
                  </span>
                  {isOpen ? <ChevronDown size={14} className="text-muted" /> : <ChevronRight size={14} className="text-muted" />}
                </div>
              </button>
              {isOpen && (
                <div className="divide-y divide-border">
                  {group.devices.map((dev) => (
                    <DeviceTreeRow
                      key={dev.deviceId}
                      dev={dev}
                      groupType={group.type}
                      buildingId={buildingId}
                      intercoms={intercoms}
                      lprCameras={lprCameras}
                      onAssigned={onAssigned}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function DeviceTreeRow({
  dev, groupType, buildingId, intercoms, lprCameras, onAssigned,
}: {
  dev: DeviceTreeNode
  groupType: string
  buildingId: string
  intercoms: Intercom[]
  lprCameras: LprCamera[]
  onAssigned: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [assigning, setAssigning] = useState<AssignCategory | null>(null)
  const [relayStates, setRelayStates] = useState<Record<number, ActionState>>({})
  const [restartState, setRestartState] = useState<ActionState>('idle')

  const assignedIntercom = intercoms.find((ic) => ic.edgeDeviceId === dev.deviceId)
  const assignedCamera   = lprCameras.find((c)  => c.edgeDeviceId === dev.deviceId)
  const assignment = assignedIntercom
    ? { type: 'INTERCOM' as AssignCategory, record: assignedIntercom }
    : assignedCamera
      ? { type: 'LPR_CAMERA' as AssignCategory, record: assignedCamera }
      : null

  const availableCategories = categoriesForGroup(groupType)

  const assignTo = async (category: AssignCategory) => {
    setMenuOpen(false)
    setAssigning(category)
    try {
      const name = dev.name || [dev.manufacturer, dev.model].filter(Boolean).join(' ') || dev.deviceId
      if (category === 'INTERCOM') {
        await integratorApi.post(`/integrator/buildings/${buildingId}/intercoms`, {
          name, model: dev.model ?? null, edgeDeviceId: dev.deviceId,
        })
      } else if (category === 'LPR_CAMERA') {
        await integratorApi.post(`/integrator/buildings/${buildingId}/lpr-cameras`, {
          name,
          manufacturer: dev.manufacturer ?? 'Hikvision',
          model: dev.model ?? null,
          edgeDeviceId: dev.deviceId,
        })
      }
      onAssigned()
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Nie udało się przypisać urządzenia'
      alert(msg)
    } finally {
      setAssigning(null)
    }
  }

  const triggerRestart = async () => {
    setRestartState('loading')
    try {
      await integratorApi.post(`/integrator/buildings/${buildingId}/edge/restart`, {
        deviceId: dev.deviceId,
      })
      setRestartState('ok')
      setTimeout(() => setRestartState('idle'), 3000)
    } catch {
      setRestartState('err')
      setTimeout(() => setRestartState('idle'), 3000)
    }
  }

  const triggerRelay = async (relayIndex: number) => {
    setRelayStates((s) => ({ ...s, [relayIndex]: 'loading' }))
    try {
      await integratorApi.post(`/integrator/buildings/${buildingId}/edge/relay`, {
        deviceId: dev.deviceId, relayIndex,
      })
      setRelayStates((s) => ({ ...s, [relayIndex]: 'ok' }))
      setTimeout(() => setRelayStates((s) => ({ ...s, [relayIndex]: 'idle' })), 2500)
    } catch {
      setRelayStates((s) => ({ ...s, [relayIndex]: 'err' }))
      setTimeout(() => setRelayStates((s) => ({ ...s, [relayIndex]: 'idle' })), 2500)
    }
  }

  const hasRelays = Array.isArray(dev.relays) && dev.relays.length > 0
  const hasVideo = CAMERA_TYPES.has(groupType) && dev.ipAddress
  const canExpand = hasRelays || hasVideo

  return (
    <div className="px-4 py-3 bg-surface">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dev.online ? 'bg-success' : 'bg-muted-2'}`} />
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-ink truncate">{dev.name}</p>
            <p className="text-[11px] text-muted truncate" style={{ fontFamily: 'var(--font-plex-mono, monospace)' }}>
              {dev.ipAddress ?? 'Brak IP'}
              {dev.manufacturer ? ` · ${dev.manufacturer}` : ''}
              {dev.model ? ` ${dev.model}` : ''}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {assignment ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-r1 bg-success-50 text-success border border-success/30 font-medium">
              <Check size={11} strokeWidth={2.5} />
              {CATEGORY_META[assignment.type].label} «{assignment.record.name}»
            </span>
          ) : availableCategories.length > 0 ? (
            <div className="relative">
              <button
                onClick={() => setMenuOpen((o) => !o)}
                disabled={assigning !== null}
                className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-r1 border border-brand/30 bg-brand-50 text-brand hover:bg-brand-50/80 font-medium transition-colors"
              >
                {assigning ? <Spinner size={11} /> : <Plus size={11} strokeWidth={2.5} />}
                Dodaj
              </button>
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                  <div className="absolute right-0 top-full mt-1 bg-surface border border-border rounded-r2 shadow-lg py-1 z-20 min-w-[180px]">
                    {availableCategories.map((cat) => {
                      const CatIcon = CATEGORY_META[cat].icon
                      return (
                        <button
                          key={cat}
                          onClick={() => assignTo(cat)}
                          className="w-full text-left px-3 py-2 text-[13px] hover:bg-surface-2 flex items-center gap-2 text-ink"
                        >
                          <CatIcon size={13} strokeWidth={1.8} className="text-muted" />
                          {CATEGORY_META[cat].label}
                        </button>
                      )
                    })}
                    <div className="border-t border-border my-1" />
                    <div className="px-3 py-2 text-[11px] text-muted-2">
                      Monitoring CCTV — wkrótce
                    </div>
                  </div>
                </>
              )}
            </div>
          ) : (
            <span className="text-[11px] text-muted-2 italic px-2">brak kategorii</span>
          )}

          {RESTARTABLE_TYPES.has(groupType) && (
            <button
              onClick={triggerRestart}
              disabled={restartState === 'loading'}
              title="Zrestartuj urządzenie"
              className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-r1 border transition-colors ${
                restartState === 'ok'  ? 'bg-success-50 border-success text-success'
                : restartState === 'err' ? 'bg-danger-50 border-danger text-danger'
                : 'border-warn/40 text-warn hover:bg-warn-50'
              }`}
            >
              {restartState === 'loading' ? <Spinner size={10} />
                : restartState === 'ok' ? <Check size={10} strokeWidth={2.5} />
                : restartState === 'err' ? <X size={10} strokeWidth={2.5} />
                : <RefreshCw size={10} strokeWidth={2.5} />}
              {restartState === 'ok' ? 'OK' : restartState === 'err' ? 'Błąd' : 'Restart'}
            </button>
          )}

          {dev.ipAddress && (
            <a
              href={`http://${dev.ipAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-brand hover:text-brand-600 border border-brand/30 px-2 py-1 rounded-r1 transition-colors"
            >
              UI
              <ExternalLink size={9} strokeWidth={2.5} />
            </a>
          )}

          {canExpand && (
            <button
              onClick={() => setExpanded((e) => !e)}
              className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-ink border border-border px-2 py-1 rounded-r1 transition-colors"
            >
              {expanded ? <><ChevronDown size={10} /> Zwiń</> : <><ChevronRight size={10} /> Szczegóły</>}
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="mt-3 space-y-3 pl-5">
          {hasRelays && dev.relays && (
            <div>
              <p className="text-[10px] text-muted-2 font-semibold uppercase tracking-wider mb-2">
                Elektrozaczepy
              </p>
              <div className="flex flex-wrap gap-2">
                {dev.relays.map((r) => {
                  const st: ActionState = relayStates[r.index] ?? 'idle'
                  const palette =
                    st === 'ok'  ? 'bg-success-50 border-success text-success'
                    : st === 'err' ? 'bg-danger-50 border-danger text-danger'
                    : 'bg-warn-50 border-warn/50 text-warn hover:bg-warn-50/80'
                  return (
                    <button
                      key={r.index}
                      onClick={() => triggerRelay(r.index)}
                      disabled={st === 'loading'}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-r2 text-[12px] font-medium border transition-colors ${palette}`}
                    >
                      {st === 'loading' ? <Spinner size={12} />
                        : st === 'ok' ? <Check size={12} strokeWidth={2.5} />
                        : st === 'err' ? <X size={12} strokeWidth={2.5} />
                        : <Unlock size={12} strokeWidth={2} />}
                      {st === 'ok' ? 'Otwarto!' : st === 'err' ? 'Błąd' : r.name}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {hasVideo && (
            <div>
              <p className="text-[10px] text-muted-2 font-semibold uppercase tracking-wider mb-2">
                Podgląd video
              </p>
              <SnapshotViewer
                buildingId={buildingId}
                deviceId={dev.deviceId}
                label={`${dev.name} · ${dev.ipAddress}`}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
