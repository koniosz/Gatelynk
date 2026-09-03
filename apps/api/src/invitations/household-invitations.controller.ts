import { Body, Controller, Get, Post, Query } from '@nestjs/common'
import { HouseholdInvitationsService } from './household-invitations.service'

// ─── Publiczne endpointy akceptacji zaproszenia domownika (2026-08-09) ────────
//
// Strona web `/accept-household?token=…` (apps/web) używa dwóch endpointów —
// wzór 1:1 z admin flow `/api/invitations/preview|accept` (PR-6):
//   GET  /api/household-invitations/preview?token=…  → nagłówek strony
//   POST /api/household-invitations/accept?token=…   → body { email, password,
//                                                       firstName?, lastName? }
// Token (64 hex, TTL 7 dni, jednorazowy) sam w sobie jest autoryzacją.
// Endpointy mieszkańca (tworzenie/lista/anulowanie) są w ResidentController
// pod guardem jwt-resident.

@Controller('household-invitations')
export class HouseholdInvitationsController {
  constructor(private svc: HouseholdInvitationsService) {}

  /** Public — podgląd zaproszenia (kto zaprasza, budynek, lokal, ważność). */
  @Get('preview')
  preview(@Query('token') token: string) {
    return this.svc.preview(token)
  }

  /** Public — akceptacja: e-mail + hasło → Resident + pivot do lokalu. */
  @Post('accept')
  accept(
    @Query('token') token: string,
    @Body() body: { email?: string; password?: string; firstName?: string; lastName?: string },
  ) {
    return this.svc.accept(token, body)
  }
}
