/**
 * PROVISIONING (Etap 2, ZA FLAGĄ AKUVOX_PROVISIONING_SYNC=false) — endpoint
 * PUBLICZNY (bez JWT — urządzenie Akuvox nie zrobi Bearer-a), zabezpieczony
 * tokenem HMAC per urządzenie (wzorzec legacy phonebook tokenFor()).
 *
 * GET /api/integrations/akuvox/provisioning/:deviceId/directory?t=<token>
 *
 * Mechanizm wyłącznie po stronie GateLynk: urządzenie samo pobiera plik
 * (wzorzec autop). UWAGA: oficjalna dokumentacja Akuvox NIE potwierdza
 * dystrybucji katalogu użytkowników przez autoprovisioning dla R29 na
 * 29.30.10.x — endpoint przygotowany na zapas, flaga domyślnie OFF, przy
 * wyłączonej fladze odpowiada 404. Zero żądań wychodzących do urządzeń.
 */
import { Controller, Get, Param, ParseIntPipe, Query, Response } from '@nestjs/common'
import type { Response as ExpressResponse } from 'express'
import { AkuvoxDirectoryService } from './akuvox-directory.service'

@Controller('integrations/akuvox/provisioning')
export class AkuvoxProvisioningController {
  constructor(private readonly service: AkuvoxDirectoryService) {}

  @Get(':deviceId/directory')
  async fetchDirectory(
    @Param('deviceId', ParseIntPipe) deviceId: number,
    @Query('t') token: string,
    @Response() res: ExpressResponse,
  ): Promise<void> {
    const file = await this.service.provisioningFetch(deviceId, token ?? '')
    res.setHeader('Content-Type', file.mimeType)
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`)
    res.setHeader('X-Directory-Checksum', file.directoryChecksum)
    res.setHeader('Cache-Control', 'no-cache')
    res.send(file.content)
  }
}
