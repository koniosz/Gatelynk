/**
 * Edge KnowledgeService — RAG storage + retrieval dla Building Knowledge.
 *
 * Pipeline:
 *  1. KNOWLEDGE_UPSERT przez tunnel → `upsert(payload)`
 *  2. Chunkujemy parsedText (~800 znaków, 150 znaków overlap)
 *  3. Każdy chunk → embedding via Ollama bge-m3 (1024-dim)
 *  4. Insert do `knowledge_chunks` (BLOB embeddings)
 *  5. Search: query → embedding → brute-force cosine vs all chunks → top-K
 *
 * Performance: brute-force scan O(N×1024) gdzie N to liczba chunków.
 * Dla 10K chunków × 1024 dim = 10M float ops = ~30ms na M2.
 * Wystarczy aż portfolio osiągnie ~100K chunków (kilkanaście budynków × tysiąc dokumentów).
 *
 * Memory: 1024 × 4 bytes = 4 KB per chunk. 10K chunków = 40 MB w RAM gdy cache.
 *
 * Polish embeddings: bge-m3 jest multilingual (100+ languages), wytrenowany na
 * polskich danych — dobry recall dla pytań typu "co mówi uchwała o psach?".
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { StoreService } from '../store/store.service'

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434'
const EMBED_MODEL = process.env.GLE_EMBED_MODEL ?? 'bge-m3'
const EMBED_DIM = 1024 // bge-m3 dimensionality
const EMBED_TIMEOUT_MS = 30_000

/** Chunking config — ~800 znaków/chunk z 150 znaków overlap. */
const CHUNK_CHARS = 800
const CHUNK_OVERLAP = 150

export interface KnowledgeSearchHit {
  cloudId: number
  type: string
  title: string
  chunkIdx: number
  text: string
  score: number // cosine similarity, 0..1 (wyższe = bardziej relevant)
}

@Injectable()
export class KnowledgeService implements OnModuleInit {
  private readonly logger = new Logger(KnowledgeService.name)

  constructor(private readonly store: StoreService) {}

  onModuleInit() {
    // Samonaprawa: dokument z chunk_count=0 to ślad po nieudanym embedzie przy
    // pierwotnym KNOWLEDGE_UPSERT (np. Ollama nieosiągalna — incydent VN
    // 2026-08-14: brak OLLAMA_URL w plist → ECONNREFUSED 127.0.0.1:11434,
    // a Cloud nie ma ścieżki resync). Retry przy starcie + co 30 min; gdy
    // wszystko zindeksowane, przebieg jest darmowym SELECT-em.
    const run = () =>
      this.reindexUnindexed().catch((err: any) =>
        this.logger.warn(`Re-index nieudany: ${err?.message ?? err}`),
      )
    setTimeout(run, 20_000)
    setInterval(run, 30 * 60_000)
  }

  /** Ponowna indeksacja dokumentów bez chunków — nie dotyka rekordu doc-a (metadata zostaje). */
  private async reindexUnindexed(): Promise<void> {
    const pending = this.store.knowledgeListDocs().filter((d) => d.chunkCount === 0)
    if (pending.length === 0) return
    const texts = new Map(this.store.knowledgeListDocTexts().map((d) => [d.cloudId, d.parsedText]))
    for (const doc of pending) {
      const parsedText = texts.get(doc.cloudId)
      if (!parsedText) continue
      const chunks = this.chunkText(parsedText)
      this.store.knowledgeDeleteChunks(doc.cloudId)
      let embedded = 0
      for (let idx = 0; idx < chunks.length; idx++) {
        try {
          const emb = await this.embed(chunks[idx])
          this.store.knowledgeInsertChunk({ docId: doc.cloudId, chunkIdx: idx, text: chunks[idx], embedding: emb })
          embedded++
        } catch (err: any) {
          this.logger.warn(`Re-index embed failed doc=${doc.cloudId} chunk=${idx}: ${err.message}`)
        }
      }
      this.store.knowledgeMarkIndexed(doc.cloudId, embedded)
      this.logger.log(`Re-index doc ${doc.cloudId} ("${doc.title}"): ${embedded}/${chunks.length} chunks`)
    }
  }

  /**
   * Receiver dla tunnel KNOWLEDGE_UPSERT. Pełny upsert — zastępuje istniejące
   * chunki nowymi (jeśli doc był updateowany na Cloud).
   *
   * Payload: { id, type, title, parsedText, metadata }
   */
  async upsert(payload: {
    id: number
    type: string
    title: string
    parsedText: string
    metadata?: any
  }): Promise<{ chunks: number; durationMs: number }> {
    const start = Date.now()
    const { id, type, title, parsedText, metadata } = payload

    // 1. Insert/update doc record
    this.store.knowledgeUpsertDoc({
      cloudId: id,
      type,
      title,
      parsedText,
      metadata: metadata ? JSON.stringify(metadata) : null,
    })

    // 2. Wipe old chunks (idempotent upsert pattern)
    this.store.knowledgeDeleteChunks(id)

    // 3. Chunk text
    const chunks = this.chunkText(parsedText)
    this.logger.log(`Doc ${id} (${title}): ${parsedText.length} chars → ${chunks.length} chunks`)

    // 4. Embed each chunk + store
    let embedded = 0
    for (let idx = 0; idx < chunks.length; idx++) {
      try {
        const emb = await this.embed(chunks[idx])
        this.store.knowledgeInsertChunk({
          docId: id,
          chunkIdx: idx,
          text: chunks[idx],
          embedding: emb,
        })
        embedded++
      } catch (err: any) {
        this.logger.warn(`Embed failed for doc=${id} chunk=${idx}: ${err.message}`)
      }
    }

    // 5. Mark indexed
    this.store.knowledgeMarkIndexed(id, embedded)

    const durationMs = Date.now() - start
    this.logger.log(`Doc ${id} indexed: ${embedded}/${chunks.length} chunks in ${durationMs}ms`)
    return { chunks: embedded, durationMs }
  }

