'use client'
/**
 * Faza 5 — Punkty dostępu (BA).
 *
 * Edge auto-syncuje strukturę co 5 min (`syncAccessPoints` w cloud:edge.service).
 * Admin nie tworzy ani nie usuwa AP — może tylko: zmienić nazwę/ikonę,
 * przełączyć isActive, przeciągnąć kolejność. Patrz komentarz w
 * `BuildingAdminService.updateAccessPoint`.
 *
 * Drag-and-drop natywne HTML5 (bez nowych deps). Lista jest krótka (3-10
 * pozycji), więc nie potrzebujemy `@dnd-kit`.
 */
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { buildingAdminApi } from '@/lib/building-admin-api'
import {
  ACCESS_POINT_ICONS,
  AccessPointIcon,
  ICON_EMOJI,
  ICON_LABEL,
  emojiFor,
} from '@/lib/access-point-icons'

interface AccessPoint {
  id: number
  buildingId: number
  label: string
  icon: string
  edgeDeviceId: string | null
  deviceId: string
  relayIndex: number
  isActive: boolean
  sortOrder: number
  // Refactor 2026-06-01 — binding/scope/duration:
  outputDeviceId?: string | null
  outputIndex?: number | null
  durationMs?: number
  scope?: 'PUBLIC' | 'RESIDENT' | 'ADMIN_ONLY'
}

interface ApSchedule {
  id: number
  accessPointId: number
  cronExpr: string
  label: string | null
  enabled: boolean
  lastFiredAt: string | null
}

interface DeviceListItem {
  // /building-admin/buildings/:id/devices zwraca mix sekcji — tutaj
  // potrzebujemy tylko podzbioru, więc bardzo wolne typowanie.
  deviceUuid?: string
  id?: string | number
  name?: string
  type?: string
  config?: { name?: string; ipAddress?: string }
}

const SCOPE_OPTIONS: Array<{ value: NonNullable<AccessPoint['scope']>; label: string; hint: string }> = [
  { value: 'RESIDENT',   label: 'Mieszkańcy', hint: 'Widoczny w iOS apce dla mieszkańców budynku.' },
  { value: 'PUBLIC',     label: 'Publiczny',  hint: 'Każdy gość z portalu może otworzyć.' },
  { value: 'ADMIN_ONLY', label: 'Tylko admin', hint: 'Ukryty w aplikacji — wystrzeliwany tylko z panelu BA.' },
]

