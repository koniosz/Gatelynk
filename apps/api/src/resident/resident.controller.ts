import { Controller, Post, Get, Patch, Body, Param, Delete, Query, UseGuards, Request, Res } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { ResidentService } from './resident.service'
import { AccessEventsService } from '../access-events/access-events.service'
import { CourierVisitService } from './courier-visit.service'
import { GuestPortalService } from '../guest-portal/guest-portal.service'
import { ResidentSmartLockService } from './resident-smart-lock.service'
import { HouseholdInvitationsService } from '../invitations/household-invitations.service'

@Controller('resident')
export class ResidentController {
  constructor(
    private svc: ResidentService,
    private accessEvents: AccessEventsService,
    private courier: CourierVisitService,
    private guestPortal: GuestPortalService,
    private smartLock: ResidentSmartLockService,
    private household: HouseholdInvitationsService,
  ) {}

  // ── Auth ──────────────────────────────────────────────────────────────────

  @Post('auth/login')
  login(@Body() body: { email: string; password: string }) {
    return this.svc.login(body.email, body.password)
  }

  /** Step 2 of multi-building login: pick a building */
  @Post('auth/select-building')
  selectBuilding(@Body() body: { email: string; password: string; residentId: number }) {
    return this.svc.selectBuilding(body.email, body.password, body.residentId)
  }

  // ── Protected ─────────────────────────────────────────────────────────────

  /** In-app building switcher — returns new JWT for the chosen building */
  @UseGuards(AuthGuard('jwt-resident'))
  @Post('auth/switch-building')
  switchBuilding(@Request() req: any, @Body() body: { residentId: number }) {
    return this.svc.switchBuilding(req.user.email, body.residentId)
  }

  /** List all buildings this resident belongs to */
  @UseGuards(AuthGuard('jwt-resident'))
  @Get('my-buildings')
  getMyBuildings(@Request() req: any) {
    return this.svc.getMyBuildings(req.user.email)
  }

  @UseGuards(AuthGuard('jwt-resident'))
  @Get('me')
  getMe(@Request() req: any) {
    return this.svc.getMe(req.user.residentId)
  }

  /**
   * 2026-07-07: Usunięcie konta z poziomu aplikacji (wymóg Apple 5.1.1(v)).
   * Soft-delete/anonimizacja spójna z polityką prywatności (model procesora:
   * dane audytu wejść zostają u administratora danych — wspólnoty/zarządcy).
   */
  @UseGuards(AuthGuard('jwt-resident'))
  @Delete('me')
  deleteMyAccount(@Request() req: any) {
    return this.svc.deleteMyAccount(req.user.residentId)
  }

  @UseGuards(AuthGuard('jwt-resident'))
  @Patch('me/avatar')
  updateAvatar(@Request() req: any, @Body() body: { avatarBase64: string | null }) {
    return this.svc.updateAvatar(req.user.residentId, body.avatarBase64)
  }

  /**
   * 2026-06-02: Stały PIN mieszkańca do klawiatury Akuvox przy bramie.
   * Body: `{ pin: "123456" | null }` — null usuwa PIN.
   * Walidacja: 4-6 cyfr, blacklist trivial, unique per building, brak kolizji
   * z aktywnym Guest.pin. Po success: Cloud pusha `RESIDENT_PIN_UPSERT` przez
   * tunnel do Edge — działa offline-first.
   */
  @UseGuards(AuthGuard('jwt-resident'))
  @Patch('me/intercom-pin')
  setIntercomPin(@Request() req: any, @Body() body: { pin: string | null }) {
    return this.svc.setIntercomPin(req.user.residentId, body?.pin ?? null)
  }

  @UseGuards(AuthGuard('jwt-resident'))
  @Get('building')
  getBuilding(@Request() req: any) {
    return this.svc.getBuilding(req.user.buildingId)
  }

  @UseGuards(AuthGuard('jwt-resident'))
  @Get('notifications')
  getNotifications(@Request() req: any) {
    return this.svc.getNotifications(req.user.residentId, req.user.buildingId)
  }

