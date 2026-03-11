import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { PrismaModule } from './prisma/prisma.module'
import { AuthModule } from './auth/auth.module'
import { LicenseModule } from './license/license.module'
import { BuildingsModule } from './buildings/buildings.module'
import { UnitsModule } from './units/units.module'
import { ResidentsModule } from './residents/residents.module'
import { InvitationsModule } from './invitations/invitations.module'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    LicenseModule,
    BuildingsModule,
    UnitsModule,
    ResidentsModule,
    InvitationsModule,
  ],
})
export class AppModule {}
