/**
 * Akuvox Directory Sync v2 — routing (pkt 16/17 spec). Kontroler = TYLKO
 * routing; logika w AkuvoxDirectoryService.
 *
 * Prefix globalny /api jest w main.ts → pełne ścieżki:
 *   GET    /api/integrations/akuvox/buildings/:buildingId/devices
 *   POST   /api/integrations/akuvox/buildings/:buildingId/devices
 *   PATCH  /api/integrations/akuvox/devices/:deviceId
 *   GET    /api/integrations/akuvox/devices/:deviceId/capabilities
 *   GET    /api/integrations/akuvox/devices/:deviceId/directory
 *   POST   /api/integrations/akuvox/devices/:deviceId/directory/template
 *   POST   /api/integrations/akuvox/devices/:deviceId/directory/device-export
 *   POST   /api/integrations/akuvox/devices/:deviceId/directory/sync/preview
 *   POST   /api/integrations/akuvox/devices/:deviceId/directory/sync/export
 *   POST   /api/integrations/akuvox/devices/:deviceId/directory/sync/apply
 *   GET    /api/integrations/akuvox/devices/:deviceId/directory/sync/history
 *   GET    /api/integrations/akuvox/devices/:deviceId/directory/sync/:syncId
 *
 * RBAC (pkt 18): wyłącznie Integrator (instalator) — IntegratorJwtAuthGuard.
 * Feature flag AKUVOX_DIRECTORY_V2=false → 404 na całej sekcji.
 */
import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Request,
  Response,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import type { Response as ExpressResponse } from 'express'
import { IntegratorJwtAuthGuard } from '../integrator/integrator-jwt-auth.guard'
import { AkuvoxDirectoryConfigService } from './akuvox-directory-config.service'
import { AkuvoxDirectoryService } from './akuvox-directory.service'
import type { UpsertAkuvoxDeviceDto } from './akuvox-directory.service'

interface IntegratorRequest {
  user: { sub: number; adminId: number; email: string }
}

@Controller('integrations/akuvox')
@UseGuards(IntegratorJwtAuthGuard)
export class AkuvoxDirectoryController {
  constructor(
    private readonly service: AkuvoxDirectoryService,
    private readonly config: AkuvoxDirectoryConfigService,
  ) {}

  private assertEnabled(): void {
    if (!this.config.flags.directoryV2) {
      throw new NotFoundException('Akuvox Directory v2 wyłączony (flaga AKUVOX_DIRECTORY_V2)')
    }
  }

  private operator(req: IntegratorRequest): string {
    return `INTEGRATOR:${req.user.sub} (${req.user.email})`
  }

  @Get('flags')
  getFlags() {
    return this.config.flags
  }

  @Get('buildings/:buildingId/devices')
  listDevices(@Param('buildingId', ParseIntPipe) buildingId: number, @Request() req: IntegratorRequest) {
    this.assertEnabled()
    return this.service.listDevices(buildingId, req.user.adminId)
  }

  @Post('buildings/:buildingId/devices')
  createDevice(
    @Param('buildingId', ParseIntPipe) buildingId: number,
    @Body() dto: UpsertAkuvoxDeviceDto,
    @Request() req: IntegratorRequest,
  ) {
    this.assertEnabled()
    return this.service.createDevice(buildingId, req.user.adminId, dto)
  }

  @Patch('devices/:deviceId')
  updateDevice(
    @Param('deviceId', ParseIntPipe) deviceId: number,
    @Body() dto: Partial<UpsertAkuvoxDeviceDto>,
    @Request() req: IntegratorRequest,
  ) {
    this.assertEnabled()
    return this.service.updateDevice(deviceId, req.user.adminId, dto)
  }

  @Get('devices/:deviceId/capabilities')
  getCapabilities(@Param('deviceId', ParseIntPipe) deviceId: number, @Request() req: IntegratorRequest) {
    this.assertEnabled()
    return this.service.getCapabilities(deviceId, req.user.adminId)
  }

  @Get('devices/:deviceId/directory')
  getDirectory(@Param('deviceId', ParseIntPipe) deviceId: number, @Request() req: IntegratorRequest) {
    this.assertEnabled()
    return this.service.getDirectory(deviceId, req.user.adminId)
  }

