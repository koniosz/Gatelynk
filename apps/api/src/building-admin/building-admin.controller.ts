import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Request,
  Res,
  UseGuards,
} from '@nestjs/common'
import { BuildingAdminJwtAuthGuard } from './building-admin-jwt-auth.guard'
import {
  BuildingAdminService,
  BaCreateResidentDto,
  BaCreateUnitDto,
  BaCreateUnitTypeDto,
  BaAssignResidentDto,
  BaSendNotificationDto,
  BaUpsertCommonAreaSettingsDto,
  BaUpdateTicketStatusDto,
  BaAddTicketReplyDto,
  BaCreateVehicleDto,
  BaUpdateVehicleDto,
  BaUpdateVehicleStatusDto,
  BaUpdateAccessPointDto,
  BaReorderAccessPointsDto,
  BaCreateAccessPointScheduleDto,
  BaUpdateAccessPointScheduleDto,
  BaCreateContactGroupDto,
  BaUpdateContactGroupDto,
  BaSetContactGroupUnitsDto,
} from './building-admin.service'
import { StairwellIntercomDto } from '../buildings/buildings.service'
import { AccessEventsService, AccessEventType } from '../access-events/access-events.service'
import { ForbiddenException } from '@nestjs/common'
import type { Response } from 'express'
import { IntercomAkuvoxExportService } from '../resident/intercom-akuvox-export.service'
import { PaymentsAdminService } from '../payments/payments-admin.service'
import type { ComponentDto } from '../payments/payments-admin.service'

@Controller('building-admin')
export class BuildingAdminController {
  constructor(
    private baService: BuildingAdminService,
    private accessEvents: AccessEventsService,
    private akuvoxExport: IntercomAkuvoxExportService,
    private paymentsAdmin: PaymentsAdminService,
  ) {}

