'use client'
/**
 * EdgeStatusSection — lista appliance'ów Edge w obiekcie (handoff §5
 * „Urządzenia Edge"). Per Edge: ikona, nazwa, IP, FW, last-seen, status pill,
 * deeplink „Otwórz UI →".
 *
 * Pre-handoff to było inline w monolicie (EdgeStatusWidget linia 99). Tutaj
 * przepisane na tokeny + Lucide + IBM Plex Mono dla danych technicznych.
 *
 * Sesja 4 (2026-05-17): zastąpiony bezpośredni link `http://IP:4000/ui` na
 * `openEdgeUI()` — Cloud generuje one-time token (TTL 60s) i redirect-uje.
 */
import { useEffect, useState } from 'react'
import { Server, ExternalLink } from 'lucide-react'
import { integratorApi } from '@/lib/integrator-api'
import { openEdgeUI } from '@/lib/integrator-deeplink'
import type { EdgeAppliance } from './types'

export function EdgeStatusSection({ buildingId }: { buildingId: string }) {
  const [devices, setDevices] = useState<EdgeAppliance[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    integratorApi.get(`/integrator/buildings/${buildingId}/edge`)
      .then((r) => setDevices(r.data))
      .catch(() => { /* no-op — Edge może być offline */ })
      .finally(() => setLoading(false))
  }, [buildingId])

  if (loading || !devices.length) return null

  return (
    <div className="mb-5 space-y-2">
      {devices.map((d) => {
        const ago = d.lastSeenAt ? Math.round((Date.now() - new Date(d.lastSeenAt).getTime()) / 1000) : null
        const agoLabel = ago == null ? 'nigdy'
          : ago < 60 ? `${ago}s temu`
          : ago < 3600 ? `${Math.round(ago / 60)} min temu`
          : `${Math.round(ago / 3600)} h temu`

        return (
          <div
            key={d.id}
            className="bg-surface border border-border rounded-r3 px-5 py-4 flex items-center justify-between"
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-r2 bg-surface-2 flex items-center justify-center">
                <Server size={16} strokeWidth={1.8} className="text-ink-2" />
              </div>
              <div>
                <p className="text-[13px] font-semibold text-ink">{d.name ?? 'GateLynk Edge'}</p>
                <p
                  className="text-[11px] text-muted mt-0.5"
                  style={{ fontFamily: 'var(--font-plex-mono, monospace)' }}
                >
                  {d.ipAddress ? `${d.ipAddress}` : 'IP —'}
                  {d.version ? ` · v${d.version}` : ''}
                  {` · ${agoLabel}`}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <StatusPill online={!!d.isOnline} />
              <button
                onClick={() => openEdgeUI(buildingId, d.id)}
                className="inline-flex items-center gap-1 text-[12px] font-medium text-brand hover:text-brand-600 bg-brand-50 px-3 py-1.5 rounded-r2 border border-brand/30 transition-colors"
                title="1-click do panelu Edge klienta (Cloud SSO redirect)"
              >
                Otwórz UI
                <ExternalLink size={11} strokeWidth={2} />
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function StatusPill({ online }: { online: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-r1 border ${
        online
          ? 'bg-success-50 text-success border-success/30'
          : 'bg-danger-50 text-danger border-danger/30'
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${online ? 'bg-success' : 'bg-danger'}`} />
      {online ? 'Online' : 'Offline'}
    </span>
  )
}