  @Post('devices/:deviceId/directory/template')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  uploadTemplate(
    @Param('deviceId', ParseIntPipe) deviceId: number,
    @UploadedFile() file: { originalname: string; buffer: Buffer } | undefined,
    @Request() req: IntegratorRequest,
  ) {
    this.assertEnabled()
    if (!file) throw new NotFoundException('Brak pliku (pole formularza: file)')
    return this.service.uploadTemplate(deviceId, req.user.adminId, file, this.operator(req))
  }

  @Post('devices/:deviceId/directory/device-export')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  uploadDeviceExport(
    @Param('deviceId', ParseIntPipe) deviceId: number,
    @UploadedFile() file: { originalname: string; buffer: Buffer } | undefined,
    @Request() req: IntegratorRequest,
  ) {
    this.assertEnabled()
    if (!file) throw new NotFoundException('Brak pliku (pole formularza: file)')
    return this.service.uploadDeviceExport(deviceId, req.user.adminId, file, this.operator(req))
  }

  @Post('devices/:deviceId/directory/sync/preview')
  preview(@Param('deviceId', ParseIntPipe) deviceId: number, @Request() req: IntegratorRequest) {
    this.assertEnabled()
    return this.service.preview(deviceId, req.user.adminId, this.operator(req))
  }

  @Post('devices/:deviceId/directory/sync/export')
  async exportFile(
    @Param('deviceId', ParseIntPipe) deviceId: number,
    @Request() req: IntegratorRequest,
    @Response() res: ExpressResponse,
  ) {
    this.assertEnabled()
    const file = await this.service.exportFile(deviceId, req.user.adminId, this.operator(req))
    res.setHeader('Content-Type', file.mimeType)
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`)
    res.setHeader('X-Directory-Checksum', file.directoryChecksum)
    res.setHeader('X-Sync-Run-Id', String(file.syncRunId))
    res.send(file.content)
  }

  @Post('devices/:deviceId/directory/sync/apply')
  apply(@Param('deviceId', ParseIntPipe) deviceId: number, @Request() req: IntegratorRequest) {
    this.assertEnabled()
    return this.service.applyConfirm(deviceId, req.user.adminId, this.operator(req))
  }

  // ── Etap 2: kreator migracji legacy → v2 (pkt 20) ───────────────────────────

  @Post('devices/:deviceId/migration/preview')
  migrationPreview(@Param('deviceId', ParseIntPipe) deviceId: number, @Request() req: IntegratorRequest) {
    this.assertEnabled()
    return this.service.migrationPreview(deviceId, req.user.adminId)
  }

  @Post('devices/:deviceId/migration/adopt')
  migrationAdopt(@Param('deviceId', ParseIntPipe) deviceId: number, @Request() req: IntegratorRequest) {
    this.assertEnabled()
    return this.service.migrationAdopt(deviceId, req.user.adminId, this.operator(req))
  }

  // ── Etap 2: PROVISIONING info (fetch przez urządzenie = osobny publiczny
  //    kontroler AkuvoxProvisioningController) ─────────────────────────────────

  @Get('devices/:deviceId/provisioning-info')
  provisioningInfo(@Param('deviceId', ParseIntPipe) deviceId: number, @Request() req: IntegratorRequest) {
    this.assertEnabled()
    return this.service.provisioningInfo(deviceId, req.user.adminId)
  }

  @Get('devices/:deviceId/directory/sync/history')
  history(
    @Param('deviceId', ParseIntPipe) deviceId: number,
    @Query('limit') limit: string | undefined,
    @Request() req: IntegratorRequest,
  ) {
    this.assertEnabled()
    return this.service.history(deviceId, req.user.adminId, limit ? Number(limit) : undefined)
  }

  @Get('devices/:deviceId/directory/sync/:syncId')
  getSyncRun(
    @Param('deviceId', ParseIntPipe) deviceId: number,
    @Param('syncId', ParseIntPipe) syncId: number,
    @Request() req: IntegratorRequest,
  ) {
    this.assertEnabled()
    return this.service.getSyncRun(deviceId, syncId, req.user.adminId)
  }
}
