/**
 * Mapa osiedla — endpointy administratora osiedla (jwt-building-admin).
 *
 *   GET    /building-admin/buildings/:id/estate-map
 *          → { map | null, assignments[], units[] }
 *   PUT    /building-admin/buildings/:id/estate-map
 *          → zapis/podmiana konfiguracji (render + obszary)
 *   PUT    /building-admin/buildings/:id/estate-map/slots/:mapBuildingId/:slot
 *          body { unitId, expectedUnitId?, replace?, move? } → przypisanie (atomowe)
 *   DELETE /building-admin/buildings/:id/estate-map/slots/:mapBuildingId/:slot
 *          body { expectedUnitId? } → odpięcie
 */
import { Body, Controller, Delete, Get, Param, Put, Request, UseGuards } from '@nestjs/common'
import { IsArray, IsBoolean, IsInt, IsObject, IsOptional, IsString } from 'class-validator'
import { BuildingAdminJwtAuthGuard } from '../building-admin/building-admin-jwt-auth.guard'
import { EstateMapService } from './estate-map.service'
import { EstateMapConfigInput } from './estate-map.types'

export class UpsertEstateMapDto {
  @IsString() name: string
  @IsString() imageUrl: string
  @IsObject() canvas: { width: number; height: number }
  @IsArray() buildings: EstateMapConfigInput['buildings']
  @IsOptional() @IsArray() gates?: EstateMapConfigInput['gates']
  @IsOptional() @IsArray() streets?: EstateMapConfigInput['streets']
  @IsOptional() @IsString() geometryStatus?: string
  @IsOptional() @IsString() addressStatus?: string
}

export class AssignEstateSlotDto {
  @IsInt() unitId: number
  // null = „widziałem puste miejsce"; brak pola = bez kontroli optymistycznej.
  @IsOptional() @IsInt() expectedUnitId?: number | null
  @IsOptional() @IsBoolean() replace?: boolean
  @IsOptional() @IsBoolean() move?: boolean
}

export class UnlinkEstateSlotDto {
  @IsOptional() @IsInt() expectedUnitId?: number | null
}

@Controller('building-admin/buildings/:id/estate-map')
@UseGuards(BuildingAdminJwtAuthGuard)
export class EstateMapController {
  constructor(private readonly service: EstateMapService) {}

  @Get()
  get(@Param('id') id: string, @Request() req: any) {
    return this.service.get(+id, req.user.buildingIds ?? [])
  }

  @Put()
  upsert(@Param('id') id: string, @Body() body: UpsertEstateMapDto, @Request() req: any) {
    return this.service.upsertConfig(+id, req.user.buildingIds ?? [], body as EstateMapConfigInput)
  }

  @Put('slots/:mapBuildingId/:slot')
  assign(
    @Param('id') id: string,
    @Param('mapBuildingId') mapBuildingId: string,
    @Param('slot') slot: string,
    @Body() body: AssignEstateSlotDto,
    @Request() req: any,
  ) {
    return this.service.assign(+id, req.user.buildingIds ?? [], mapBuildingId, slot, body, req.user.sub ?? null)
  }

  @Delete('slots/:mapBuildingId/:slot')
  unlink(
    @Param('id') id: string,
    @Param('mapBuildingId') mapBuildingId: string,
    @Param('slot') slot: string,
    @Body() body: UnlinkEstateSlotDto,
    @Request() req: any,
  ) {
    return this.service.unlink(+id, req.user.buildingIds ?? [], mapBuildingId, slot, body ?? {}, req.user.sub ?? null)
  }
}
