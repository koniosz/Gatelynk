/**
 * System tab — najważniejsza zakładka Edge.
 *
 * Z handoff doc:
 *  • DeviceCard grid (1/2 col responsive)
 *  • Status online/offline (live, polling 15s)
 *  • Akcje per card: relay trigger | edit (drawer — E-2.2) | delete | diagnostyka
 *  • CTA „Dodaj urządzenie" → wizard
 */
import { useMemo, useState } from 'react'
import { useDevices } from '../lib/useDevices'
import { DeviceCard } from '../components/system/DeviceCard'
import { DeviceDrawer } from '../components/system/DeviceDrawer'
import { AddDeviceMenu } from '../components/system/AddDeviceMenu'
import { api } from '../lib/api'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from '../i18n'

export function SystemPage() {
  const { devices, statusByDeviceId, loading, error, refresh } = useDevices()
  const [toast, setToast] = useState<string | null>(null)
  /** E-2.2: DeviceId aktualnie otwarty w drawer-ze edycji. */
  const [editingId, setEditingId] = useState<string | null>(null)
  const { t, lang } = useTranslation()

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Usunąć to urządzenie z Edge?')) return
    try {
      await api.deleteDevice(id)
      refresh()
      showToast('✓ Usunięto')
    } catch (err: any) {
      showToast(`✗ ${err?.message ?? 'błąd'}`)
    }
  }

  const handleTest = async (id: string) => {
    showToast('Test w toku…')
    try {
      const result = await api.testMatrix(id)
      showToast(result.online ? `✓ Online (${result.finishedAt - result.startedAt} ms)` : '⚠️ Niepełna diagnostyka — sprawdź szczegóły')
    } catch (err: any) {
      showToast(`✗ ${err?.message ?? 'błąd'}`)
    }
  }

  const handleEdit = (id: string) => {
    setEditingId(id)
  }
  const editingDevice = editingId ? devices.find((d) => d.deviceId === editingId) ?? null : null

  // Stats — online count + total
  const onlineCount = devices.filter((d) => statusByDeviceId.get(d.deviceId)?.online).length

  /**
   * Podział urządzeń na sekcje. Kamery LPR rozpoznajemy po TYPIE urządzenia
   * (`LPR_CAMERA`), a nie po modelu — tutaj, w przeciwieństwie do kreatora,
   * urządzenie jest już dodane, więc typ znamy na pewno.
   */
  const deviceGroups = useMemo(() => {
    const groups = [
      { key: 'INTERCOM',   label: 'Domofony',         icon: '🚪', items: [] as typeof devices },
      { key: 'LPR_CAMERA', label: 'Kamery LPR',       icon: '🚗', items: [] as typeof devices },
      { key: 'CAMERA',     label: 'Pozostałe kamery', icon: '📹', items: [] as typeof devices },
      { key: 'OTHER',      label: 'Inne urządzenia',  icon: '📡', items: [] as typeof devices },
    ]
    const by = (k: string) => groups.find((g) => g.key === k)!
    for (const d of devices) {
      const t = String(d.type ?? '').toUpperCase()
      if (t === 'INTERCOM') by('INTERCOM').items.push(d)
      else if (t === 'LPR_CAMERA') by('LPR_CAMERA').items.push(d)
      else if (t === 'CAMERA') by('CAMERA').items.push(d)
      else by('OTHER').items.push(d)
    }
    return groups.filter((g) => g.items.length > 0)
  }, [devices])

  return (
    <div>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        marginBottom: 24,
        gap: 16,
        flexWrap: 'wrap',
      }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, color: 'var(--ink)', margin: 0 }}>
            {t('system.title')}
          </h1>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
            {loading
              ? t('common.loading')
              : lang === 'pl'
                ? `${devices.length} urządzeń · ${onlineCount} online`
                : `${devices.length} devices · ${onlineCount} online`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            className="btn-icon"
            title={t('common.refresh')}
            onClick={refresh}
            disabled={loading}
          >
            <RefreshCw size={16} />
          </button>
          <AddDeviceMenu />
        </div>
      </div>

      {error && (
        <div className="card" style={{
          padding: 12,
          marginBottom: 16,
          background: 'var(--red-50)',
          borderColor: 'var(--red)',
          color: 'var(--red)',
          fontSize: 13,
        }}>
          {t('common.error')}: {error}
        </div>
      )}

      {/* Empty state */}
      {!loading && devices.length === 0 && (
        <div className="card" style={{ padding: 48, textAlign: 'center' }}>
          <p style={{ fontSize: 14, color: 'var(--ink-2)', margin: 0, marginBottom: 12 }}>
            {t('system.empty.title')}
          </p>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0, marginBottom: 16 }}>
            {t('system.empty.hint')}
          </p>
        </div>
      )}

      {/* Urządzenia w sekcjach wg typu — zgłoszenie Konrada 2026-08-07.
          Wcześniej była jedna płaska siatka, w której domofony, kamery LPR
          i kamery obserwacyjne mieszały się ze sobą; przy kilkunastu
          urządzeniach na obiekcie nie dało się tego czytać. */}
      {deviceGroups.map((g) => (
        <div key={g.key} style={{ marginBottom: 24 }}>
          <h3 style={{
            fontSize: 13, fontWeight: 600, color: 'var(--ink)',
            margin: '0 0 10px 0', display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <span>{g.icon}</span>
            <span>{g.label}</span>
            <span style={{ color: 'var(--muted)', fontWeight: 400 }}>({g.items.length})</span>
          </h3>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))',
            gap: 16,
          }}>
            {g.items.map((d) => (
              <DeviceCard
                key={d.deviceId}
                device={d}
                status={statusByDeviceId.get(d.deviceId)}
                onTest={handleTest}
                onEdit={handleEdit}
                onDelete={handleDelete}
              />
            ))}
          </div>
        </div>
      ))}

      {/* Device drawer (E-2.2) */}
      {editingDevice && (
        <DeviceDrawer
          device={editingDevice}
          status={statusByDeviceId.get(editingDevice.deviceId)}
          onClose={() => setEditingId(null)}
          onSaved={() => {
            refresh()
            showToast('✓ Zmiany zapisane')
          }}
          onDeleted={() => {
            refresh()
            showToast('✓ Urządzenie usunięte')
          }}
        />
      )}

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed',
          bottom: 24,
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'var(--ink)',
          color: 'var(--surface)',
          padding: '10px 16px',
          borderRadius: 'var(--r-3)',
          fontSize: 13,
          boxShadow: 'var(--shadow-2)',
          zIndex: 100,
        }}>
          {toast}
        </div>
      )}
    </div>
  )
}
