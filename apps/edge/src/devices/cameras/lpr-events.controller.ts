import { All, Controller, Headers, Logger, Param, Req } from '@nestjs/common'
import type { Request } from 'express'
import { HikvisionLprService } from './hikvision-lpr.service'
import {
  extractAnprXml,
  parseAnprFields,
  extractAllAnprImages,
  pickBestAnprImage,
} from './anpr-xml-parser'

/**
 * HTTP endpoint that Hikvision ANPR cameras POST to when they detect a plate.
 *
 * Hikvision sends one of:
 *   • application/xml              — inline EventNotificationAlert
 *   • multipart/form-data          — XML part + attached vehicle/plate JPEG(s)
 *
 * `main.ts` mounts `express.raw({ type: any, limit: '10mb' })` for this
 * prefix, so `req.body` arrives as a Buffer — critical for recovering the
 * embedded JPEG bytes without UTF-8 corruption.
 *
 * Refactor 2026-07-05 (MVP „stare kamery"): cały parsing XML/multipart
 * wydzielony do `anpr-xml-parser.ts` (czysty moduł, testowalny standalone —
 * `apps/edge/tools/test-anpr-parser.ts`). Tolerancja na starsze firmware
 * (inne namespace'y, brak pól vehicle*, float confidence) żyje tam.
 */
@Controller('events/lpr')
export class LprEventsController {
  private readonly logger = new Logger(LprEventsController.name)

  constructor(private readonly lpr: HikvisionLprService) {}

  @All('hikvision/:cameraDeviceId')
  async receive(
    @Param('cameraDeviceId') cameraDeviceId: string,
    @Req() req: Request,
    @Headers('content-type') contentType = '',
  ) {
    const raw = await this.readRawBuffer(req)
    if (!raw || raw.length === 0) {
      this.logger.debug(`Empty body from camera ${cameraDeviceId}`)
      return { ok: true, ignored: 'empty' }
    }

    const xml = extractAnprXml(raw, contentType)
    if (!xml) {
      this.logger.debug(`No XML found in event from ${cameraDeviceId}`)
      return { ok: true, ignored: 'no_xml' }
    }

    // Recognise non-ANPR events (motion, IO, etc.) by absence of the plate field.
    const fields = parseAnprFields(xml)
    if (!fields.plate) {
      this.logger.debug(`Event ${fields.eventType ?? '?'} from ${cameraDeviceId} has no plate, skipping`)
      return { ok: true, ignored: 'no_plate' }
    }

    // Pull the best JPEG attachment — Hikvision typically sends 1–3 images
    // (plate crop, vehicle crop, full scene). We want the full-scene shot so
    // the operator can see the whole car including brand/logo.
    const images = extractAllAnprImages(raw, contentType)
    const best = pickBestAnprImage(images)

    this.logger.log(
      `ANPR event from ${cameraDeviceId}: plate=${fields.plate} conf=${fields.confidence} dir=${fields.direction ?? '-'} ` +
      `color=${fields.vehicleColor ?? '-'} brand=${fields.vehicleBrand ?? '-'} type=${fields.vehicleType ?? '-'} ` +
      `images=[${images.map(i => `${i.name || '?'}:${i.data.length}B`).join(', ') || '-'}] ` +
      `picked=${best ? `${best.name || '?'}:${best.data.length}B` : '-'}`,
    )
    const image = best?.data ?? null

    const result = await this.lpr.handleAnprEvent(cameraDeviceId, fields.plate, {
      confidence: fields.confidence,
      direction: fields.direction,
      vehicleColor: fields.vehicleColor,
      vehicleBrand: fields.vehicleBrand,
      vehicleType: fields.vehicleType,
      vehicleSubtype: fields.vehicleSubtype,
      image,
      // Raw XML kept for diagnostic dump alongside the JPEG, so if a
      // firmware exposes brand under an exotic tag we can still recover
      // it after the fact without waiting for another detection.
      rawXml: xml,
    })
    return { ok: true, ...result }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────
  /**
   * `express.raw` populates `req.body` as a Buffer; fall back to streaming
   * the request ourselves if the middleware didn't grab it (e.g. an unusual
   * content-type skipped the matcher).
   */
  private async readRawBuffer(req: Request): Promise<Buffer> {
    const body = (req as any).body
    if (Buffer.isBuffer(body) && body.length > 0) return body
    if (typeof body === 'string' && body.length > 0) return Buffer.from(body, 'utf8')
    if ((req as any).readable) {
      return new Promise<Buffer>((resolve) => {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
        req.on('end',  () => resolve(Buffer.concat(chunks)))
        req.on('error', () => resolve(Buffer.alloc(0)))
      })
    }
    return Buffer.alloc(0)
  }
}
