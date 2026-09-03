'use client'
/**
 * ExportConfigModal (Sesja 5) — pobieranie konfiguracji obiektu jako JSON.
 *
 * Flow:
 *   1. User wybiera obiekt
 *   2. Klik „Pobierz" → POST /integrator/buildings/:id/export
 *   3. Backend zwraca pełen dump z maskowanymi sekretami
 *   4. Browser pobiera jako `gatelynk-{slug}-{date}.json`
 *
 * Audit log automatycznie po stronie Cloud (CONFIG_EXPORT entry).
 */
import { useEffect, useState } from 'react'
import { X, Download, AlertTriangle, Building2 } from 'lucide-react'
import { integratorApi } from '@/lib/integrator-api'
import { Spinner } from '@/components/integrator/property/shared/Spinner'

interface Props {
  open: boolean
  onClose: () => void
  buildings: Array<{ id: number; name: string; address: string }>
}

export function ExportConfigModal({ open, onClose, buildings }: Props) {
  const [buildingId, setBuildingId] = useState<number | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastSuccess, setLastSuccess] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setError(null); setLastSuccess(null); setDownloading(false)
    }
  }, [open])

  useEffect(() => {
    if (open && !buildingId && buildings.length > 0) setBuildingId(buildings[0].id)
  }, [open, buildings, buildingId])

  const handleDownload = async () => {
    if (!buildingId) return
    setDownloading(true)
    setError(null)
    setLastSuccess(null)
    try {
      const r = await integratorApi.post(`/integrator/buildings/${buildingId}/export`)
      const dump = r.data
      const building = buildings.find((b) => b.id === buildingId)
      const slug = (building?.name ?? `building-${buildingId}`)
        .toLowerCase()
        .replace(/[ąćęłńóśźż]/g, (c) => 'acelnoszz'['ąćęłńóśźż'.indexOf(c)])
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
      const date = new Date().toISOString().slice(0, 10)
      const filename = `gatelynk-${slug}-${date}.json`

      // Browser download
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      setLastSuccess(filename)
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Błąd eksportu'
      setError(msg)
    } finally {
      setDownloading(false)
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
        className="bg-surface border border-border rounded-r3 w-full max-w-lg overflow-hidden"
      >
        <header className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <Download size={18} strokeWidth={1.8} className="text-success" />
            <h2 className="text-[14px] font-semibold text-ink">Eksport konfiguracji</h2>
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-ink p-1 rounded-r1 hover:bg-surface-2"
          >
            <X size={16} />
          </button>
        </header>

        <div className="p-5 space-y-4">
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-2 mb-2">
              Obiekt do eksportu
            </label>
            <select
              value={buildingId ?? ''}
              onChange={(e) => setBuildingId(parseInt(e.target.value, 10))}
              disabled={downloading}
              className="w-full bg-surface border border-border rounded-r2 px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-brand"
            >
              <option value="" disabled>— wybierz obiekt —</option>
              {buildings.map((b) => (
                <option key={b.id} value={b.id}>{b.name} — {b.address}</option>
              ))}
            </select>
          </div>

          <div className="bg-surface-2 rounded-r2 p-3 border border-border">
            <p className="text-[11px] text-muted leading-relaxed">
              <strong className="text-ink-2">Co zostanie wyeksportowane:</strong> Pełna konfiguracja
              obiektu — flagi modułów, klatki schodowe + domofony (z IP/login, hasła zamaskowane),
              kamery LPR, lista Edge z wersją firmware i statusem aktywacji.
            </p>
            <p className="text-[11px] text-muted leading-relaxed mt-2">
              <strong className="text-warn">Bezpieczeństwo:</strong> Sekrety (sipPassword, password)
              są zastępowane przez <code className="bg-surface px-1 rounded-r1 text-[10px]">***</code>.
              Eksport zostanie zapisany w historii operacji.
            </p>
          </div>

          {error && (
            <div className="bg-danger-50 border border-danger/30 rounded-r2 p-3 flex items-center gap-2 text-[13px] text-danger">
              <AlertTriangle size={14} />
              {error}
            </div>
          )}

          {lastSuccess && (
            <div className="bg-success-50 border border-success/30 rounded-r2 p-3 flex items-center gap-2 text-[13px] text-success">
              <Download size={14} />
              Pobrano: <strong>{lastSuccess}</strong>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              disabled={downloading}
              className="text-[13px] text-muted hover:text-ink px-4 py-2 rounded-r2 hover:bg-surface-2 transition-colors"
            >
              Anuluj
            </button>
            <button
              onClick={handleDownload}
              disabled={!buildingId || downloading}
              className="inline-flex items-center gap-2 bg-success text-white text-[13px] font-medium px-4 py-2 rounded-r2 hover:bg-success/90 disabled:opacity-50 transition-colors"
            >
              {downloading ? <Spinner size={13} className="text-white" /> : <Download size={13} />}
              {downloading ? 'Pobieranie…' : 'Pobierz JSON'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
