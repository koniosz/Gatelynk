import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import {
  BuildingsService,
  CreateBuildingDto,
  UpdateBuildingDto,
  StairwellIntercomDto,
  CreateLprCameraDto,
  UpdateLprCameraDto,
  CreateBuildingIntercomDto,
  UpdateBuildingIntercomDto,
  CreateIntegratorDto,
  CreateBuildingAdminDto,
  CreateConciergeDto,
  CreateVehicleDto,
  UpdateVehicleDto,
} from './buildings.service'

@UseGuards(JwtAuthGuard)
@Controller('buildings')
export class BuildingsController {
  constructor(private buildingsService: BuildingsService) {}

  @Get()
  findAll(
    @Request() req: any,
    @Query('includeArchived') includeArchived?: string,
  ) {
    return this.buildingsService.findAll(
      req.user.id,
      includeArchived === 'true',
    )
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: any) {
    return this.buildingsService.findOne(+id, req.user.id)
  }

  @Post()
  create(@Body() dto: CreateBuildingDto, @Request() req: any) {
    return this.buildingsService.create(req.user.id, dto)
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateBuildingDto,
    @Request() req: any,
  ) {
    return this.buildingsService.update(+id, req.user.id, dto)
  }

  @Patch(':id/archive')
  archive(@Param('id') id: string, @Request() req: any) {
    return this.buildingsService.archive(+id, req.user.id)
  }

  @Patch(':id/unarchive')
  unarchive(@Param('id') id: string, @Request() req: any) {
    return this.buildingsService.unarchive(+id, req.user.id)
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Body('confirmName') confirmName: string,
    @Request() req: any,
  ) {
    return this.buildingsService.remove(+id, req.user.id, confirmName)
  }

  // Klatki schodowe
  @Post(':id/stairwells')
  addStairwell(
    @Param('id') id: string,
    @Body('name') name: string,
    @Request() req: any,
  ) {
    return this.buildingsService.addStairwell(+id, req.user.id, name)
  }

  @Patch(':id/stairwells/:stairwellId')
  updateStairwell(
    @Param('id') id: string,
    @Param('stairwellId') stairwellId: string,
    @Body('name') name: string,
    @Request() req: any,
  ) {
    return this.buildingsService.updateStairwell(
      +id,
      +stairwellId,
      req.user.id,
      name,
    )
  }

  @Delete(':id/stairwells/:stairwellId')
  removeStairwell(
    @Param('id') id: string,
    @Param('stairwellId') stairwellId: string,
    @Request() req: any,
  ) {
    return this.buildingsService.removeStairwell(
      +id,
      +stairwellId,
      req.user.id,
    )
  }

  // ── Szczegóły klatki ────────────────────────────────────────────────────────
  @Get(':id/stairwells/:stairwellId')
  getStairwellDetail(
    @Param('id') id: string,
    @Param('stairwellId') stairwellId: string,
    @Request() req: any,
  ) {
    return this.buildingsService.getStairwellDetail(+id, +stairwellId, req.user.id)
  }

  // ── Domofon klatki ──────────────────────────────────────────────────────────
  @Put(':id/stairwells/:stairwellId/intercom')
  upsertStairwellIntercom(
    @Param('id') id: string,
    @Param('stairwellId') stairwellId: string,
    @Body() dto: StairwellIntercomDto,
    @Request() req: any,
  ) {
    return this.buildingsService.upsertStairwellIntercom(
      +id,
      +stairwellId,
      req.user.id,
      dto,
    )
  }

  // ── Kamery LPR ──────────────────────────────────────────────────────────────
  @Get(':id/lpr-cameras')
  getLprCameras(@Param('id') id: string, @Request() req: any) {
    return this.buildingsService.getLprCameras(+id, req.user.id)
  }

  @Post(':id/lpr-cameras')
  createLprCamera(
    @Param('id') id: string,
    @Body() dto: CreateLprCameraDto,
    @Request() req: any,
  ) {
    return this.buildingsService.createLprCamera(+id, req.user.id, dto)
  }

  @Patch(':id/lpr-cameras/:cameraId')
  updateLprCamera(
    @Param('id') id: string,
    @Param('cameraId') cameraId: string,
    @Body() dto: UpdateLprCameraDto,
    @Request() req: any,
  ) {
    return this.buildingsService.updateLprCamera(+id, +cameraId, req.user.id, dto)
  }

  @Delete(':id/lpr-cameras/:cameraId')
  deleteLprCamera(
    @Param('id') id: string,
    @Param('cameraId') cameraId: string,
    @Request() req: any,
  ) {
    return this.buildingsService.deleteLprCamera(+id, +cameraId, req.user.id)
  }

  // ── Domofony budynku ────────────────────────────────────────────────────────
  @Get(':id/intercoms')
  getIntercoms(@Param('id') id: string, @Request() req: any) {
    return this.buildingsService.getIntercoms(+id, req.user.id)
  }