  @UseGuards(AuthGuard('jwt-resident'))
  @Get('parcels')
  getParcels(@Request() req: any) {
    return this.svc.getParcels(req.user.residentId, req.user.buildingId)
  }

  @UseGuards(AuthGuard('jwt-resident'))
  @Get('vehicles')
  getVehicles(@Request() req: any) {
    return this.svc.getVehicles(req.user.residentId)
  }

  @UseGuards(AuthGuard('jwt-resident'))
  @Post('vehicles')
  createVehicle(
    @Request() req: any,
    @Body()
    body: {
      make: string
      model?: string
      color: string
      licensePlate: string
      kind?: 'RESIDENT' | 'SERVICE' | 'DELIVERY' | 'EMERGENCY' | 'PUBLIC'
      serviceName?: string
      notes?: string
      photo?: string
    },
  ) {
    return this.svc.createVehicle(req.user.residentId, req.user.buildingId, body)
  }

  @UseGuards(AuthGuard('jwt-resident'))
  @Patch('vehicles/:id')
  updateVehicle(
    @Request() req: any,
    @Param('id') id: string,
    @Body()
    body: {
      make?: string
      model?: string
      color?: string
      licensePlate?: string
      kind?: 'RESIDENT' | 'SERVICE' | 'DELIVERY' | 'EMERGENCY' | 'PUBLIC'
      serviceName?: string
      notes?: string
      // undefined = bez zmian, null = usuń zdjęcie.
      photo?: string | null
      // Push o przejeździe własnego pojazdu (2026-08-21).
      notifyOnUse?: boolean
      // 2026-09-25 — czy rozpoznanie tablicy ma otwierać bramę/szlaban
      // (przełącznik w karcie pojazdu). Egzekwowane offline na Edge.
      autoOpen?: boolean
    },
  ) {
    return this.svc.updateVehicle(+id, req.user.residentId, body)
  }

  @UseGuards(AuthGuard('jwt-resident'))
  @Delete('vehicles/:id')
  deleteVehicle(@Request() req: any, @Param('id') id: string) {
    return this.svc.deleteVehicle(+id, req.user.residentId)
  }

  // ── Goście (Faza 2 bety Villa Natura) ─────────────────────────────────────
  // Mieszkaniec zaprasza gościa: dostaje 6-cyfrowy PIN do domofonu Akuvox
  // (Faza 2D), opcjonalnie tablica idzie do allowlist LPR na czas pobytu.
  // GET zwraca zarówno aktywnych jak i przeszłych (po validTo / cancelled),
  // klient sortuje. Cron-job od EXPIRED — Faza 2B/3.

  @UseGuards(AuthGuard('jwt-resident'))
  @Get('guests')
  getGuests(@Request() req: any) {
    return this.svc.getGuests(req.user.residentId)
  }

  @UseGuards(AuthGuard('jwt-resident'))
  @Post('guests')
  createGuest(
    @Request() req: any,
    @Body()
    body: {
      name: string
      phone?: string
      vehiclePlate?: string
      // ISO 8601 — domyślnie now() jeśli null
      validFrom?: string
      // ISO 8601 — wymagane (max 30 dni od validFrom)
      validTo: string
      // Opcjonalny email — gdy podany, Cloud wyśle Resend z linkiem do
      // portalu (`gatelynk.com/g/<token>`). Bez emaila iOS i tak ma
      // urlToken w response → wysyła SMS lokalnie z telefonu mieszkańca.
      email?: string
      // false = bez pushy o aktywności tego gościa (2026-08-14).
      notifyOnUse?: boolean
      // Ograniczenia dostępu (2026-07-08) — opcjonalne, addytywne:
      //   [{apId, maxUses?}] — tylko wybrane wejścia (+limit otwarć per AP)
      allowedAccessPoints?: { apId: number; maxUses?: number | null }[] | null
      //   {days: [1..7]?, startTime: "06:00", endTime: "07:00", tz?} —
      //   cykliczne okno dobowe W RAMACH validFrom..validTo
      recurringSchedule?: {
        days?: number[] | null
        startTime: string
        endTime: string
        tz?: string | null
      } | null
    },
  ) {
    return this.svc.createGuest(req.user.residentId, req.user.buildingId, body)
  }

