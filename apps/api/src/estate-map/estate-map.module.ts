import { Module } from '@nestjs/common'
import { PrismaModule } from '../prisma/prisma.module'
import { EstateMapService } from './estate-map.service'
import { EstateMapController } from './estate-map.controller'

/**
 * Mapa osiedla (2026-09-08). Guard `jwt-building-admin` jest strategią
 * Passport zarejestrowaną w BuildingAdminModule — działa globalnie, więc
 * kontroler nie musi importować tamtego modułu.
 */
@Module({
  imports: [PrismaModule],
  providers: [EstateMapService],
  controllers: [EstateMapController],
  exports: [EstateMapService],
})
export class EstateMapModule {}
