import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Patch,
  Query,
  Request,
  Response,
  UseGuards,
} from '@nestjs/common'
import type { Response as ExpressResponse } from 'express'
import { IntegratorJwtAuthGuard } from './integrator-jwt-auth.guard'
import { IntegratorService, IntegratorUpdateAccessPointDto } from './integrator.service'
import { IntegratorReadinessService } from './readiness.service'
import { StairwellIntercomDto, UpdateLprCameraDto } from '../buildings/buildings.service'
import { IntercomAkuvoxExportService } from '../resident/intercom-akuvox-export.service'

@Controller('integrator')
export class IntegratorController {
  constructor(
    private integratorService: IntegratorService,
    private readinessService: IntegratorReadinessService,
    private akuvoxExport: IntercomAkuvoxExportService,
  ) {}

  /**
   * GET /api/integrator/buildings/:id/akuvox-userdata.tgz
   * Eksport listy mieszkańców do importu na domofonie Akuvox (Directory → User
   * → Import). `UserData.tgz` z Name=lokal+nazwisko, Phone=id lokalu (dzwonienie).
   */
  @UseGuards(IntegratorJwtAuthGuard)
  @Get('buildings/:id/akuvox-userdata.tgz')
  async akuvoxUserData(@Param('id') id: string, @Request() req: any, @Response() res: ExpressResponse) {
    await this.integratorService.getBuilding(+id, req.user.adminId) // walidacja dostępu (rzuca gdy brak)
    const buf = await this.akuvoxExport.buildUserDataTgz(+id)
    res.setHeader('Content-Type', 'application/gzip')
    res.setHeader('Content-Disposition', 'attachment; filename="UserData.tgz"')
    res.send(buf)
  }

  @Post('auth/login')
  login(@Body() body: { email: string; password: string }) {
    return this.integratorService.login(body.email, body.password)
  }

  @UseGuards(IntegratorJwtAuthGuard)
  @Get('buildings')
  getBuildings(@Request() req: any) {
    return this.integratorService.getBuildings(req.user.adminId)
  }

  @UseGuards(IntegratorJwtAuthGuard)
  @Get('buildings/:id')
  getBuilding(@Param('id') id: string, @Request() req: any) {
    return this.integratorService.getBuilding(+id, req.user.adminId)
  }

  /**
   * PR-3 — Health-check „obiekt gotowy" (design doc onboarding, Faza 7).
   * Checklista gotowości obiektu: Edge, urządzenia, AP, LPR, BA, dane,
   * AI Engine. Read-only, pollowalne (tanie COUNT-y — patrz readiness.service).
   */
  @UseGuards(IntegratorJwtAuthGuard)
  @Get('buildings/:id/readiness')
  getBuildingReadiness(@Param('id') id: string, @Request() req: any) {
    return this.readinessService.getBuildingReadiness(+id, req.user.adminId)
  }

  @UseGuards(IntegratorJwtAuthGuard)
  @Get('buildings/:id/stairwells/:stairwellId')
  getStairwellDetail(
    @Param('id') id: string,
    @Param('stairwellId') stairwellId: string,
    @Request() req: any,
  ) {
    return this.integratorService.getStairwellDetail(+id, +stairwellId, req.user.adminId)
  }

  @UseGuards(IntegratorJwtAuthGuard)
  @Put('buildings/:id/stairwells/:stairwellId/intercom')
  upsertStairwellIntercom(
    @Param('id') id: string,
    @Param('stairwellId') stairwellId: string,
    @Body() dto: StairwellIntercomDto,
    @Request() req: any,
  ) {
    return this.integratorService.upsertStairwellIntercom(
      +id,
      +stairwellId,
      req.user.adminId,
      dto,
    )
  }

  // ── Smart locks — Nuki (2026-07-08) ─────────────────────────────────────
  // Token API Nuki płynie pass-through do Edge (NIE zapisuje się w Postgres) —
  // patrz komentarz w integrator.service.ts (sekcja Smart locks).

  @UseGuards(IntegratorJwtAuthGuard)
  @Get('buildings/:id/smart-locks')
  listSmartLocks(@Param('id') id: string, @Request() req: any) {
    return this.integratorService.listSmartLocks(+id, req.user.adminId)
  }

