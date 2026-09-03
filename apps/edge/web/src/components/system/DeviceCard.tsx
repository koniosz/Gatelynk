/**
 * DeviceCard — pojedyncza karta urządzenia w System tab.
 *
 * Layout z handoff doc sek. 5:
 *   [ ikona 40x40 ] [ thumb 124x70 ] [ nazwa + KV grid ]
 *   ───────────────────────────────────────────────────
 *   [ akcje: relay primary | otwórz panel | edit | delete ]
 *
 * Thumb pokazujemy TYLKO dla kamer (CAMERA / LPR_CAMERA / INTERCOM z snapshot).
 * Dla SWITCH/LOCK/KNX/ELEVATOR/LIGHTING — bez thumb, kompaktowiej.
 *
 * KV grid 2-kolumnowy: Producent | Model, IP | MAC (last 6), itp. — gęstość.
 *
 * Dokument: „brak emoji, ikony z biblioteki" — wszystkie ikony z lucide-react.
 */
import { useState, useEffect } from 'react'
import {
  Trash2, Settings, Stethoscope,
  DoorOpen, Maximize2, BookOpen,
} from 'lucide-react'
import type { DeviceEntry, DeviceTreeNode } from '../../lib/types'
import { deviceMeta, shortMac } from '../../lib/deviceMeta'
import { api } from '../../lib/api'
import { LivePreviewModal } from './LivePreviewModal'
import { DeviceGuideModal } from './DeviceGuideModal'
import { useTranslation } from '../../i18n'

interface DeviceCardProps {
  device: DeviceEntry
  status?: DeviceTreeNode  // online/offline z /devices/tree
  onTest?: (id: string) => void
  onDelete?: (id: string) => void
  onEdit?: (id: string) => void
}

export function DeviceCard({ device, status, onTest, onDelete, onEdit }: DeviceCardProps) {
  const { config, type, deviceId } = device
  const { icon: Icon, labelKey } = deviceMeta(type)
  const { t } = useTranslation()
  const typeLabel = t(labelKey)
  const online = status?.online ?? false
  const hasCamera = type === 'INTERCOM' || type === 'CAMERA' || type === 'LPR_CAMERA'

  const [snapshot, setSnapshot] = useState<string | null>(null)
  const [snapshotErr, setSnapshotErr] = useState(false)
  // Snapshot tylko dla kamer + jeśli online (oszczędność requestów)
  useEffect(() => {
    if (!hasCamera || !online) return
    let cancelled = false
    api.quickSnapshot(deviceId)
      .then((r) => { if (!cancelled && r.snapshot) setSnapshot(r.snapshot) })
      .catch(() => { if (!cancelled) setSnapshotErr(true) })
    return () => { cancelled = true }
  }, [deviceId, hasCamera, online])

  // 2026-05-14: live preview modal po kliknięciu na thumb
  const [previewOpen, setPreviewOpen] = useState(false)
  const canOpenPreview = hasCamera && online && snapshot !== null

  // Przewodnik konfiguracji (📘) — panel z ustawieniami + krokami device-side
  const [guideOpen, setGuideOpen] = useState(false)

  return (
    <div
      className="card card-hoverable"
      style={{
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      {/* Header: ikona + thumb + nazwa + KV */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div style={{
          width: 40, height: 40,
          borderRadius: 'var(--r-2)',
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--muted)',
          flexShrink: 0,
        }}>
          <Icon size={20} strokeWidth={1.8} />
        </div>

        {hasCamera && (
          <button
            onClick={() => canOpenPreview && setPreviewOpen(true)}
            disabled={!canOpenPreview}
            title={canOpenPreview ? t('system.card.live') : snapshotErr ? t('common.error') : t('common.loading')}
            style={{
              width: 124, height: 70,
              borderRadius: 'var(--r-2)',
              background: 'var(--bg-2)',
              border: '1px solid var(--border)',
              overflow: 'hidden',
              flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--muted-2)',
              fontSize: 10,
              position: 'relative',
              padding: 0,
              cursor: canOpenPreview ? 'pointer' : 'default',
              transition: 'transform 120ms, box-shadow 120ms',
            }}
            // Hover effect — subtle zoom + shadow + show maximize icon
            className="thumb-button"
          >
            {snapshot ? (
              <>
                <img
                  src={snapshot}
                  alt={t('system.card.field.snapshot')}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
                {canOpenPreview && (
                  <span
                    className="thumb-overlay"
                    style={{
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: 'rgba(0,0,0,0.35)',
                      color: 'white',
                      opacity: 0,
                      transition: 'opacity 120ms',
                    }}
                  >
                    <Maximize2 size={18} strokeWidth={2} />
                  </span>
                )}
              </>
            ) : snapshotErr ? (
              <span>{t('common.none')}</span>
            ) : (
              <span>{t('common.loading')}</span>
            )}
          </button>
        )}

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              fontWeight: 600,
              fontSize: 14,
              color: 'var(--ink)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {config.name ?? deviceId.slice(0, 12)}
            </span>
            <StatusBadge online={online} />
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
            {typeLabel}
          </div>

          {/* KV grid 2-kolumnowy — gęstość per handoff doc */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            columnGap: 8,
            rowGap: 2,
            fontSize: 11,
            marginTop: 8,
          }}>
            {config.ipAddress && (
              <>
                <span style={{ color: 'var(--muted)' }}>IP</span>
                <span className="mono" style={{ color: 'var(--ink-2)' }}>{config.ipAddress}</span>
              </>
            )}
            {config.manufacturer && (
              <>
                <span style={{ color: 'var(--muted)' }}>{t('system.card.field.manufacturer')}</span>
                <span style={{ color: 'var(--ink-2)' }}>
                  {config.manufacturer}{config.model ? ` · ${config.model}` : ''}
                </span>
              </>
            )}
            {config.mac && (
              <>
                <span style={{ color: 'var(--muted)' }}>MAC</span>
                <span className="mono" style={{ color: 'var(--ink-2)' }}>{shortMac(config.mac)}</span>
              </>
            )}
            {config.driverId && (
              <>
                <span style={{ color: 'var(--muted)' }}>{t('drawer.identity.driver')}</span>
                <span className="mono" style={{ color: 'var(--ink-2)', fontSize: 10 }}>{config.driverId}</span>
              </>
            )}
            {config.relays && config.relays.length > 0 && (
              <>
                <span style={{ color: 'var(--muted)' }}>{t('system.card.field.relays')}</span>
                <span style={{ color: 'var(--ink-2)' }}>{config.relays.length}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Akcje */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        paddingTop: 12,
        borderTop: '1px solid var(--border)',
      }}>
        {/* Relay primary (zielony przycisk) dla INTERCOM/SWITCH */}
        {(type === 'INTERCOM' || type === 'SWITCH') && config.relays && config.relays.length > 0 ? (
          <RelayButtons deviceId={deviceId} relays={config.relays} />
        ) : (
          <div style={{ flex: 1 }} />
        )}

        <div style={{ flex: 1 }} />

        <button
          className="btn-icon"
          title={t('system.card.guide')}
          onClick={() => setGuideOpen(true)}
          style={{ color: 'var(--blue)' }}
        >
          <BookOpen size={16} />
        </button>
        <button
          className="btn-icon"
          title={t('drawer.tab.diagnostics')}
          onClick={() => onTest?.(deviceId)}
        >
          <Stethoscope size={16} />
        </button>
        <button
          className="btn-icon"
          title={t('common.edit')}
          onClick={() => onEdit?.(deviceId)}
        >
          <Settings size={16} />
        </button>
        <button
          className="btn-icon"
          title={t('common.delete')}
          onClick={() => onDelete?.(deviceId)}
          style={{ color: 'var(--red)' }}
        >
          <Trash2 size={16} />
        </button>
      </div>

      {previewOpen && (
        <LivePreviewModal device={device} onClose={() => setPreviewOpen(false)} />
      )}

      {guideOpen && (
        <DeviceGuideModal device={device} status={status} onClose={() => setGuideOpen(false)} />
      )}
    </div>
  )
}