  // Edycja zaproszenia (np. przedłużenie pobytu, dopisanie tablicy).
  // Zmiana tablicy / okna czasowego synchronizuje LPR allowlist:
  // stara tablica DELETE, nowa UPSERT z aktualnymi datami.
  @UseGuards(AuthGuard('jwt-resident'))
  @Patch('guests/:id')
  updateGuest(
    @Request() req: any,
    @Param('id') id: string,
    @Body()
    body: {
      name?: string
      phone?: string | null
      vehiclePlate?: string | null
      validFrom?: string
      validTo?: string
      notifyOnUse?: boolean
      // Ograniczenia (2026-07-08): pominięte = bez zmian, null = wyczyść.
      allowedAccessPoints?: { apId: number; maxUses?: number | null }[] | null
      recurringSchedule?: {
        days?: number[] | null
        startTime: string
        endTime: string
        tz?: string | null
      } | null
    },
  ) {
    return this.svc.updateGuest(+id, req.user.residentId, body)
  }

  // CANCELLED — gość nie wjedzie więcej. Tablica usuwana z LPR allowlist.
  @UseGuards(AuthGuard('jwt-resident'))
  @Delete('guests/:id')
  cancelGuest(@Request() req: any, @Param('id') id: string) {
    return this.svc.cancelGuest(+id, req.user.residentId)
  }

  // ── Domownicy (2026-08-09) ────────────────────────────────────────────────
  // Mieszkaniec zaprasza domownika (żona/dziecko) do SWOJEGO lokalu: tworzy
  // zaproszenie (imię + opcjonalna relacja), dostaje link do udostępnienia
  // ShareLink-iem; domownik na /accept-household podaje e-mail + hasło →
  // pełnoprawny Resident + pivot unit_residents. Szczegóły + decyzje:
  // HouseholdInvitationsService.

  /** Lista: aktywni współlokatorzy + aktywne zaproszenia (per lokal). */
  @UseGuards(AuthGuard('jwt-resident'))
  @Get('household')
  getHousehold(@Request() req: any) {
    return this.household.overview(req.user.residentId, req.user.buildingId)
  }

  /** Nowe zaproszenie — response zawiera `inviteUrl` do ShareLink. */
  @UseGuards(AuthGuard('jwt-resident'))
  @Post('household/invitations')
  createHouseholdInvitation(
    @Request() req: any,
    @Body() body: { name?: string; relationLabel?: string | null; unitId?: number | null },
  ) {
    return this.household.create(req.user.residentId, req.user.buildingId, body)
  }

  /** Anulowanie — może każdy aktywny mieszkaniec lokalu zaproszenia. */
  @UseGuards(AuthGuard('jwt-resident'))
  @Delete('household/invitations/:id')
  cancelHouseholdInvitation(@Request() req: any, @Param('id') id: string) {
    return this.household.cancel(req.user.residentId, +id)
  }

  @UseGuards(AuthGuard('jwt-resident'))
  @Get('reservations')
  getReservations(@Request() req: any) {
    return this.svc.getReservations(req.user.residentId)
  }

  @UseGuards(AuthGuard('jwt-resident'))
  @Get('reservations/units')
  getReservableUnits(@Request() req: any) {
    return this.svc.getReservableUnits(req.user.buildingId)
  }

  @UseGuards(AuthGuard('jwt-resident'))
  @Post('reservations')
  createReservation(@Request() req: any, @Body() body: { unitId: number; startAt: string; endAt: string; note?: string }) {
    return this.svc.createReservation(req.user.residentId, req.user.buildingId, body)
  }