export default function BaAccessPointsPage() {
  const params = useParams<{ id: string }>()
  const buildingId = Number(params.id)
  const [items, setItems] = useState<AccessPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draggingId, setDraggingId] = useState<number | null>(null)
  const [hoverId, setHoverId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    buildingAdminApi
      .get(`/building-admin/buildings/${buildingId}/access-points`)
      .then((r) => setItems(r.data as AccessPoint[]))
      .catch((err) => setError(err?.response?.data?.message ?? 'Błąd ładowania'))
      .finally(() => setLoading(false))
  }, [buildingId])

  useEffect(() => { load() }, [load])

  const persistOrder = async (newOrder: AccessPoint[]) => {
    setSaving(true)
    try {
      await buildingAdminApi.patch(
        `/building-admin/buildings/${buildingId}/access-points/reorder`,
        { ids: newOrder.map((x) => x.id) },
      )
    } catch (err: any) {
      setError(err?.response?.data?.message ?? 'Błąd zapisu kolejności')
      load()
    } finally {
      setSaving(false)
    }
  }

  const onDragStart = (e: React.DragEvent<HTMLElement>, id: number) => {
    setDraggingId(id)
    e.dataTransfer.effectAllowed = 'move'
    // Some browsers wymagają dataTransfer set żeby drag w ogóle wystartował.
    e.dataTransfer.setData('text/plain', String(id))
  }

  const onDragOver = (e: React.DragEvent<HTMLElement>, overId: number) => {
    e.preventDefault()
    if (overId !== hoverId) setHoverId(overId)
  }

  const onDrop = async (e: React.DragEvent<HTMLElement>, targetId: number) => {
    e.preventDefault()
    if (draggingId === null || draggingId === targetId) {
      setDraggingId(null); setHoverId(null)
      return
    }
    const fromIdx = items.findIndex((x) => x.id === draggingId)
    const toIdx = items.findIndex((x) => x.id === targetId)
    if (fromIdx < 0 || toIdx < 0) return
    const next = [...items]
    const [moved] = next.splice(fromIdx, 1)
    next.splice(toIdx, 0, moved)
    setItems(next)
    setDraggingId(null); setHoverId(null)
    await persistOrder(next)
  }

  const onDragEnd = () => { setDraggingId(null); setHoverId(null) }

  return (
    <div className="max-w-3xl">
      <div className="mb-4">
        <Link
          href={`/building-admin/buildings/${buildingId}`}
          className="text-sm text-gray-400 hover:text-gray-600"
        >
          ← Budynek
        </Link>
      </div>

      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">🔌 Punkty dostępu</h1>
          <p className="text-sm text-gray-500 mt-1">
            Edge auto-wykrywa przekaźniki domofonów co 5 minut. Możesz nadać im
            nazwy, ikony i kolejność widoczną dla mieszkańców (przeciągnij
            wiersz, żeby zmienić kolejność). Tworzenie / usuwanie kontroluje Edge.
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="text-sm px-3 py-1.5 rounded-lg bg-white border border-gray-200 hover:bg-gray-50 shrink-0"
        >
          ↻ Odśwież
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2 rounded-lg mb-4">
          {error}
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-400 text-sm">Ładowanie…</div>
        ) : items.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">
            Brak punktów dostępu. Edge nie zsynchronizował jeszcze urządzeń —
            sprawdź zakładkę „Urządzenia" czy Edge jest online.
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {items.map((ap) => {
              const isDragging = draggingId === ap.id
              const isHover = hoverId === ap.id && draggingId !== null && draggingId !== ap.id
              return (
                <li
                  key={ap.id}
                  draggable
                  onDragStart={(e) => onDragStart(e, ap.id)}
                  onDragOver={(e) => onDragOver(e, ap.id)}
                  onDrop={(e) => onDrop(e, ap.id)}
                  onDragEnd={onDragEnd}
                  className={`px-4 py-3 flex items-center gap-3 cursor-grab transition ${
                    isDragging ? 'opacity-40' : ''
                  } ${isHover ? 'bg-blue-50 border-t-2 border-t-blue-400' : ''}`}
                >
                  <span className="text-gray-300 select-none">⋮⋮</span>
                  <span className="text-2xl">{emojiFor(ap.icon)}</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-gray-900 truncate">{ap.label}</div>
                    <div className="text-xs text-gray-400">
                      relay {ap.relayIndex} · {ap.deviceId.slice(0, 12)}…
                      {!ap.isActive && (
                        <span className="ml-2 text-amber-600">• ukryty dla mieszkańców</span>
                      )}
                    </div>
                  </div>
                  {ap.isActive && (
                    <HoldOpenButton
                      buildingId={Number(params.id)}
                      apId={ap.id}
                      label={ap.label}
                    />
                  )}
                  <button
                    onClick={() => setEditingId(ap.id)}
                    className="text-sm text-blue-600 hover:underline shrink-0"
                  >
                    Edytuj
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        {saving && (
          <div className="px-4 py-2 bg-gray-50 border-t border-gray-100 text-xs text-gray-400">
            Zapisywanie kolejności…
          </div>
        )}
      </div>

      {editingId !== null && (
        <EditModal
          ap={items.find((x) => x.id === editingId)!}
          buildingId={buildingId}
          onClose={() => setEditingId(null)}
          onSaved={() => { setEditingId(null); load() }}
        />
      )}
    </div>
  )
}

function EditModal({
  ap, buildingId, onClose, onSaved,
}: {
  ap: AccessPoint
  buildingId: number
  onClose: () => void
  onSaved: () => void
}) {
  const [label, setLabel] = useState(ap.label)
  const [icon, setIcon] = useState<AccessPointIcon>((ap.icon as AccessPointIcon) || 'door')
  const [isActive, setIsActive] = useState(ap.isActive)
  // Refactor 2026-06-01 — binding & scope.
  const [outputDeviceId, setOutputDeviceId] = useState<string>(ap.outputDeviceId ?? ap.deviceId ?? '')
  const [outputIndex, setOutputIndex] = useState<number>(ap.outputIndex ?? ap.relayIndex ?? 0)
  const [durationMs, setDurationMs] = useState<number>(ap.durationMs ?? 800)
  const [scope, setScope] = useState<NonNullable<AccessPoint['scope']>>(ap.scope ?? 'RESIDENT')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [devices, setDevices] = useState<Array<{ uuid: string; label: string; type: string }>>([])
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)

  // Devices dropdown — pobieramy z BA endpointu, mapujemy do flat listy.
  useEffect(() => {
    buildingAdminApi
      .get(`/building-admin/buildings/${buildingId}/devices`)
      .then((r) => {
        const data = r.data as any
        const flat: Array<{ uuid: string; label: string; type: string }> = []
        // Akceptujemy różne kształty (legacy + mirror) — kolejność: mirror > intercomy > kamery > edges.
        const mirror = Array.isArray(data?.mirrorDevices) ? data.mirrorDevices : []
        for (const m of mirror) {
          if (!m.deviceUuid) continue
          const ip = m.config?.ipAddress ?? ''
          flat.push({
            uuid: m.deviceUuid,
            label: `${m.displayLabel ?? m.config?.name ?? m.type ?? 'Urządzenie'} ${ip ? `· ${ip}` : ''} [${m.type}]`,
            type: m.type ?? '',
          })
        }
        const intercoms = Array.isArray(data?.intercoms) ? data.intercoms : []
        for (const i of intercoms) {
          if (!i.edgeDeviceId) continue
          // intercom.edgeDeviceId != device uuid — to inna semantyka. Zostawiamy
          // mirror-based dropdown jako primary. Logiwka legacy do dropdown-u nie
          // ma sensu bez UUID-a, więc skip.
        }
        setDevices(flat)
      })
      .catch(() => { /* nie blokujemy edycji */ })
  }, [buildingId])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!label.trim()) { setError('Nazwa nie może być pusta'); return }
    setSaving(true); setError(null)
    try {
      await buildingAdminApi.patch(
        `/building-admin/buildings/${buildingId}/access-points/${ap.id}`,
        {
          label: label.trim(),
          icon,
          isActive,
          outputDeviceId: outputDeviceId || undefined,
          outputIndex: Number.isFinite(outputIndex) ? outputIndex : undefined,
          durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
          scope,
        },
      )
      onSaved()
    } catch (err: any) {
      setError(err?.response?.data?.message ?? 'Błąd zapisu')
    } finally {
      setSaving(false)
    }
  }

  const testPulse = async () => {
    setTesting(true); setTestResult(null)
    try {
      await buildingAdminApi.post(
        `/building-admin/buildings/${buildingId}/access-points/${ap.id}/test-fire`,
      )
      setTestResult('✓ Komenda wysłana do Edge — słuchaj/patrz na bramę')
    } catch (err: any) {
      setTestResult(`✗ ${err?.response?.data?.message ?? 'Błąd'}`)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <form
        onSubmit={save}
        className="bg-white rounded-xl border border-gray-200 w-full max-w-md p-5 space-y-4"
      >
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Edytuj punkt dostępu</h2>
          <p className="text-xs text-gray-500 mt-1">
            relay {ap.relayIndex} · {ap.deviceId}
          </p>
        </div>

        <div>
          <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Nazwa</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="np. Wjazd główny"
            className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            autoFocus
          />
        </div>

        <div>
          <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Ikona</label>
          <div className="mt-1 grid grid-cols-5 gap-2">
            {ACCESS_POINT_ICONS.map((ic) => (
              <button
                key={ic}
                type="button"
                onClick={() => setIcon(ic)}
                className={`text-center py-2 rounded-lg border text-sm transition ${
                  icon === ic
                    ? 'border-blue-500 bg-blue-50 text-blue-800'
                    : 'border-gray-200 hover:bg-gray-50 text-gray-600'
                }`}
                title={ICON_LABEL[ic]}
              >
                <div className="text-2xl">{ICON_EMOJI[ic]}</div>
                <div className="text-[10px] mt-0.5">{ICON_LABEL[ic]}</div>
              </button>
            ))}
          </div>
        </div>

        {/* ── Refactor 2026-06-01 — Binding output device → output index ── */}
        <div className="border-t border-gray-100 pt-3">
          <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
            Wyjście (które urządzenie + który przekaźnik otwiera ten AP)
          </label>
          <div className="mt-1 grid grid-cols-3 gap-2">
            <select
              value={outputDeviceId}
              onChange={(e) => setOutputDeviceId(e.target.value)}
              className="col-span-2 border border-gray-200 rounded-lg px-2 py-1.5 text-sm"
            >
              <option value="">— (legacy) {ap.deviceId.slice(0, 12)}…</option>
              {devices.map((d) => (
                <option key={d.uuid} value={d.uuid}>{d.label}</option>
              ))}
            </select>
            <input
              type="number"
              min={0}
              max={16}
              value={outputIndex}
              onChange={(e) => setOutputIndex(Number(e.target.value))}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm"
              placeholder="0..16"
              title="Numer wyjścia: 0/1 dla Akuvox, 1..n dla Hikvision I/O"
            />
          </div>
          <p className="text-[11px] text-gray-400 mt-1">
            0/1 dla Akuvox doorIndex; 1..n dla wyjść I/O Hikvision LPR.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              Czas impulsu (ms)
            </label>
            <input
              type="number"
              min={100}
              max={30000}
              step={100}
              value={durationMs}
              onChange={(e) => setDurationMs(Number(e.target.value))}
              className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm"
            />
            <p className="text-[11px] text-gray-400 mt-1">100–30 000 ms</p>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              Widoczność
            </label>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as NonNullable<AccessPoint['scope']>)}
              className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm"
            >
              {SCOPE_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
            <p className="text-[11px] text-gray-400 mt-1">
              {SCOPE_OPTIONS.find((s) => s.value === scope)?.hint}
            </p>
          </div>
        </div>

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-400"
          />
          <span className="text-sm text-gray-700">
            Pokazuj mieszkańcom w aplikacji
          </span>
        </label>

        {/* ── Test pulse + Schedules ── */}
        <div className="border-t border-gray-100 pt-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Test</span>
            <button
              type="button"
              onClick={testPulse}
              disabled={testing}
              className="text-xs px-3 py-1 rounded-lg bg-gray-100 hover:bg-gray-200 border border-gray-200 disabled:opacity-50"
              title="Wyzwala impulse na Edge (audyt jako MANUAL_OPEN źródło 'admin-test')"
            >
              🔧 Test pulse
            </button>
          </div>
          {testResult && (
            <p className={`text-xs ${testResult.startsWith('✓') ? 'text-emerald-700' : 'text-red-700'}`}>
              {testResult}
            </p>
          )}
        </div>

        <SchedulesSection buildingId={buildingId} apId={ap.id} />


        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2 rounded-lg">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="text-sm px-3 py-1.5 rounded-lg text-gray-600 hover:bg-gray-100"
          >
            Anuluj
          </button>
          <button
            type="submit"
            disabled={saving}
            className="text-sm px-4 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Zapisywanie…' : 'Zapisz'}
          </button>
        </div>
      </form>
    </div>
  )
}

