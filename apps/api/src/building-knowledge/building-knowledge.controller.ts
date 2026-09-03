/**
 * BuildingKnowledgeController — endpointy dla Building Admin do zarządzania
 * repozytorium wiedzy LLM (Messenger chaty, uchwały, regulaminy, kontakty).
 *
 * Auth: building-admin JWT. Każdy endpoint walidowany przez guard +
 * cross-tenant check (admin może być przypisany do wielu budynków,
 * sprawdzamy `buildingAdminAssignments`).
 *
 *   POST   /building-admin/buildings/:id/knowledge/messenger  → upload Messenger JSON
 *   POST   /building-admin/buildings/:id/knowledge/text       → upload plain text
 *   GET    /building-admin/buildings/:id/knowledge            → list (?type=...)
 *   GET    /building-admin/buildings/:id/knowledge/:docId     → full doc
 *   DELETE /building-admin/buildings/:id/knowledge/:docId     → soft-delete
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { FileInterceptor } from '@nestjs/platform-express'
import type { Request } from 'express'
import { BuildingKnowledgeService, type KnowledgeType } from './building-knowledge.service'
import { PrismaService } from '../prisma/prisma.service'

// JWT building-admin strategy returns { id, email, buildingIds } (NIE `sub`!).
// Patrz: apps/api/src/building-admin/building-admin-jwt.strategy.ts:validate().
interface AuthReq extends Request {
  user: { id: number; email: string; buildingIds: number[] }
}

@Controller('building-admin/buildings/:id/knowledge')
@UseGuards(AuthGuard('jwt-building-admin'))
export class BuildingKnowledgeController {
  constructor(
    private readonly service: BuildingKnowledgeService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Sprawdza czy building-admin ma assignment do tego budynku.
   * Throws ForbiddenException gdy nie. Zapobiega cross-tenant access.
   */
  private async guardBuilding(req: AuthReq, buildingId: number): Promise<number> {
    const baId = req.user.id
    const assignment = await this.prisma.buildingAdminAssignment.findFirst({
      where: { buildingAdminId: baId, buildingId },
    })
    if (!assignment) {
      throw new ForbiddenException(`Brak dostępu do budynku ${buildingId}`)
    }
    return baId
  }

  /**
   * POST messenger upload.
   * Body: { title?: string, rawJson: string }
   * Albo:  { title?: string, rawJsonFiles: string[] }   (multi-chunk thread)
   */
  @Post('messenger')
  async uploadMessenger(
    @Param('id', ParseIntPipe) buildingId: number,
    @Body() body: { title?: string; rawJson?: string; rawJsonFiles?: string[] },
    @Req() req: AuthReq,
  ) {
    const baId = await this.guardBuilding(req, buildingId)
    return this.service.uploadMessengerChat(buildingId, baId, body)
  }

  /**
   * POST file upload (multipart). Dla PDF/DOCX/TXT/MD → UCHWALA/REGULAMIN/INNE.
   * Body multipart: file=<binary>, type=UCHWALA, title?=...
   */
  @Post('file')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  async uploadFile(
    @Param('id', ParseIntPipe) buildingId: number,
    @UploadedFile() file: {
      buffer: Buffer
      originalname: string
      mimetype: string
      size: number
    },
    @Body() body: { type: KnowledgeType; title?: string },
    @Req() req: AuthReq,
  ) {
    const baId = await this.guardBuilding(req, buildingId)
    if (!file) throw new BadRequestException('Brak pliku (oczekiwany field "file" w multipart)')
    return this.service.uploadFile(buildingId, baId, body.type, file, body.title)
  }

  /**
   * POST plain-text upload. Dla UCHWALA / REGULAMIN / KONTAKT / INNE.
   * Body: { type, title, content, metadata? }
   */
  @Post('text')
  async uploadText(
    @Param('id', ParseIntPipe) buildingId: number,
    @Body()
    body: {
      type: KnowledgeType
      title: string
      content: string
      metadata?: Record<string, any>
    },
    @Req() req: AuthReq,
  ) {
    const baId = await this.guardBuilding(req, buildingId)
    return this.service.uploadPlainText(buildingId, baId, body)
  }

  /**
   * GET list. Optional ?type=MESSENGER_CHAT|UCHWALA|REGULAMIN|KONTAKT|INNE filter.
   */
  @Get()
  async list(
    @Param('id', ParseIntPipe) buildingId: number,
    @Query('type') type: string | undefined,
    @Req() req: AuthReq,
  ) {
    await this.guardBuilding(req, buildingId)
    const validTypes: KnowledgeType[] = ['MESSENGER_CHAT', 'UCHWALA', 'REGULAMIN', 'KONTAKT', 'INNE']
    const typeFilter = type && validTypes.includes(type as KnowledgeType) ? (type as KnowledgeType) : undefined
    return this.service.list(buildingId, typeFilter)
  }

  /** GET pojedynczy doc z pełnym parsedText. */
  @Get(':docId')
  async getOne(
    @Param('id', ParseIntPipe) buildingId: number,
    @Param('docId', ParseIntPipe) docId: number,
    @Req() req: AuthReq,
  ) {
    await this.guardBuilding(req, buildingId)
    return this.service.getById(buildingId, docId)
  }

  /** Soft-delete + KNOWLEDGE_DELETE do Edge. */
  @Delete(':docId')
  async remove(
    @Param('id', ParseIntPipe) buildingId: number,
    @Param('docId', ParseIntPipe) docId: number,
    @Req() req: AuthReq,
  ) {
    await this.guardBuilding(req, buildingId)
    return this.service.remove(buildingId, docId)
  }
}