  @UseGuards(AuthGuard('jwt-resident'))
  @Patch('reservations/:id')
  updateReservation(@Request() req: any, @Param('id') id: string, @Body() body: { unitId?: number; startAt?: string; endAt?: string; note?: string }) {
    return this.svc.updateReservation(+id, req.user.residentId, body)
  }

  @UseGuards(AuthGuard('jwt-resident'))
  @Delete('reservations/:id')
  cancelReservation(@Request() req: any, @Param('id') id: string) {
    return this.svc.cancelReservation(+id, req.user.residentId)
  }

  @UseGuards(AuthGuard('jwt-resident'))
  @Get('tickets')
  getTickets(@Request() req: any) {
    return this.svc.getTickets(req.user.residentId)
  }

  @UseGuards(AuthGuard('jwt-resident'))
  @Post('tickets')
  createTicket(
    @Request() req: any,
    // `type` (Faza 4) — opcjonalny, default 'ADMIN'. iOS wysyła 'CONCIERGE'
    // gdy mieszkaniec chce zgłosić sprawę portierowi (np. paczka czeka,
    // odebranie kuriera).
    @Body() body: { category: string; title: string; body: string; photo?: string; type?: string },
  ) {
    return this.svc.createTicket(req.user.residentId, req.user.buildingId, body)
  }

  @UseGuards(AuthGuard('jwt-resident'))
  @Get('tickets/:id')
  getTicket(@Request() req: any, @Param('id') id: string) {
    return this.svc.getTicket(+id, req.user.residentId)
  }

  @UseGuards(AuthGuard('jwt-resident'))
  @Post('tickets/:id/replies')
  addReply(@Request() req: any, @Param('id') id: string, @Body() body: { body: string; photo?: string }) {
    return this.svc.addReply(+id, req.user.residentId, body.body, body.photo)
  }

  // Usunięcie własnego zgłoszenia (2026-07-13) — swipe-to-delete w iOS.
  // Twarde usunięcie ticketu wraz z odpowiedziami.
  @UseGuards(AuthGuard('jwt-resident'))
  @Delete('tickets/:id')
  deleteTicket(@Request() req: any, @Param('id') id: string) {
    return this.svc.deleteTicket(+id, req.user.residentId)
  }

  // ── Access Points ─────────────────────────────────────────────────────────

  @UseGuards(AuthGuard('jwt-resident'))
  @Get('access-points')
  getAccessPoints(@Request() req: any) {
    return this.svc.getAccessPoints(req.user.buildingId, req.user.residentId)
  }

  @UseGuards(AuthGuard('jwt-resident'))
  @Get('access-points/:id/snapshot')
  getSnapshot(
    @Request() req: any, @Param('id') id: string, @Query('live') live: string,
    @Query('w') w: string, @Query('q') q: string,
    @Res() res: import('express').Response,
  ) {
    // 2026-08-19: ?w/?q — wariant kaflowy (downscale na Edge, ~10× mniejszy
    // transfer). Clamp jak na Edge; bez w = pełna klatka (sheet podglądu).
    const width = w ? Math.max(160, Math.min(parseInt(w, 10) || 0, 1920)) : undefined
    const quality = q ? Math.max(30, Math.min(parseInt(q, 10) || 0, 90)) : undefined
    return this.svc.pipeSnapshot(+id, req.user.buildingId, res, live === '1', width, quality)
  }

  /**
   * Live MJPEG z kamery domofonu (2026-08-12) — proxy strumienia
   * `http://<edge>:4000/devices/<uuid>/stream` (Akuvox video.cgi albo
   * RTSP→MJPEG przez ffmpeg na Edge). Apka (GlassCameraSheet) konsumuje
   * multipart/x-mixed-replace i wyciąga klatki JPEG; przy błędzie wraca
   * do pollingu snapshotów.
   */
  @UseGuards(AuthGuard('jwt-resident'))
  @Get('access-points/:id/stream')
  getVideoStream(@Request() req: any, @Param('id') id: string, @Res() res: import('express').Response) {
    return this.svc.pipeVideoStream(+id, req.user.buildingId, res)
  }

