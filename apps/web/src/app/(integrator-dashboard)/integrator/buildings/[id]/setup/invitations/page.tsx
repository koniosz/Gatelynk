'use client'
/**
 * PR-6 (2026-07-05) — Zaproszenia mieszkańców (setup-hub).
 *
 * Lista mieszkańców ze statusem konta:
 *   aktywny / zaproszony / wygasłe / bez e-maila / niezaproszony
 * + „Wyślij zaproszenia" (bulk do wszystkich bez konta) + resend pojedynczo.
 *
 * Endpointy:
 *   GET  /integrator/buildings/:id/resident-invitations
 *   POST /integrator/buildings/:id/resident-invitations/bulk-send
 *   POST /integrator/buildings/:id/resident-invitations/:residentId/resend
 *
 * Gdy backend nie ma skonfigurowanego Resend (dev), response bulk-send
 * zawiera `inviteUrl` per mieszkaniec — pokazujemy przycisk „Kopiuj link".
 */
import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeft, Mail, Send, RefreshCw, CheckCircle2, Clock,
  AlertTriangle, MinusCircle, Copy,
} from 'lucide-react'
import { integratorApi } from '@/lib/integrator-api'
import { Spinner } from '@/components/integrator/property/shared/Spinner'

type Status = 'active' | 'invited' | 'expired' | 'no_email' | 'not_invited'

interface Row {
  residentId: number
  firstName: string
  lastName: string
  email: string | null
  unitNumber: string | null
  status: Status
  lastSentAt: string | null
  lastExpiresAt: string | null
}

interface BulkResult {
  sent: number
  skipped: number
  failed: number
  results: Array<{
    residentId: number
    email: string | null
    status: 'sent' | 'skipped' | 'failed'
    reason?: string
    inviteUrl?: string
  }>
}

const STATUS_META: Record<Status, { label: string; cls: string; icon: React.ReactNode }> = {
  active: {
    label: 'aktywny',
    cls: 'bg-success-50 text-success border-success/30',
    icon: <CheckCircle2 size={12} strokeWidth={2} />,
  },
  invited: {
    label: 'zaproszony',
    cls: 'bg-brand-50 text-brand border-brand/30',
    icon: <Clock size={12} strokeWidth={2} />,
  },
  expired: {
    label: 'zaproszenie wygasło',
    cls: 'bg-warn-50 text-warn border-warn/30',
    icon: <AlertTriangle size={12} strokeWidth={2} />,
  },
  no_email: {
    label: 'bez e-maila',
    cls: 'bg-surface-2 text-muted border-border',
    icon: <MinusCircle size={12} strokeWidth={2} />,
  },
  not_invited: {
    label: 'niezaproszony',
    cls: 'bg-danger-50 text-danger border-danger/30',
    icon: <Mail size={12} strokeWidth={2} />,
  },
}

