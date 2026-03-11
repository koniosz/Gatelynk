import { Injectable, NotFoundException, ConflictException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { BuildingsService } from '../buildings/buildings.service'
import { IsEmail, IsOptional, IsString, IsInt, IsDateString } from 'class-validator'

export class CreateResidentDto {
  @IsString() firstName: string
  @IsString() lastName: string
  @IsEmail() email: string
  @IsOptional() @IsString() phone?: string
}

export class AssignResidentDto {
  @IsInt() residentId: number
  @IsString() role: 'OWNER' | 'TENANT'
  @IsDateString() sinceDate: string
}

@Injectable()
export class ResidentsService {
  constructor(
    private prisma: PrismaService,
    private buildingsService: BuildingsService,
  ) {}

  async findAll(buildingId: number, adminId: number) {
    await this.buildingsService.findOne(buildingId, adminId)
    return this.prisma.resident.findMany({
      where: { buildingId },
      include: {
        unitResidents: {
          where: { untilDate: null },
          include: { unit: { include: { unitType: true } } },
        },
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    })
  }

  async findOne(id: number, buildingId: number, adminId: number) {
    await this.buildingsService.findOne(buildingId, adminId)
    const resident = await this.prisma.resident.findFirst({
      where: { id, buildingId },
      include: {
        unitResidents: {
          include: { unit: { include: { unitType: true } } },
        },
      },
    })
    if (!resident) throw new NotFoundException('Mieszkaniec nie istnieje')
    return resident
  }

  async create(buildingId: number, adminId: number, dto: CreateResidentDto) {
    await this.buildingsService.findOne(buildingId, adminId)
    const exists = await this.prisma.resident.findUnique({
      where: { buildingId_email: { buildingId, email: dto.email } },
    })
    if (exists) throw new ConflictException('Mieszkaniec z tym adresem email już istnieje')
    return this.prisma.resident.create({ data: { ...dto, buildingId } })
  }

  async update(id: number, buildingId: number, adminId: number, dto: Partial<CreateResidentDto>) {
    await this.findOne(id, buildingId, adminId)
    return this.prisma.resident.update({ where: { id }, data: dto })
  }

  async remove(id: number, buildingId: number, adminId: number) {
    await this.findOne(id, buildingId, adminId)
    return this.prisma.resident.delete({ where: { id } })
  }

  async assignToUnit(buildingId: number, adminId: number, dto: AssignResidentDto) {
    await this.buildingsService.findOne(buildingId, adminId)
    return this.prisma.unitResident.create({
      data: {
        unitId: dto.residentId, // fixed below
        residentId: dto.residentId,
        role: dto.role,
        sinceDate: new Date(dto.sinceDate),
      },
    })
  }

  async assignResidentToUnit(
    buildingId: number,
    unitId: number,
    adminId: number,
    dto: AssignResidentDto,
  ) {
    await this.buildingsService.findOne(buildingId, adminId)
    return this.prisma.unitResident.create({
      data: {
        unitId,
        residentId: dto.residentId,
        role: dto.role,
        sinceDate: new Date(dto.sinceDate),
      },
      include: { resident: true },
    })
  }

  async removeFromUnit(assignmentId: number, buildingId: number, adminId: number) {
    await this.buildingsService.findOne(buildingId, adminId)
    return this.prisma.unitResident.update({
      where: { id: assignmentId },
      data: { untilDate: new Date() },
    })
  }
}
