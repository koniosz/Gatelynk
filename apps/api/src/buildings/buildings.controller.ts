import { Body, Controller, Delete, Get, Param, Patch, Post, Request, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { BuildingsService, CreateBuildingDto, UpdateBuildingDto } from './buildings.service'

@UseGuards(JwtAuthGuard)
@Controller('buildings')
export class BuildingsController {
  constructor(private buildingsService: BuildingsService) {}

  @Get()
  findAll(@Request() req: any) {
    return this.buildingsService.findAll(req.user.id)
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
  update(@Param('id') id: string, @Body() dto: UpdateBuildingDto, @Request() req: any) {
    return this.buildingsService.update(+id, req.user.id, dto)
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Request() req: any) {
    return this.buildingsService.remove(+id, req.user.id)
  }
}
