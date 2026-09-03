/**
 * BuildingKnowledgeService — RAG repozytorium dokumentów per budynek.
 *
 * **Prisma 5.22 drift workaround:** Cały serwis używa raw SQL (`$queryRaw` /
 * `$executeRaw`) zamiast typed Prisma Client, bo `prisma generate` jest
 * popsute w monorepo (vide CLAUDE.md "Faza 7.1"). Migracja w bazie jest
 * (`20260518220000_add_building_knowledge_docs`), tylko Client nie zna typu.
 *
 * Upload flow:
 *   1. Building admin wgrywa plik (Messenger JSON / PDF / DOCX / CSV).
 *   2. Cloud parsuje content → parsedText + metadata.
 *   3. Cloud insert do Postgres + enqueue KNOWLEDGE_UPSERT przez EdgeOutbox.
 *   4. Edge dostaje action, embeduje (bge-m3), indeksuje.
 *   5. LLM dostaje tool `search_knowledge` → semantic search.
 */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { EdgeOutboxService } from '../edge/edge-outbox.service'
import {
  parseMessengerFile,
  mergeMessengerFiles,
  formatThreadAsText,
  type ParsedMessengerThread,
} from './messenger-parser'
import { parseDocument } from './document-parser'

export type KnowledgeType = 'MESSENGER_CHAT' | 'UCHWALA' | 'REGULAMIN' | 'KONTAKT' | 'INNE'

export interface KnowledgeListItem {
  id: number
  type: KnowledgeType
  title: string
  metadata: any
  fileExt: string | null
  fileSizeB: number | null
  uploadedAt: Date
  preview: string
}

@Injectable()
export class BuildingKnowledgeService {
  private readonly logger = new Logger(BuildingKnowledgeService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: EdgeOutboxService,
  ) {}

  async uploadMessengerChat(
    buildingId: number,
    uploadedBy: number,
    body: { title?: string; rawJson?: string; rawJsonFiles?: string[] },
  ) {
    const inputs: string[] = []
    if (body.rawJson) inputs.push(body.rawJson)
    if (Array.isArray(body.rawJsonFiles)) inputs.push(...body.rawJsonFiles)
    if (inputs.length === 0) {
      throw new BadRequestException('Wymagany `rawJson` albo `rawJsonFiles[]`')
    }

    let threads: ParsedMessengerThread[]
    try {
      threads = inputs.map((raw) => parseMessengerFile(raw))
    } catch (err: any) {
      throw new BadRequestException(`Nieprawidłowy Messenger JSON: ${err.message}`)
    }
    const merged = mergeMessengerFiles(threads)
    if (merged.messages.length === 0) {
      throw new BadRequestException('Plik nie zawiera żadnych wiadomości')
    }

    const parsedText = formatThreadAsText(merged)
    const title = body.title?.trim() || merged.title || `Rozmowa z ${merged.participants[0] ?? 'Messenger'}`
    const metadata = {
      participants: merged.participants,
      messageCount: merged.messages.length,
      startTs: merged.startTs,
      endTs: merged.endTs,
      perSenderCount: merged.perSenderCount,
    }
    const fileSizeB = Buffer.byteLength(parsedText, 'utf8')

    const inserted = await this.prisma.$queryRaw<Array<{ id: number; uploadedAt: Date }>>`
      INSERT INTO "building_knowledge_docs"
        ("buildingId", "type", "title", "parsedText", "metadata", "fileExt", "fileSizeB", "uploadedBy", "updatedAt")
      VALUES
        (${buildingId}, 'MESSENGER_CHAT'::"BuildingKnowledgeType", ${title}, ${parsedText},
         ${metadata}::jsonb, 'json', ${fileSizeB}, ${uploadedBy}, NOW())
      RETURNING "id", "uploadedAt"
    `
    const doc = inserted[0]

    await this.syncToEdge(buildingId, 'KNOWLEDGE_UPSERT', {
      id: doc.id,
      type: 'MESSENGER_CHAT',
      title,
      parsedText,
      metadata,
    })

    this.logger.log(
      `[building ${buildingId}] Messenger chat uploaded: doc=${doc.id} title="${title}" msgs=${merged.messages.length}`,
    )

    return {
      id: doc.id,
      type: 'MESSENGER_CHAT' as const,
      title,
      messageCount: merged.messages.length,
      participants: merged.participants,
      sizeBytes: fileSizeB,
    }
  }

