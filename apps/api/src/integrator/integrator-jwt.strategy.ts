import { Injectable, UnauthorizedException } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { ExtractJwt, Strategy } from 'passport-jwt'
import { ConfigService } from '@nestjs/config'

@Injectable()
export class IntegratorJwtStrategy extends PassportStrategy(Strategy, 'jwt-integrator') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET', 'fallback-secret'),
    })
  }

  async validate(payload: { sub: number; email: string; type: string; adminId: number }) {
    if (payload.type !== 'integrator') {
      throw new UnauthorizedException()
    }
    // Zwracamy `sub` (JWT subject = integrator.id) ORAZ alias `id` dla backwards
    // compatibility ze starymi endpointami które używały `req.user.id`.
    // Nowe endpointy (Sesja 3-6) używają `req.user.sub` — vide
    // integrator.controller.ts (getMe, updateMe, audit, deeplink, email-change, etc.).
    return {
      sub: payload.sub,
      id: payload.sub,
      email: payload.email,
      adminId: payload.adminId,
    }
  }
}
