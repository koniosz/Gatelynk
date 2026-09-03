/**
 * IntercomSnapshotController (Edge) — snapshot kamery Akuvox dla AKTYWNEJ sesji
 * połączenia domofonowego. Hybrydowe wideo (docs/intercom-akuvox-call.md):
 * WebRTC-wideo Akuvoxa nie działa (H.264 packetization-mode=0 + libwebrtc
 * odrzuca `m=video`), więc obraz gościa pokazujemy ze snapshotów kamery panelu.
 * Audio WebRTC zostaje BEZ ZMIAN — to osobny, niezależny endpoint HTTP.
 *
 * Flow:
 *   iOS → Cloud /resident/intercom/calls/:id/snapshot (proxy)
 *       → Edge GET /assistant/intercom-snapshot?session=<id>  ← TEN controller
 *       → IntercomCallService.resolveAkuvoxDeviceIdForSession  (sesja → deviceId)
 *       → DeviceRegistryService.quickSnapshot(deviceId, skipCache=true)  (GetSnapshot)
 *       → image/jpeg
 *
 * Reużywamy istniejącej ścieżki snapshotu (`quickSnapshot` → fast-path Akuvox
 * GetSnapshot w device-registry) — NIE duplikujemy logiki pobierania kadru.
 *
 * Prefix `assistant` współdzielony z AssistantController (różne route — brak
 * kolizji), spójnie z resztą proxy iOS↔Edge (assistant.controller `day-summary`
 * / `calendar`). Brak guardu — Edge nie jest publiczny (LAN/Tailscale, Cloud
 * pełni rolę bramy z JWT).
 */
import { Controller, Get, Logger, Post, Query, Res } from '@nestjs/common'
import type { Response } from 'express'
import { DeviceRegistryService } from '../device-registry.service'
import { IntercomCallService } from './intercom-call.service'

@Controller('assistant')
export class IntercomSnapshotController {
  private readonly logger = new Logger(IntercomSnapshotController.name)

  constructor(
    private readonly calls: IntercomCallService,
    private readonly registry: DeviceRegistryService,
  ) {}

  /**
   * GET /assistant/intercom-snapshot?session=<id>
   * Zwraca świeży (live=1) JPEG kamery Akuvox przypisanej do sesji.
   * 204 gdy: feature off, brak session param, sesja/urządzenie nieznane,
   * albo snapshot pusty (panel jeszcze nie oddał kadru). 204 (a nie 404) żeby
   * iOS po prostu pokazał ostatnią klatkę / placeholder bez logowania błędu.
   */
  @Get('intercom-snapshot')
  async intercomSnapshot(
    @Query('session') session: string | undefined,
    @Query('w') w: string | undefined,
    @Query('q') q: string | undefined,
    @Res() res: Response,
  ) {
    if (!this.calls.enabled) {
      res.status(204).end()
      return
    }
    const sessionId = (session ?? '').trim()
    if (!sessionId) {
      res.status(204).end()
      return
    }

    const deviceId = this.calls.resolveAkuvoxDeviceIdForSession(sessionId)
    if (!deviceId) {
      this.logger.debug(`intercom-snapshot: brak urządzenia dla sesji ${sessionId}`)
      res.status(204).end()
      return
    }

    try {
      // skipCache=true → świeży kadr przy każdym pollingu (live).
      const { snapshot } = await this.registry.quickSnapshot(deviceId, true)
      const raw = decodeSnapshot(snapshot)
      if (!raw) {
        this.logger.log(`intercom-snapshot session=${sessionId} device=${deviceId} → 204 (brak kadru)`)
        res.status(204).end()
        return
      }
      // Skalujemy + rekompresujemy TU (na Edge), zanim klatka pójdzie przez tunel/
      // LTE — mniejszy obraz = płynniejszy polling przy niższym zużyciu łącza.
      // `w`/`q` przychodzą z iOS (adaptacja WiFi vs komórka). Gdy `sharp` nie ma /
      // błąd → oddajemy oryginał (degradacja, nie crash).
      const width = clampInt(w, 160, 1280)
      const quality = clampInt(q, 20, 90)
      const buf = await downscaleJpeg(raw, width, quality)
      this.logger.log(
        `intercom-snapshot session=${sessionId} device=${deviceId} → ${buf.length} B JPEG` +
          (width || quality ? ` (w=${width ?? '-'} q=${quality ?? '-'}, było ${raw.length} B)` : ''),
      )
      res.setHeader('Content-Type', 'image/jpeg')
      res.setHeader('Cache-Control', 'no-store, no-cache')
      res.setHeader('Content-Length', buf.length)
      res.end(buf)
    } catch (err: any) {
      this.logger.warn(`intercom-snapshot session=${sessionId} device=${deviceId} failed: ${err?.message}`)
      res.status(204).end()
    }
  }