  @UseGuards(IntegratorJwtAuthGuard)
  @Get('buildings/:id/smart-locks/units')
  listSmartLockUnits(@Param('id') id: string, @Request() req: any) {
    return this.integratorService.listUnitsForSmartLock(+id, req.user.adminId)
  }

  @UseGuards(IntegratorJwtAuthGuard)
  @Post('buildings/:id/smart-locks')
  createSmartLock(
    @Param('id') id: string,
    @Body() body: { name?: string; unitId?: number; smartlockId?: string; apiToken?: string },
    @Request() req: any,
  ) {
    return this.integratorService.createSmartLock(+id, req.user.adminId, req.user.sub, body)
  }

  @UseGuards(IntegratorJwtAuthGuard)
  @Patch('buildings/:id/smart-locks/:apId')
  updateSmartLock(
    @Param('id') id: string,
    @Param('apId') apId: string,
    @Body() body: { name?: string; isActive?: boolean; smartlockId?: string; apiToken?: string },
    @Request() req: any,
  ) {
    return this.integratorService.updateSmartLock(+id, req.user.adminId, req.user.sub, +apId, body)
  }

  @UseGuards(IntegratorJwtAuthGuard)
  @Delete('buildings/:id/smart-locks/:apId')
  deleteSmartLock(@Param('id') id: string, @Param('apId') apId: string, @Request() req: any) {
    return this.integratorService.deleteSmartLock(+id, req.user.adminId, req.user.sub, +apId)
  }

  @UseGuards(IntegratorJwtAuthGuard)
  @Post('buildings/:id/smart-locks/:apId/test')
  testSmartLock(@Param('id') id: string, @Param('apId') apId: string, @Request() req: any) {
    return this.integratorService.testSmartLock(+id, req.user.adminId, +apId)
  }

  @UseGuards(IntegratorJwtAuthGuard)
  @Get('buildings/:id/intercoms')
  getIntercoms(@Param('id') id: string, @Request() req: any) {
    return this.integratorService.getIntercoms(+id, req.user.adminId)
  }

  @UseGuards(IntegratorJwtAuthGuard)
  @Post('buildings/:id/intercoms')
  createIntercom(
    @Param('id') id: string,
    @Body() dto: { name: string; model?: string | null; edgeDeviceId?: string | null },
    @Request() req: any,
  ) {
    return this.integratorService.createIntercom(+id, req.user.adminId, dto)
  }

  @UseGuards(IntegratorJwtAuthGuard)
  @Patch('buildings/:id/intercoms/:intercomId')
  updateIntercom(
    @Param('id') id: string,
    @Param('intercomId') intercomId: string,
    @Body() body: {
      name?: string
      ipAddress?: string | null
      login?: string | null
      password?: string | null
      edgeDeviceId?: string | null
      /** Multi-station call bridge — most rozmów per stacja (2026-07-05). */
      bridgeEnabled?: boolean
    },
    @Request() req: any,
  ) {
    return this.integratorService.updateIntercom(+id, +intercomId, req.user.adminId, body)
  }

  @UseGuards(IntegratorJwtAuthGuard)
  @Get('buildings/:id/lpr-cameras')
  getLprCameras(@Param('id') id: string, @Request() req: any) {
    return this.integratorService.getLprCameras(+id, req.user.adminId)
  }

  @UseGuards(IntegratorJwtAuthGuard)
  @Post('buildings/:id/lpr-cameras')
  createLprCamera(
    @Param('id') id: string,
    @Body() dto: { name: string; manufacturer?: string | null; model?: string | null; edgeDeviceId?: string | null },
    @Request() req: any,
  ) {
    return this.integratorService.createLprCamera(+id, req.user.adminId, dto)
  }

  @UseGuards(IntegratorJwtAuthGuard)
  @Patch('buildings/:id/lpr-cameras/:cameraId')
  updateLprCamera(
    @Param('id') id: string,
    @Param('cameraId') cameraId: string,
    @Body() dto: UpdateLprCameraDto & { edgeDeviceId?: string | null },
    @Request() req: any,
  ) {
    return this.integratorService.updateLprCamera(+id, +cameraId, req.user.adminId, dto)
  }

