/**
 * BuildingAdminAssistantController — proxy dla panelu BA → Edge AI assistant.
 *
 * Flow:
 *   BA web (apps/web, Cloud HTTPS + JWT BA)
 *     → Cloud /api/building-admin/buildings/:id/assistant/ask  ← TEN controller
 *     → undici fetch via Tailscale proxy
 *     → Edge http://<edge-ip>:4000/assistant/ask
 *     → Python prototype localhost:8000
 *     → response
 *
 * Auth: jwt-building-admin — `req.user.buildingIds: number[]` (multi-building
 * BA może obsługiwać kilka osiedli). Sprawdzamy że `buildingId` z URL pasuje
 * do listy z JWT (guardBuilding pattern, ten sam co inne BA endpointy).
 *
 * Patrz `resident-assistant.controller.ts` — identyczna architektura, różni
 * się tylko auth + skąd wyciągamy buildingId (BA: URL param, resident: JWT).
 */
import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Logger,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common'
import type { Request } from 'express'
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'
import { BuildingAdminJwtAuthGuard } from './building-admin-jwt-auth.guard'
import { EdgeGateway } from '../edge/edge.gateway'
import { PrismaService } from '../prisma/prisma.service'

const edgeDispatcher: Dispatcher | undefined = process.env.TS_HTTP_PROXY
  ? new ProxyAgent(process.env.TS_HTTP_PROXY)
  : undefined

interface AuthReq extends Request {
  user: { id: number; email: string; buildingIds: number[] }
}

interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
}

interface AssistantBody {
  question?: string
  smart?: boolean
  history?: ConversationTurn[]
}

interface EdgeAssistantResponse {
  answer: string
  trace?: unknown[]
  modelUsed?: string
  totalMs?: number
  intent?: string
  parameters?: Record<string, unknown>
  data?: unknown
  followUps?: string[]
  rewrittenQuestion?: string
}

@Controller('building-admin')
export class BuildingAdminAssistantController {
  private readonly logger = new Logger(BuildingAdminAssistantController.name)

