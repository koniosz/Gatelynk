import { Injectable, UnauthorizedException } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { ExtractJwt, Strategy } from 'passport-jwt'
import { ConfigService } from '@nestjs/config'

@Injectable()
export class ResidentJwtStrategy extends PassportStrategy(Strategy, 'jwt-resident') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET', 'fallback-secret'),
    })
  }

  async validate(payload: { sub: number; email: string; type: string; buildingId: number; residentId: number }) {
    if (payload.type !== 'resident') throw new UnauthorizedException()
    return { id: payload.sub, email: payload.email, buildingId: payload.buildingId, residentId: payload.residentId }
  }
}