  // FAZA 8.h (2026-06-03) — Camera role (STANDARD vs LPR) + aiAnalysisEnabled
  // toggle. Endpoint pod `/cameras/:cameraId` (nie `/lpr-cameras/...`) bo
  // semantycznie obsługuje obie role — pozostawienie `/lpr-cameras/...`
  // utrwala wrażenie że to tylko LPR.
  //
  // Body partial: `{ role?: 'STANDARD' | 'LPR', aiAnalysisEnabled?: boolean }`.
  // Wymaga ≥1 pola (BadRequestException w service). Push do Edge przez
  // tunnel `CAMERA_CONFIG_UPDATE`.
  @UseGuards(IntegratorJwtAuthGuard)
  @Patch('buildings/:id/cameras/:cameraId')
  updateCamera(
    @Param('id') id: string,
    @Param('cameraId') cameraId: string,
    @Body() body: { role?: string; aiAnalysisEnabled?: boolean },
    @Request() req: any,
  ) {
    return this.integratorService.updateCamera(
      +id, +cameraId, req.user.adminId, req.user.sub, body,
    )
  }

  // ── Edge control endpoints ────────────────────────────────────────────────────

  /** Status urządzeń Edge przypisanych do budynku */
  @UseGuards(IntegratorJwtAuthGuard)
  @Get('buildings/:id/edge')
  getEdgeStatus(@Param('id') id: string, @Request() req: any) {
    return this.integratorService.getEdgeStatus(+id, req.user.adminId)
  }

  /** Lista urządzeń skonfigurowanych na Edge (proxy HTTP → Edge) */
  @UseGuards(IntegratorJwtAuthGuard)
  @Get('buildings/:id/edge/devices')
  getEdgeDevices(@Param('id') id: string, @Request() req: any) {
    return this.integratorService.getEdgeDevices(+id, req.user.adminId)
  }

  /** Wyzwól przekaźnik na domofonie */
  @UseGuards(IntegratorJwtAuthGuard)
  @Post('buildings/:id/edge/relay')
  triggerRelay(
    @Param('id') id: string,
    @Body() body: { deviceId: string; relayIndex: number },
    @Request() req: any,
  ) {
    return this.integratorService.triggerEdgeRelay(+id, req.user.adminId, body.deviceId, body.relayIndex)
  }

  /** Restart urządzenia (domofon / kamera) */
  @UseGuards(IntegratorJwtAuthGuard)
  @Post('buildings/:id/edge/restart')
  restartDevice(
    @Param('id') id: string,
    @Body() body: { deviceId: string },
    @Request() req: any,
  ) {
    return this.integratorService.restartEdgeDevice(+id, req.user.adminId, body.deviceId)
  }

  /** Snapshot z urządzenia */
  @UseGuards(IntegratorJwtAuthGuard)
  @Get('buildings/:id/edge/snapshot')
  getSnapshot(
    @Param('id') id: string,
    @Query('deviceId') deviceId: string,
    @Request() req: any,
  ) {
    return this.integratorService.getEdgeSnapshot(+id, req.user.adminId, deviceId)
  }

  /** URL strumienia MJPEG */
  @UseGuards(IntegratorJwtAuthGuard)
  @Get('buildings/:id/edge/stream-url')
  getStreamUrl(
    @Param('id') id: string,
    @Query('deviceId') deviceId: string,
    @Request() req: any,
  ) {
    return this.integratorService.getEdgeStreamUrl(+id, req.user.adminId, deviceId)
  }

  // ── PR-1 (2026-07): karta „Edge / kod aktywacyjny" ────────────────────────
  // Przeniesione z legacy panelu superadmina (`/edge/buildings/:id/...`,
  // guard `jwt`) do kontekstu integratora (`jwt-integrator` + tenant-check
  // po adminId). Legacy endpointy zostają nietknięte.

  /** Lista EdgeDevice budynku (nazwa, isActivated, lastSeenAt, IP, wersja, pending kod). */
  @UseGuards(IntegratorJwtAuthGuard)
  @Get('buildings/:id/edge-devices')
  listEdgeDevices(@Param('id') id: string, @Request() req: any) {
    return this.integratorService.listEdgeDevicesForBuilding(+id, req.user.adminId)
  }

  /** Generuj jednorazowy kod aktywacyjny Edge (24h TTL). */
  @UseGuards(IntegratorJwtAuthGuard)
  @Post('buildings/:id/edge-devices/activation-code')
  generateEdgeActivationCode(
    @Param('id') id: string,
    @Body() body: { type?: 'EDGE' | 'EDGE_AI'; name?: string },
    @Request() req: any,
  ) {
    return this.integratorService.generateEdgeActivationCode(+id, req.user.adminId, body)
  }

