import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Request, UseGuards } from '@nestjs/common'
import { ConciergeJwtAuthGuard } from './concierge-jwt-auth.guard'
import {
  ConciergeService,
  ConciergeNotificationDto,
  ReceiveParcelDto,
  IssueParcelDto,
  CreateReservationDto,
  ConciergeCreateVehicleDto,
  ConciergeUpdateVehicleDto,
  ConciergeAddTicketReplyDto,
  ConciergeUpdateTicketStatusDto,
} from './concierge.service'
import { AccessEventsService, AccessEventType } from '../access-events/access-events.service'

@Controller('concierge')
export class ConciergeController {
  constructor(
    private conciergeService: ConciergeService,
    private accessEvents: AccessEventsService,
  ) {}

  // ── Auth ──────────────────────────────────────────────────────────────────
  @Post('auth/login')
  login(@Body() body: { email: string; password: string }) {
    return this.conciergeService.login(body.email, body.password)
  }

  // ── Me ────────────────────────────────────────────────────────────────────
  @UseGuards(ConciergeJwtAuthGuard)
  @Get('me')
  getMe(@Request() req: any) {
    return this.conciergeService.getMe(req.user.sub)
  }

  // ── Budynek ───────────────────────────────────────────────────────────────
  @UseGuards(ConciergeJwtAuthGuard)
  @Get('building')
  getBuilding(@Request() req: any) {
    return this.conciergeService.getBuilding(req.user.buildingId)
  }

  // ── Lokale ────────────────────────────────────────────────────────────────
  @UseGuards(ConciergeJwtAuthGuard)
  @Get('building/units')
  getUnits(@Request() req: any) {
    return this.conciergeService.getUnits(req.user.buildingId)
  }

  @UseGuards(ConciergeJwtAuthGuard)
  @Get('building/units/:unitId')
  getUnit(@Param('unitId') unitId: string, @Request() req: any) {
    return this.conciergeService.getUnit(+unitId, req.user.buildingId)
  }

  // ── Mieszkańcy ────────────────────────────────────────────────────────────
  @UseGuards(ConciergeJwtAuthGuard)
  @Get('building/residents')
  getResidents(@Request() req: any) {
    return this.conciergeService.getResidents(req.user.buildingId)
  }

  @UseGuards(ConciergeJwtAuthGuard)
  @Get('building/residents/:rId')
  getResident(@Param('rId') rId: string, @Request() req: any) {
    return this.conciergeService.getResident(+rId, req.user.buildingId)
  }

  // ── Powiadomienia ─────────────────────────────────────────────────────────
  @UseGuards(ConciergeJwtAuthGuard)
  @Post('building/notifications')
  sendNotification(@Body() dto: ConciergeNotificationDto, @Request() req: any) {
    return this.conciergeService.sendNotification(req.user.buildingId, dto)
  }

  // ── Przesyłki ─────────────────────────────────────────────────────────────
  @UseGuards(ConciergeJwtAuthGuard)
  @Get('building/parcels')
  getParcels(@Request() req: any, @Query('status') status?: string) {
    return this.conciergeService.getParcels(req.user.buildingId, status)
  }

  @UseGuards(ConciergeJwtAuthGuard)
  @Post('building/parcels')
  receiveParcel(@Body() dto: ReceiveParcelDto, @Request() req: any) {
    return this.conciergeService.receiveParcel(req.user.buildingId, req.user.id, dto)
  }

  @UseGuards(ConciergeJwtAuthGuard)
  @Patch('building/parcels/:id/issue')
  issueParcel(@Param('id') id: string, @Body() dto: IssueParcelDto, @Request() req: any) {
    return this.conciergeService.issueParcel(req.user.buildingId, +id, dto)
  }

  @UseGuards(ConciergeJwtAuthGuard)
  @Post('building/parcels/:id/remind')
  remindParcel(@Param('id') id: string, @Request() req: any) {
    return this.conciergeService.remindParcel(req.user.buildingId, +id)
  }

  @UseGuards(ConciergeJwtAuthGuard)
  @Get('building/units/:uid/parcels')
  getUnitParcels(@Param('uid') uid: string, @Request() req: any) {
    return this.conciergeService.getUnitParcels(req.user.buildingId, +uid)
  }

  // ── Pojazdy ───────────────────────────────────────────────────────────────
  @UseGuards(ConciergeJwtAuthGuard)
  @Get('building/vehicles')
  getVehicles(@Request() req: any) {
    return this.conciergeService.getVehicles(req.user.buildingId)
  }

