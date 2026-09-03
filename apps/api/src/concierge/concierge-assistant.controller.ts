/**
 * ConciergeAssistantController — proxy dla panelu konsjerża → Edge AI assistant.
 *
 * Flow:
 *   Concierge web (apps/web, Cloud HTTPS + JWT concierge)
 *     → Cloud /api/concierge/assistant/ask  ← TEN controller
 *     → undici fetch via Tailscale proxy
 *     → Edge http://<edge-ip>:4000/assistant/ask
 *     → Python prototype localhost:8000
 *     → response
 *
 * Auth: jwt-concierge — `req.user.buildingId: number` (concierge zawsze
 * obsługuje DOKŁADNIE jeden budynek, w przeciwieństwie do BA multi-building).
 * Nie ma URL param `:id` — buildingId zawsze z JWT.
 *
 * Patrz `resident-assistant.controller.ts` i `building-admin-assistant.controller.ts`
 * — identyczna architektura, różni się tylko skąd pochodzi buildingId.
 */
import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common'
import type { Request } from 'express'
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'
import { ConciergeJwtAuthGuard } from './concierge-jwt-auth.guard'
import { EdgeGateway } from '../edge/edge.gateway'

const edgeDispatcher: Dispatcher | undefined = process.env.TS_HTTP_PROXY
  ? new ProxyAgent(process.env.TS_HTTP_PROXY)
  : undefined

interface AuthReq extends Request {
  user: { sub: number; email: string; buildingId: number }
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

@Controller('concierge')
export class ConciergeAssistantController {
  private readonly logger = new Logger(ConciergeAssistantController.name)

  constructor(private readonly edgeGateway: EdgeGateway) {}

  /**
   * POST /api/concierge/assistant/ask
   * Body: { question: string, smart?: boolean, history?: ConversationTurn[] }
   */
  @Post('assistant/ask')
  @UseGuards(ConciergeJwtAuthGuard)
  async ask(@Body() body: AssistantBody, @Req() req: AuthReq) {
    const buildingId = req.user.buildingId
    if (!Number.isInteger(buildingId) || buildingId <= 0) {
      throw new BadRequestException('JWT concierge bez prawidłowego buildingId')
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

    const ip = this.edgeGateway.getEdgeIpForBuilding(buildingId)
    if (!ip) {
      this.logger.warn(`No Edge IP for building ${buildingId} (concierge assistant)`)
      throw new ServiceUnavailableException(
        'Asystent niedostępny — Edge tego budynku nie jest aktywny',
      )
    }

    const edgeUrl = `http://${ip}:4000/assistant/ask`
    const edgePayload: Record<string, unknown> = { question, smart }
    if (history.length > 0) edgePayload.history = history

    this.logger.log(
      `[concierge ${req.user.sub}/building ${buildingId}] → ${edgeUrl} [${smart ? 'smart' : 'fast'}, history=${history.length}] Q=${question.slice(0, 80)}`,
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
      this.logger.error(`Edge fetch failed (concierge): ${err.message}`)
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
      `[concierge building ${buildingId}] ← intent=${data.intent} ${wallMs}ms (edge=${data.totalMs ?? '?'}ms)${data.rewrittenQuestion ? ` rewrite="${data.rewrittenQuestion.slice(0, 60)}"` : ''}`,
    )
    return data
  }
}

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