  /** Usuń / dezaktywuj EdgeDevice (także pending z niewykorzystanym kodem). */
  @UseGuards(IntegratorJwtAuthGuard)
  @Delete('buildings/:id/edge-devices/:deviceId')
  removeEdgeDevice(
    @Param('id') id: string,
    @Param('deviceId') deviceId: string,
    @Request() req: any,
  ) {
    return this.integratorService.removeEdgeDevice(+id, req.user.adminId, deviceId)
  }

  // ── Faza B-5 (2026-05-14): devices page ──────────────────────────────────
  // Pełen widok urządzeń z Edge mirror — Integrator widzi config techniczny,
  // może edytować displayLabel (z `updatedBy='integrator'`).

  @UseGuards(IntegratorJwtAuthGuard)
  @Get('buildings/:id/devices')
  listDevices(@Param('id') id: string, @Request() req: any) {
    return this.integratorService.listDevices(+id, req.user.adminId)
  }

  @UseGuards(IntegratorJwtAuthGuard)
  @Patch('buildings/:id/devices/mirror/:mirrorId/label')
  updateMirrorDeviceLabel(
    @Param('id') id: string,
    @Param('mirrorId') mirrorId: string,
    @Body() body: { displayLabel: string },
    @Request() req: any,
  ) {
    return this.integratorService.updateDeviceDisplayLabel(
      +id,
      +mirrorId,
      body.displayLabel,
      req.user.adminId,
    )
  }

  // ── Sesja 3 (2026-05-17) — globalna lista Edge + profil + powiadomienia ─

  /** Wszystkie Edge integratora — used by <EdgesPage>. */
  @UseGuards(IntegratorJwtAuthGuard)
  @Get('edges')
  listAllEdges(@Request() req: any) {
    return this.integratorService.listAllEdges(req.user.adminId)
  }

  /** Profil aktualnego integratora — Sidebar + <SettingsPage>. */
  @UseGuards(IntegratorJwtAuthGuard)
  @Get('me')
  getMe(@Request() req: any) {
    return this.integratorService.getMe(req.user.sub)
  }

  @UseGuards(IntegratorJwtAuthGuard)
  @Put('me')
  updateMe(
    @Body() body: { name?: string; company?: string | null },
    @Request() req: any,
  ) {
    return this.integratorService.updateMe(req.user.sub, body)
  }

  @UseGuards(IntegratorJwtAuthGuard)
  @Get('me/notifications/preferences')
  getNotificationPrefs(@Request() req: any) {
    return this.integratorService.getNotificationPrefs(req.user.sub)
  }

  @UseGuards(IntegratorJwtAuthGuard)
  @Put('me/notifications/preferences')
  updateNotificationPrefs(
    @Body() body: Record<string, boolean>,
    @Request() req: any,
  ) {
    return this.integratorService.updateNotificationPrefs(req.user.sub, body)
  }

  // ── Sesja 4: Deeplink SSO do Edge UI ────────────────────────────────────

  /**
   * Generuje URL z one-time tokenem prowadzącym do Edge UI klienta.
   * Frontend otwiera w nowej karcie — Cloud robi redirect.
   * Token TTL: 60s, one-time use.
   */
  @UseGuards(IntegratorJwtAuthGuard)
  @Get('buildings/:id/edges/:edgeId/deeplink')
  generateEdgeDeeplink(
    @Param('id') id: string,
    @Param('edgeId') edgeId: string,
    @Request() req: any,
  ) {
    return this.integratorService.generateEdgeDeeplink(+id, edgeId, req.user.adminId, req.user.sub)
  }

  /**
   * Walidacja tokenu + redirect do Edge. UWAGA: ten endpoint NIE wymaga JWT —
   * autentykacja przez sam token w query string (one-time, TTL 60s).
   *
   * Token jest wygenerowany przez authenticated `generateEdgeDeeplink`, więc
   * tylko user który ma access do buildingu może go w ogóle dostać.
   */
  @Get('edge-sso')
  async edgeSso(
    @Query('token') token: string,
    @Response() res: ExpressResponse,
  ) {
    if (!token) {
      return res.status(400).send('Brak tokenu')
    }
    const url = await this.integratorService.resolveDeeplink(token)
    if (!url) {
      return res.status(410).send('Token wygasł lub jest nieprawidłowy — wygeneruj nowy z panelu integratora')
    }
    return res.redirect(302, url)
  }