  constructor(
    private readonly edgeGateway: EdgeGateway,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * POST /api/building-admin/buildings/:id/assistant/ask
   * Body: { question: string, smart?: boolean, history?: ConversationTurn[] }
   */
  @Post('buildings/:id/assistant/ask')
  @UseGuards(BuildingAdminJwtAuthGuard)
  async ask(
    @Param('id') id: string,
    @Body() body: AssistantBody,
    @Req() req: AuthReq,
  ) {
    const buildingId = Number(id)
    if (!Number.isInteger(buildingId) || buildingId <= 0) {
      throw new BadRequestException('Nieprawidłowy buildingId')
    }
    // Guard: BA musi mieć ten building w swojej liście (multi-building support).
    if (!req.user.buildingIds.includes(buildingId)) {
      throw new ForbiddenException(`Brak dostępu do budynku ${buildingId}`)
    }

    const question = body?.question?.trim()
    if (!question) {
      throw new BadRequestException('Missing "question" field')
    }
    if (question.length > 500) {
      throw new BadRequestException('Question too long (max 500 chars)')
    }
    const smart = body?.smart !== false
    const history = sanitizeHistory(body?.history)

    // 8.h.32 — cloud-local routing (wzór resident-assistant): pytania o dane
    // z Postgresa (liczba mieszkańców/lokali, naliczenia czynszu per budynek)
    // odpowiadamy bez Edge (~30ms, deterministyczne). Follow-upy (historia +
    // krótkie pytanie) pomijają local routing — kontekst rozwiązuje Edge.
    const skipLocal = history.length > 0 && looksLikeFollowup(question)
    const localAnswer = skipLocal ? null : await this.tryAnswerLocally(question, buildingId)
    if (localAnswer) {
      this.logger.log(
        `[BA ${req.user.id}/building ${buildingId}] LOCAL intent=${localAnswer.intent} ${localAnswer.totalMs}ms`,
      )
      void this.prisma.assistantQueryLog
        .create({
          data: {
            buildingId,
            role: 'BUILDING_ADMIN',
            userId: req.user.id,
            question: question.slice(0, 2000),
            answer: localAnswer.answer.slice(0, 8000),
            intent: localAnswer.intent,
            totalMs: localAnswer.totalMs,
            model: 'cloud-local',
            smart,
          },
        })
        .catch((err: Error) => this.logger.warn(`assistant query log failed: ${err.message}`))
      return localAnswer
    }

    const ip = this.edgeGateway.getEdgeIpForBuilding(buildingId)
    if (!ip) {
      this.logger.warn(`No Edge IP for building ${buildingId} (BA assistant)`)
      throw new ServiceUnavailableException(
        'Asystent niedostępny — Edge tego budynku nie jest aktywny',
      )
    }

    const edgeUrl = `http://${ip}:4000/assistant/ask`
    const edgePayload: Record<string, unknown> = { question, smart }
    if (history.length > 0) edgePayload.history = history

    this.logger.log(
      `[BA ${req.user.id}/building ${buildingId}] → ${edgeUrl} [${smart ? 'smart' : 'fast'}, history=${history.length}] Q=${question.slice(0, 80)}`,
    )

    const start = Date.now()
    let edgeRes: Awaited<ReturnType<typeof undiciFetch>>
    try {
      edgeRes = await undiciFetch(edgeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(edgePayload),
        dispatcher: edgeDispatcher,
        signal: AbortSignal.timeout(60_000),
      })
    } catch (err: any) {
      this.logger.error(`Edge fetch failed (BA): ${err.message}`)
      throw new BadGatewayException(`Edge nie odpowiada: ${err.message}`)
    }

    if (!edgeRes.ok) {
      const text = await edgeRes.text().catch(() => '')
      this.logger.warn(`Edge HTTP ${edgeRes.status}: ${text.slice(0, 200)}`)
      throw new BadGatewayException(`Edge HTTP ${edgeRes.status}`)
    }

    const data = (await edgeRes.json()) as EdgeAssistantResponse
    const wallMs = Date.now() - start
    this.logger.log(
      `[BA building ${buildingId}] ← intent=${data.intent} ${wallMs}ms (edge=${data.totalMs ?? '?'}ms)${data.rewrittenQuestion ? ` rewrite="${data.rewrittenQuestion.slice(0, 60)}"` : ''}`,
    )
    // FAZA 8.h.25 — fire-and-forget log Q/A do oceny w panelu Integratora.
    void this.prisma.assistantQueryLog
      .create({
        data: {
          buildingId,
          role: 'BUILDING_ADMIN',
          userId: req.user.id,
          question: question.slice(0, 2000),
          answer: (data.answer ?? '').slice(0, 8000),
          intent: data.intent ?? null,
          totalMs: data.totalMs ?? wallMs,
          model: data.modelUsed ?? null,
          smart,
        },
      })
      .catch((err: Error) => this.logger.warn(`assistant query log failed: ${err.message}`))
    return data
  }

  // ─── 8.h.32 — cloud-local intents (Postgres, bez Edge) ────────────────────

