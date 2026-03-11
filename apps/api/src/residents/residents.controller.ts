import { Body, Controller, Delete, Get, Param, Patch, Post, Request, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { ResidentsService, CreateResidentDto, AssignResidentDto } from './residents.service'

@UseGuards(JwtAuthGuard)
@Controller('buildings/:buildingId/residents')
export class ResidentsController {
  constructor(private residentsService: ResidentsService) {}

  @Get()
  findAll(@Param('buildingId') buildingId: string, @Request() req: any) {
    return this.residentsService.findAll(+buildingId, req.user.id)
  }

  @Get(':id')
  findOne(@Param('buildingId') buildingId: string, @Param('id') id: string, @Request() req: any) {
    return this.residentsService.findOne(+id, +buildingId, req.user.id)
  }

  @Post()
  create(@Param('buildingId') buildingId: string, @Body() dto: CreateResidentDto, @Request() req: any) {
    return this.residentsService.create(+buildingId, req.user.id, dto)
  }

  @Patch(':id')
  update(
    @Param('buildingId') buildingId: string,
    @Param('id') id: string,
    @Body() dto: Partial<CreateResidentDto>,
    @Request() req: any,
  ) {
    return this.residentsService.update(+id, +buildingId, req.user.id, dto)
  }

  @Delete(':id')
  remove(@Param('buildingId') buildingId: string, @Param('id') id: string, @Request() req: any) {
    return this.residentsService.remove(+id, +buildingId, req.user.id)
  }

  @Post(':unitId/assign')
  assignToUnit(
    @Param('buildingId') buildingId: string,
    @Param('unitId') unitId: string,
    @Body() dto: AssignResidentDto,
    @Request() req: any,
  ) {
    return this.residentsService.assignResidentToUnit(+buildingId, +unitId, req.user.id, dto)
  }

  @Patch('assignments/:assignmentId/end')
  removeFromUnit(
    @Param('buildingId') buildingId: string,
    @Param('assignmentId') assignmentId: string,
    @Request() req: any,
  ) {
    return this.residentsService.removeFromUnit(+assignmentId, +buildingId, req.user.id)
  }
}