  @UseGuards(AuthGuard('jwt-resident'))
  @Post('access-points/:id/open')
  openAccessPoint(@Request() req: any, @Param('id') id: string) {
    return this.svc.openAccessPoint(+id, req.user.buildingId, req.user.residentId)
  }

  // ── Smart lock (Nuki) — onboarding PRZEZ MIESZKAŃCA (2026-07-09) ─────────────
  // Świadoma zgoda: mieszkaniec sam podaje token API Nuki i podpina zamek do
  // SWOJEGO lokalu. Token płynie pass-through na Edge (NIE do Postgres/logów
  // Cloud). unitId wyliczany z unit_residents (NIE z body). Feature wykrywany
  // przez iOS po istnieniu tych endpointów (fail-silent na starym backendzie).

  /** Status zamka lokalu (jest/brak, nazwa + live stan) — bez tokenu.
   *  `?fresh=1` omija 12 s cache (klient po otwarciu zamka odświeża stan). */
  @UseGuards(AuthGuard('jwt-resident'))
  @Get('smart-lock')
  getSmartLock(@Request() req: any, @Query('fresh') fresh?: string) {
    return this.smartLock.status(req.user.residentId, req.user.buildingId, {
      fresh: fresh === '1' || fresh === 'true',
    })
  }

  /** Weryfikacja tokenu → lista zamków konta Nuki (delegowana do Edge). */
  @UseGuards(AuthGuard('jwt-resident'))
  @Post('smart-lock/verify')
  verifySmartLock(@Request() req: any, @Body() body: { apiToken: string }) {
    return this.smartLock.verify(req.user.residentId, req.user.buildingId, body?.apiToken)
  }

  /** Rejestracja zamka jako UNIT_DOOR lokalu mieszkańca. */
  @UseGuards(AuthGuard('jwt-resident'))
  @Post('smart-lock')
  createSmartLock(
    @Request() req: any,
    @Body()
    body: { apiToken: string; smartlockId: string; name?: string; unitId?: number; replace?: boolean },
  ) {
    return this.smartLock.create(req.user.residentId, req.user.buildingId, body)
  }

  /** Usunięcie zamka lokalu (tylko własny lokal). */
  @UseGuards(AuthGuard('jwt-resident'))
  @Delete('smart-lock/:apId')
  deleteSmartLock(@Request() req: any, @Param('apId') apId: string) {
    return this.smartLock.remove(req.user.residentId, req.user.buildingId, +apId)
  }

  // ── Guest approvals (2026-07-08, Nuki UNIT_DOOR) ────────────────────────────
  // Gość poprosił o otwarcie drzwi lokalu (approvalRequired) → host widzi
  // PENDING requesty i zatwierdza/odrzuca. Otwarcie wykonuje Cloud po approve.

  @UseGuards(AuthGuard('jwt-resident'))
  @Get('guest-approvals/pending')
  listGuestApprovals(@Request() req: any) {
    return this.guestPortal.listPendingApprovals(req.user.residentId)
  }

  @UseGuards(AuthGuard('jwt-resident'))
  @Post('guest-approvals/:id/approve')
  approveGuestRequest(@Request() req: any, @Param('id') id: string) {
    return this.guestPortal.approveRequest(req.user.residentId, +id)
  }

  @UseGuards(AuthGuard('jwt-resident'))
  @Post('guest-approvals/:id/deny')
  denyGuestRequest(@Request() req: any, @Param('id') id: string) {
    return this.guestPortal.denyRequest(req.user.residentId, +id)
  }

  // ── Access events (Faza 3) ─────────────────────────────────────────────────