  /**
   * Pełne teksty dokumentów (NIE chunki) danego typu — dla structured calendar
   * parsera (FAZA 8.h.28). Cienki passthrough do StoreService; trzymamy go tu
   * żeby KnowledgeController nie zależał bezpośrednio od StoreService.
   */
  listDocTexts(type?: string): Array<{
    cloudId: number
    type: string
    title: string
    parsedText: string
  }> {
    return this.store.knowledgeListDocTexts(type)
  }

  /** Receiver dla KNOWLEDGE_DELETE — usuwa doc + chunks. */
  async remove(payload: { id: number }): Promise<{ removed: boolean }> {
    this.store.knowledgeDeleteDoc(payload.id)
    return { removed: true }
  }

  /**
   * Semantic search — query embedding → cosine similarity z każdym chunkiem →
   * top-K rankowane.
   *
   * @param query  natural language pytanie ("co mówi uchwała o psach?")
   * @param opts.type  optional filter po typie ('UCHWALA' itp.)
   * @param opts.limit  top-K (default 5, max 20)
   * @param opts.minScore  filter low-quality matches (default 0.4)
   */
  async search(
    query: string,
    opts: { type?: string; limit?: number; minScore?: number } = {},
  ): Promise<KnowledgeSearchHit[]> {
    const limit = Math.min(Math.max(opts.limit ?? 5, 1), 20)
    const minScore = opts.minScore ?? 0.4

    const queryEmb = await this.embed(query)
    const candidates = this.store.knowledgeListAllChunks(opts.type)

    // Scoring
    const scored: KnowledgeSearchHit[] = candidates
      .map((c) => ({
        cloudId: c.docId,
        type: c.type,
        title: c.title,
        chunkIdx: c.chunkIdx,
        text: c.text,
        score: cosineSimilarity(queryEmb, c.embedding),
      }))
      .filter((h) => h.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    this.logger.log(`Search "${query.slice(0, 50)}" → ${scored.length}/${candidates.length} hits, top=${scored[0]?.score.toFixed(3) ?? 'n/a'}`)
    return scored
  }

  /**
   * Chunk text z overlap — utrzymuje kontekst między granicami.
   * Splituje na granicach zdania/akapitu gdy możliwe (mniej truncated context).
   */
  private chunkText(text: string): string[] {
    if (!text || text.length === 0) return []
    if (text.length <= CHUNK_CHARS) return [text]

    const chunks: string[] = []
    let start = 0
    while (start < text.length) {
      let end = Math.min(start + CHUNK_CHARS, text.length)
      // Prefer split na granicy akapitu (\n\n) → potem zdania (. ) → potem dowolnej spacji
      if (end < text.length) {
        const para = text.lastIndexOf('\n\n', end)
        const sent = text.lastIndexOf('. ', end)
        const space = text.lastIndexOf(' ', end)
        // Preferuj boundary najbliższy CHUNK_CHARS (ale >= start + min size)
        const minEnd = start + CHUNK_CHARS * 0.7
        if (para > minEnd) end = para + 2
        else if (sent > minEnd) end = sent + 2
        else if (space > minEnd) end = space + 1
      }
      const chunk = text.slice(start, end).trim()
      if (chunk) chunks.push(chunk)
      if (end >= text.length) break
      start = end - CHUNK_OVERLAP // step back overlap chars
    }
    return chunks
  }

  /**
   * Call Ollama embed API → Float32Array (1024-dim).
   * Buffered as raw bytes for sqlite BLOB storage.
   */
  private async embed(text: string): Promise<Buffer> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS)
    try {
      const res = await fetch(`${OLLAMA_URL}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, input: text }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`Ollama embed HTTP ${res.status}`)
      const data: { embeddings: number[][] } = await res.json()
      const vec = data.embeddings?.[0]
      if (!vec || vec.length !== EMBED_DIM) {
        throw new Error(`Invalid embedding response: len=${vec?.length}`)
      }
      // Pack as Float32 LE bytes (4 bytes × 1024 = 4096 bytes)
      const buf = Buffer.alloc(EMBED_DIM * 4)
      for (let i = 0; i < EMBED_DIM; i++) {
        buf.writeFloatLE(vec[i], i * 4)
      }
      return buf
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Cosine similarity dla dwóch Float32 vectors (jako Buffers).
 * Returns 0..1 dla unit-normalized embeddings (bge-m3 produces normalized).
 * Range -1..1 generalnie, ale bge-m3 zwraca w 0..1.
 */
function cosineSimilarity(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) return 0
  const n = a.length / 4
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < n; i++) {
    const av = a.readFloatLE(i * 4)
    const bv = b.readFloatLE(i * 4)
    dot += av * bv
    normA += av * av
    normB += bv * bv
  }
  if (normA === 0 || normB === 0) return 0
  return dot / Math.sqrt(normA * normB)
}
