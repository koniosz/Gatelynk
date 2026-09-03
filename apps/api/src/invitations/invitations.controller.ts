import { Body, Controller, Get, Param, Post, Query, Request, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { InvitationsService } from './invitations.service'
import { IsInt } from 'class-validator'

class SendInvitationDto {
  @IsInt() residentId: number
  @IsInt() unitId: number
}

@Controller('invitations')
export class InvitationsController {
  constructor(private invitationsService: InvitationsService) {}

  @UseGuards(JwtAuthGuard)
  @Post('send')
  send(@Body() dto: SendInvitationDto, @Request() req: any) {
    // buildingId resolved from unit ownership in service
    return this.invitationsService.send(0, dto.residentId, dto.unitId, req.user.id)
  }

  @UseGuards(JwtAuthGuard)
  @Post('buildings/:buildingId/send')
  sendForBuilding(
    @Param('buildingId') buildingId: string,
    @Body() dto: SendInvitationDto,
    @Request() req: any,
  ) {
    return this.invitationsService.send(+buildingId, dto.residentId, dto.unitId, req.user.id)
  }

  @UseGuards(JwtAuthGuard)
  @Get('buildings/:buildingId')
  findAll(@Param('buildingId') buildingId: string) {
    return this.invitationsService.findAll(+buildingId)
  }

  // ── PR-6 (2026-07-05) — publiczny accept-flow z ustawieniem hasła ────────
  // Strona web `/accept-invitation?token=…` (apps/web) używa dwóch endpointów:
  //   GET  /api/invitations/preview?token=…   → dane do nagłówka strony
  //   POST /api/invitations/accept?token=…    → body { password } (nowy flow)
  // Token (64 hex, TTL 7 dni, hash w DB) sam w sobie jest autoryzacją.

  /** Public — podgląd zaproszenia (imię, budynek, lokal, ważność). */
  @Get('preview')
  preview(@Query('token') token: string) {
    return this.invitationsService.preview(token)
  }

  /** Public — akceptacja. Z `password` w body ustawia hasło mieszkańca
   *  (nowy flow PR-6); bez — legacy zmiana statusu (backward-compat). */
  @Post('accept')
  accept(@Query('token') token: string, @Body() body?: { password?: string }) {
    if (body?.password !== undefined) {
      return this.invitationsService.acceptWithPassword(token, body.password)
    }
    return this.invitationsService.accept(token)
  }
}