  /**
   * Lista „Ostatnich wejść" rezydenta — sklejony feed z access_events:
   *   • REMOTE_OPEN przez tego rezydenta,
   *   • LPR_MATCH dla jego pojazdów,
   *   • wszystkie eventy JEGO gości (PIN / LPR autem gościa / portal).
   *
   * Default limit=20 (HomeView pokazuje top 5; web może pobrać więcej).
   *
   * 2026-07-04 — opcjonalne `guestId=` (historia konkretnego gościa w
   * GuestsView) i `guestsOnly=true` (tylko aktywność gości). Prywatność
   * egzekwuje `listForResident` — cudzy guestId zwraca pustą listę.
   */
  /**
   * GET /api/resident/vehicles/:id/history — pełna historia przejazdów
   * WŁASNEGO pojazdu (access_events po tablicy; LPR_MATCH + odmowy).
   */
  @UseGuards(AuthGuard('jwt-resident'))
  @Get('vehicles/:id/history')
  async vehicleHistory(
    @Request() req: any,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.vehicleHistory(
      +id, req.user.buildingId, req.user.residentId,
      limit ? parseInt(limit, 10) || 200 : 200,
    )
  }

  @UseGuards(AuthGuard('jwt-resident'))
  @Get('access-events')
  async getAccessEvents(
    @Request() req: any,
    @Query('limit') limit?: string,
    @Query('guestId') guestId?: string,
    @Query('guestsOnly') guestsOnly?: string,
  ) {
    const events = await this.accessEvents.listForResident(
      req.user.residentId,
      req.user.buildingId,
      {
        limit: limit ? +limit : 20,
        guestId: guestId ? +guestId : null,
        guestsOnly: guestsOnly === 'true',
      },
    )
    return { events }
  }

  // ── Push Tokens ────────────────────────────────────────────────────────────

  @UseGuards(AuthGuard('jwt-resident'))
  @Post('push-token')
  registerPushToken(
    @Request() req: any,
    @Body() body: {
      token: string
      environment?: 'production' | 'development'
      // 2026-07-15 — bundle apki (GateLynk/Glass/Gamma); topic APNs per token.
      bundleId?: string
    },
  ) {
    // `environment`/`bundleId` opcjonalne dla wstecznej kompatybilności ze
    // starymi buildami iOS — domyślnie 'production' / fallback env.
    return this.svc.registerPushToken(req.user.residentId, body.token, body.environment, body.bundleId)
  }

  @UseGuards(AuthGuard('jwt-resident'))
  @Delete('push-token')
  unregisterPushToken(@Body() body: { token: string }) {
    return this.svc.unregisterPushToken(body.token)
  }

  // ── PAYMENTS ──────────────────────────────────────────────────────────────────

  @UseGuards(AuthGuard('jwt-resident'))
  @Get('payments')
  getMyPayments(@Request() req: any) {
    return this.svc.getMyPayments(req.user.residentId, req.user.buildingId)
  }

  /**
   * 2026-07-04 — archiwum naliczeń miesięcznych mieszkańca (składowe + status
   * + wpłaty per miesiąc). `months` clamp 1–24, default 12. Fail-soft: pusta
   * lista + `configured: false` gdy budynek nie ma konfiguracji opłat.
   */
  @UseGuards(AuthGuard('jwt-resident'))
  @Get('payments/charges')
  getMyPaymentCharges(@Request() req: any, @Query('months') months?: string) {
    return this.svc.getMyPaymentCharges(
      req.user.residentId,
      req.user.buildingId,
      months !== undefined ? Number(months) : undefined,
    )
  }

  // ── COURIER VISITS (FAZA d — 2026-06-02) ──────────────────────────────────

  /** Mieszkaniec akceptuje wizyte kuriera → fire AP. */
  @UseGuards(AuthGuard('jwt-resident'))
  @Post('courier-visits/accept/:id')
  acceptCourierVisit(@Param('id') id: string, @Request() req: any) {
    return this.courier.accept(+id, req.user.residentId, req.user.buildingId)
  }

  /** Mieszkaniec odrzuca wizyte. */
  @UseGuards(AuthGuard('jwt-resident'))
  @Post('courier-visits/reject/:id')
  rejectCourierVisit(@Param('id') id: string, @Request() req: any) {
    return this.courier.reject(+id, req.user.residentId, req.user.buildingId)
  }
}