  // Rejestracja samochodu — dla mieszkańca albo jako ogólna usługa (np.
  // śmieciarka). Używane z modalu „Identyfikuj" w liście odczytów LPR. Po
  // zapisie od razu aktualizujemy whitelistę na Edge.
  @UseGuards(ConciergeJwtAuthGuard)
  @Post('building/vehicles')
  createVehicle(@Body() dto: ConciergeCreateVehicleDto, @Request() req: any) {
    return this.conciergeService.createVehicle(req.user.buildingId, dto)
  }

  // Edycja istniejącego pojazdu — używane głównie z modalu LPR „Identyfikuj"
  // przy poprawianiu literówek. Symetryczne do BA — patrz updateVehicle w
  // concierge.service.ts (komentarz tam tłumaczy dlaczego concierge potrzebuje
  // własnego endpointu PATCH zamiast tylko POST).
  @UseGuards(ConciergeJwtAuthGuard)
  @Patch('building/vehicles/:vehicleId')
  updateVehicle(
    @Param('vehicleId') vehicleId: string,
    @Body() dto: ConciergeUpdateVehicleDto,
    @Request() req: any,
  ) {
    return this.conciergeService.updateVehicle(req.user.buildingId, +vehicleId, dto)
  }

  // Usunięcie pojazdu — głównie do sprzątania duplikatów (np. literówka, która
  // utworzyła drugi wpis przed dodaniem PATCH-a w UI).
  @UseGuards(ConciergeJwtAuthGuard)
  @Delete('building/vehicles/:vehicleId')
  deleteVehicle(@Param('vehicleId') vehicleId: string, @Request() req: any) {
    return this.conciergeService.deleteVehicle(req.user.buildingId, +vehicleId)
  }

  // Autocomplete sugestii nazw serwisów w budynku (np. „Glovo", „MPO").
  @UseGuards(ConciergeJwtAuthGuard)
  @Get('building/vehicle-service-names')
  listVehicleServiceNames(@Request() req: any) {
    return this.conciergeService.listServiceNames(req.user.buildingId)
  }

  // Autocomplete istniejących tagów pojazdów w budynku — łączymy z curated
  // dictionary po stronie front-endu (lib/vehicle-tags.ts).
  @UseGuards(ConciergeJwtAuthGuard)
  @Get('building/vehicle-tags')
  listVehicleTags(@Request() req: any) {
    return this.conciergeService.listVehicleTags(req.user.buildingId)
  }

  // ── Access events (Faza 3) ─────────────────────────────────────────────────
  //
  // Pełen feed wejść do budynku — concierge widzi wszystko co LPR/PIN/REMOTE.
  // Filtry opcjonalne (type, plate, q). `offset` + `limit` paginują;
  // `q` szuka po stronie servera, więc obejmuje cały zakres 30-dniowy
  // (nie tylko aktualną stronę).
  @UseGuards(ConciergeJwtAuthGuard)
  @Get('access-events')
  async getAccessEvents(
    @Request() req: any,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('type') type?: string,
    @Query('plate') plate?: string,
    @Query('q') q?: string,
    @Query('guestId') guestId?: string,
    @Query('guestsOnly') guestsOnly?: string,
  ) {
    const { events, total } = await this.accessEvents.listForBuilding(req.user.buildingId, {
      limit: limit ? +limit : 50,
      offset: offset ? +offset : 0,
      type: (type as AccessEventType) || null,
      plate: plate || null,
      q: q || null,
      // 2026-07-04 — per-gość historia + feed „tylko goście" (spójnie z BA
      // i resident endpointami). Backward-compat przy braku parametrów.
      guestId: guestId ? +guestId : null,
      guestsOnly: guestsOnly === 'true',
    })
    return { events, total }
  }

  // ── Goście (Faza 2 bety Villa Natura) ────────────────────────────────────
  // Konsjerż widzi i zarządza wszystkimi gośćmi w budynku — może zaprosić
  // gościa „od ręki" (np. taksówkarz przy szlabanie), edytować lub anulować.
  // residentId jest wymagany — pokazuje kogo „bierze na klatę" zaproszenie.
  @UseGuards(ConciergeJwtAuthGuard)
  @Get('building/guests')
  getGuests(@Request() req: any) {
    return this.conciergeService.getGuests(req.user.buildingId)
  }

  @UseGuards(ConciergeJwtAuthGuard)
  @Post('building/guests')
  createGuest(
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
    return this.conciergeService.createGuest(req.user.buildingId, body)
  }