  /**
   * Próbuje odpowiedzieć lokalnie (dane Cloud). null = forward do Edge.
   * Zakres BA: liczba mieszkańców/lokali + naliczenia czynszu per budynek
   * (suma za bieżący miesiąc + składowe budynkowe).
   */
  private async tryAnswerLocally(
    question: string,
    buildingId: number,
  ): Promise<{
    answer: string
    intent: string
    parameters: Record<string, unknown>
    totalMs: number
    modelUsed: string
    data: unknown
  } | null> {
    const q = question.toLowerCase().trim()
    const start = Date.now()
    try {
      if (
        /il[eu]\s+mieszka[nń]c/i.test(q) ||
        /il[eu]\s+os[óo]b\s+(mieszka|zamieszkuje|żyje)/i.test(q) ||
        /liczba\s+mieszka[nń]c/i.test(q)
      ) {
        return await this.handleResidentsCount(buildingId, start)
      }
      // 2026-08-24 — „kto ma zaległości / którzy mieszkańcy zalegają /
      // lista dłużników": zestawienie zaległości per lokal (BA ma do tego
      // prawo — to jego panel płatności). PRZED czynszem — bardziej
      // specyficzne dopasowanie.
      if (/zaleg[lł]?\w*|d[lł]u[żz]nik\w*|przeterminowan\w*|po\s+terminie/i.test(q)) {
        const arrears = await this.handleArrearsList(buildingId, start)
        if (arrears) return arrears
      }
      const isDocQuestion = /(uchwa[lł]|regulamin|co\s+m[oó]wi|co\s+pisze)/i.test(q)
      if (
        !isDocQuestion &&
        (/(ile|jaki|jaka|jak\s+wysoki)\s+(wynosi\s+)?.{0,15}czynsz/i.test(q) ||
          /czynsz\w*.{0,20}(wynosi|kwota|wysoko|p[lł]ac)/i.test(q) ||
          /z\s+czego\s+sk[lł]ada\s+si[eę].{0,15}(czynsz|op[lł]at)/i.test(q) ||
          /jakie\s+(s[aą]\s+)?op[lł]aty/i.test(q) ||
          /nalicze[nń]\w*.{0,25}(miesi[aą]c|bie[żz][aą]c|suma|[lł][aą]czn)/i.test(q))
      ) {
        return await this.handleRentSummary(buildingId, start)
      }
      return null
    } catch (err: any) {
      this.logger.error(`BA local assistant failed: ${err.message}`)
      return null // fallback do Edge
    }
  }

  private async handleResidentsCount(buildingId: number, start: number) {
    const [b, residentCount, unitCount, vehicleCount] = await Promise.all([
      this.prisma.building.findUnique({ where: { id: buildingId }, select: { name: true } }),
      this.prisma.resident.count({ where: { buildingId } }),
      this.prisma.unit.count({ where: { buildingId } }),
      this.prisma.vehicle.count({ where: { buildingId, status: 'APPROVED' } }),
    ])
    const parts = [
      `Osiedle${b?.name ? ` "${b.name}"` : ''} ma ${residentCount} ${plural(residentCount, 'mieszkańca', 'mieszkańców', 'mieszkańców')}` +
        ` (zarejestrowane konta) w ${unitCount} ${plural(unitCount, 'lokalu', 'lokalach', 'lokalach')}.`,
    ]
    if (vehicleCount > 0) {
      parts.push(
        `Na białej liście pojazdów: ${vehicleCount} ${plural(vehicleCount, 'pojazd', 'pojazdy', 'pojazdów')}.`,
      )
    }
    return {
      answer: parts.join(' '),
      intent: 'residents_count',
      parameters: {},
      totalMs: Date.now() - start,
      modelUsed: 'cloud-building-info',
      data: { name: b?.name, residentCount, unitCount, vehicleCount },
    }
  }