  // ── Sesja 4: LAN scan ────────────────────────────────────────────────────

  @UseGuards(IntegratorJwtAuthGuard)
  @Post('buildings/:id/lan-scan')
  startLanScan(
    @Param('id') id: string,
    @Body() body: { protocols?: string[]; timeoutMs?: number },
    @Request() req: any,
  ) {
    return this.integratorService.startLanScan(+id, req.user.adminId, body ?? {})
  }

  @UseGuards(IntegratorJwtAuthGuard)
  @Get('buildings/:id/lan-scan/:runId')
  getLanScanStatus(
    @Param('id') id: string,
    @Param('runId') runId: string,
    @Request() req: any,
  ) {
    return this.integratorService.getLanScanStatus(+id, req.user.adminId, runId)
  }

  // ── Sesja 5: audit log + diagnostyka + eksport ──────────────────────────

  /** Historia operacji integratora — Settings → Historia. */
  @UseGuards(IntegratorJwtAuthGuard)
  @Get('me/audit')
  listAuditLog(
    @Query('limit') limit: string | undefined,
    @Query('buildingId') buildingId: string | undefined,
    @Request() req: any,
  ) {
    return this.integratorService.listAuditLog(req.user.sub, {
      limit: limit ? parseInt(limit, 10) : undefined,
      buildingId: buildingId ? parseInt(buildingId, 10) : undefined,
    })
  }

  /** Test-matrix per device — Tools → Diagnostyka. */
  @UseGuards(IntegratorJwtAuthGuard)
  @Post('buildings/:id/devices/:deviceId/test-matrix')
  runDeviceTestMatrix(
    @Param('id') id: string,
    @Param('deviceId') deviceId: string,
    @Request() req: any,
  ) {
    return this.integratorService.runDeviceTestMatrix(
      +id, req.user.adminId, deviceId, req.user.sub,
    )
  }

  /** Eksport pełnej konfiguracji obiektu jako JSON — Tools → Eksport. */
  @UseGuards(IntegratorJwtAuthGuard)
  @Post('buildings/:id/export')
  exportBuildingConfig(
    @Param('id') id: string,
    @Request() req: any,
  ) {
    return this.integratorService.exportBuildingConfig(+id, req.user.adminId, req.user.sub)
  }

  // ── Sesja 6: email change + health report ──────────────────────────────

  /** Inicjacja zmiany emaila — Settings → Konto. Wymaga aktualnego hasła. */
  @UseGuards(IntegratorJwtAuthGuard)
  @Post('me/email-change/request')
  requestEmailChange(
    @Body() body: { newEmail: string; currentPassword: string },
    @Request() req: any,
  ) {
    return this.integratorService.requestEmailChange(
      req.user.sub,
      body.newEmail,
      body.currentPassword,
    )
  }

  /** Weryfikacja linka z emaila. PUBLIC — token sam autoryzuje. */
  @Post('me/email-change/verify')
  verifyEmailChange(@Body() body: { token: string }) {
    if (!body?.token) throw new BadRequestException('Brak tokenu')
    return this.integratorService.verifyEmailChange(body.token)
  }

  /** Health report — Tools → Health. */
  @UseGuards(IntegratorJwtAuthGuard)
  @Get('health-report')
  getHealthReport(@Request() req: any) {
    return this.integratorService.getHealthReport(req.user.adminId, req.user.sub)
  }

  // ── 2026-06-02: AccessPoint binding + LPR linkage (panel integratora) ───
  //
  // Integrator widzi te endpointy jako write-pełne. BA odpowiedniki są
  // READ-ONLY na poziomie UI (samo API jeszcze przyjmuje binding dla
  // backwards-compat, defense-in-depth na osobną sesję — patrz CLAUDE.md).

  /** Lista AP dla dropdown w UI. */
  @UseGuards(IntegratorJwtAuthGuard)
  @Get('buildings/:id/access-points')
  listAccessPointsForIntegrator(@Param('id') id: string, @Request() req: any) {
    return this.integratorService.listAccessPointsForIntegrator(+id, req.user.adminId)
  }

