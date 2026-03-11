import { Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { LicenseService } from '../license/license.service'
import { IsOptional, IsString } from 'class-validator'

export class CreateBuildingDto {
  @IsString() name: string
  @IsString() address: string
  @IsOptional() @IsString() nip?: string
  @IsOptional() @IsString() regon?: string
}

export class UpdateBuildingDto {
  @IsOptional() @IsString() name?: string
  @IsOptional() @IsString() address?: string
  @IsOptional() @IsString() nip?: string
  @IsOptional() @IsString() regon?: string
}

@Injectable()
export class BuildingsService {
  constructor(
    private prisma: PrismaService,
    private licenseService: LicenseService,
  ) {}

  async findAll(adminId: number) {
    return this.prisma.building.findMany({
      where: { adminId },
      orderBy: { createdAt: 'asc' },
    })
  }

  async findOne(id: number, adminId: number) {
    const building = await this.prisma.building.findFirst({ where: { id, adminId } })
    if (!building) throw new NotFoundException('Budynek nie istnieje')
    return building
  }

  async create(adminId: number, dto: CreateBuildingDto) {
    await this.licenseService.checkLimit(adminId, 'buildings')
    return this.prisma.building.create({ data: { ...dto, adminId } })
  }

  async update(id: number, adminId: number, dto: UpdateBuildingDto) {
    await this.findOne(id, adminId)
    return this.prisma.building.update({ where: { id }, data: dto })
  }

  async remove(id: number, adminId: number) {
    await this.findOne(id, adminId)
    return this.prisma.building.delete({ where: { id } })
  }
}
