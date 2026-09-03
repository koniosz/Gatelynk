import { Injectable } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'

@Injectable()
export class ConciergeJwtAuthGuard extends AuthGuard('jwt-concierge') {}
