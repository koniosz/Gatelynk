'use client'
/**
 * HealthReportModal (Sesja 6) — agregowany dashboard wszystkich Edge w portfolio.
 *
 * Snapshot: per-Edge uptime estymowane z lastSeenAt, status online (z gateway),
 * FW version, ostatnia diagnostyka. Plus summary stats (online/offline/uptime avg).
 *
 * Print: `window.print()` daje natywny browser PDF. CSS `@media print` ukrywa
 * chrome (header, buttons), zostawia tylko tabelę.
 *
 * Backend: GET /integrator/health-report
 */
import { useCallback, useEffect, useState } from 'react'
import {
  X, Activity, Printer, AlertTriangle, CheckCircle2, Server,
  Building2, ExternalLink,
} from 'lucide-react'
import { integratorApi } from '@/lib/integrator-api'
import { openEdgeUI } from '@/lib/integrator-deeplink'
import { Spinner } from '@/components/integrator/property/shared/Spinner'

interface HealthReport {
  generatedAt: string
  summary: {
    totalEdges: number
    onlineCount: number
    offlineCount: number
    activatedCount: number
    avgUptimePct: number
    firmwareVersions: string[]
  }
  edges: Array<{
    edgeId: string
    edgeName: string
    building: { id: number; name: string; address: string }
    ipAddress?: string | null
    version?: string | null
    isActivated: boolean
    isOnline: boolean
    lastSeenAt?: string | null
    uptimePct: number
    lastDiagnostic?: { at: string; online: boolean | null } | null
    ageDays: number
  }>
}

interface Props {
  open: boolean
  onClose: () => void
}