  /**
   * GET /api/building-admin/buildings/:id/akuvox-userdata.tgz
   * Eksport listy mieszkańców do importu na domofonie Akuvox (Directory → User
   * → Import). Pobiera gotowe `UserData.tgz` (Name=lokal+nazwisko, Phone=id lokalu).
   */
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/akuvox-userdata.tgz')
  async akuvoxUserData(@Param('id') id: string, @Request() req: any, @Res() res: Response) {
    await this.baService.getBuilding(+id, req.user.buildingIds) // walidacja dostępu (rzuca gdy brak)
    const buf = await this.akuvoxExport.buildUserDataTgz(+id)
    res.setHeader('Content-Type', 'application/gzip')
    res.setHeader('Content-Disposition', 'attachment; filename="UserData.tgz"')
    res.send(buf)
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  @Post('auth/login')
  login(@Body() body: { email: string; password: string }) {
    return this.baService.login(body.email, body.password)
  }

  /** Reset hasła — krok 1: wysyłka linku na maila. Publiczny, bez guardu;
   *  zawsze zwraca { ok: true } (brak enumeracji kont). */
  @Post('auth/forgot-password')
  forgotPassword(@Body() body: { email: string }) {
    return this.baService.forgotPassword(body?.email ?? '')
  }

  /** Reset hasła — krok 2: ustawienie nowego hasła tokenem z maila. */
  @Post('auth/reset-password')
  resetPassword(@Body() body: { token: string; password: string }) {
    return this.baService.resetPassword(body?.token ?? '', body?.password ?? '')
  }

  // ── Me ────────────────────────────────────────────────────────────────────
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('me')
  getMe(@Request() req: any) {
    return this.baService.getMe(req.user.sub)
  }

  /** Portal wyboru obiektu — powitanie + obiekty z alertami + totals. */
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('my-buildings-overview')
  getMyBuildingsOverview(@Request() req: any) {
    return this.baService.getBuildingsOverview(req.user.sub, req.user.buildingIds ?? [])
  }

  /** Portal: „Wyślij przypomnienia" o zaległościach — idempotentne per dzień. */
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('portfolio/reminders')
  sendArrearsReminders(@Request() req: any) {
    return this.baService.sendArrearsReminders(req.user.sub, req.user.buildingIds ?? [])
  }

  // ── Budynki ───────────────────────────────────────────────────────────────
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings')
  getBuildings(@Request() req: any) {
    return this.baService.getBuildings(req.user.buildingIds)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id')
  getBuilding(@Param('id') id: string, @Request() req: any) {
    return this.baService.getBuilding(+id, req.user.buildingIds)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Patch('buildings/:id/branding')
  updateBranding(
    @Param('id') id: string,
    @Body() body: { logoBase64?: string | null; backgroundImageBase64?: string | null },
    @Request() req: any,
  ) {
    return this.baService.updateBranding(+id, req.user.buildingIds, body)
  }

  // ── Klatki schodowe ───────────────────────────────────────────────────────
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/stairwells/:swId')
  getStairwellDetail(
    @Param('id') id: string,
    @Param('swId') swId: string,
    @Request() req: any,
  ) {
    return this.baService.getStairwellDetail(+id, +swId, req.user.buildingIds)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('buildings/:id/stairwells')
  addStairwell(
    @Param('id') id: string,
    @Body('name') name: string,
    @Request() req: any,
  ) {
    return this.baService.addStairwell(+id, req.user.buildingIds, name)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Patch('buildings/:id/stairwells/:swId')
  updateStairwell(
    @Param('id') id: string,
    @Param('swId') swId: string,
    @Body('name') name: string,
    @Request() req: any,
  ) {
    return this.baService.updateStairwell(+id, +swId, req.user.buildingIds, name)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Delete('buildings/:id/stairwells/:swId')
  removeStairwell(
    @Param('id') id: string,
    @Param('swId') swId: string,
    @Request() req: any,
  ) {
    return this.baService.removeStairwell(+id, +swId, req.user.buildingIds)
  }

  // ── Domofon (read-only) ───────────────────────────────────────────────────
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/stairwells/:swId/intercom')
  getIntercom(
    @Param('id') id: string,
    @Param('swId') swId: string,
    @Request() req: any,
  ) {
    return this.baService.getStairwellIntercom(+id, +swId, req.user.buildingIds)
  }

  // ── Typy lokali ───────────────────────────────────────────────────────────
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/unit-types')
  getUnitTypes(@Param('id') id: string, @Request() req: any) {
    return this.baService.getUnitTypes(+id, req.user.buildingIds)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('buildings/:id/unit-types')
  createUnitType(
    @Param('id') id: string,
    @Body() dto: BaCreateUnitTypeDto,
    @Request() req: any,
  ) {
    return this.baService.createUnitType(+id, req.user.buildingIds, dto)
  }

  // ── Lokale ────────────────────────────────────────────────────────────────
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/units')
  getUnits(@Param('id') id: string, @Request() req: any) {
    return this.baService.getUnits(+id, req.user.buildingIds)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/units/:unitId')
  getUnit(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @Request() req: any,
  ) {
    return this.baService.getUnit(+unitId, +id, req.user.buildingIds)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('buildings/:id/units')
  createUnit(
    @Param('id') id: string,
    @Body() dto: BaCreateUnitDto,
    @Request() req: any,
  ) {
    return this.baService.createUnit(+id, req.user.buildingIds, dto)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Patch('buildings/:id/units/:unitId')
  updateUnit(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @Body() dto: Partial<BaCreateUnitDto>,
    @Request() req: any,
  ) {
    return this.baService.updateUnit(+unitId, +id, req.user.buildingIds, dto)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Delete('buildings/:id/units/:unitId')
  removeUnit(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @Request() req: any,
  ) {
    return this.baService.removeUnit(+unitId, +id, req.user.buildingIds)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('buildings/:id/units/:unitId/residents')
  assignResident(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @Body() dto: BaAssignResidentDto,
    @Request() req: any,
  ) {
    return this.baService.assignResidentToUnit(+id, +unitId, req.user.buildingIds, dto)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Delete('buildings/:id/units/:unitId/residents/:assignmentId')
  removeResidentFromUnit(
    @Param('id') id: string,
    @Param('assignmentId') assignmentId: string,
    @Request() req: any,
  ) {
    return this.baService.removeResidentFromUnit(+id, +assignmentId, req.user.buildingIds)
  }

  // ── Mieszkańcy ────────────────────────────────────────────────────────────
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/residents')
  getResidents(@Param('id') id: string, @Request() req: any) {
    return this.baService.getResidents(+id, req.user.buildingIds)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/residents/:rId')
  getResident(
    @Param('id') id: string,
    @Param('rId') rId: string,
    @Request() req: any,
  ) {
    return this.baService.getResident(+rId, +id, req.user.buildingIds)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('buildings/:id/residents')
  createResident(
    @Param('id') id: string,
    @Body() dto: BaCreateResidentDto,
    @Request() req: any,
  ) {
    return this.baService.createResident(+id, req.user.buildingIds, dto)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Patch('buildings/:id/residents/:rId')
  updateResident(
    @Param('id') id: string,
    @Param('rId') rId: string,
    @Body() dto: Partial<BaCreateResidentDto>,
    @Request() req: any,
  ) {
    return this.baService.updateResident(+rId, +id, req.user.buildingIds, dto)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Patch('buildings/:id/residents/:rId/avatar')
  updateResidentAvatar(
    @Param('id') id: string,
    @Param('rId') rId: string,
    @Body() body: { avatarBase64: string | null },
    @Request() req: any,
  ) {
    return this.baService.updateResidentAvatar(+rId, +id, req.user.buildingIds, body.avatarBase64)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Delete('buildings/:id/residents/:rId')
  removeResident(
    @Param('id') id: string,
    @Param('rId') rId: string,
    @Request() req: any,
  ) {
    return this.baService.removeResident(+rId, +id, req.user.buildingIds)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('buildings/:id/residents/:rId/set-password')
  setResidentPassword(
    @Param('id') id: string,
    @Param('rId') rId: string,
    @Body() body: { password: string },
    @Request() req: any,
  ) {
    return this.baService.setResidentPassword(+rId, +id, req.user.buildingIds, body.password)
  }

  // ── Powiadomienia ─────────────────────────────────────────────────────────
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('buildings/:id/notifications')
  sendNotification(
    @Param('id') id: string,
    @Body() dto: BaSendNotificationDto,
    @Request() req: any,
  ) {
    return this.baService.sendNotification(+id, req.user.buildingIds, dto, req.user.sub)
  }

  // FAZA polish (f) — historia broadcastów. Zwraca listę z grupowaniem
  // (jeden broadcast = jeden klik „Wyślij" → N wierszy w `notifications` o
  // tym samym title+body+sentAt sekunda). Frontend pokazuje też miesięczny
  // licznik (osobny endpoint /count-this-month).
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/notifications')
  listNotifications(
    @Param('id') id: string,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @Query('q') q: string | undefined,
    @Request() req: any,
  ) {
    return this.baService.listNotifications(+id, req.user.buildingIds, {
      limit: limit ? +limit : undefined,
      offset: offset ? +offset : undefined,
      q,
    })
  }

  // ── Kamery LPR (read-only + linked AP edit) ───────────────────────────────
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/lpr-cameras')
  getLprCameras(@Param('id') id: string, @Request() req: any) {
    return this.baService.getLprCameras(+id, req.user.buildingIds)
  }

  /**
   * 2026-06-02: Powiązanie kamery LPR z AccessPoint-em. Cloud aktualizuje
   * mirror + pusha config przez tunnel do Edge (`DEVICE_CONFIG_UPDATE`).
   * `accessPointId=null` usuwa link → Edge fallbackuje do legacy
   * `linkedIntercomDeviceId + linkedRelayIndex`.
   */
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Patch('buildings/:id/lpr-cameras/:deviceUuid/linked-ap')
  setLprLinkedAp(
    @Param('id') id: string,
    @Param('deviceUuid') deviceUuid: string,
    @Body() body: { accessPointId: number | null },
    @Request() req: any,
  ) {
    const apId =
      body?.accessPointId === null ? null
        : typeof body?.accessPointId === 'number' && body.accessPointId > 0 ? body.accessPointId
        : null
    return this.baService.setLprLinkedAccessPoint(+id, deviceUuid, apId, req.user.buildingIds)
  }

  // ── Ustawienia części wspólnych ───────────────────────────────────────────
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Put('buildings/:id/units/:unitId/settings')
  upsertCommonAreaSettings(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @Body() dto: BaUpsertCommonAreaSettingsDto,
    @Request() req: any,
  ) {
    return this.baService.upsertCommonAreaSettings(+id, +unitId, req.user.buildingIds, dto)
  }

  // ── Rezerwacje ─────────────────────────────────────────────────────────────
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/reservations')
  getReservations(
    @Param('id') id: string,
    @Query('unitId') unitId?: string,
    @Query('date') date?: string,
    @Query('status') status?: string,
    @Request() req?: any,
  ) {
    return this.baService.getReservations(+id, req.user.buildingIds, {
      unitId: unitId ? +unitId : undefined,
      date,
      status,
    })
  }

  // ── Zgłoszenia mieszkańców (Tickets) ──────────────────────────────────────
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/tickets')
  getTickets(
    @Param('id') id: string,
    @Query('status') status?: string,
    @Request() req?: any,
  ) {
    return this.baService.getTickets(+id, req.user.buildingIds, status)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Patch('buildings/:id/tickets/:ticketId/status')
  updateTicketStatus(
    @Param('id') id: string,
    @Param('ticketId') ticketId: string,
    @Body() dto: BaUpdateTicketStatusDto,
    @Request() req: any,
  ) {
    return this.baService.updateTicketStatus(+id, +ticketId, req.user.buildingIds, dto)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('buildings/:id/tickets/:ticketId/replies')
  addTicketReply(
    @Param('id') id: string,
    @Param('ticketId') ticketId: string,
    @Body() dto: BaAddTicketReplyDto,
    @Request() req: any,
  ) {
    return this.baService.addTicketReply(+id, +ticketId, req.user.buildingIds, req.user.sub, dto)
  }

  // ── Pojazdy ───────────────────────────────────────────────────────────────
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/vehicles')
  getVehicles(@Param('id') id: string, @Request() req: any) {
    return this.baService.getVehicles(+id, req.user.buildingIds)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('buildings/:id/vehicles')
  createVehicle(
    @Param('id') id: string,
    @Body() dto: BaCreateVehicleDto,
    @Request() req: any,
  ) {
    return this.baService.createVehicle(+id, req.user.buildingIds, dto)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Patch('buildings/:id/vehicles/:vehicleId')
  updateVehicle(
    @Param('id') id: string,
    @Param('vehicleId') vehicleId: string,
    @Body() dto: BaUpdateVehicleDto,
    @Request() req: any,
  ) {
    return this.baService.updateVehicle(+id, +vehicleId, req.user.buildingIds, dto)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Delete('buildings/:id/vehicles/:vehicleId')
  deleteVehicle(
    @Param('id') id: string,
    @Param('vehicleId') vehicleId: string,
    @Request() req: any,
  ) {
    return this.baService.deleteVehicle(+id, +vehicleId, req.user.buildingIds)
  }

  // Faza 1 bety Villa Natura — zmiana statusu pojazdu (approve/reject/block/unblock).
  // Osobny endpoint od PATCH .../:vehicleId, bo to event-stylowa zmiana stanu
  // (z LPR-sync + push) a nie edycja danych. Body: { action, reason? }.
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Patch('buildings/:id/vehicles/:vehicleId/status')
  updateVehicleStatus(
    @Param('id') id: string,
    @Param('vehicleId') vehicleId: string,
    @Body() dto: BaUpdateVehicleStatusDto,
    @Request() req: any,
  ) {
    return this.baService.updateVehicleStatus(
      +id,
      +vehicleId,
      req.user.buildingIds,
      req.user.sub,
      dto,
    )
  }

  // Autocomplete sugestii nazw serwisów (np. „Glovo", „MPO") — karmi to pole
  // "Nazwa firmy" w modalu identyfikacji pojazdu na liście odczytów LPR.
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/vehicle-service-names')
  listVehicleServiceNames(@Param('id') id: string, @Request() req: any) {
    return this.baService.listServiceNames(+id, req.user.buildingIds)
  }

  // Autocomplete istniejących tagów pojazdów (kabrio, Glovo, opiekunka, …) —
  // łączymy curated dictionary (front-end) z tym, co już jest wpisane w bazie.
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/vehicle-tags')
  listVehicleTags(@Param('id') id: string, @Request() req: any) {
    return this.baService.listVehicleTags(+id, req.user.buildingIds)
  }

  // ── Punkty dostępu (Faza 5) ───────────────────────────────────────────────
  //
  // CRUD ograniczony — Edge auto-syncuje strukturę (`syncAccessPoints` co 5min),
  // BA może tylko: zmienić label/icon/sortOrder/isActive. Reorder bulk po
  // drag-drop. Tworzenie i usuwanie pomijane bo Edge i tak je odtworzy.

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/access-points')
  listAccessPoints(@Param('id') id: string, @Request() req: any) {
    return this.baService.listAccessPoints(+id, req.user.buildingIds)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Patch('buildings/:id/access-points/reorder')
  reorderAccessPoints(
    @Param('id') id: string,
    @Body() dto: BaReorderAccessPointsDto,
    @Request() req: any,
  ) {
    return this.baService.reorderAccessPoints(+id, req.user.buildingIds, dto)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Patch('buildings/:id/access-points/:apId')
  updateAccessPoint(
    @Param('id') id: string,
    @Param('apId') apId: string,
    @Body() dto: BaUpdateAccessPointDto,
    @Request() req: any,
  ) {
    return this.baService.updateAccessPoint(+id, +apId, req.user.buildingIds, dto)
  }

  // ── Grupy kontaktowe (2026-07-30) ─────────────────────────────────────────
  //
  // Grupy lokali na ekran domofonu Akuvox (np. „Budynek 1", „ulica
  // Komfortowa"). Lokal w maks. 1 grupie. Sync: E18C przez UserData.tgz
  // (Group=nazwa grupy), R29 przez Remote Phonebook (prefiks + sortowanie).

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/contact-groups')
  listContactGroups(@Param('id') id: string, @Request() req: any) {
    return this.baService.listContactGroups(+id, req.user.buildingIds)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('buildings/:id/contact-groups')
  createContactGroup(
    @Param('id') id: string,
    @Body() dto: BaCreateContactGroupDto,
    @Request() req: any,
  ) {
    return this.baService.createContactGroup(+id, req.user.buildingIds, dto)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Patch('buildings/:id/contact-groups/:gid')
  updateContactGroup(
    @Param('id') id: string,
    @Param('gid') gid: string,
    @Body() dto: BaUpdateContactGroupDto,
    @Request() req: any,
  ) {
    return this.baService.updateContactGroup(+id, req.user.buildingIds, +gid, dto)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Delete('buildings/:id/contact-groups/:gid')
  deleteContactGroup(@Param('id') id: string, @Param('gid') gid: string, @Request() req: any) {
    return this.baService.deleteContactGroup(+id, req.user.buildingIds, +gid)
  }

  /** Replace-all przypisania lokali do grupy ({ unitIds }). */
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Patch('buildings/:id/contact-groups/:gid/units')
  setContactGroupUnits(
    @Param('id') id: string,
    @Param('gid') gid: string,
    @Body() dto: BaSetContactGroupUnitsDto,
    @Request() req: any,
  ) {
    return this.baService.setContactGroupUnits(+id, req.user.buildingIds, +gid, dto)
  }

  /** Token + host do URL-a Remote Phonebook (R29) — sekcja „Synchronizacja". */
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/intercom-phonebook-info')
  getIntercomPhonebookInfo(@Param('id') id: string, @Request() req: any) {
    return this.baService.getIntercomPhonebookInfo(+id, req.user.buildingIds)
  }

  // ── Urządzenia (Faza 5) ───────────────────────────────────────────────────
  //
  // Lista wszystkich urządzeń + live online status z `EdgeGateway`. Akcje:
  // ping (sprawdza obecność WS) i restart (wysyła CMD `RESTART` przez WS —
  // Edge musi zaimplementować handler).

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/devices')
  listDevices(@Param('id') id: string, @Request() req: any) {
    return this.baService.listDevices(+id, req.user.buildingIds)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('buildings/:id/devices/:edgeDeviceId/ping')
  pingDevice(
    @Param('id') id: string,
    @Param('edgeDeviceId') edgeDeviceId: string,
    @Request() req: any,
  ) {
    return this.baService.pingDevice(+id, edgeDeviceId, req.user.buildingIds)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('buildings/:id/devices/:edgeDeviceId/restart')
  restartDevice(
    @Param('id') id: string,
    @Param('edgeDeviceId') edgeDeviceId: string,
    @Request() req: any,
  ) {
    return this.baService.restartDevice(+id, edgeDeviceId, req.user.buildingIds)
  }

  /**
   * Faza C1+R1 (2026-05-15): wymuś pełen resync wszystkich APPROVED pojazdów
   * do Edge whitelist. Używane po zmianach struktury PLATE_UPSERT payload
   * (kind/tags/unitLabel) albo gdy Edge whitelist rozjedzie się z Cloud DB.
   *
   * Zwraca `{count}` ile pojazdów zostało wysłanych. Każdy upsert idzie przez
   * EdgeOutbox (gdy Edge offline = enqueue, dostarcza przy reconnect).
   */
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('buildings/:id/vehicles/resync-to-edge')
  resyncVehiclesToEdge(@Param('id') id: string, @Request() req: any) {
    return this.baService.resyncAllVehiclesToEdge(+id, req.user.buildingIds)
  }

  /**
   * Faza B-4 (2026-05-14): edycja nazwy wyświetlanej urządzenia z mirror-a.
   * `:mirrorId` to numeryczne id z `edge_device_mirror` (NIE deviceUuid z Edge sqlite).
   * BA może zmienić label-only — pozostała konfiguracja techniczna pozostaje
   * w gestii Integratora (przez Edge wizard).
   */
  /**
   * Faza F-2.3 (2026-05-14): HOLD_OPEN dla konkretnego AccessPoint-u
   * — kurier, ekipa remontowa, sprzątaczki. Body: `{ seconds }`.
   */
  /** Overview deck (2026-07-20): pojedyncze otwarcie wejścia z panelu. */
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('buildings/:id/access-points/:apId/open')
  openAccessPointNow(
    @Param('id') id: string,
    @Param('apId') apId: string,
    @Request() req: any,
  ) {
    return this.baService.openAccessPointNow(+id, +apId, req.user.buildingIds, req.user.sub)
  }

  /** Overview deck: podgląd z kamery domofonu wejścia (binarne JPEG). */
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/access-points/:apId/snapshot')
  apSnapshot(
    @Param('id') id: string,
    @Param('apId') apId: string,
    @Query('live') live: string,
    @Request() req: any,
    @Res() res: import('express').Response,
  ) {
    return this.baService.pipeApSnapshot(+id, +apId, req.user.buildingIds, res, live === '1')
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('buildings/:id/access-points/:apId/hold-open')
  holdOpenAccessPoint(
    @Param('id') id: string,
    @Param('apId') apId: string,
    @Body() body: { seconds: number },
    @Request() req: any,
  ) {
    return this.baService.holdOpenAccessPoint(
      +id, +apId, body.seconds, req.user.buildingIds, req.user.sub,
    )
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('buildings/:id/access-points/:apId/hold-open/cancel')
  cancelHoldOpenAccessPoint(
    @Param('id') id: string,
    @Param('apId') apId: string,
    @Request() req: any,
  ) {
    return this.baService.cancelHoldOpenAccessPoint(+id, +apId, req.user.buildingIds)
  }

  // ── Access Point Schedules (cron auto-open, refactor 2026-06-01) ──────────
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/access-points/:apId/schedules')
  listAccessPointSchedules(
    @Param('id') id: string,
    @Param('apId') apId: string,
    @Request() req: any,
  ) {
    return this.baService.listAccessPointSchedules(+id, +apId, req.user.buildingIds)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('buildings/:id/access-points/:apId/schedules')
  createAccessPointSchedule(
    @Param('id') id: string,
    @Param('apId') apId: string,
    @Body() dto: BaCreateAccessPointScheduleDto,
    @Request() req: any,
  ) {
    return this.baService.createAccessPointSchedule(+id, +apId, req.user.buildingIds, dto)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Patch('buildings/:id/schedules/:scheduleId')
  updateAccessPointSchedule(
    @Param('id') id: string,
    @Param('scheduleId') scheduleId: string,
    @Body() dto: BaUpdateAccessPointScheduleDto,
    @Request() req: any,
  ) {
    return this.baService.updateAccessPointSchedule(+id, +scheduleId, req.user.buildingIds, dto)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Delete('buildings/:id/schedules/:scheduleId')
  deleteAccessPointSchedule(
    @Param('id') id: string,
    @Param('scheduleId') scheduleId: string,
    @Request() req: any,
  ) {
    return this.baService.deleteAccessPointSchedule(+id, +scheduleId, req.user.buildingIds)
  }

  /**
   * Test pulse — admin klika „🔧 Test pulse" przy AP. Wysyłamy AP_TEST_FIRE
   * przez tunel; Edge wywołuje executor.fire(apId, {trigger:'MANUAL'}).
   * Audyt MANUAL_OPEN z meta source='admin-test'.
   */
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('buildings/:id/access-points/:apId/test-fire')
  testFireAccessPoint(
    @Param('id') id: string,
    @Param('apId') apId: string,
    @Request() req: any,
  ) {
    return this.baService.testFireAccessPoint(
      +id, +apId, req.user.buildingIds, req.user.sub,
    )
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Patch('buildings/:id/devices/mirror/:mirrorId/label')
  updateMirrorDeviceLabel(
    @Param('id') id: string,
    @Param('mirrorId') mirrorId: string,
    @Body() body: { displayLabel: string },
    @Request() req: any,
  ) {
    return this.baService.updateDeviceDisplayLabel(
      +id,
      +mirrorId,
      body.displayLabel,
      req.user.buildingIds,
    )
  }

  // ── Access events (Faza 3) ─────────────────────────────────────────────────
  //
  // Pełen audit feed z opcjonalnymi filtrami (type, plate, q). Paginacja
  // przez offset/limit; `q` szuka po stronie servera (cały zakres 30-dniowy).
  // Default limit=50, max 200 — większe okna mają być realizowane przez
  // paginację, nie przez „daj mi 500 na raz".
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/access-events')
  async getAccessEvents(
    @Param('id') id: string,
    @Request() req: any,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('type') type?: string,
    @Query('plate') plate?: string,
    @Query('q') q?: string,
    @Query('guestId') guestId?: string,
    @Query('guestsOnly') guestsOnly?: string,
  ) {
    const buildingId = +id
    if (!req.user.buildingIds?.includes(buildingId)) throw new ForbiddenException()
    const { events, total } = await this.accessEvents.listForBuilding(buildingId, {
      limit: limit ? +limit : 50,
      offset: offset ? +offset : 0,
      type: (type as AccessEventType) || null,
      plate: plate || null,
      q: q || null,
      // 2026-07-04 — historia konkretnego gościa (drawer w tabie Goście) +
      // `guestsOnly=true` (feed „tylko aktywność gości"). Backward-compat:
      // brak parametrów = dotychczasowe zachowanie.
      guestId: guestId ? +guestId : null,
      guestsOnly: guestsOnly === 'true',
    })
    return { events, total }
  }

  // ── Goście (Faza 2 bety Villa Natura) ─────────────────────────────────────
  // Admin może zaprosić gościa w imieniu wybranego mieszkańca (wymagany
  // `residentId` w body), edytować lub anulować dowolne zaproszenie w budynku.
  // To samo robi mieszkaniec dla swoich gości w `/resident/guests`, tutaj
  // pomijamy filtr po residentId — admin widzi i zarządza wszystkim.

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/guests')
  getGuests(@Param('id') id: string, @Request() req: any) {
    return this.baService.getGuests(+id, req.user.buildingIds)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('buildings/:id/guests')
  createGuestForResident(
    @Param('id') id: string,
    @Request() req: any,
    @Body()
    body: {
      residentId: number
      name: string
      phone?: string
      vehiclePlate?: string
      validFrom?: string
      validTo: string
      // Patrz ResidentService — opcjonalny email gościa, Cloud wyśle Resend.
      email?: string
    },
  ) {
    return this.baService.createGuest(+id, req.user.buildingIds, body)
  }

  /**
   * Ponowne wysłanie emaila z linkiem do portalu zaproszenia. Body opcjonalne —
   * gdy `email` podany, nadpisuje zapisany w bazie; gdy null, używa `guest.email`.
   */
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('buildings/:id/guests/:guestId/resend-email')
  resendGuestInviteEmail(
    @Param('id') id: string,
    @Param('guestId') guestId: string,
    @Body() body: { email?: string },
    @Request() req: any,
  ) {
    return this.baService.resendInviteEmail(+id, +guestId, req.user.buildingIds, body?.email)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Patch('buildings/:id/guests/:guestId')
  updateGuest(
    @Param('id') id: string,
    @Param('guestId') guestId: string,
    @Request() req: any,
    @Body()
    body: {
      residentId?: number
      name?: string
      phone?: string | null
      vehiclePlate?: string | null
      validFrom?: string
      validTo?: string
    },
  ) {
    return this.baService.updateGuest(+id, +guestId, req.user.buildingIds, body)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Delete('buildings/:id/guests/:guestId')
  cancelGuest(
    @Param('id') id: string,
    @Param('guestId') guestId: string,
    @Request() req: any,
  ) {
    return this.baService.cancelGuest(+id, +guestId, req.user.buildingIds)
  }

  /**
   * Historia zdarzeń gości w budynku — UNION dwóch źródeł:
   *   • `guest_events` (PORTAL_OPEN — kliknięcia w portalu /g/<token>)
   *   • `lpr_reads` z `matched=true` JOIN-owane po `vehiclePlate` z `guests`
   *     w oknie validity (LPR rozpoznał tablicę gościa).
   *
   * Sort DESC po ts, limit 100. Bez kursora — admin rzadko scrolluje głębiej,
   * a paginacja wymagałaby UNION-a-w-podzapytaniu i komplikacji.
   */
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/guests/history')
  getGuestsHistory(@Param('id') id: string, @Request() req: any) {
    return this.baService.getGuestsHistory(+id, req.user.buildingIds)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Patch('buildings/:id/reservations/:rId/cancel')
  cancelReservation(
    @Param('id') id: string,
    @Param('rId') rId: string,
    @Request() req: any,
  ) {
    return this.baService.cancelReservation(+id, +rId, req.user.buildingIds)
  }

  // ── PAYMENTS ──────────────────────────────────────────────────────────────────

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/payments')
  getPaymentsOverview(@Param('id') id: string, @Request() req: any) {
    return this.baService.getPaymentsOverview(+id, req.user.buildingIds)
  }

  // ── PAYMENTS v2 (2026-07-03): składowe + naliczenia + raport + MT940 ────────
  // UWAGA: trasy statyczne ('config', 'report', 'charges', 'mt940') MUSZĄ być
  // zadeklarowane PRZED ':unitId' — Nest matchuje w kolejności deklaracji.

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/payments/config')
  getPaymentsConfiguration(@Param('id') id: string, @Request() req: any) {
    return this.paymentsAdmin.getConfiguration(+id, req.user.buildingIds)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Put('buildings/:id/payments/config/settings')
  upsertPaymentsSettings(
    @Param('id') id: string,
    @Body() body: { dueDay: number },
    @Request() req: any,
  ) {
    return this.paymentsAdmin.upsertSettings(+id, req.user.buildingIds, body)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('buildings/:id/payments/components')
  createPaymentComponent(
    @Param('id') id: string,
    @Body() body: ComponentDto,
    @Request() req: any,
  ) {
    return this.paymentsAdmin.createComponent(+id, req.user.buildingIds, body)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Patch('buildings/:id/payments/components/:componentId')
  updatePaymentComponent(
    @Param('id') id: string,
    @Param('componentId') componentId: string,
    @Body() body: Partial<ComponentDto>,
    @Request() req: any,
  ) {
    return this.paymentsAdmin.updateComponent(+id, +componentId, req.user.buildingIds, body)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Delete('buildings/:id/payments/components/:componentId')
  deletePaymentComponent(
    @Param('id') id: string,
    @Param('componentId') componentId: string,
    @Request() req: any,
  ) {
    return this.paymentsAdmin.deleteComponent(+id, +componentId, req.user.buildingIds)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('buildings/:id/payments/charges/generate')
  generatePaymentCharges(
    @Param('id') id: string,
    @Body() body: { period: string },
    @Request() req: any,
  ) {
    return this.paymentsAdmin.generateCharges(+id, req.user.buildingIds, body.period)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/payments/report')
  getPaymentsMonthlyReport(
    @Param('id') id: string,
    @Query('period') period: string,
    @Request() req: any,
  ) {
    return this.paymentsAdmin.getMonthlyReport(+id, req.user.buildingIds, period)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('buildings/:id/payments/mt940/preview')
  mt940Preview(
    @Param('id') id: string,
    @Body() body: { contentBase64?: string; content?: string; fileName?: string },
    @Request() req: any,
  ) {
    return this.paymentsAdmin.mt940Preview(+id, req.user.buildingIds, body)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('buildings/:id/payments/mt940/confirm')
  mt940Confirm(
    @Param('id') id: string,
    @Body()
    body: {
      fileHash: string
      fileName?: string
      accountNumber?: string | null
      statementNumber?: string | null
      transactionCount?: number
      items: Array<{
        unitId: number
        amount: number
        valueDate: string
        title?: string | null
        senderName?: string | null
        reference?: string | null
      }>
    },
    @Request() req: any,
  ) {
    return this.paymentsAdmin.mt940Confirm(+id, req.user.buildingIds, body)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('buildings/:id/payments/:unitId/manual')
  addManualPayment(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @Body() body: { amount: number; date: string; description?: string; period?: string },
    @Request() req: any,
  ) {
    return this.paymentsAdmin.addManualPayment(+id, +unitId, req.user.buildingIds, body)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/payments/:unitId')
  getUnitPayments(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @Request() req: any,
  ) {
    return this.baService.getUnitPayments(+id, +unitId, req.user.buildingIds)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Put('buildings/:id/payments/:unitId/config')
  upsertPaymentConfig(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @Body() body: { monthlyRent: number; dueDay: number; openingBalance: number; openingDate: string },
    @Request() req: any,
  ) {
    return this.baService.upsertPaymentConfig(+id, +unitId, req.user.buildingIds, body)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('buildings/:id/payments/:unitId/correction')
  addPaymentCorrection(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @Body() body: { amount: number; description: string; date: string },
    @Request() req: any,
  ) {
    return this.baService.addPaymentCorrection(+id, +unitId, req.user.buildingIds, body)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('buildings/:id/payments/mt940')
  importMt940(
    @Param('id') id: string,
    @Body() body: { content: string },
    @Request() req: any,
  ) {
    return this.baService.importMt940(+id, req.user.buildingIds, body.content)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Post('buildings/:id/payments/:unitId/remind')
  sendPaymentReminder(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @Body() body: { email?: boolean } | undefined,
    @Request() req: any,
  ) {
    return this.baService.sendPaymentReminder(+id, +unitId, req.user.buildingIds, {
      viaEmail: body?.email === true,
    })
  }

  // ── Wizja kamer (YOLO) ───────────────────────────────────────────────────
  // Cloud BA proxy do Edge `/vision/*` endpointów. Wszystkie wymagają
  // BA assigned to buildingId (guardBuilding w service).

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/vision/detections')
  visionListDetections(
    @Param('id') id: string,
    @Request() req: any,
    @Query('since_hours') sinceHours?: string,
    @Query('camera_id') cameraId?: string,
    @Query('class') classQ?: string,
    @Query('limit') limit?: string,
    @Query('with_image') withImage?: string,
    @Query('q') q?: string,
    @Query('since_ts') sinceTs?: string,
    @Query('until_ts') untilTs?: string,
    @Query('before_ts') beforeTs?: string,
  ) {
    return this.baService.visionListDetections(+id, req.user.buildingIds, {
      sinceHours, cameraId, class: classQ, limit, withImage, q,
      sinceTs, untilTs, beforeTs,
    })
  }

  // 2026-08-26 — zdarzenia sytuacyjne (korelator Edge) + Kronika dnia.
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/situations')
  situationsList(
    @Param('id') id: string,
    @Request() req: any,
    @Query('since_hours') sinceHours?: string,
    @Query('types') types?: string,
    @Query('limit') limit?: string,
  ) {
    return this.baService.situationsList(+id, req.user.buildingIds, {
      sinceHours, types, limit,
    })
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/chronicle')
  situationsChronicle(
    @Param('id') id: string,
    @Request() req: any,
    @Query('smart') smart?: string,
  ) {
    return this.baService.situationsChronicle(+id, req.user.buildingIds, smart !== '0')
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/vision/plate-suggestions')
  visionPlateSuggestions(
    @Param('id') id: string,
    @Request() req: any,
    @Query('since_days') sinceDays?: string,
  ) {
    return this.baService.visionPlateSuggestions(+id, req.user.buildingIds, sinceDays)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/vision/stats')
  visionStats(
    @Param('id') id: string,
    @Request() req: any,
    @Query('since_hours') sinceHours?: string,
  ) {
    return this.baService.visionStats(+id, req.user.buildingIds, sinceHours)
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/vision/cameras')
  visionCameras(@Param('id') id: string, @Request() req: any) {
    return this.baService.visionCameras(+id, req.user.buildingIds)
  }

  /**
   * Frame proxy — pipe-uje binarne JPEG z Edge. Używamy @Res żeby ominąć
   * NestJS default JSON serialization (tak jak resident snapshot endpoint).
   */
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/vision/frame/:filename')
  visionFrame(
    @Param('id') id: string,
    @Param('filename') filename: string,
    @Request() req: any,
    @Res() res: import('express').Response,
  ) {
    return this.baService.visionPipeFrame(+id, req.user.buildingIds, filename, res)
  }

  // ── FAZA d (2026-06-02) — Courier visits dla osiedla ─────────────────────

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/courier-visits')
  listCourierVisits(
    @Param('id') id: string,
    @Query('limit') limit: string | undefined,
    @Query('status') status: string | undefined,
    @Request() req: any,
  ) {
    return this.baService.listCourierVisits(+id, req.user.buildingIds, {
      limit: limit ? +limit : undefined,
      status,
    })
  }

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/courier-visits/stats')
  courierVisitsStats(@Param('id') id: string, @Request() req: any) {
    return this.baService.courierVisitsStats(+id, req.user.buildingIds)
  }
}