export default function InvitationsPage() {
  const { id } = useParams()
  const buildingId = id as string

  const [rows, setRows] = useState<Row[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [resendBusy, setResendBusy] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null)
  const [inviteUrls, setInviteUrls] = useState<Map<number, string>>(new Map())

  const load = useCallback(async () => {
    try {
      const res = await integratorApi.get<Row[]>(
        `/integrator/buildings/${buildingId}/resident-invitations`,
      )
      setRows(res.data)
      setError(null)
    } catch (err: any) {
      setError(err?.response?.data?.message ?? err?.message ?? 'Błąd ładowania')
    } finally {
      setLoading(false)
    }
  }, [buildingId])

  useEffect(() => { load() }, [load])

  const bulkSend = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await integratorApi.post<BulkResult>(
        `/integrator/buildings/${buildingId}/resident-invitations/bulk-send`,
      )
      setBulkResult(res.data)
      // dev-mode: zbierz inviteUrl per resident (brak Resend → link ręczny)
      const urls = new Map<number, string>()
      for (const r of res.data.results) {
        if (r.inviteUrl) urls.set(r.residentId, r.inviteUrl)
      }
      setInviteUrls(urls)
      await load()
    } catch (err: any) {
      setError(err?.response?.data?.message ?? err?.message ?? 'Błąd wysyłki')
    } finally {
      setBusy(false)
    }
  }, [buildingId, load])

  const resend = useCallback(async (residentId: number) => {
    setResendBusy(residentId)
    setError(null)
    try {
      const res = await integratorApi.post<{ inviteUrl?: string }>(
        `/integrator/buildings/${buildingId}/resident-invitations/${residentId}/resend`,
      )
      if (res.data.inviteUrl) {
        setInviteUrls((prev) => new Map(prev).set(residentId, res.data.inviteUrl!))
      }
      await load()
    } catch (err: any) {
      setError(err?.response?.data?.message ?? err?.message ?? 'Błąd wysyłki')
    } finally {
      setResendBusy(null)
    }
  }, [buildingId, load])

  const invitable = rows?.filter((r) => r.status === 'not_invited' || r.status === 'expired').length ?? 0
  const counts = rows
    ? {
        active: rows.filter((r) => r.status === 'active').length,
        invited: rows.filter((r) => r.status === 'invited').length,
        noEmail: rows.filter((r) => r.status === 'no_email').length,
      }
    : null

  return (
    <div className="max-w-4xl mx-auto">
      <Link
        href={`/integrator/buildings/${buildingId}/setup`}
        className="inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-ink mb-4 transition-colors"
      >
        <ArrowLeft size={13} /> Wróć do checklisty
      </Link>

      <div className="bg-surface border border-border rounded-r3 p-5 mb-5">
        <div className="flex items-center gap-2.5 mb-1">
          <Mail size={18} strokeWidth={1.8} className="text-brand" />
          <h1 className="text-[16px] font-semibold text-ink flex-1">Zaproszenia mieszkańców</h1>
          <button
            onClick={() => { setLoading(true); load() }}
            disabled={loading}
            className="inline-flex items-center gap-1.5 text-[12px] font-medium text-brand hover:text-brand-600 bg-brand-50 px-2.5 py-1.5 rounded-r1 border border-brand/30 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={12} strokeWidth={2} className={loading ? 'animate-spin' : ''} />
            Odśwież
          </button>
        </div>
        <p className="text-[12px] text-muted mb-4">
          Mieszkaniec dostaje e-mail z linkiem, ustawia własne hasło i loguje się w aplikacji
          iOS. Zaproszenie jest ważne 7 dni — po wygaśnięciu można wysłać ponownie.
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={bulkSend}
            disabled={busy || invitable === 0}
            className="inline-flex items-center gap-2 text-[13px] font-semibold text-white bg-brand hover:bg-brand-600 px-4 py-2 rounded-r2 transition-colors disabled:opacity-50"
          >
            {busy ? <Spinner size={13} /> : <Send size={14} strokeWidth={2} />}
            Wyślij zaproszenia ({invitable})
          </button>
          {counts && (
            <span className="text-[12px] text-muted">
              {counts.active} aktywnych · {counts.invited} zaproszonych · {counts.noEmail} bez e-maila
            </span>
          )}
        </div>
        {bulkResult && (
          <p className="text-[12px] text-ink-2 mt-3 bg-surface-2 rounded-r1 px-2.5 py-1.5">
            Wysłano: <strong>{bulkResult.sent}</strong>
            {bulkResult.skipped > 0 && <> · pominięto: {bulkResult.skipped}</>}
            {bulkResult.failed > 0 && <> · <span className="text-danger">błędy: {bulkResult.failed}</span></>}
            {inviteUrls.size > 0 && (
              <> · serwer bez konfiguracji e-mail — skopiuj linki przyciskami poniżej</>
            )}
          </p>
        )}
      </div>

      {error && (
        <div className="bg-danger-50 border border-danger/30 rounded-r3 p-3.5 mb-4 text-[13px] text-danger">
          {error}
        </div>
      )}

      {loading && !rows ? (
        <div className="flex items-center gap-2 py-6 text-muted text-[13px]">
          <Spinner size={14} /> Ładowanie…
        </div>
      ) : rows && rows.length === 0 ? (
        <div className="text-center py-10 text-muted text-[13px]">
          Brak mieszkańców —{' '}
          <Link href={`/integrator/buildings/${buildingId}/setup/import`} className="text-brand hover:underline">
            zaimportuj z CSV
          </Link>
        </div>
      ) : rows ? (
        <div className="bg-surface border border-border rounded-r3 overflow-hidden">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="bg-surface-2 text-muted text-left">
                <th className="px-3 py-2 font-medium">Mieszkaniec</th>
                <th className="px-3 py-2 font-medium">Lokal</th>
                <th className="px-3 py-2 font-medium">E-mail</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Wysłano</th>
                <th className="px-3 py-2 font-medium text-right">Akcje</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const meta = STATUS_META[r.status]
                const canResend = r.status !== 'active' && r.status !== 'no_email'
                const url = inviteUrls.get(r.residentId)
                return (
                  <tr key={r.residentId} className="border-t border-border">
                    <td className="px-3 py-2 text-ink font-medium">{r.firstName} {r.lastName}</td>
                    <td className="px-3 py-2 text-ink-2">{r.unitNumber ?? '—'}</td>
                    <td className="px-3 py-2 text-ink-2">{r.email ?? <span className="text-muted-2">brak</span>}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-r1 border ${meta.cls}`}>
                        {meta.icon} {meta.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted">
                      {r.lastSentAt
                        ? new Date(r.lastSentAt).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
                        : '—'}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {url && (
                        <button
                          onClick={() => navigator.clipboard.writeText(url)}
                          title="Kopiuj link zaproszenia (serwer bez e-mail)"
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-muted hover:text-ink mr-2 transition-colors"
                        >
                          <Copy size={12} /> link
                        </button>
                      )}
                      {canResend && (
                        <button
                          onClick={() => resend(r.residentId)}
                          disabled={resendBusy === r.residentId}
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-brand hover:text-brand-600 transition-colors disabled:opacity-50"
                        >
                          {resendBusy === r.residentId ? <Spinner size={11} /> : <Send size={12} />}
                          {r.status === 'invited' ? 'wyślij ponownie' : 'zaproś'}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}