  /** Edycja AP — label/icon/scope/isActive ORAZ binding (outputDeviceId/Index/durationMs). */
  @UseGuards(IntegratorJwtAuthGuard)
  @Patch('buildings/:id/access-points/:apId')
  updateAccessPointForIntegrator(
    @Param('id') id: string,
    @Param('apId') apId: string,
    @Body() dto: IntegratorUpdateAccessPointDto,
    @Request() req: any,
  ) {
    return this.integratorService.updateAccessPointForIntegrator(
      +id, +apId, req.user.adminId, dto,
    )
  }

  /** Powiązanie kamery LPR z AccessPoint-em (po deviceUuid z mirror). */
  @UseGuards(IntegratorJwtAuthGuard)
  @Patch('buildings/:id/lpr-cameras/:deviceUuid/linked-ap')
  setLprLinkedAccessPointForIntegrator(
    @Param('id') id: string,
    @Param('deviceUuid') deviceUuid: string,
    @Body() body: { accessPointId: number | null },
    @Request() req: any,
  ) {
    const apId =
      body?.accessPointId === null ? null
        : typeof body?.accessPointId === 'number' && body.accessPointId > 0 ? body.accessPointId
        : null
    return this.integratorService.setLprLinkedAccessPointForIntegrator(
      +id, deviceUuid, apId, req.user.adminId,
    )
  }

  /** Test pulse — wysyła AP_TEST_FIRE do Edge i auditrowany MANUAL_OPEN. */
  @UseGuards(IntegratorJwtAuthGuard)
  @Post('buildings/:id/access-points/:apId/test-fire')
  testFireAccessPointForIntegrator(
    @Param('id') id: string,
    @Param('apId') apId: string,
    @Request() req: any,
  ) {
    return this.integratorService.testFireAccessPointForIntegrator(
      +id, +apId, req.user.adminId, req.user.sub,
    )
  }

  // ── 2026-06-02 (FAZA b) — Universal object types ─────────────────────────

  /** GET aktualny objectType + features (z fallback defaultami). */
  @UseGuards(IntegratorJwtAuthGuard)
  @Get('buildings/:id/object-type')
  getBuildingObjectType(@Param('id') id: string, @Request() req: any) {
    return this.integratorService.getObjectTypeConfig(+id, req.user.adminId)
  }

  /**
   * PATCH typ obiektu + features.
   * Body: `{ objectType: 'BUILDING'|'HOUSING_ESTATE'|..., features?: Partial<BuildingFeatures> }`
   *
   * Zmiana typu nadpisuje features defaultami chyba że jawnie podane w body.
   * Po PATCH wysyłamy `BUILDING_CONFIG_UPDATE` do Edge (outbox + tunnel).
   */
  @UseGuards(IntegratorJwtAuthGuard)
  @Patch('buildings/:id/object-type')
  updateBuildingObjectType(
    @Param('id') id: string,
    @Body() body: { objectType?: unknown; features?: any },
    @Request() req: any,
  ) {
    return this.integratorService.updateObjectType(
      +id, req.user.adminId, req.user.sub, body,
    )
  }

  // ── 2026-07-30 — Przepustka wyjazdowa (exit grace pass) ──────────────────

  /** GET konfiguracja przepustki wyjazdowej (Building.features.exitGrace). */
  @UseGuards(IntegratorJwtAuthGuard)
  @Get('buildings/:id/exit-grace')
  getExitGrace(@Param('id') id: string, @Request() req: any) {
    return this.integratorService.getExitGraceConfig(+id, req.user.adminId)
  }

  /**
   * PATCH konfiguracja przepustki wyjazdowej.
   * Body: `{ enabled?, minutes? (5–120), afterExpiry? ('OPEN_AND_FLAG'|'DENY') }`
   * Po zapisie push `BUILDING_CONFIG_UPDATE` do Edge (outbox + tunnel).
   */
  @UseGuards(IntegratorJwtAuthGuard)
  @Patch('buildings/:id/exit-grace')
  updateExitGrace(
    @Param('id') id: string,
    @Body() body: { enabled?: unknown; minutes?: unknown; afterExpiry?: unknown },
    @Request() req: any,
  ) {
    return this.integratorService.updateExitGrace(
      +id, req.user.adminId, req.user.sub, body,
    )
  }

