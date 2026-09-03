import { Controller, Get, Header, NotFoundException, Param, ParseIntPipe, Post, Query, Logger, Res } from '@nestjs/common'
import type { Response } from 'express'
import * as fs from 'fs'
import * as path from 'path'
import { HikvisionLprService } from './hikvision-lpr.service'
import { StoreService } from '../../store/store.service'

/**
 * LPR admin / inspection endpoints used by the installer.
 *
 * Distinct from `/events/lpr` (camera callbacks) — these let the installer
 * inspect the plate list from the Edge UI panel.
 *
 * Architecture note: Edge is the only store of the whitelist (we don't push
 * plates to the camera). Historic CSV-export / force-push endpoints were
 * removed when we dropped the camera/hybrid modes.
 */
@Controller('lpr')
export class LprAdminController {
  private readonly logger = new Logger(LprAdminController.name)

  constructor(
    private readonly lpr: HikvisionLprService,
    private readonly store: StoreService,
  ) {}

  /**
   * Current whitelist for this camera (JSON) — used by the Edge UI panel
   * to show a table of plates with owner + validity.
   */
  @Get(':cameraDeviceId/plates')
  listPlates(@Param('cameraDeviceId') cameraDeviceId: string) {
    return { plates: this.lpr.listPlates(cameraDeviceId) }
  }

  /**
   * Read-only feed of recent ANPR detections (matched + unmatched). Used by
   * the Edge UI panel on the "Odczyty" tab. Query params:
   *   - plate:   substring search (case-insensitive, non-alphanumerics stripped)
   *   - matched: 'true' | 'false' | omitted (no filter)
   *   - limit:   1..1000, default 200
   */
  @Get(':cameraDeviceId/reads')
  listReads(
    @Param('cameraDeviceId') cameraDeviceId: string,
    @Query('plate') plate?: string,
    @Query('matched') matched?: string,
    @Query('limit') limit?: string,
  ) {
    const matchedFilter =
      matched === 'true' ? true : matched === 'false' ? false : undefined
    const limitNum = limit ? Math.max(1, Math.min(parseInt(limit, 10) || 200, 1000)) : 200
    return {
      reads: this.lpr.listReads(cameraDeviceId, {
        plate,
        matched: matchedFilter,
        limit: limitNum,
      }),
    }
  }

  /**
   * Cross-camera feed — wszystkie odczyty ze wszystkich kamer LPR, posortowane
   * malejąco po ts. Używane przez zakładkę „Odczyty LPR" w SPA, która chce
   * zobaczyć aktywność wszystkich bram naraz bez wybierania kamery.
   * Wspiera te same filtry co per-camera variant.
   */
  @Get('reads')
  listAllReads(
    @Query('plate') plate?: string,
    @Query('matched') matched?: string,
    @Query('cameraId') cameraDeviceId?: string,
    @Query('limit') limit?: string,
  ) {
    const matchedFilter =
      matched === 'true' ? true : matched === 'false' ? false : undefined
    const limitNum = limit ? Math.max(1, Math.min(parseInt(limit, 10) || 200, 1000)) : 200
    return {
      reads: this.store.lprListRecentAll({
        plate,
        matched: matchedFilter,
        cameraDeviceId,
        limit: limitNum,
      }),
    }
  }

  /**
   * Manual trigger for camera-side ANPR configuration. `addDevice()` already
   * calls `ensureAnprTriggering` on boot, but this lets the installer re-run
   * the same probe after changing camera password / firmware / network without
   * restarting Edge, and surfaces the ISAPI trace so we can see exactly what
   * the firmware accepted or rejected.
   */
  @Post(':cameraDeviceId/camera-setup')
  async runCameraSetup(@Param('cameraDeviceId') cameraDeviceId: string) {
    this.logger.log(`Manual camera-setup requested for ${cameraDeviceId}`)
    return this.lpr.ensureAnprTriggering(cameraDeviceId)
  }

  /**
   * Serve the JPEG snapshot captured at ANPR-event time. Safe against
   * path traversal: we pull the filename from the DB row (not the URL), so a
   * user cannot probe arbitrary files via `?file=`. Also guards against a
   * stored value that resolves outside the snapshots directory.
   */
  @Get('reads/:id/image')
  @Header('Cache-Control', 'public, max-age=86400')
  async getReadImage(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const row = this.store.lprGetRead(id)
    if (!row || !row.imagePath) throw new NotFoundException('No snapshot for this read')

    const dir = this.store.lprSnapshotsDir()
    const full = path.resolve(dir, row.imagePath)
    // Defence in depth — reject anything that points outside the snapshots dir.
    if (!full.startsWith(path.resolve(dir) + path.sep)) {
      throw new NotFoundException('Invalid snapshot path')
    }
    if (!fs.existsSync(full)) throw new NotFoundException('Snapshot file missing')

    res.setHeader('Content-Type', 'image/jpeg')
    fs.createReadStream(full).pipe(res)
  }
}