  /**
   * POST /assistant/intercom-open?session=<id>
   * Otwiera elektrozaczep domofonu dzwoniącego w danej sesji. Edge SAM rozwiązuje
   * sesję→domofon (`resolveAkuvoxDeviceIdForSession` — mapa SIP URI→IP→urządzenie),
   * bo Cloud zna tylko SIP URI sesji, nie UUID urządzenia. Wyzwala relay 0
   * (elektrozaczep — potwierdzone przez właściciela) tą samą drogą co panel/app
   * („📲 Relay [0] open requested" → OPEN_DOOR przez driver).
   */
  @Post('intercom-open')
  async intercomOpen(@Query('session') session: string | undefined, @Res() res: Response) {
    if (!this.calls.enabled) {
      res.status(503).json({ success: false, reason: 'disabled' })
      return
    }
    const sessionId = (session ?? '').trim()
    if (!sessionId) {
      res.status(400).json({ success: false, reason: 'no-session' })
      return
    }
    const deviceId = this.calls.resolveAkuvoxDeviceIdForSession(sessionId)
    if (!deviceId) {
      this.logger.warn(`intercom-open: brak urządzenia dla sesji ${sessionId}`)
      res.status(404).json({ success: false, reason: 'no-device' })
      return
    }
    try {
      // relay 0 = elektrozaczep (AP „Wyjazd"); triggerRelay loguje 📲/✅.
      const result = await this.registry.triggerRelay(deviceId, 0)
      this.logger.log(`intercom-open session=${sessionId} device=${deviceId} relay=0 → OK`)
      res.json({ success: true, deviceId, result })
    } catch (err: any) {
      this.logger.warn(`intercom-open session=${sessionId} device=${deviceId} failed: ${err?.message}`)
      res.status(502).json({ success: false, reason: 'edge-error' })
    }
  }
}

/** Parsuje liczbę z query i przycina do [min,max]; undefined gdy brak/niepoprawna. */
function clampInt(v: string | undefined, min: number, max: number): number | undefined {
  if (v == null || v === '') return undefined
  const n = Number.parseInt(v, 10)
  if (!Number.isFinite(n)) return undefined
  return Math.min(max, Math.max(min, n))
}

/**
 * Skaluje JPEG do `width` (zachowując proporcje, bez powiększania) i rekompresuje
 * z `quality`. `sharp` ładowany dynamicznie i defensywnie — gdy niedostępny na
 * Edge (native binary), oddajemy oryginalny bufor zamiast wywalać snapshot.
 */
async function downscaleJpeg(
  buf: Buffer,
  width: number | undefined,
  quality: number | undefined,
): Promise<Buffer> {
  if (!width && !quality) return buf
  try {
    // Nazwa w zmiennej → dynamiczny import (Promise<any>), żeby `nest build` nie
    // wymagał typów `sharp` (bywa tylko hoistowany w monorepo, nie w apps/edge).
    const modName = 'sharp'
    const sharpMod: any = await import(modName)
    const sharp = sharpMod.default ?? sharpMod
    let img = sharp(buf, { failOn: 'none' }).rotate()
    if (width) img = img.resize({ width, withoutEnlargement: true })
    return await img.jpeg({ quality: quality ?? 60, mozjpeg: true }).toBuffer()
  } catch {
    return buf
  }
}

/**
 * `quickSnapshot` zwraca data-URI (`data:image/jpeg;base64,...`) albo null.
 * Dekodujemy do surowego bufora JPEG; null gdy brak/niepoprawne.
 */
function decodeSnapshot(snapshot: string | null): Buffer | null {
  if (!snapshot) return null
  const commaIdx = snapshot.indexOf(',')
  const b64 = commaIdx >= 0 ? snapshot.slice(commaIdx + 1) : snapshot
  if (!b64) return null
  try {
    const buf = Buffer.from(b64, 'base64')
    return buf.length > 0 ? buf : null
  } catch {
    return null
  }
}