  @UseGuards(ConciergeJwtAuthGuard)
  @Patch('building/guests/:id')
  updateGuest(
    @Request() req: any,
    @Param('id') id: string,
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
    return this.conciergeService.updateGuest(req.user.buildingId, +id, body)
  }

  @UseGuards(ConciergeJwtAuthGuard)
  @Delete('building/guests/:id')
  cancelGuest(@Request() req: any, @Param('id') id: string) {
    return this.conciergeService.cancelGuest(req.user.buildingId, +id)
  }

  /** Ponowne wysłanie emaila z linkiem do portalu zaproszenia. */
  @UseGuards(ConciergeJwtAuthGuard)
  @Post('building/guests/:id/resend-email')
  resendGuestInviteEmail(
    @Request() req: any,
    @Param('id') id: string,
    @Body() body: { email?: string },
  ) {
    return this.conciergeService.resendInviteEmail(req.user.buildingId, +id, body?.email)
  }

  /** Historia zdarzeń gości w budynku konsjerża (UNION guest_events PORTAL_OPEN
   *  + lpr_reads matched). Building bierzemy z JWT — konsjerż widzi tylko
   *  swój budynek (założenie: 1 konsjerż = 1 budynek/osiedle). */
  @UseGuards(ConciergeJwtAuthGuard)
  @Get('building/guests/history')
  getGuestsHistory(@Request() req: any) {
    return this.conciergeService.getGuestsHistory(req.user.buildingId)
  }

  // ── Części wspólne ────────────────────────────────────────────────────────
  @UseGuards(ConciergeJwtAuthGuard)
  @Get('building/common-areas')
  getCommonAreas(@Request() req: any) {
    return this.conciergeService.getCommonAreas(req.user.buildingId)
  }

  @UseGuards(ConciergeJwtAuthGuard)
  @Get('building/common-areas/:id/reservations')
  getDayReservations(
    @Param('id') id: string,
    @Query('date') date: string,
    @Request() req: any,
  ) {
    return this.conciergeService.getDayReservations(req.user.buildingId, +id, date)
  }

  // ── Rezerwacje ─────────────────────────────────────────────────────────────
  @UseGuards(ConciergeJwtAuthGuard)
  @Post('building/reservations')
  createReservation(@Body() dto: CreateReservationDto, @Request() req: any) {
    return this.conciergeService.createReservation(req.user.buildingId, dto)
  }

  @UseGuards(ConciergeJwtAuthGuard)
  @Patch('building/reservations/:id/cancel')
  cancelReservation(@Param('id') id: string, @Request() req: any) {
    return this.conciergeService.cancelReservation(req.user.buildingId, +id)
  }

  // ── Tickety (Faza 4) ──────────────────────────────────────────────────────
  //
  // Konsjerż widzi tylko ticket-y typu CONCIERGE w SWOIM budynku (z JWT).
  // Może odpowiadać + zmieniać status. Push do mieszkańca + auto-IN_PROGRESS
  // przy pierwszej odpowiedzi — patrz `addConciergeTicketReply` w service.
  @UseGuards(ConciergeJwtAuthGuard)
  @Get('building/tickets')
  getTickets(@Request() req: any, @Query('status') status?: string) {
    return this.conciergeService.getConciergeTickets(req.user.buildingId, status)
  }

  @UseGuards(ConciergeJwtAuthGuard)
  @Get('building/tickets/:ticketId')
  getTicket(@Request() req: any, @Param('ticketId') ticketId: string) {
    return this.conciergeService.getConciergeTicket(req.user.buildingId, +ticketId)
  }

  @UseGuards(ConciergeJwtAuthGuard)
  @Post('building/tickets/:ticketId/replies')
  addTicketReply(
    @Request() req: any,
    @Param('ticketId') ticketId: string,
    @Body() dto: ConciergeAddTicketReplyDto,
  ) {
    return this.conciergeService.addConciergeTicketReply(
      req.user.buildingId,
      req.user.sub,
      +ticketId,
      dto,
    )
  }

  @UseGuards(ConciergeJwtAuthGuard)
  @Patch('building/tickets/:ticketId/status')
  updateTicketStatus(
    @Request() req: any,
    @Param('ticketId') ticketId: string,
    @Body() dto: ConciergeUpdateTicketStatusDto,
  ) {
    return this.conciergeService.updateConciergeTicketStatus(
      req.user.buildingId,
      +ticketId,
      dto,
    )
  }
}