function StatusBadge({ online }: { online: boolean }) {
  const { t } = useTranslation()
  if (online) {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 11, color: 'var(--green)',
      }}>
        <span className="dot dot-green" />
        {t('common.online')}
      </span>
    )
  }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 11, color: 'var(--muted)',
    }}>
      <span className="dot dot-gray" />
      {t('common.offline')}
    </span>
  )
}

function RelayButtons({ deviceId, relays }: { deviceId: string; relays: { index: number; name: string }[] }) {
  const [busyIdx, setBusyIdx] = useState<number | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const { t } = useTranslation()

  const trigger = async (idx: number, name: string) => {
    setBusyIdx(idx)
    try {
      await api.triggerRelay(deviceId, idx)
      setToast(`✓ ${name}`)
    } catch (err: any) {
      setToast(`✗ ${err?.message ?? t('common.error').toLowerCase()}`)
    } finally {
      setBusyIdx(null)
      setTimeout(() => setToast(null), 2500)
    }
  }

  return (
    <>
      {relays.map((r) => (
        <button
          key={r.index}
          onClick={() => trigger(r.index, r.name || `Relay ${r.index}`)}
          disabled={busyIdx === r.index}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 12px',
            background: 'var(--green)',
            color: 'white',
            border: '1px solid var(--green)',
            borderRadius: 'var(--r-2)',
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
            opacity: busyIdx === r.index ? 0.5 : 1,
          }}
          title={`${t('drawer.relay.trigger')} ${r.name}`}
        >
          <DoorOpen size={14} strokeWidth={2.2} />
          {r.name || `Relay ${r.index}`}
        </button>
      ))}
      {toast && (
        <span style={{
          fontSize: 11,
          color: toast.startsWith('✓') ? 'var(--green)' : 'var(--red)',
          marginLeft: 4,
        }}>
          {toast}
        </span>
      )}
    </>
  )
}
