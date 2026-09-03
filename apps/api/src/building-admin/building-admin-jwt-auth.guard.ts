import { Injectable } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'

@Injectable()
export class BuildingAdminJwtAuthGuard extends AuthGuard('jwt-building-admin') {}