  /**
   * 2026-08-24 — zestawienie zaległości per lokal dla BA („kto ma
   * zaległości?"). Semantyka jak resident handleMyArrears, ale budynkowo
   * i JEDNYM SQL: naliczenia z 12 mies. + wpłaty w miesiącu naliczenia;
   * zaległość = dueDate < NOW() i wpłaty < naliczenie. Top 10 lokali,
   * sortowanie po kwocie. null gdy płatności nieskonfigurowane.
   */
  private async handleArrearsList(buildingId: number, start: number) {
    const rows = await this.prisma.$queryRaw<
      Array<{ unit: string; overdue: number; periods: number; maxDays: number }>
    >`
      SELECT u.number AS unit,
             SUM(pc."totalAmount"::float - paid.total)          AS overdue,
             COUNT(*)::int                                      AS periods,
             MAX(EXTRACT(DAY FROM NOW() - pc."dueDate"))::int   AS "maxDays"
        FROM payment_charges pc
        JOIN units u ON u.id = pc."unitId"
        CROSS JOIN LATERAL (
          SELECT COALESCE(SUM(pe.amount::float), 0) AS total
            FROM payment_entries pe
           WHERE pe."unitId" = pc."unitId"
             AND pe.amount > 0
             AND to_char(pe.date, 'YYYY-MM') = pc.period
        ) paid
       WHERE pc."buildingId" = ${buildingId}
         AND pc."dueDate" < NOW()
         AND pc."dueDate" > NOW() - INTERVAL '12 months'
         AND pc."totalAmount"::float - paid.total > 0.01
       GROUP BY u.number
       ORDER BY overdue DESC
       LIMIT 25
    `
    // Płatności nieskonfigurowane → powiedz to WPROST (fallback do KB dawał
    // mylące „nie znalazłem w dokumentach" — case VN 2026-08-24).
    if (rows.length === 0) {
      const any = await this.prisma.paymentCharge.count({ where: { buildingId } })
      if (any === 0) {
        return {
          answer:
            'Moduł płatności nie ma jeszcze naliczeń dla tego osiedla — ' +
            'zestawienie zaległości pojawi się po skonfigurowaniu płatności ' +
            '(zakładka Płatności → składowe czynszu i naliczenia).',
          intent: 'building_arrears',
          parameters: {},
          totalMs: Date.now() - start,
          modelUsed: 'cloud-building-info',
          data: { configured: false },
        }
      }
    }
    const fmtZl = (n: number) =>
      `${(Math.round(n * 100) / 100).toFixed(2).replace('.', ',')} zł`

    if (rows.length === 0) {
      return {
        answer: 'Żaden lokal nie ma obecnie zaległości w opłatach. 👍',
        intent: 'building_arrears',
        parameters: {},
        totalMs: Date.now() - start,
        modelUsed: 'cloud-building-info',
        data: { units: [] },
      }
    }
    const total = rows.reduce((s2, r) => s2 + r.overdue, 0)
    const top = rows.slice(0, 10)
    const lines = top.map(
      (r) =>
        `• ${r.unit} — ${fmtZl(r.overdue)} (${r.periods} ${r.periods === 1 ? 'okres' : r.periods < 5 ? 'okresy' : 'okresów'}, najstarszy ${r.maxDays} dni po terminie)`,
    )
    const more = rows.length > top.length ? `\n…i ${rows.length - top.length} kolejnych lokali.` : ''
    return {
      answer:
        `Zaległości ma ${rows.length} ${rows.length === 1 ? 'lokal' : rows.length < 5 ? 'lokale' : 'lokali'}, łącznie ${fmtZl(total)}:\n` +
        lines.join('\n') + more +
        `\nSzczegóły i historia wpłat: zakładka Płatności.`,
      intent: 'building_arrears',
      parameters: {},
      totalMs: Date.now() - start,
      modelUsed: 'cloud-building-info',
      data: { units: rows, total },
    }
  }