  /**
   * Upload PDF/DOCX/TXT/MD pliku (multipart). Cloud parsuje → plain text
   * → Postgres + sync do Edge.
   *
   * @param buildingId
   * @param uploadedBy  Building Admin ID (z JWT)
   * @param type        UCHWALA | REGULAMIN | INNE (Messenger ma osobny endpoint)
   * @param file        Express.Multer.File { buffer, originalname, mimetype, size }
   * @param title       Optional override — domyślnie parser detected lub filename
   */
  async uploadFile(
    buildingId: number,
    uploadedBy: number,
    type: KnowledgeType,
    file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
    title?: string,
  ) {
    if (!['UCHWALA', 'REGULAMIN', 'INNE'].includes(type)) {
      throw new BadRequestException(`File upload tylko dla UCHWALA/REGULAMIN/INNE. Otrzymano: ${type}`)
    }
    if (!file?.buffer || file.buffer.length === 0) {
      throw new BadRequestException('Pusty plik')
    }
    if (file.size > 20 * 1024 * 1024) {
      throw new BadRequestException('Plik > 20 MB — wgrywaj krótsze fragmenty')
    }

    let parsed
    try {
      parsed = await parseDocument(file.buffer, file.originalname, file.mimetype)
    } catch (err: any) {
      throw new BadRequestException(`Nie udało się sparsować pliku: ${err.message}`)
    }
    if (!parsed.text || parsed.text.length < 10) {
      throw new BadRequestException(
        'Plik nie zawiera tekstu (pewnie skan PDF). OCR nie jest jeszcze wspierany — wpisz treść ręcznie.',
      )
    }

    const finalTitle = title?.trim() || parsed.detectedTitle || file.originalname.replace(/\.[^.]+$/, '')
    const metadata = {
      originalFilename: file.originalname,
      mimeType: file.mimetype,
      pageCount: parsed.pageCount,
      uploadedFileSize: file.size,
    }
    const fileSizeB = Buffer.byteLength(parsed.text, 'utf8')
    const typeEnum = Prisma.sql([`'${type}'::"BuildingKnowledgeType"`])

    const inserted = await this.prisma.$queryRaw<Array<{ id: number }>>`
      INSERT INTO "building_knowledge_docs"
        ("buildingId", "type", "title", "parsedText", "metadata", "fileExt", "fileSizeB", "uploadedBy", "updatedAt")
      VALUES
        (${buildingId}, ${typeEnum}, ${finalTitle}, ${parsed.text},
         ${metadata as any}::jsonb, ${parsed.fileExt}, ${fileSizeB}, ${uploadedBy}, NOW())
      RETURNING "id"
    `
    const doc = inserted[0]

    await this.syncToEdge(buildingId, 'KNOWLEDGE_UPSERT', {
      id: doc.id,
      type,
      title: finalTitle,
      parsedText: parsed.text,
      metadata,
    })

    this.logger.log(
      `[building ${buildingId}] ${type} file uploaded: doc=${doc.id} title="${finalTitle}" ` +
        `pages=${parsed.pageCount ?? '?'} chars=${parsed.text.length}`,
    )

    return {
      id: doc.id,
      type,
      title: finalTitle,
      pageCount: parsed.pageCount,
      charCount: parsed.text.length,
      fileExt: parsed.fileExt,
    }
  }

