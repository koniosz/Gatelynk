'use client'
/**
 * PR-4 (2026-07-05) — Setup-hub: checklista-orkiestrator uruchomienia obiektu
 * (design doc docs/design/onboarding-instalacja-budynku-2026-07.md, Faza 4,
 * decyzja D7: checklista-hub zamiast sztywnego steppera).
 *
 * Strona sterowana readiness endpointem (PR-3):
 *   GET /integrator/buildings/:id/readiness → checks[] (ok/warn/fail/skip)
 * Każdy check = karta ze statusem, opisem PL „co zrobić" i linkiem prosto
 * do właściwego miejsca panelu. Statusy auto-wyliczane z danych — strona
 * jest wizard-em przy pierwszym uruchomieniu i widokiem „stan konfiguracji"
 * później. Checki `skip` = „nie dotyczy" (np. konsjerż/AI wyłączone
 * w features obiektu) — szare, nie czerwone.
 */
import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import {
  CheckCircle2, AlertTriangle, XCircle, MinusCircle, RefreshCw,
  ChevronRight, ClipboardCheck, Cpu, Router, DoorOpen, Camera,
  UserCog, Users, Mail, Bot, ConciergeBell, ArrowLeft,
} from 'lucide-react'
import { integratorApi } from '@/lib/integrator-api'
import { readinessCta, readinessHref } from '@/lib/readiness-links'
import { Spinner } from '@/components/integrator/property/shared/Spinner'

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

/** Meta per check: ikona, PL opis „co zrobić" i link do miejsca w panelu.
 *  Linki (href/cta) — wspólny moduł lib/readiness-links.ts (2026-08-01). */
const CHECK_META: Record<string, {
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>
  todo: string
}> = {
  edge: {
    icon: Cpu,
    todo: 'Wygeneruj kod aktywacyjny, a instalator wpisze go w Edge UI on-site (http://<edge>:4000/ui → Ustawienia). Po aktywacji Edge łączy się z chmurą automatycznie.',
  },
  devices: {
    icon: Router,
    todo: 'Urządzenia (domofony, kamery, przekaźniki) dodaje instalator w Edge UI (wizard 5 kroków, on-site). Tutaj zweryfikuj, czy wszystkie są widoczne i dostępne.',
  },
  access_points: {
    icon: DoorOpen,
    todo: 'Utwórz punkty dostępu i przypnij każdy do urządzenia + wyjścia przekaźnika (binding device→output→czas). Przetestuj przyciskiem „Test".',
  },
  lpr: {
    icon: Camera,
    todo: 'Każda kamera LPR musi mieć powiązanie z punktem dostępu (kierunek IN/OUT). Na koniec wykonaj testowy przejazd autem z whitelisty.',
  },
  building_admin: {
    icon: UserCog,
    todo: 'Utwórz konto administratora budynku (zarządcy). Konto BA zakładane jest obecnie w legacy panelu superadmina — poproś GateLynk, jeśli nie masz dostępu.',
  },
  concierge: {
    icon: ConciergeBell,
    todo: 'Obiekt ma włączonego konsjerża w ustawieniach typu obiektu. Utwórz konto konsjerża albo wyłącz funkcję w karcie „Typ obiektu i funkcje".',
  },
  building_data: {
    icon: Users,
    todo: 'Zaimportuj lokale i mieszkańców z pliku CSV (imię, nazwisko, e-mail, telefon, lokal). Lokale utworzą się automatycznie.',
  },
  invitations: {
    icon: Mail,
    todo: 'Wyślij zaproszenia e-mail — mieszkaniec klika link, ustawia hasło i loguje się w aplikacji iOS. Hasła nie są nigdzie przekazywane ręcznie.',
  },
  ai_engine: {
    icon: Bot,
    todo: 'Skonfiguruj URL AI Engine i wykonaj test połączenia — albo pozostaw wyłączone, jeśli obiekt nie ma analityki AI.',
  },
}

const OVERALL_META: Record<Overall, { label: string; pill: string; dot: string; bar: string; desc: string }> = {
  ready: {
    label: 'Gotowy',
    pill: 'bg-success-50 text-success border-success/30',
    dot: 'bg-success',
    bar: 'bg-success',
    desc: 'Wszystkie checki przeszły — obiekt gotowy do oddania.',
  },
  almost: {
    label: 'Prawie gotowy',
    pill: 'bg-warn-50 text-warn border-warn/30',
    dot: 'bg-warn',
    bar: 'bg-warn',
    desc: 'Zostały ostrzeżenia — przejrzyj karty poniżej.',
  },
  not_ready: {
    label: 'Niegotowy',
    pill: 'bg-danger-50 text-danger border-danger/30',
    dot: 'bg-danger',
    bar: 'bg-danger',
    desc: 'Część checków nie przechodzi — zacznij od czerwonych kart.',
  },
}