  // ── 2026-06-02 (FAZA c) — AP category + multi-LPR linkage ────────────────

  /** PATCH AccessPoint.category — zmiana semantycznego typu. */
  @UseGuards(IntegratorJwtAuthGuard)
  @Patch('buildings/:id/access-points/:apId/category')
  updateAccessPointCategory(
    @Param('id') id: string,
    @Param('apId') apId: string,
    @Body() body: { category?: unknown },
    @Request() req: any,
  ) {
    return this.integratorService.updateAccessPointCategory(
      +id, +apId, req.user.adminId, req.user.sub, body,
    )
  }

  /** GET — wszystkie linki LPR→AP w budynku. */
  @UseGuards(IntegratorJwtAuthGuard)
  @Get('buildings/:id/lpr-camera-ap-links')
  listLprApLinksForBuilding(@Param('id') id: string, @Request() req: any) {
    return this.integratorService.listLprLinksForBuilding(+id, req.user.adminId)
  }

  /** GET — kamery linked do konkretnego AP. */
  @UseGuards(IntegratorJwtAuthGuard)
  @Get('buildings/:id/access-points/:apId/cameras')
  listCamerasForAccessPoint(
    @Param('id') id: string,
    @Param('apId') apId: string,
    @Request() req: any,
  ) {
    return this.integratorService.listLprLinksForAccessPoint(+id, +apId, req.user.adminId)
  }

  /** POST — link camera do AP. Body: `{ cameraDeviceUuid, direction?: 'IN'|'OUT' }`. */
  @UseGuards(IntegratorJwtAuthGuard)
  @Post('buildings/:id/access-points/:apId/cameras')
  createLprApLink(
    @Param('id') id: string,
    @Param('apId') apId: string,
    @Body() body: { cameraDeviceUuid?: unknown; direction?: unknown },
    @Request() req: any,
  ) {
    return this.integratorService.createLprApLink(
      +id, +apId, req.user.adminId, req.user.sub, body,
    )
  }

  /** PATCH — zmiana direction istniejącego linku. */
  @UseGuards(IntegratorJwtAuthGuard)
  @Patch('buildings/:id/access-points/:apId/cameras/:linkId')
  updateLprApLink(
    @Param('id') id: string,
    @Param('apId') apId: string,
    @Param('linkId') linkId: string,
    @Body() body: { direction?: unknown },
    @Request() req: any,
  ) {
    return this.integratorService.updateLprApLink(
      +id, +apId, +linkId, req.user.adminId, req.user.sub, body,
    )
  }

  /** DELETE — unlink. */
  @UseGuards(IntegratorJwtAuthGuard)
  @Delete('buildings/:id/access-points/:apId/cameras/:linkId')
  deleteLprApLink(
    @Param('id') id: string,
    @Param('apId') apId: string,
    @Param('linkId') linkId: string,
    @Request() req: any,
  ) {
    return this.integratorService.deleteLprApLink(
      +id, +apId, +linkId, req.user.adminId, req.user.sub,
    )
  }

  // ── 2026-06-02 (FAZA e) — Permissions Matrix per role ───────────────────
  //
  // Integrator otrzymuje visual matrix 3 ról × N features/AP. Backend
  // filtruje API zwroty + iOS/Web UI conditional rendering.

  /** GET — pełny payload do wyrenderowania visual matrix. */
  @UseGuards(IntegratorJwtAuthGuard)
  @Get('buildings/:id/permissions')
  getBuildingPermissions(@Param('id') id: string, @Request() req: any) {
    return this.integratorService.getPermissions(+id, req.user.adminId)
  }

  /** PATCH — zapisz pełne permissions z UI. */
  @UseGuards(IntegratorJwtAuthGuard)
  @Patch('buildings/:id/permissions')
  setBuildingPermissions(
    @Param('id') id: string,
    @Body() body: { permissions?: unknown },
    @Request() req: any,
  ) {
    return this.integratorService.setPermissions(+id, req.user.adminId, req.user.sub, body)
  }

  /** POST — reset do defaultów dla obecnego objectType. */
  @UseGuards(IntegratorJwtAuthGuard)
  @Post('buildings/:id/permissions/reset')
  resetBuildingPermissions(@Param('id') id: string, @Request() req: any) {
    return this.integratorService.resetPermissions(+id, req.user.adminId, req.user.sub)
  }

