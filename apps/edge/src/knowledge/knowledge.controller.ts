/**
 * KnowledgeController — HTTP endpoint dla semantic search w bazie wiedzy.
 *
 * POST /knowledge/search
 *   Body: { query: string, type?: string, limit?: number, minScore?: number }
 *
 * Używane przez:
 *  • Prototype intent classifier (ai-prototype/app.py) — gdy intent =
 *    search_knowledge_base, prototype calluje ten endpoint, dostaje top-K
 *    chunków i zwraca user-friendly answer (template lub LLM smart mode).
 *  • Future: bezpośrednio iOS app / Edge UI dla manual search.
 *
 * Edge nie ma global prefix `/api` (Cloud API ma, Edge NIE) — endpoint
 * jest pod `http://<edge>:4000/knowledge/search`.
 */
import { BadRequestException, Body, Controller, Get, Logger, Post, Query } from '@nestjs/common'
import { KnowledgeService } from './knowledge.service'

const VALID_TYPES = ['MESSENGER_CHAT', 'UCHWALA', 'REGULAMIN', 'KONTAKT', 'INNE']

@Controller('knowledge')
export class KnowledgeController {
  private readonly logger = new Logger(KnowledgeController.name)
  constructor(private readonly knowledge: KnowledgeService) {}

  /**
   * Semantic search po chunkach z bazy wiedzy (bge-m3 cosine similarity).
   *
   * @returns { query, type, hitCount, hits: [{docId, type, title, chunkIdx, text, score}] }
   *          score zaokrąglone do 3 miejsc po przecinku (czytelność dla UI/LLM).
   */
  @Post('search')
  async search(
    @Body()
    body: {
      query?: string
      type?: string
      limit?: number
      minScore?: number
    },
  ) {
    const query = body?.query?.trim()
    if (!query) throw new BadRequestException('Missing "query"')
    if (query.length > 500) throw new BadRequestException('Query too long (max 500)')

    const type = body.type && VALID_TYPES.includes(body.type) ? body.type : undefined
    const limit = Math.min(Math.max(body.limit ?? 5, 1), 20)
    const minScore = typeof body.minScore === 'number' ? body.minScore : 0.4

    this.logger.log(
      `POST /knowledge/search query="${query.slice(0, 80)}" type=${type ?? 'any'} limit=${limit} minScore=${minScore}`,
    )

    const hits = await this.knowledge.search(query, { type, limit, minScore })

    return {
      query,
      type: type ?? null,
      hitCount: hits.length,
      hits: hits.map((h) => ({
        docId: h.cloudId,
        type: h.type,
        title: h.title,
        chunkIdx: h.chunkIdx,
        text: h.text,
        score: Math.round(h.score * 1000) / 1000,
      })),
    }
  }

  /**
   * GET /knowledge/docs?type=INNE — pełne (NIE-chunkowane) teksty dokumentów.
   *
   * FAZA 8.h.28 — structured calendar (harmonogram śmieci jako per-dzień
   * eventy w iOS Kalendarzu). Search zwraca tylko top-K chunków przyciętych do
   * ~800 znaków; deterministyczny parser dat per frakcja potrzebuje PEŁNEGO
   * tekstu dokumentu. Harmonogram śmieci jest uploadowany jako type=INNE.
   *
   * Read-only, lokalny LAN endpoint (Edge nie ma `/api` prefiksu) — woła go
   * wyłącznie ai-prototype na localhost:8000.
   */
  @Get('docs')
  async docs(@Query('type') type?: string) {
    const filter = type && VALID_TYPES.includes(type) ? type : undefined
    const docs = this.knowledge.listDocTexts(filter)
    return {
      type: filter ?? null,
      count: docs.length,
      docs,
    }
  }
}