export function HealthReportModal({ open, onClose }: Props) {
  const [report, setReport] = useState<HealthReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    integratorApi.get<HealthReport>('/integrator/health-report')
      .then((r) => setReport(r.data))
      .catch((err: unknown) => {
        const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Błąd generowania raportu'
        setError(msg)
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (open) load()
    else { setReport(null); setError(null) }
  }, [open, load])

  if (!open) return null

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-ink/40 backdrop-blur-sm flex items-center justify-center p-6 print:bg-transparent print:p-0 print:items-start"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-surface border border-border rounded-r3 w-full max-w-5xl max-h-[85vh] flex flex-col overflow-hidden print:max-h-none print:max-w-none print:rounded-none print:border-0 print:shadow-none"
      >
        <header className="flex items-center justify-between px-5 py-4 border-b border-border print:hidden">
          <div className="flex items-center gap-2.5">
            <Activity size={18} strokeWidth={1.8} className="text-success" />
            <h2 className="text-[14px] font-semibold text-ink">Health report — portfolio Edge</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => window.print()}
              disabled={!report}
              title="Drukuj / zapisz jako PDF"
              className="inline-flex items-center gap-1.5 text-[12px] text-brand hover:text-brand-600 border border-brand/30 hover:bg-brand-50 px-3 py-1.5 rounded-r2 font-medium transition-colors disabled:opacity-50"
            >
              <Printer size={12} strokeWidth={2} />
              Drukuj / PDF
            </button>
            <button
              onClick={onClose}
              className="text-muted hover:text-ink p-1 rounded-r1 hover:bg-surface-2"
            >
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="overflow-y-auto p-5 print:overflow-visible print:p-8">
          {/* Print-only title (chrome ukryte) */}
          <div className="hidden print:block mb-6">
            <h1 className="text-2xl font-semibold text-ink">GateLynk — Health report</h1>
            {report && (
              <p className="text-[12px] text-muted mt-1">
                Wygenerowano: {new Date(report.generatedAt).toLocaleString('pl-PL')}
              </p>
            )}
          </div>

          {loading && (
            <div className="flex items-center gap-2 py-12 text-muted text-[13px]">
              <Spinner size={14} /> Generowanie raportu…
            </div>
          )}

          {error && (
            <div className="bg-danger-50 border border-danger/30 rounded-r2 p-3 flex items-center gap-2 text-[13px] text-danger">
              <AlertTriangle size={14} />
              {error}
            </div>
          )}

          {report && (
            <>
              {/* Summary cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6 print:gap-2">
                <SummaryCard
                  label="Edge w portfolio"
                  value={String(report.summary.totalEdges)}
                  icon={Server}
                  tone="neutral"
                />
                <SummaryCard
                  label="Online teraz"
                  value={`${report.summary.onlineCount} / ${report.summary.totalEdges}`}
                  icon={CheckCircle2}
                  tone="success"
                />
                <SummaryCard
                  label="Średni uptime"
                  value={`${report.summary.avgUptimePct}%`}
                  icon={Activity}
                  tone={report.summary.avgUptimePct >= 90 ? 'success' : report.summary.avgUptimePct >= 50 ? 'warn' : 'danger'}
                />
                <SummaryCard
                  label="Wersje firmware"
                  value={report.summary.firmwareVersions.length === 0
                    ? '—'
                    : report.summary.firmwareVersions.length === 1
                      ? report.summary.firmwareVersions[0]
                      : `${report.summary.firmwareVersions.length} wersji`}
                  icon={Server}
                  tone={report.summary.firmwareVersions.length > 2 ? 'warn' : 'neutral'}
                />
              </div>

              {/* Edge table */}
              {report.edges.length === 0 ? (
                <div className="text-center py-12 text-muted">
                  <Server size={36} strokeWidth={1.5} className="mx-auto mb-3 text-muted-2" />
                  <p className="text-[13px]">Brak Edge w portfolio</p>
                </div>
              ) : (
                <div className="bg-surface border border-border rounded-r3 overflow-hidden print:border-0 print:rounded-none">
                  <table className="w-full text-[12px]">
                    <thead className="bg-surface-2 border-b border-border">
                      <tr className="text-left">
                        <Th>Edge</Th>
                        <Th>Obiekt</Th>
                        <Th>FW</Th>
                        <Th>Status</Th>
                        <Th>Uptime</Th>
                        <Th>Ostatnia diag.</Th>
                        <Th className="text-right print:hidden">Akcja</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {report.edges.map((e) => (
                        <tr key={e.edgeId} className="hover:bg-surface-2 print:hover:bg-transparent">
                          <Td>
                            <div className="flex items-center gap-2">
                              <Server size={12} strokeWidth={1.8} className="text-ink-2 flex-shrink-0" />
                              <div>
                                <div className="font-medium text-ink">{e.edgeName}</div>
                                <div className="text-[10px] text-muted" style={{ fontFamily: 'var(--font-plex-mono, monospace)' }}>
                                  {e.ipAddress ?? '—'}
                                </div>
                              </div>
                            </div>
                          </Td>
                          <Td>
                            <div className="flex items-center gap-1 text-brand">
                              <Building2 size={11} strokeWidth={1.8} />
                              {e.building.name}
                            </div>
                          </Td>
                          <Td className="text-muted" style={{ fontFamily: 'var(--font-plex-mono, monospace)' }}>
                            {e.version ?? '—'}
                          </Td>
                          <Td>
                            <StatusPill online={e.isOnline} />
                          </Td>
                          <Td>
                            <UptimePill pct={e.uptimePct} />
                          </Td>
                          <Td className="text-muted">
                            {e.lastDiagnostic
                              ? formatAgo(new Date(e.lastDiagnostic.at).getTime())
                              : <span className="text-muted-2">brak</span>}
                          </Td>
                          <Td className="text-right print:hidden">
                            {e.ipAddress && (
                              <button
                                onClick={() => openEdgeUI(e.building.id, e.edgeId)}
                                className="inline-flex items-center gap-1 text-[11px] font-medium text-brand hover:text-brand-600 bg-brand-50 px-2 py-0.5 rounded-r1 border border-brand/30 transition-colors"
                              >
                                UI <ExternalLink size={9} strokeWidth={2} />
                              </button>
                            )}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <p className="text-[10px] text-muted-2 mt-4 leading-relaxed">
                Uptime estymowane na podstawie `lastSeenAt` heartbeat. Dokładne metryki będą dostępne
                gdy włączymy `edge_heartbeats` audit table. Diagnostyka per-Edge w zakładce Narzędzia.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function SummaryCard({ label, value, icon: Icon, tone }: {
  label: string
  value: string
  icon: typeof Server
  tone: 'success' | 'warn' | 'danger' | 'neutral'
}) {
  const colors = {
    success: 'bg-success-50 text-success border-success/30',
    warn:    'bg-warn-50 text-warn border-warn/30',
    danger:  'bg-danger-50 text-danger border-danger/30',
    neutral: 'bg-surface-2 text-ink-2 border-border',
  }[tone]

  return (
    <div className={`border rounded-r2 p-3 ${colors}`}>
      <div className="flex items-center gap-1.5 mb-1">
        <Icon size={12} strokeWidth={2} />
        <div className="text-[10px] uppercase tracking-wider font-semibold opacity-80">{label}</div>
      </div>
      <div className="text-[16px] font-semibold">{value}</div>
    </div>
  )
}

function StatusPill({ online }: { online: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-r1 border ${
      online ? 'bg-success-50 text-success border-success/30' : 'bg-danger-50 text-danger border-danger/30'
    }`}>
      <span className={`w-1 h-1 rounded-full ${online ? 'bg-success' : 'bg-danger'}`} />
      {online ? 'Online' : 'Offline'}
    </span>
  )
}

function UptimePill({ pct }: { pct: number }) {
  const tone = pct >= 90 ? 'text-success' : pct >= 50 ? 'text-warn' : 'text-danger'
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-12 h-1 bg-surface-2 rounded-r1 overflow-hidden">
        <div
          className={`h-full ${pct >= 90 ? 'bg-success' : pct >= 50 ? 'bg-warn' : 'bg-danger'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-[11px] font-medium ${tone}`}>{pct}%</span>
    </div>
  )
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={`px-3 py-2 text-[9px] font-bold text-muted-2 uppercase tracking-wider ${className ?? ''}`}>
      {children}
    </th>
  )
}

function Td({ children, className, style }: { children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  return <td className={`px-3 py-2 align-middle ${className ?? ''}`} style={style}>{children}</td>
}

function formatAgo(ts: number): string {
  const sec = Math.round((Date.now() - ts) / 1000)
  if (sec < 60) return `${sec} s temu`
  if (sec < 3600) return `${Math.round(sec / 60)} min temu`
  if (sec < 86400) return `${Math.round(sec / 3600)} h temu`
  return `${Math.round(sec / 86400)} dni temu`
}
