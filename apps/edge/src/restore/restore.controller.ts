/**
 * RestoreController — wgrywanie kopii zapasowej z UI na żywym Edge.
 *
 * Endpoint:
 *   POST /api/system/restore?confirmHostname=<host>
 *   Content-Type: application/gzip
 *   Body: raw bytes pliku .tar.gz (z `/api/system/backup`)
 *
 * Auth challenge: query param `confirmHostname` musi matchować `os.hostname()`.
 * Identyczny pattern jak factory-reset — chroni przed przypadkowym wgraniem
 * niewłaściwego backupu z innego Edge.
 *
 * Flow:
 *   1. Validate hostname challenge
 *   2. Stream raw body do tmp file (NIE buforujemy 3 GB w RAM)
 *   3. Spawn `tar tzf` żeby zwalidować że to tar.gz + zawiera store.db + MANIFEST
 *   4. Extract do stagingu w `data/.restore-staging/`
 *   5. Validate extracted store.db jest spójną sqlite (lite check via tar metadata)
 *   6. Write flag file `data/.restore-pending` z stagingDir
 *   7. setTimeout(exit(0), 2s) → pm2 restart-uje
 *   8. Pre-bootstrap handler w `main.ts` widzi flag → swap → boot normalnie
 *
 * Edge POST/restore endpoint NIE robi auth challenge cloud-side — to Edge
 * LAN-only, instalator wgrywa fizycznie/przez Tailscale.
 */
import { BadRequestException, Controller, Logger, Post, Query, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawn } from 'child_process'
import { StoreService } from '../store/store.service'
import { EventLogService } from '../event-log/event-log.service'

@Controller('api/system')
export class RestoreController {
  private readonly logger = new Logger(RestoreController.name)

  constructor(
    private readonly store: StoreService,
    private readonly eventLog: EventLogService,
  ) {}

  @Post('restore')
  async restore(
    @Query('confirmHostname') confirmHostname: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const hostname = os.hostname()
    if (confirmHostname !== hostname) {
      res.status(400).json({
        error: `Wymagane potwierdzenie hostname. Wpisz „${hostname}" w polu confirmHostname.`,
        hostname,
      })
      return
    }

    // 1. Stream upload do tmp file. Edge może odbierać 3 GB — NIE bufferujemy
    // w pamięci. Express body-parser by też nie zadziałał (10mb limit), więc
    // pomijamy go i pipe-ujemy req bezpośrednio do dysku.
    const dataDir = path.dirname(this.store.storePath())
    const stagingDir = path.join(dataDir, '.restore-staging')

    // Czyszczenie poprzedniego stagingu (gdyby ktoś anulował upload)
    try {
      if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true })
    } catch { /* ignore */ }
    fs.mkdirSync(stagingDir, { recursive: true })

    const uploadPath = path.join(stagingDir, 'backup.tar.gz')
    const writeStream = fs.createWriteStream(uploadPath)

    try {
      await new Promise<void>((resolve, reject) => {
        req.pipe(writeStream)
        writeStream.on('finish', () => resolve())
        writeStream.on('error', reject)
        req.on('error', reject)
      })
    } catch (err: any) {
      this.logger.error(`Upload stream failed: ${err.message}`)
      try { fs.rmSync(stagingDir, { recursive: true, force: true }) } catch { /* ignore */ }
      throw new BadRequestException(`Upload failed: ${err.message}`)
    }

    const uploadSize = fs.statSync(uploadPath).size
    this.logger.log(`Backup upload complete: ${uploadSize} bytes`)
    if (uploadSize < 1024) {
      try { fs.rmSync(stagingDir, { recursive: true, force: true }) } catch { /* ignore */ }
      throw new BadRequestException('Plik za mały — to nie wygląda na valid backup.')
    }

    // 2. Validate: tar -tzf żeby wyciągnąć listing
    try {
      const listing = await runCommand('tar', ['-tzf', uploadPath])
      const files = listing.split('\n').map((s) => s.trim()).filter(Boolean)
      const hasStoreDb = files.some((f) => f === 'store.db' || f.endsWith('/store.db'))
      const hasManifest = files.some((f) => f === 'MANIFEST.txt' || f.endsWith('/MANIFEST.txt'))
      if (!hasStoreDb) {
        throw new Error('Backup nie zawiera store.db — to nie jest valid GateLynk backup.')
      }
      if (!hasManifest) {
        this.logger.warn('Brak MANIFEST.txt — kontynuuję ale to nietypowe.')
      }
      this.logger.log(`tar listing OK (${files.length} entries, store.db: ✓)`)
    } catch (err: any) {
      try { fs.rmSync(stagingDir, { recursive: true, force: true }) } catch { /* ignore */ }
      throw new BadRequestException(`Walidacja tarball-a nie powiodła się: ${err.message}`)
    }

    // 3. Extract do stagingu
    try {
      await runCommand('tar', ['-xzf', uploadPath, '-C', stagingDir])
      this.logger.log(`Extracted to ${stagingDir}`)
    } catch (err: any) {
      try { fs.rmSync(stagingDir, { recursive: true, force: true }) } catch { /* ignore */ }
      throw new BadRequestException(`Tar extract failed: ${err.message}`)
    }

    // 4. Cleanup tarball z stagingu (już niepotrzebny)
    try { fs.unlinkSync(uploadPath) } catch { /* ignore */ }

    // 5. Sanity-check extracted store.db
    const stagedDb = path.join(stagingDir, 'store.db')
    if (!fs.existsSync(stagedDb) || fs.statSync(stagedDb).size < 1024) {
      try { fs.rmSync(stagingDir, { recursive: true, force: true }) } catch { /* ignore */ }
      throw new BadRequestException('Wyekstrahowane store.db jest niepoprawne lub puste.')
    }

    // 6. Read MANIFEST (jeśli istnieje) — zwracamy info userowi
    const manifestPath = path.join(stagingDir, 'MANIFEST.txt')
    let manifestPreview = ''
    if (fs.existsSync(manifestPath)) {
      manifestPreview = fs.readFileSync(manifestPath, 'utf-8').slice(0, 400)
    }

    // 7. Write flag — pre-bootstrap handler w main.ts to złapie po restart-cie
    const flagPath = path.join(dataDir, '.restore-pending')
    fs.writeFileSync(flagPath, JSON.stringify({
      stagingDir,
      requestedAt: new Date().toISOString(),
      requestedBy: req.headers['user-agent'] ?? 'unknown',
    }))

    this.eventLog.error('SYSTEM', '⚠️ RESTORE — wgrano backup, restart Edge w ciągu 2s')
    this.logger.warn(`Restore staged at ${stagingDir} — exiting in 2s for pm2 restart`)

    // 8. Schedule restart
    setTimeout(() => process.exit(0), 2000)

    res.status(200).json({
      restoring: true,
      restartingIn: 2,
      stagingDir,
      uploadSize,
      manifestPreview,
    })
  }
}

/** Helper — spawn proces, capture stdout, throw error gdy non-zero exit. */
function runCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => { stderr += d.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${cmd} exit ${code}: ${stderr.slice(0, 200)}`))
    })
  })
}
