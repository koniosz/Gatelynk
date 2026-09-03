import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common'
import type { Response } from 'express'
import { LprReadsService } from './lpr-reads.service'
import { verifyPushMediaToken } from './push-media-token'

/**
 * Publiczne zdjęcia do powiadomień push (2026-08-12).
 *
 * `GET /push-media/lpr/:token` — Notification Service Extension w iOS pobiera
 * stąd kadr z pojazdem gościa, zanim pokaże push „Gość wjechał/wyjechał".
 * BEZ guardu JWT użytkownika: rozszerzenie powiadomień nie ma sesji, więc
 * autoryzacją jest podpisany, krótkożyciowy token wskazujący jedno konkretne
 * zdjęcie (szczegóły w push-media-token.ts). Obraz płynie tunelem WS z Edge
 * — tą samą drogą co miniatury LPR w panelu.
 */
@Controller('push-media')
export class PushMediaController {
  constructor(private readonly svc: LprReadsService) {}

  @Get('lpr/:token')
  async lprImage(@Param('token') token: string, @Res() res: Response) {
    const payload = verifyPushMediaToken(token)
    if (!payload) throw new NotFoundException()

    const buf = await this.svc.fetchSnapshotByEdgeReadId(payload.buildingId, payload.edgeReadId)
    if (!buf) throw new NotFoundException()

    res.setHeader('Content-Type', 'image/jpeg')
    // Zdjęcie jest niezmienne — APNs może retry'ować pobranie, cache pomaga.
    res.setHeader('Cache-Control', 'private, max-age=7200')
    res.send(buf)
  }
}
