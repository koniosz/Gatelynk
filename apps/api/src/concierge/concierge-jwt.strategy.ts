import { Injectable, UnauthorizedException } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { ExtractJwt, Strategy } from 'passport-jwt'
import { ConfigService } from '@nestjs/config'

@Injectable()
export class ConciergeJwtStrategy extends PassportStrategy(Strategy, 'jwt-concierge') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET', 'fallback-secret'),
    })
  }

  async validate(payload: { sub: number; email: string; type: string; buildingId: number }) {
    if (payload.type !== 'concierge') {
      throw new UnauthorizedException()
    }
    return { id: payload.sub, email: payload.email, buildingId: payload.buildingId }
  }
}
