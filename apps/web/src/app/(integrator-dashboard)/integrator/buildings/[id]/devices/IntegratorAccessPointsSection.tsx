'use client'
/**
 * Sekcja „Punkty dostępu — wiring techniczny" w panelu Integratora.
 *
 * 2026-06-02: integrator dostaje pełną edycję bindingu device→output (oraz
 * scope/durationMs). W BA te same pola są READ-ONLY — patrz
 * `apps/web/src/app/(ba-v2)/.../devices/components/AccessPointList.tsx`.
 *
 * Endpointy:
 *   GET   /integrator/buildings/:id/access-points
 *   PATCH /integrator/buildings/:id/access-points/:apId
 *   POST  /integrator/buildings/:id/access-points/:apId/test-fire
 *   GET   /integrator/buildings/:id/devices    (mirrorDevices dla dropdown)
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { integratorApi } from '@/lib/integrator-api'

type ApScope = 'PUBLIC' | 'RESIDENT' | 'ADMIN_ONLY'
type ApIcon = 'door' | 'garage' | 'gate' | 'elevator' | 'barrier'

// FAZA c (2026-06-02) — kategoria semantyczna AP.
type ApCategory = 'MAIN_ENTRY' | 'FIRE_ESCAPE' | 'PEDESTRIAN_GATE' | 'GARAGE_ENTRY' | 'SERVICE_ENTRY'

const AP_CATEGORIES: ApCategory[] = [
  'MAIN_ENTRY',
  'FIRE_ESCAPE',
  'PEDESTRIAN_GATE',
  'GARAGE_ENTRY',
  'SERVICE_ENTRY',
]

const AP_CATEGORY_LABELS: Record<ApCategory, string> = {
  MAIN_ENTRY: 'Brama glowna',
  FIRE_ESCAPE: 'Brama pozarowa',
  PEDESTRIAN_GATE: 'Furtka piesza',
  GARAGE_ENTRY: 'Brama garazowa',
  SERVICE_ENTRY: 'Wjazd serwisowy',
}

interface AccessPoint {
  id: number
  label: string
  icon: string
  sortOrder: number
  isActive: boolean
  scope: ApScope
  // FAZA c (2026-06-02) — semantyczna kategoria.
  category?: ApCategory
  outputDeviceId: string | null
  outputIndex: number | null
  durationMs: number
  // legacy fields w odpowiedzi, używane tylko do display fallback:
  deviceId: string
  relayIndex: number
}

interface MirrorDeviceLite {
  id: number
  deviceUuid: string
  type: string
  driverId: string | null
  config: Record<string, unknown>
  displayLabel: string | null
}

const ICON_EMOJI: Record<ApIcon, string> = {
  door: 'drzwi',
  garage: 'garaz',
  gate: 'brama',
  elevator: 'winda',
  barrier: 'szlaban',
}

// Mapowanie ikon na lokalny zestaw symboli używane jako label tekstowy
// (zgodnie z wymogiem braku emoji w UI integratora — poza ikoną AP, którą
// w panelu integratora prezentujemy jako kanoniczne słowo).
function iconLabel(icon: string): string {
  return ICON_EMOJI[icon as ApIcon] ?? icon
}

const TYPE_ALLOWED = new Set(['INTERCOM', 'LPR_CAMERA', 'CAMERA', 'SWITCH', 'LIGHTING', 'LOCK'])

interface Props {
  buildingId: number
}

export function IntegratorAccessPointsSection({ buildingId }: Props) {
  const [accessPoints, setAccessPoints] = useState<AccessPoint[]>([])
  const [mirrorDevices, setMirrorDevices] = useState<MirrorDeviceLite[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([
      integratorApi.get<AccessPoint[]>(`/integrator/buildings/${buildingId}/access-points`),
      integratorApi.get<{ mirrorDevices: MirrorDeviceLite[] }>(`/integrator/buildings/${buildingId}/devices`),
    ])
      .then(([apsRes, devRes]) => {
        setAccessPoints(apsRes.data)
        setMirrorDevices(devRes.data.mirrorDevices ?? [])
      })
      .catch((err: unknown) => {
        const e2 = err as { response?: { data?: { message?: string } } }
        setError(e2.response?.data?.message ?? 'Blad ladowania punktow dostepu')
      })
      .finally(() => setLoading(false))
  }, [buildingId])

  useEffect(() => { load() }, [load])

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3500)
  }

  const eligibleDevices = useMemo(
    () => mirrorDevices.filter((m) => TYPE_ALLOWED.has(m.type)),
    [mirrorDevices],
  )

  const editing = editingId !== null ? accessPoints.find((a) => a.id === editingId) ?? null : null

  // FAZA c — grupowanie po `category` z fallbackiem 'MAIN_ENTRY'. Kolejność
  // zgodna z AP_CATEGORIES. Pusta grupa jest pomijana.
  const grouped = useMemo(() => {
    const buckets = new Map<ApCategory, AccessPoint[]>()
    for (const cat of AP_CATEGORIES) buckets.set(cat, [])
    for (const ap of accessPoints) {
      const cat: ApCategory = (ap.category && AP_CATEGORIES.includes(ap.category) ? ap.category : 'MAIN_ENTRY') as ApCategory
      buckets.get(cat)!.push(ap)
    }
    return AP_CATEGORIES.map((cat) => ({ category: cat, items: buckets.get(cat) ?? [] })).filter((g) => g.items.length > 0)
  }, [accessPoints])

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
            Punkty dostepu — wiring techniczny
          </h2>
          <p style={{ fontSize: 12, color: '#6b7280', margin: '4px 0 0 0', lineHeight: 1.4 }}>
            Konfiguracja bindingu device → wyjscie. Etykiety, harmonogramy i widocznosc
            zarzadza Building Admin; tutaj integrator decyduje ktore wyjscie urzadzenia
            otwiera dany punkt.
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
      ) : accessPoints.length === 0 ? (
        <div style={{ padding: 28, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
          Brak punktow dostepu. Edge zsynchronizuje je przy pierwszym DEVICE_UPSERT.
        </div>
      ) : (
        <div style={{ padding: 16, display: 'grid', gap: 18 }}>
          {grouped.map((group) => (
            <div key={group.category}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: '#6b7280',
                  paddingBottom: 6,
                  borderBottom: '1px solid #f3f4f6',
                  marginBottom: 10,
                }}
              >
                {AP_CATEGORY_LABELS[group.category]}
                <span style={{ color: '#d1d5db', marginLeft: 6 }}>({group.items.length})</span>
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                  gap: 12,
                }}
              >
                {group.items.map((ap) => (
                  <AccessPointCard
                    key={ap.id}
                    ap={ap}
                    mirrorDevices={eligibleDevices}
                    onClick={() => setEditingId(ap.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <EditAccessPointModal
          ap={editing}
          mirrorDevices={eligibleDevices}
          buildingId={buildingId}
          onClose={() => setEditingId(null)}
          onSaved={(updated) => {
            setAccessPoints((prev) => prev.map((x) => (x.id === updated.id ? { ...x, ...updated } : x)))
            setEditingId(null)
            showToast('Konfiguracja zapisana')
          }}
          onError={(msg) => showToast(msg)}
        />
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

// ── Card ──────────────────────────────────────────────────────────────────

function AccessPointCard({
  ap,
  mirrorDevices,
  onClick,
}: {
  ap: AccessPoint
  mirrorDevices: MirrorDeviceLite[]
  onClick: () => void
}) {
  const linkedDevice = ap.outputDeviceId
    ? mirrorDevices.find((m) => m.deviceUuid === ap.outputDeviceId) ?? null
    : null

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: 'left',
        border: '1px solid #e5e7eb',
        borderRadius: 10,
        padding: 14,
        background: '#fff',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        transition: 'border-color 0.1s, box-shadow 0.1s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = '#a5b4fc'
        e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.06)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = '#e5e7eb'
        e.currentTarget.style.boxShadow = 'none'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>{ap.label}</div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
            ikona: {iconLabel(ap.icon)} · scope: {ap.scope}
          </div>
        </div>
        {ap.isActive ? (
          <span
            style={{
              fontSize: 10,
              padding: '2px 6px',
              borderRadius: 4,
              background: '#ecfdf5',
              color: '#065f46',
              border: '1px solid #a7f3d0',
              whiteSpace: 'nowrap',
            }}
          >
            aktywny
          </span>
        ) : (
          <span
            style={{
              fontSize: 10,
              padding: '2px 6px',
              borderRadius: 4,
              background: '#f3f4f6',
              color: '#6b7280',
              border: '1px solid #e5e7eb',
              whiteSpace: 'nowrap',
            }}
          >
            ukryty
          </span>
        )}
      </div>
      <div
        style={{
          fontSize: 11,
          background: '#f9fafb',
          border: '1px solid #f3f4f6',
          borderRadius: 6,
          padding: '6px 8px',
          color: '#374151',
        }}
      >
        <div style={{ color: '#6b7280', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>
          binding
        </div>
        {ap.outputDeviceId ? (
          <>
            <div>
              <strong>{linkedDevice?.displayLabel ?? (linkedDevice?.config as any)?.name ?? 'Urzadzenie'}</strong>
              <span style={{ color: '#6b7280' }}> · wyjscie {ap.outputIndex ?? '?'}</span>
            </div>
            <div style={{ color: '#9ca3af', fontFamily: 'monospace', fontSize: 10, marginTop: 2 }}>
              {ap.outputDeviceId.slice(0, 12)}… · impuls {ap.durationMs}ms
            </div>
          </>
        ) : (
          <div style={{ color: '#9ca3af', fontStyle: 'italic' }}>
            Niepowiazane — fallback do {ap.deviceId.slice(0, 12)}… / relay {ap.relayIndex}
          </div>
        )}
      </div>
    </button>
  )
}

// ── Modal ─────────────────────────────────────────────────────────────────

function EditAccessPointModal({
  ap,
  mirrorDevices,
  buildingId,
  onClose,
  onSaved,
  onError,
}: {
  ap: AccessPoint
  mirrorDevices: MirrorDeviceLite[]
  buildingId: number
  onClose: () => void
  onSaved: (updated: AccessPoint) => void
  onError: (msg: string) => void
}) {
  const [outputDeviceId, setOutputDeviceId] = useState<string | null>(ap.outputDeviceId)
  const [outputIndex, setOutputIndex] = useState<number>(ap.outputIndex ?? 0)
  const [durationMs, setDurationMs] = useState<number>(ap.durationMs ?? 800)
  // FAZA c — kategoria semantyczna. PATCH-owana osobno (PATCH .../category).
  const [category, setCategory] = useState<ApCategory>(
    (ap.category && AP_CATEGORIES.includes(ap.category) ? ap.category : 'MAIN_ENTRY') as ApCategory,
  )
  const [savingCategory, setSavingCategory] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)

  const dirty =
    outputDeviceId !== ap.outputDeviceId ||
    outputIndex !== (ap.outputIndex ?? 0) ||
    durationMs !== (ap.durationMs ?? 800)

  const saveCategory = async (next: ApCategory) => {
    setSavingCategory(true)
    try {
      const res = await integratorApi.patch<AccessPoint>(
        `/integrator/buildings/${buildingId}/access-points/${ap.id}/category`,
        { category: next },
      )
      setCategory(next)
      onSaved(res.data)
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } }
      onError(e2.response?.data?.message ?? 'Blad zmiany kategorii')
    } finally {
      setSavingCategory(false)
    }
  }

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (outputIndex < 0 || outputIndex > 16) {
      setError('Wyjscie musi byc w zakresie 0..16')
      return
    }
    if (durationMs < 100 || durationMs > 30_000) {
      setError('Impuls musi byc w zakresie 100..30000 ms')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const payload: {
        outputDeviceId: string | null
        outputIndex: number | null
        durationMs: number
      } = {
        outputDeviceId,
        outputIndex: outputDeviceId === null ? null : outputIndex,
        durationMs,
      }
      const res = await integratorApi.patch<AccessPoint>(
        `/integrator/buildings/${buildingId}/access-points/${ap.id}`,
        payload,
      )
      onSaved(res.data)
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } }
      const msg = e2.response?.data?.message ?? 'Blad zapisu'
      setError(msg)
      onError(msg)
    } finally {
      setSaving(false)
    }
  }

  const testFire = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      await integratorApi.post(
        `/integrator/buildings/${buildingId}/access-points/${ap.id}/test-fire`,
      )
      setTestResult('Komenda wyslana do Edge (sprawdz urzadzenie)')
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } }
      setTestResult(`Blad: ${e2.response?.data?.message ?? 'nieznany'}`)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15,17,20,0.45)',
        zIndex: 80,
        display: 'grid',
        placeItems: 'center',
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <form
        onSubmit={save}
        style={{
          background: '#fff',
          borderRadius: 14,
          padding: 22,
          width: '100%',
          maxWidth: 520,
          display: 'grid',
          gap: 16,
          maxHeight: 'calc(100vh - 32px)',
          overflowY: 'auto',
        }}
      >
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>
            Wiring punktu „{ap.label}"
          </div>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4, fontFamily: 'monospace' }}>
            AP #{ap.id} · scope {ap.scope} · {ap.isActive ? 'aktywny' : 'ukryty'}
          </div>
        </div>

        <label style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>
            Kategoria (typ przejscia)
          </span>
          <select
            value={category}
            onChange={(e) => saveCategory(e.target.value as ApCategory)}
            disabled={savingCategory}
            style={{
              fontSize: 13,
              padding: '8px 10px',
              border: '1px solid #d1d5db',
              borderRadius: 6,
              background: '#fff',
              color: '#111827',
            }}
          >
            {AP_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {AP_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
          <span style={{ fontSize: 11, color: '#9ca3af' }}>
            Zmiana zapisywana od razu. Uzywana do grupowania w UI i regul (np. brama pozarowa = ADMIN_ONLY).
          </span>
        </label>

        <label style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>
            Urzadzenie (output)
          </span>
          <select
            value={outputDeviceId ?? ''}
            onChange={(e) => setOutputDeviceId(e.target.value || null)}
            disabled={saving}
            style={{
              fontSize: 13,
              padding: '8px 10px',
              border: '1px solid #d1d5db',
              borderRadius: 6,
              background: '#fff',
              color: '#111827',
            }}
          >
            <option value="">— Niepowiazane (fallback legacy) —</option>
            {mirrorDevices.map((m) => (
              <option key={m.deviceUuid} value={m.deviceUuid}>
                {m.displayLabel ?? (m.config as any)?.name ?? m.deviceUuid.slice(0, 12)}
                {' · '}
                {m.type}
                {m.driverId ? ` · ${m.driverId}` : ''}
              </option>
            ))}
          </select>
          <span style={{ fontSize: 11, color: '#9ca3af' }}>
            Lista wszystkich urzadzen z Edge mirror (intercom, LPR, kamera, switch, lock).
          </span>
        </label>

        <label style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>
            Numer wyjscia / przekaznika
          </span>
          <input
            type="number"
            min={0}
            max={16}
            value={outputIndex}
            onChange={(e) => setOutputIndex(parseInt(e.target.value, 10) || 0)}
            disabled={saving || outputDeviceId === null}
            style={{
              fontSize: 13,
              padding: '8px 10px',
              border: '1px solid #d1d5db',
              borderRadius: 6,
              background: outputDeviceId === null ? '#f9fafb' : '#fff',
              color: '#111827',
              fontFamily: 'monospace',
            }}
          />
          <span style={{ fontSize: 11, color: '#9ca3af' }}>
            0/1 dla Akuvox doorIndex · 0/1 dla Hikvision relay · 0..n dla LAN switch port.
          </span>
        </label>

        <label style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>
            Czas impulsu (ms)
          </span>
          <input
            type="number"
            min={100}
            max={30_000}
            step={100}
            value={durationMs}
            onChange={(e) => setDurationMs(parseInt(e.target.value, 10) || 100)}
            disabled={saving}
            style={{
              fontSize: 13,
              padding: '8px 10px',
              border: '1px solid #d1d5db',
              borderRadius: 6,
              background: '#fff',
              color: '#111827',
              fontFamily: 'monospace',
            }}
          />
          <span style={{ fontSize: 11, color: '#9ca3af' }}>
            Default 800 ms. Hikvision wymaga explicit low (relay sam nie wraca). Powyzej
            30 s zaprosimy o uzycie dedykowanego hold-open (BA).
          </span>
        </label>

        <div
          style={{
            borderTop: '1px solid #f3f4f6',
            paddingTop: 14,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Test pulse</div>
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
              Wysyla AP_TEST_FIRE do Edge — slyszysz/widzisz czy zaskoczylo.
            </div>
          </div>
          <button
            type="button"
            onClick={testFire}
            disabled={testing}
            style={{
              fontSize: 12,
              padding: '6px 14px',
              border: '1px solid #d1d5db',
              borderRadius: 6,
              background: '#fff',
              color: '#374151',
              cursor: testing ? 'wait' : 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {testing ? 'Wysylanie…' : 'Wyslij test'}
          </button>
        </div>
        {testResult && (
          <div
            style={{
              fontSize: 12,
              color: testResult.startsWith('Blad') ? '#b91c1c' : '#065f46',
              background: testResult.startsWith('Blad') ? '#fef2f2' : '#ecfdf5',
              padding: '6px 10px',
              borderRadius: 6,
            }}
          >
            {testResult}
          </div>
        )}

        {error && (
          <div style={{ fontSize: 12, color: '#b91c1c', background: '#fef2f2', padding: '6px 10px', borderRadius: 6 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            style={{
              fontSize: 13,
              padding: '8px 16px',
              border: '1px solid #d1d5db',
              borderRadius: 6,
              background: '#fff',
              color: '#374151',
              cursor: saving ? 'wait' : 'pointer',
            }}
          >
            Anuluj
          </button>
          <button
            type="submit"
            disabled={saving || !dirty}
            style={{
              fontSize: 13,
              padding: '8px 16px',
              border: '1px solid #1d4ed8',
              borderRadius: 6,
              background: saving || !dirty ? '#93c5fd' : '#2563eb',
              color: '#fff',
              cursor: saving || !dirty ? 'not-allowed' : 'pointer',
            }}
          >
            {saving ? 'Zapisywanie…' : 'Zapisz binding'}
          </button>
        </div>
      </form>
    </div>
  )
}