// ── Faza F-2.3: HOLD_OPEN button + select czasu ──────────────────────────────
//
// Trzymaj otwartą bramę przez wybrany czas. Akuvox/Hik nie mają natywnego
// hold-open — Edge symuluje przez cykliczne wywołania openDoor (patrz
// `IntercomService.holdOpen`). Dropdown z presetami 30s / 2 min / 10 min,
// plus opcja „Anuluj" gdy zmienimy zdanie. Auto-cancel po expire (timeout
// w Edge), więc nie ma ryzyka „zostawienia bramy otwartej na zawsze".

function HoldOpenButton({
  buildingId,
  apId,
  label,
}: {
  buildingId: number
  apId: number
  label: string
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [activeHoldUntil, setActiveHoldUntil] = useState<number | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3500)
  }

  const start = async (seconds: number) => {
    setBusy(true)
    setOpen(false)
    try {
      const res = await buildingAdminApi.post(
        `/building-admin/buildings/${buildingId}/access-points/${apId}/hold-open`,
        { seconds },
      )
      const data = res.data as { success: boolean; holdingForSeconds: number }
      const expireAt = Date.now() + data.holdingForSeconds * 1000
      setActiveHoldUntil(expireAt)
      showToast(`✓ ${label}: trzymam otwarte ${data.holdingForSeconds}s`)
      // Auto-clear status when expire
      setTimeout(() => setActiveHoldUntil(null), data.holdingForSeconds * 1000)
    } catch (err: any) {
      showToast(`✗ ${err?.response?.data?.message ?? 'Błąd hold-open'}`)
    } finally {
      setBusy(false)
    }
  }

  const cancel = async () => {
    setBusy(true)
    try {
      await buildingAdminApi.post(
        `/building-admin/buildings/${buildingId}/access-points/${apId}/hold-open/cancel`,
      )
      setActiveHoldUntil(null)
      showToast(`✓ ${label}: zamknięte`)
    } catch (err: any) {
      showToast(`✗ ${err?.response?.data?.message ?? 'Błąd anulowania'}`)
    } finally {
      setBusy(false)
    }
  }

  const isActive = activeHoldUntil !== null && activeHoldUntil > Date.now()
  const remainingSec = isActive && activeHoldUntil ? Math.max(0, Math.round((activeHoldUntil - Date.now()) / 1000)) : 0

  return (
    <div className="relative shrink-0">
      {isActive ? (
        <button
          onClick={cancel}
          disabled={busy}
          className="text-xs px-2.5 py-1 rounded bg-amber-50 border border-amber-300 text-amber-800 hover:bg-amber-100 disabled:opacity-40 inline-flex items-center gap-1"
          title={`Trzymam otwarte przez ~${remainingSec}s. Kliknij aby anulować.`}
        >
          ⏱ {remainingSec}s · Anuluj
        </button>
      ) : (
        <>
          <button
            onClick={() => setOpen((o) => !o)}
            disabled={busy}
            className="text-xs px-2.5 py-1 rounded bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-40"
            title="Trzymaj bramę otwartą przez wybrany czas"
          >
            ⏱ Hold
          </button>
          {open && (
            <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-10 overflow-hidden">
              {[
                { sec: 30,   label: '30 sek' },
                { sec: 120,  label: '2 min'  },
                { sec: 300,  label: '5 min'  },
                { sec: 600,  label: '10 min' },
              ].map((opt) => (
                <button
                  key={opt.sec}
                  onClick={() => start(opt.sec)}
                  className="block w-full text-left text-sm px-4 py-2 hover:bg-gray-50 whitespace-nowrap"
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-sm px-4 py-2 rounded-lg shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  )
}

// ── Schedules (cron auto-open) — Refactor 2026-06-01 ────────────────────────
//
// CRUD per-AP harmonogramów. Każdy ma `cronExpr` (standard 5-pól: minuta,
// godzina, dzień, miesiąc, dzień tyg.), opcjonalny `label`, toggle `enabled`.
// Cloud waliduje cron przez cron-parser, Edge wykonuje co minutę (patrz
// `apps/edge/src/access-points/schedule.service.ts`).
//
// UI: lista + inline create form + per-row edit (cronExpr/label/enabled) +
// delete button. Bez modal-w-modal — wszystko w sekcji.

function SchedulesSection({ buildingId, apId }: { buildingId: number; apId: number }) {
  const [items, setItems] = useState<ApSchedule[]>([])
  const [loading, setLoading] = useState(false)
  const [newCron, setNewCron] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    buildingAdminApi
      .get(`/building-admin/buildings/${buildingId}/access-points/${apId}/schedules`)
      .then((r) => setItems(r.data as ApSchedule[]))
      .catch((e) => setErr(e?.response?.data?.message ?? 'Błąd ładowania'))
      .finally(() => setLoading(false))
  }, [buildingId, apId])

  useEffect(() => { load() }, [load])

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newCron.trim()) return
    setBusy(true); setErr(null)
    try {
      await buildingAdminApi.post(
        `/building-admin/buildings/${buildingId}/access-points/${apId}/schedules`,
        { cronExpr: newCron.trim(), label: newLabel.trim() || undefined, enabled: true },
      )
      setNewCron(''); setNewLabel('')
      load()
    } catch (e: any) {
      setErr(e?.response?.data?.message ?? 'Błąd zapisu')
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (s: ApSchedule) => {
    setBusy(true)
    try {
      await buildingAdminApi.patch(
        `/building-admin/buildings/${buildingId}/schedules/${s.id}`,
        { enabled: !s.enabled },
      )
      load()
    } catch (e: any) {
      setErr(e?.response?.data?.message ?? 'Błąd zapisu')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (s: ApSchedule) => {
    if (!confirm(`Usunąć harmonogram „${s.label ?? s.cronExpr}"?`)) return
    setBusy(true)
    try {
      await buildingAdminApi.delete(`/building-admin/buildings/${buildingId}/schedules/${s.id}`)
      load()
    } catch (e: any) {
      setErr(e?.response?.data?.message ?? 'Błąd zapisu')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-t border-gray-100 pt-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
          Harmonogramy (cron)
        </span>
        <span className="text-[10px] text-gray-400">
          Format: <code>min h dz mies dzTyg</code>, np. <code>0 18 * * 1-5</code>
        </span>
      </div>
      {loading ? (
        <p className="text-xs text-gray-400">Ładowanie…</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-gray-400">Brak — dodaj pierwszy harmonogram poniżej.</p>
      ) : (
        <ul className="space-y-1">
          {items.map((s) => (
            <li key={s.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={s.enabled}
                onChange={() => toggle(s)}
                disabled={busy}
                className="w-4 h-4"
                title={s.enabled ? 'Aktywny — kliknij aby wyłączyć' : 'Wyłączony — kliknij aby włączyć'}
              />
              <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">{s.cronExpr}</code>
              <span className="text-gray-700 flex-1 truncate">{s.label ?? '—'}</span>
              {s.lastFiredAt && (
                <span className="text-[10px] text-gray-400" title="Ostatnio wystrzelono">
                  ⏱ {new Date(s.lastFiredAt).toLocaleString('pl-PL')}
                </span>
              )}
              <button
                type="button"
                onClick={() => remove(s)}
                disabled={busy}
                className="text-xs text-red-600 hover:underline"
              >
                Usuń
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="flex items-center gap-2 mt-2">
        <input
          type="text"
          value={newCron}
          onChange={(e) => setNewCron(e.target.value)}
          placeholder="0 18 * * *"
          className="text-xs border border-gray-200 rounded px-2 py-1 w-32 font-mono"
        />
        <input
          type="text"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="Etykieta (opcj.)"
          className="text-xs border border-gray-200 rounded px-2 py-1 flex-1"
        />
        <button
          type="submit"
          disabled={busy || !newCron.trim()}
          className="text-xs px-3 py-1 rounded bg-blue-600 text-white disabled:opacity-50"
        >
          + Dodaj
        </button>
      </form>
      {err && <p className="text-xs text-red-600">{err}</p>}
    </div>
  )
}