  // ── 2026-06-02 (FAZA f) — Multi-budynkowy dashboard ───────────────────────
  //
  // Pierwsza strona po login integratora. Agreguje wszystkie budynki
  // klienta + status Edge + kluczowe statystyki + computed health.
  // Polling co 30s po stronie web; tu read-only, bez audit logu.

  @UseGuards(IntegratorJwtAuthGuard)
  @Get('dashboard')
  getDashboard(@Request() req: any) {
    return this.integratorService.getDashboard(req.user.adminId)
  }

  // ── FAZA 8.g (2026-06-03) — AI Engine config + test ─────────────────────

  /** GET aktualny config AI Engine + last test wynik (z polling-iem z UI). */
  @UseGuards(IntegratorJwtAuthGuard)
  @Get('buildings/:id/ai-engine')
  getAiEngine(@Param('id') id: string, @Request() req: any) {
    return this.integratorService.getAiEngineConfig(+id, req.user.adminId)
  }

  /** PATCH config — `{ url, healthPath?, model?, enabled? }`. Tunnel push. */
  @UseGuards(IntegratorJwtAuthGuard)
  @Patch('buildings/:id/ai-engine')
  updateAiEngine(
    @Param('id') id: string,
    @Body() body: {
      url?: string
      healthPath?: string | null
      model?: string | null
      enabled?: boolean
    },
    @Request() req: any,
  ) {
    return this.integratorService.upsertAiEngineConfig(
      +id, req.user.adminId, req.user.sub, body,
    )
  }

  /** POST test — wysyła AI_ENGINE_TEST do Edge. Wynik trafia do DB przez EVT. */
  @UseGuards(IntegratorJwtAuthGuard)
  @Post('buildings/:id/ai-engine/test')
  testAiEngine(
    @Param('id') id: string,
    @Body() body: { urlOverride?: string; healthPathOverride?: string } = {},
    @Request() req: any,
  ) {
    return this.integratorService.testAiEngineConnection(
      +id, req.user.adminId, req.user.sub, body,
    )
  }

  /** FAZA 8.h.8 — POST test-llm — wysyła LLM_TEST do Edge.
   *  Edge wykonuje GET /api/tags na Ollama, zwraca availableModels[].
   *  EdgeGateway zapisuje wynik do `ai_engines.llmLastTest*` + `llmAvailableModels`.
   *  Frontend polluje GET /ai-engine żeby zobaczyć listę zainstalowanych modeli. */
  @UseGuards(IntegratorJwtAuthGuard)
  @Post('buildings/:id/ai-engine/test-llm')
  testLlm(
    @Param('id') id: string,
    @Body() body: { urlOverride?: string } = {},
    @Request() req: any,
  ) {
    return this.integratorService.testLlmConnection(
      +id, req.user.adminId, req.user.sub, body,
    )
  }

  // ── FAZA 8.h.25 (2026-06-12) — logi pytań GateLynk AI + ocena ───────────

  /** GET lista Q/A logów. Query: limit, offset, rating=unrated|ok|bad. */
  @UseGuards(IntegratorJwtAuthGuard)
  @Get('buildings/:id/assistant-logs')
  getAssistantLogs(
    @Param('id') id: string,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @Query('rating') rating: string | undefined,
    @Request() req: any,
  ) {
    return this.integratorService.getAssistantLogs(+id, req.user.adminId, {
      limit: limit ? +limit : undefined,
      offset: offset ? +offset : undefined,
      rating,
    })
  }

  /** PATCH ocena — `{ ratingOk: true | false | null }` (null cofa ocenę). */
  @UseGuards(IntegratorJwtAuthGuard)
  @Patch('buildings/:id/assistant-logs/:logId')
  rateAssistantLog(
    @Param('id') id: string,
    @Param('logId') logId: string,
    @Body() body: { ratingOk?: boolean | null },
    @Request() req: any,
  ) {
    if (body?.ratingOk !== true && body?.ratingOk !== false && body?.ratingOk !== null) {
      throw new BadRequestException('ratingOk musi być true, false lub null')
    }
    return this.integratorService.rateAssistantLog(
      +id, req.user.adminId, +logId, body.ratingOk,
    )
  }
}