  /**
   * Naliczenia budynku za bieżący miesiąc: ile lokali ma naliczenie, suma
   * łączna + aktywne składowe budynkowe (unitId NULL). Gdy płatności
   * nieskonfigurowane (0 naliczeń i 0 składowych) → null (Edge/KB).
   */
  private async handleRentSummary(buildingId: number, start: number) {
    const now = new Date()
    const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
    const fmtZl = (n: number) =>
      `${(Math.round(n * 100) / 100).toFixed(2).replace('.', ',')} zł`

    const [agg, components] = await Promise.all([
      this.prisma.paymentCharge.aggregate({
        where: { buildingId, period },
        _count: { id: true },
        _sum: { totalAmount: true },
      }),
      this.prisma.paymentComponent.findMany({
        where: {
          buildingId,
          unitId: null,
          activeFrom: { lte: now },
          OR: [{ activeTo: null }, { activeTo: { gte: now } }],
        },
        orderBy: { id: 'asc' },
      }),
    ])

    const chargeCount = agg._count.id
    const totalSum = Number(agg._sum.totalAmount ?? 0)
    if (chargeCount === 0 && components.length === 0) return null

    const lines: string[] = []
    if (chargeCount > 0) {
      lines.push(
        `Naliczenia czynszu za ${period}: ${chargeCount} ${plural(chargeCount, 'lokal', 'lokale', 'lokali')} ` +
          `na łączną kwotę ${fmtZl(totalSum)}.`,
      )
    } else {
      lines.push(`Za ${period} nie wygenerowano jeszcze naliczeń czynszu.`)
    }
    if (components.length > 0) {
      const compStr = components
        .map((c) =>
          c.calcType === 'PER_SQM'
            ? `${c.name} ${fmtZl(Number(c.amount))}/m²`
            : `${c.name} ${fmtZl(Number(c.amount))}`,
        )
        .join(', ')
      lines.push(`Aktywne składowe budynkowe: ${compStr}.`)
    }
    return {
      answer: lines.join(' '),
      intent: 'building_rent_summary',
      parameters: { period },
      totalMs: Date.now() - start,
      modelUsed: 'cloud-building-info',
      data: {
        period,
        chargeCount,
        totalSum,
        components: components.map((c) => ({
          name: c.name,
          amount: Number(c.amount),
          calcType: c.calcType,
        })),
      },
    }
  }
}

/** Polski plural — `plural(1,'dom','domy','domów')`. */
function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one
  const lastTwo = n % 100
  const last = n % 10
  if (12 <= lastTwo && lastTwo <= 14) return many
  if (2 <= last && last <= 4) return few
  return many
}

/**
 * Mirror heurystyki follow-up z resident-assistant.controller.ts /
 * prototype conversation.py — keep in sync przy modyfikacjach.
 */
const FOLLOWUP_PRONOUN_RE =
  /\b(jego|jej|ich|im|tym|tych|tego|tej|tamten|tamta|tamto|tamtego|tamtej)\b/i
const FOLLOWUP_PREFIX_RE =
  /^(a\s+(?!by)|albo\s+|czy\s+te[zż]\s+|a\s+co\s+z\s+|daj\s+jeszcze|i\s+co\s+(z|jeszcze))/i
const QUESTION_STARTER_RE =
  /^(czy|ile|jak|jakie|jakim|jakich|kto|kiedy|gdzie|czemu|czego|który|która|które|co\s|poka[zż]|wymie[nń]|wy[sś]wietl)\b/i

function looksLikeFollowup(question: string): boolean {
  const q = question.trim()
  if (!q) return false
  const hasPronoun = FOLLOWUP_PRONOUN_RE.test(q)
  if (QUESTION_STARTER_RE.test(q)) return hasPronoun
  const words = q.split(/\s+/).length
  if (q.length <= 30 && words <= 4) return true
  if (q.length > 100) return false
  return hasPronoun || FOLLOWUP_PREFIX_RE.test(q)
}

/**
 * Identyczna logika co resident-assistant.controller.ts (single source of
 * truth jest tam — duplikat tutaj bo unikamy cross-module helper-utili).
 * Limit max 12 ostatnich tur — prototype LLM rewrite tail-trim do 4.
 */
function sanitizeHistory(raw: unknown): ConversationTurn[] {
  if (!Array.isArray(raw)) return []
  const out: ConversationTurn[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = (item as { role?: unknown }).role
    const c = (item as { content?: unknown }).content
    if ((r !== 'user' && r !== 'assistant') || typeof c !== 'string') continue
    const content = c.trim().slice(0, 1000)
    if (!content) continue
    out.push({ role: r, content })
  }
  return out.slice(-12)
}
