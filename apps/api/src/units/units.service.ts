import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { LicenseService } from '../license/license.service'
import { BuildingsService } from '../buildings/buildings.service'
import { IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator'

export class CreateUnitDto {
  @IsInt() unitTypeId: number
  @IsString() number: string
  @IsOptional() @IsInt() floor?: number
  @IsOptional() @IsNumber() areaSqm?: number
  @IsOptional() @IsString() description?: string
}

export class CreateUnitTypeDto {
  @IsString() name: string
  @IsString() icon: string
}

@Injectable()
export class UnitsService {
  constructor(
    private prisma: PrismaService,
    private licenseService: LicenseService,
    private buildingsService: BuildingsService,
  ) {}

  // Unit types
  async getUnitTypes(buildingId: number, adminId: number) {
    await this.buildingsService.findOne(buildingId, adminId)
    return this.prisma.unitType.findMany({
      where: { OR: [{ buildingId }, { isSystem: true, buildingId: null }] },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    })
  }

  async createUnitType(buildingId: number, adminId: number, dto: CreateUnitTypeDto) {
    await this.buildingsService.findOne(buildingId, adminId)
    const code = dto.name.toLowerCase().replace(/\s+/g, '_')
    return this.prisma.unitType.create({ data: { ...dto, code, buildingId, isSystem: false } })
  }

  // Units
  async findAll(buildingId: number, adminId: number) {
    await this.buildingsService.findOne(buildingId, adminId)
    return this.prisma.unit.findMany({
      where: { buildingId },
      include: { unitType: true },
      orderBy: { number: 'asc' },
    })
  }

  async findOne(id: number, buildingId: number, adminId: number) {
    await this.buildingsService.findOne(buildingId, adminId)
    const unit = await this.prisma.unit.findFirst({
      where: { id, buildingId },
      include: {
        unitType: true,
        unitResidents: { include: { resident: true }, where: { untilDate: null } },
      },
    })
    if (!unit) throw new NotFoundException('Lokal nie istnieje')
    return unit
  }

  async create(buildingId: number, adminId: number, dto: CreateUnitDto) {
    await this.buildingsService.findOne(buildingId, adminId)
    await this.licenseService.checkLimit(adminId, 'units')
    return this.prisma.unit.create({
      data: { ...dto, buildingId },
      include: { unitType: true },
    })
  }

  async update(id: number, buildingId: number, adminId: number, dto: Partial<CreateUnitDto>) {
    await this.findOne(id, buildingId, adminId)
    return this.prisma.unit.update({
      where: { id },
      data: dto,
      include: { unitType: true },
    })
  }

  async remove(id: number, buildingId: number, adminId: number) {
    await this.findOne(id, buildingId, adminId)
    return this.prisma.unit.delete({ where: { id } })
  }
}
