import { Injectable, UnauthorizedException } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { ExtractJwt, Strategy } from 'passport-jwt'
import { ConfigService } from '@nestjs/config'

@Injectable()
export class BuildingAdminJwtStrategy extends PassportStrategy(Strategy, 'jwt-building-admin') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET', 'fallback-secret'),
    })
  }

  async validate(payload: { sub: number; email: string; type: string; buildingIds: number[] }) {
    if (payload.type !== 'building-admin') {
      throw new UnauthorizedException()
    }
    // `sub` dokładany obok `id` (2026-07-18): kontrolery używają
    // `req.user.sub` (np. GET /me, authorId w ticket replies) — bez tego
    // pola sub było undefined i /me kończyło się 500.
    return { id: payload.sub, sub: payload.sub, email: payload.email, buildingIds: payload.buildingIds }
  }
}