export default function SetupHubPage() {
  const { id } = useParams()
  const buildingId = id as string

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
    <div className="max-w-4xl mx-auto">
      <Link
        href={`/integrator/buildings/${buildingId}`}
        className="inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-ink mb-4 transition-colors"
      >
        <ArrowLeft size={13} /> Wróć do obiektu
      </Link>

      {/* Header — ogólny status gotowości */}
      <div className="bg-surface border border-border rounded-r3 p-5 mb-5">
        <div className="flex items-center gap-2.5 mb-1">
          <ClipboardCheck size={18} strokeWidth={1.8} className="text-brand" />
          <h1 className="text-[16px] font-semibold text-ink flex-1">
            Uruchomienie obiektu — checklista
          </h1>
          {meta && (
            <span className={`inline-flex items-center gap-1.5 text-[12px] font-medium px-2.5 py-1 rounded-r1 border ${meta.pill}`}>
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
        <p className="text-[12px] text-muted mb-3">
          Statusy wyliczają się automatycznie z danych obiektu — kolejność kroków jest dowolna.
          {meta ? ` ${meta.desc}` : ''}
        </p>
        {data && meta && (
          <div className="flex items-center gap-3">
            <div className="flex-1 h-2 bg-surface-2 rounded-full overflow-hidden">
              <div className={`h-full rounded-full transition-all ${meta.bar}`} style={{ width: `${pct}%` }} />
            </div>
            <span className="text-[12px] text-muted whitespace-nowrap">
              <strong className="text-ink">{data.score.ok}</strong>/{scored} checków OK
            </span>
          </div>
        )}
      </div>

      {loading && !data ? (
        <div className="flex items-center gap-2 py-8 text-muted text-[13px]">
          <Spinner size={14} /> Sprawdzanie gotowości…
        </div>
      ) : error && !data ? (
        <div className="text-[13px] text-danger flex items-center gap-1.5 py-4">
          <AlertTriangle size={14} strokeWidth={2} /> {error}
        </div>
      ) : data ? (
        <div className="space-y-3">
          {data.checks.map((check, i) => (
            <CheckCard key={check.id} check={check} index={i + 1} buildingId={buildingId} />
          ))}
          <p className="text-[10px] text-muted-2 pt-1">
            Ostatnie sprawdzenie:{' '}
            {new Date(data.generatedAt).toLocaleTimeString('pl-PL', {
              hour: '2-digit', minute: '2-digit', second: '2-digit',
            })}
          </p>
        </div>
      ) : null}
    </div>
  )
}

function CheckCard({ check, index, buildingId }: {
  check: ReadinessCheck
  index: number
  buildingId: string
}) {
  const m = CHECK_META[check.id]
  const Icon = m?.icon ?? MinusCircle
  const href = readinessHref(check.id, buildingId)
  const isSkip = check.status === 'skip'

  const statusIcon =
    check.status === 'ok' ? <CheckCircle2 size={18} strokeWidth={2} className="text-success" />
    : check.status === 'warn' ? <AlertTriangle size={18} strokeWidth={2} className="text-warn" />
    : check.status === 'fail' ? <XCircle size={18} strokeWidth={2} className="text-danger" />
    : <MinusCircle size={18} strokeWidth={2} className="text-muted-2" />

  const border =
    check.status === 'fail' ? 'border-danger/40'
    : check.status === 'warn' ? 'border-warn/40'
    : 'border-border'

  return (
    <div className={`bg-surface border ${border} rounded-r3 p-4 ${isSkip ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-r2 bg-surface-2 flex items-center justify-center flex-shrink-0">
          <Icon size={16} strokeWidth={1.8} className="text-muted" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-2 font-medium">{index}.</span>
            <span className={`text-[14px] font-semibold ${isSkip ? 'text-muted' : 'text-ink'}`}>
              {check.label}
            </span>
            {isSkip && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-surface-2 text-muted border border-border">
                nie dotyczy
              </span>
            )}
            <span className="ml-auto flex-shrink-0">{statusIcon}</span>
          </div>
          {check.details && (
            <p className={`text-[12px] mt-0.5 ${
              check.status === 'fail' ? 'text-danger'
              : check.status === 'warn' ? 'text-warn'
              : 'text-muted'
            }`}>
              {check.details}
            </p>
          )}
          {!isSkip && check.status !== 'ok' && m?.todo && (
            <p className="text-[12px] text-ink-2 mt-2 bg-surface-2 rounded-r1 px-2.5 py-1.5">
              {m.todo}
            </p>
          )}
          {href && !isSkip && (
            <Link
              href={href}
              className="inline-flex items-center gap-1 text-[12px] font-medium text-brand hover:text-brand-600 mt-2 transition-colors"
            >
              {readinessCta(check.id) ?? 'Przejdź'} <ChevronRight size={13} />
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}
