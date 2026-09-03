// PR-5 (2026-07-05) — moduł importu mieszkańców z CSV.
// Guardy JWT (jwt-integrator / jwt-building-admin) rejestrują strategie
// w IntegratorModule / BuildingAdminModule — tu tylko klasy guardów.
import { Module } from '@nestjs/common'
import { PassportModule } from '@nestjs/passport'
import { ResidentsImportService } from './residents-import.service'
import { ResidentsImportController } from './residents-import.controller'

@Module({
  imports: [PassportModule],
  providers: [ResidentsImportService],
  controllers: [ResidentsImportController],
  exports: [ResidentsImportService],
})
export class ResidentsImportModule {}
