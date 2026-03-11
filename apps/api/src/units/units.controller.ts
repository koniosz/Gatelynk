import { Body, Controller, Delete, Get, Param, Patch, Post, Request, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { UnitsService, CreateUnitDto, CreateUnitTypeDto } from './units.service'

@UseGuards(JwtAuthGuard)
@Controller('buildings/:buildingId')
export class UnitsController {
  constructor(private unitsService: UnitsService) {}

  // Unit types
  @Get('unit-types')
  getUnitTypes(@Param('buildingId') buildingId: string, @Request() req: any) {
    return this.unitsService.getUnitTypes(+buildingId, req.user.id)
  }

  @Post('unit-types')
  createUnitType(
    @Param('buildingId') buildingId: string,
    @Body() dto: CreateUnitTypeDto,
    @Request() req: any,
  ) {
    return this.unitsService.createUnitType(+buildingId, req.user.id, dto)
  }

  // Units
  @Get('units')
  findAll(@Param('buildingId') buildingId: string, @Request() req: any) {
    return this.unitsService.findAll(+buildingId, req.user.id)
  }

  @Get('units/:id')
  findOne(@Param('buildingId') buildingId: string, @Param('id') id: string, @Request() req: any) {
    return this.unitsService.findOne(+id, +buildingId, req.user.id)
  }

  @Post('units')
  create(@Param('buildingId') buildingId: string, @Body() dto: CreateUnitDto, @Request() req: any) {
    return this.unitsService.create(+buildingId, req.user.id, dto)
  }

  @Patch('units/:id')
  update(
    @Param('buildingId') buildingId: string,
    @Param('id') id: string,
    @Body() dto: Partial<CreateUnitDto>,
    @Request() req: any,
  ) {
    return this.unitsService.update(+id, +buildingId, req.user.id, dto)
  }

  @Delete('units/:id')
  remove(@Param('buildingId') buildingId: string, @Param('id') id: string, @Request() req: any) {
    return this.unitsService.remove(+id, +buildingId, req.user.id)
  }
}