  async uploadPlainText(
    buildingId: number,
    uploadedBy: number,
    body: { type: KnowledgeType; title: string; content: string; metadata?: Record<string, any> },
  ) {
    if (!body.title?.trim()) throw new BadRequestException('Wymagany `title`')
    if (!body.content?.trim()) throw new BadRequestException('Wymagany `content`')
    if (!['UCHWALA', 'REGULAMIN', 'KONTAKT', 'INNE'].includes(body.type)) {
      throw new BadRequestException(`Nieprawidłowy type: ${body.type}`)
    }

    const title = body.title.trim()
    const content = body.content.trim()
    const metadata = body.metadata ?? {}
    const fileSizeB = Buffer.byteLength(content, 'utf8')
    // Prisma.sql interpolacja TypeName::Enum bezpiecznie (cast nie SQL injection-able):
    const typeEnum = Prisma.sql([`'${body.type}'::"BuildingKnowledgeType"`])

    const inserted = await this.prisma.$queryRaw<Array<{ id: number }>>`
      INSERT INTO "building_knowledge_docs"
        ("buildingId", "type", "title", "parsedText", "metadata", "fileExt", "fileSizeB", "uploadedBy", "updatedAt")
      VALUES
        (${buildingId}, ${typeEnum}, ${title}, ${content},
         ${metadata as any}::jsonb, NULL, ${fileSizeB}, ${uploadedBy}, NOW())
      RETURNING "id"
    `
    const doc = inserted[0]

    await this.syncToEdge(buildingId, 'KNOWLEDGE_UPSERT', {
      id: doc.id,
      type: body.type,
      title,
      parsedText: content,
      metadata,
    })

    this.logger.log(`[building ${buildingId}] ${body.type} uploaded: doc=${doc.id} title="${title}"`)
    return { id: doc.id, type: body.type, title }
  }

  async list(buildingId: number, type?: KnowledgeType): Promise<KnowledgeListItem[]> {
    const whereType = type
      ? Prisma.sql`AND "type" = ${Prisma.sql([`'${type}'::"BuildingKnowledgeType"`])}`
      : Prisma.empty
    const rows = await this.prisma.$queryRaw<Array<{
      id: number
      type: KnowledgeType
      title: string
      metadata: any
      fileExt: string | null
      fileSizeB: number | null
      uploadedAt: Date
      parsedText: string
    }>>`
      SELECT "id", "type", "title", "metadata", "fileExt", "fileSizeB", "uploadedAt", "parsedText"
        FROM "building_knowledge_docs"
       WHERE "buildingId" = ${buildingId}
         AND "isArchived" = false
         ${whereType}
       ORDER BY "uploadedAt" DESC
    `
    return rows.map((d) => ({
      id: d.id,
      type: d.type,
      title: d.title,
      metadata: d.metadata,
      fileExt: d.fileExt,
      fileSizeB: d.fileSizeB,
      uploadedAt: d.uploadedAt,
      preview: d.parsedText.slice(0, 200) + (d.parsedText.length > 200 ? '…' : ''),
    }))
  }

  async getById(buildingId: number, docId: number) {
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT * FROM "building_knowledge_docs"
       WHERE "id" = ${docId} AND "buildingId" = ${buildingId} AND "isArchived" = false
       LIMIT 1
    `
    if (rows.length === 0) throw new NotFoundException(`Knowledge doc ${docId} not found`)
    return rows[0]
  }

  async remove(buildingId: number, docId: number) {
    const found = await this.prisma.$queryRaw<Array<{ id: number }>>`
      SELECT "id" FROM "building_knowledge_docs"
       WHERE "id" = ${docId} AND "buildingId" = ${buildingId} AND "isArchived" = false
       LIMIT 1
    `
    if (found.length === 0) throw new NotFoundException(`Knowledge doc ${docId} not found`)

    await this.prisma.$executeRaw`
      UPDATE "building_knowledge_docs"
         SET "isArchived" = true, "archivedAt" = NOW(), "updatedAt" = NOW()
       WHERE "id" = ${docId}
    `
    await this.syncToEdge(buildingId, 'KNOWLEDGE_DELETE', { id: docId })

    this.logger.log(`[building ${buildingId}] doc=${docId} archived`)
    return { archived: true }
  }

  private async syncToEdge(buildingId: number, action: string, payload: any) {
    try {
      await this.outbox.enqueueForBuilding(buildingId, action, payload)
    } catch (err: any) {
      this.logger.warn(`Failed to enqueue ${action} for building ${buildingId}: ${err.message}`)
    }
  }
}