  @Post(':id/intercoms')
  createIntercom(
    @Param('id') id: string,
    @Body() dto: CreateBuildingIntercomDto,
    @Request() req: any,
  ) {
    return this.buildingsService.createIntercom(+id, req.user.id, dto)
  }

  @Patch(':id/intercoms/:intercomId')
  updateIntercom(
    @Param('id') id: string,
    @Param('intercomId') intercomId: string,
    @Body() dto: UpdateBuildingIntercomDto,
    @Request() req: any,
  ) {
    return this.buildingsService.updateIntercom(+id, +intercomId, req.user.id, dto)
  }

  @Delete(':id/intercoms/:intercomId')
  deleteIntercom(
    @Param('id') id: string,
    @Param('intercomId') intercomId: string,
    @Request() req: any,
  ) {
    return this.buildingsService.deleteIntercom(+id, +intercomId, req.user.id)
  }

  // ── Pojazdy ────────────────────────────────────────────────────────────────
  @Get(':id/vehicles')
  getVehicles(@Param('id') id: string, @Request() req: any) {
    return this.buildingsService.getVehicles(+id, req.user.id)
  }

  @Post(':id/vehicles')
  createVehicle(
    @Param('id') id: string,
    @Body() dto: CreateVehicleDto,
    @Request() req: any,
  ) {
    return this.buildingsService.createVehicle(+id, req.user.id, dto)
  }

  @Patch(':id/vehicles/:vehicleId')
  updateVehicle(
    @Param('id') id: string,
    @Param('vehicleId') vehicleId: string,
    @Body() dto: UpdateVehicleDto,
    @Request() req: any,
  ) {
    return this.buildingsService.updateVehicle(+id, +vehicleId, req.user.id, dto)
  }

  @Delete(':id/vehicles/:vehicleId')
  deleteVehicle(
    @Param('id') id: string,
    @Param('vehicleId') vehicleId: string,
    @Request() req: any,
  ) {
    return this.buildingsService.deleteVehicle(+id, +vehicleId, req.user.id)
  }
}

// ── Integratorzy (osobny kontroler) ────────────────────────────────────────
@UseGuards(JwtAuthGuard)
@Controller('integrators')
export class IntegratorsController {
  constructor(private buildingsService: BuildingsService) {}

  @Get()
  getIntegrators(@Request() req: any) {
    return this.buildingsService.getIntegrators(req.user.id)
  }

  @Post()
  createIntegrator(@Body() dto: CreateIntegratorDto, @Request() req: any) {
    return this.buildingsService.createIntegrator(req.user.id, dto)
  }

  @Delete(':id')
  deleteIntegrator(@Param('id') id: string, @Request() req: any) {
    return this.buildingsService.deleteIntegrator(req.user.id, +id)
  }

  @Patch(':id/reset-password')
  resetIntegratorPassword(
    @Param('id') id: string,
    @Body('newPassword') newPassword: string,
    @Request() req: any,
  ) {
    return this.buildingsService.resetIntegratorPassword(req.user.id, +id, newPassword)
  }
}

// ── Administratorzy budynków (osobny kontroler) ──────────────────────────────
@UseGuards(JwtAuthGuard)
@Controller('building-admins')
export class BuildingAdminsController {
  constructor(private buildingsService: BuildingsService) {}

  @Get()
  getBuildingAdmins(@Request() req: any) {
    return this.buildingsService.getBuildingAdmins(req.user.id)
  }

  @Post()
  createBuildingAdmin(@Body() dto: CreateBuildingAdminDto, @Request() req: any) {
    return this.buildingsService.createBuildingAdmin(req.user.id, dto)
  }

  @Delete(':id')
  deleteBuildingAdmin(@Param('id') id: string, @Request() req: any) {
    return this.buildingsService.deleteBuildingAdmin(req.user.id, +id)
  }

  @Patch(':id/reset-password')
  resetBuildingAdminPassword(
    @Param('id') id: string,
    @Body('newPassword') newPassword: string,
    @Request() req: any,
  ) {
    return this.buildingsService.resetBuildingAdminPassword(req.user.id, +id, newPassword)
  }
}

// ── Konsjerże (osobny kontroler) ─────────────────────────────────────────────
@UseGuards(JwtAuthGuard)
@Controller('concierges')
export class ConciergesController {
  constructor(private buildingsService: BuildingsService) {}

  @Get()
  getConcierges(@Request() req: any) {
    return this.buildingsService.getConcierges(req.user.id)
  }

  @Post()
  createConcierge(@Body() dto: CreateConciergeDto, @Request() req: any) {
    return this.buildingsService.createConcierge(req.user.id, dto)
  }

  @Delete(':id')
  deleteConcierge(@Param('id') id: string, @Request() req: any) {
    return this.buildingsService.deleteConcierge(req.user.id, +id)
  }

  @Patch(':id/reset-password')
  resetConciergePassword(
    @Param('id') id: string,
    @Body('newPassword') newPassword: string,
    @Request() req: any,
  ) {
    return this.buildingsService.resetConciergePassword(req.user.id, +id, newPassword)
  }
}
