import {
  Controller, Post, Body, Headers, UnauthorizedException, BadRequestException,
} from '@nestjs/common'
import { EdgeService } from '../edge/edge.service'
import { GuestsValidationService } from './guests-validation.service'

/**
 * Edge → Cloud: walidacja PIN-u domofonu (Faza 2D).
 *
 * Edge wystawia ten endpoint w łańcuchu Akuvox:
 *   1. Mieszkaniec zaprasza gościa (PATCH /resident/guests/...) → DB ma PIN.
 *   2. Gość przykłada PIN do domofonu Akuvox.
 *   3. Edge przechwytuje code → woła Cloud `/api/edge/validate-pin`.
 *   4. Cloud zwraca allowed=true/false → Edge wysyła „open relay" do Akuvox.
 *
 * Auth: bearer = długoterminowy JWT Edge (z `/api/edge/refresh`). Sprawdzamy
 * `verifyToken` ręcznie zamiast guarda — żeby uniknąć importu PassportModule
 * tylko dla tej jednej trasy.
 *
 * Trasa siedzi pod `/api/edge/...` (Edge zna ten prefix) — kontroler ma więc
 * `@Controller('edge')` jak EdgeController; NestJS pozwala na wiele
 * kontrolerów dzielących prefix.
 */
@Controller('edge')
export class GuestsEdgeController {
  constructor(
    private edge: EdgeService,
    private validation: GuestsValidationService,
  ) {}

  @Post('validate-pin')
  async validatePin(
    @Headers('authorization') authHeader: string | undefined,
    @Body() body: { pin?: string; buildingId?: number },
  ) {
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!token) throw new UnauthorizedException()
    const identity = this.edge.verifyToken(token)
    if (!identity) throw new UnauthorizedException()

    // Edge nie musi przesyłać buildingId — wyciągamy z tokena, nie ufamy
    // body. Jeśli Edge poda buildingId, MUSI się zgadzać (defense-in-depth
    // przeciwko zhackowanej Edge).
    if (body.buildingId !== undefined && body.buildingId !== identity.buildingId) {
      throw new UnauthorizedException()
    }

    const pin = (body.pin ?? '').trim()
    if (!pin) throw new BadRequestException('PIN required')

    return this.validation.validatePin(identity.buildingId, pin)
  }
}
