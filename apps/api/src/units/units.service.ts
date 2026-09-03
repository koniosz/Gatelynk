import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { LicenseService } from '../license/license.service'
import { BuildingsService } from '../buildings/buildings.service'
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator'
import { sortUnits } from '../common/natural-sort'

export class CreateUnitDto {
  @IsInt() unitTypeId: number
  @IsString() number: string
  @IsOptional() @IsInt() floor?: number
  @IsOptional() @IsNumber() areaSqm?: number
  @IsOptional() @IsString() description?: string
  @IsOptional() @IsInt() stairwellId?: number
}

export class CreateUnitTypeDto {
  @IsString() name: string
  @IsString() icon: string
  @IsOptional() @IsBoolean() isCommonArea?: boolean
}

export class UpsertCommonAreaSettingsDto {
  @IsOptional() @IsInt() maxSlotMinutes?: number
  @IsOptional() @IsString() openTime?: string
  @IsOptional() @IsString() closeTime?: string
  @IsOptional() @IsBoolean() isPaid?: boolean
  @IsOptional() @IsNumber() pricePerHour?: number
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
    const { isCommonArea, ...rest } = dto
    return this.prisma.unitType.create({
      data: { ...rest, code, buildingId, isSystem: false, isCommonArea: isCommonArea ?? false },
    })
  }

  async upsertCommonAreaSettings(
    id: number,
    buildingId: number,
    adminId: number,
    dto: UpsertCommonAreaSettingsDto,
  ) {
    const unit = await this.findOne(id, buildingId, adminId)
    if (!unit.unitType.isCommonArea) {
      throw new BadRequestException('Ten lokal nie jest częścią wspólną')
    }
    return this.prisma.commonAreaSettings.upsert({
      where: { unitId: id },
      create: {
        unitId: id,
        maxSlotMinutes: dto.maxSlotMinutes ?? 60,
        openTime: dto.openTime ?? '08:00',
        closeTime: dto.closeTime ?? '22:00',
        isPaid: dto.isPaid ?? false,
        pricePerHour: dto.pricePerHour != null ? dto.pricePerHour : null,
      },
      update: {
        ...(dto.maxSlotMinutes != null && { maxSlotMinutes: dto.maxSlotMinutes }),
        ...(dto.openTime != null && { openTime: dto.openTime }),
        ...(dto.closeTime != null && { closeTime: dto.closeTime }),
        ...(dto.isPaid != null && { isPaid: dto.isPaid }),
        pricePerHour: dto.isPaid === false ? null : dto.pricePerHour != null ? dto.pricePerHour : undefined,
      },
    })
  }

  // Units
  async findAll(buildingId: number, adminId: number) {
    await this.buildingsService.findOne(buildingId, adminId)
    return sortUnits(
      await this.prisma.unit.findMany({
        where: { buildingId },
        include: { unitType: true, stairwell: true, commonAreaSettings: true },
        orderBy: { number: 'asc' },
      }),
    )
  }

  async findOne(id: number, buildingId: number, adminId: number) {
    await this.buildingsService.findOne(buildingId, adminId)
    const unit = await this.prisma.unit.findFirst({
      where: { id, buildingId },
      include: {
        unitType: true,
        stairwell: true,
        commonAreaSettings: true,
        unitResidents: {
          include: { resident: true },
          orderBy: { sinceDate: 'desc' },
        },
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
