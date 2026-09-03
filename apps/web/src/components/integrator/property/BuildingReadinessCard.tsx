'use client'
/**
 * BuildingReadinessCard (PR-3, 2026-07-03).
 *
 * Karta „Gotowość obiektu" na stronie budynku Integratora — automatyczna
 * checklista health-check z `GET /integrator/buildings/:id/readiness`
 * (design doc onboarding, Faza 7). Sekcje:
 *   1. Header z overall badge (Gotowy / Prawie gotowy / Niegotowy)
 *      + przycisk „Odśwież"
 *   2. Pasek postępu (ok / ok+warn+fail)
 *   3. Checklista: ikona ✅/⚠️/❌/➖ + label + details
 *
 * Nasłuchuje `integrator:refresh` (przycisk w TopBar) tak jak strona-rodzic.
 */
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  CheckCircle2, AlertTriangle, XCircle, MinusCircle,
  RefreshCw, ClipboardCheck, ChevronRight,
} from 'lucide-react'
import { integratorApi } from '@/lib/integrator-api'
import { Spinner } from '@/components/integrator/property/shared/Spinner'
import { readinessCta, readinessHref } from '@/lib/readiness-links'

type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip'
type Overall = 'ready' | 'almost' | 'not_ready'

interface ReadinessCheck {
  id: string
  label: string
  status: CheckStatus
  details?: string
}

interface ReadinessResponse {
  buildingId: number
  generatedAt: string
  overall: Overall
  score: { ok: number; warn: number; fail: number }
  checks: ReadinessCheck[]
}

const OVERALL_META: Record<Overall, { label: string; pill: string; dot: string; bar: string }> = {
  ready: {
    label: 'Gotowy',
    pill: 'bg-success-50 text-success border-success/30',
    dot: 'bg-success',
    bar: 'bg-success',
  },
  almost: {
    label: 'Prawie gotowy',
    pill: 'bg-warn-50 text-warn border-warn/30',
    dot: 'bg-warn',
    bar: 'bg-warn',
  },
  not_ready: {
    label: 'Niegotowy',
    pill: 'bg-danger-50 text-danger border-danger/30',
    dot: 'bg-danger',
    bar: 'bg-danger',
  },
}

export function BuildingReadinessCard({ buildingId }: { buildingId: string }) {
  const [data, setData] = useState<ReadinessResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (background = false) => {
    if (background) setRefreshing(true)
    try {
      const res = await integratorApi.get<ReadinessResponse>(
        `/integrator/buildings/${buildingId}/readiness`,
      )
      setData(res.data)
      setError(null)
    } catch (err: any) {
      setError(err?.response?.data?.message ?? err?.message ?? 'Błąd ładowania')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [buildingId])

  useEffect(() => {
    load(false)
    const onRefresh = () => load(true)
    window.addEventListener('integrator:refresh', onRefresh)
    return () => window.removeEventListener('integrator:refresh', onRefresh)
  }, [load])

  const scored = data ? data.score.ok + data.score.warn + data.score.fail : 0
  const pct = data && scored > 0 ? Math.round((data.score.ok / scored) * 100) : 0
  const meta = data ? OVERALL_META[data.overall] : null

  return (
    <div className="bg-surface border border-border rounded-r3 p-5 mb-5">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <ClipboardCheck size={16} strokeWidth={1.8} className="text-brand" />
        <h2 className="text-[14px] font-semibold text-ink flex-1">Gotowość obiektu</h2>
        {meta && (
          <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-r1 border ${meta.pill}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
            {meta.label}
          </span>
        )}
        <button
          onClick={() => load(true)}
          disabled={loading || refreshing}
          className="inline-flex items-center gap-1.5 text-[12px] font-medium text-brand hover:text-brand-600 bg-brand-50 px-2.5 py-1.5 rounded-r1 border border-brand/30 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={12} strokeWidth={2} className={refreshing ? 'animate-spin' : ''} />
          Odśwież
        </button>
      </div>

      {loading && !data ? (
        <div className="flex items-center gap-2 py-4 text-muted text-[13px]">
          <Spinner size={14} /> Sprawdzanie gotowości…
        </div>
      ) : error && !data ? (
        <div className="text-[12px] text-danger flex items-center gap-1.5 py-2">
          <AlertTriangle size={13} strokeWidth={2} /> {error}
        </div>
      ) : data && meta ? (
        <>
          {/* Progress bar */}
          <div className="flex items-center gap-3 mb-4">
            <div className="flex-1 h-2 bg-surface-2 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${meta.bar}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-[12px] text-muted whitespace-nowrap">
              <strong className="text-ink">{data.score.ok}</strong>/{scored} checków OK
            </span>
          </div>

          {/* Checklista */}
          <div className="space-y-2.5">
            {data.checks.map((check) => (
              <CheckRow key={check.id} check={check} buildingId={buildingId} />
            ))}
          </div>

          <p className="text-[10px] text-muted-2 mt-3">
            Ostatnie sprawdzenie:{' '}
            {new Date(data.generatedAt).toLocaleTimeString('pl-PL', {
              hour: '2-digit', minute: '2-digit', second: '2-digit',
            })}
          </p>
        </>
      ) : null}
    </div>
  )
}

function CheckRow({ check, buildingId }: { check: ReadinessCheck; buildingId: string }) {
  const icon =
    check.status === 'ok' ? (
      <CheckCircle2 size={15} strokeWidth={2} className="text-success mt-0.5 flex-shrink-0" />
    ) : check.status === 'warn' ? (
      <AlertTriangle size={15} strokeWidth={2} className="text-warn mt-0.5 flex-shrink-0" />
    ) : check.status === 'fail' ? (
      <XCircle size={15} strokeWidth={2} className="text-danger mt-0.5 flex-shrink-0" />
    ) : (
      <MinusCircle size={15} strokeWidth={2} className="text-muted-2 mt-0.5 flex-shrink-0" />
    )

  // Zgłoszenie Konrada 2026-08-01: check wymagający akcji (czerwony/pomarańczowy)
  // ma być klikalny i prowadzić prosto do miejsca konfiguracji. Mapa docelowa
  // wspólna z setup-hubem — patrz lib/readiness-links.ts.
  const needsAction = check.status === 'fail' || check.status === 'warn'
  const href = needsAction ? readinessHref(check.id, buildingId) : null
  const cta = href ? readinessCta(check.id) : null

  const body = (
    <>
      {icon}
      <div className="min-w-0 flex-1">
        <span
          className={`text-[13px] font-medium ${
            check.status === 'skip' ? 'text-muted' : 'text-ink'
          }`}
        >
          {check.label}
        </span>
        {check.details && (
          <p
            className={`text-[12px] ${
              check.status === 'fail'
                ? 'text-danger'
                : check.status === 'warn'
                ? 'text-warn'
                : 'text-muted'
            }`}
          >
            {check.details}
          </p>
        )}
        {cta && (
          <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-brand mt-0.5 group-hover:underline">
            {cta}
            <ChevronRight size={11} strokeWidth={2.2} />
          </span>
        )}
      </div>
    </>
  )

  if (href) {
    return (
      <Link
        href={href}
        title={cta ? `Przejdź: ${cta}` : undefined}
        className="group flex items-start gap-2.5 -mx-2 px-2 py-1 rounded-r1 hover:bg-surface-2 transition-colors cursor-pointer"
      >
        {body}
      </Link>
    )
  }

  return <div className="flex items-start gap-2.5">{body}</div>
}
