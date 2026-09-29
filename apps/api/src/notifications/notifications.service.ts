import { Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { BuildingsService } from '../buildings/buildings.service'
import { PushService } from '../push/push.service'
import { IsInt, IsOptional, IsString } from 'class-validator'

export class SendNotificationDto {
  @IsString() title: string
  @IsString() body: string
  @IsOptional() @IsInt() residentId?: number // null = do wszystkich mieszkańców
}

@Injectable()
export class NotificationsService {
  constructor(
    private prisma: PrismaService,
    private buildingsService: BuildingsService,
    private push: PushService,
  ) {}

  async send(buildingId: number, adminId: number, dto: SendNotificationDto) {
    await this.buildingsService.findOne(buildingId, adminId)

    if (dto.residentId) {
      // Wyślij do konkretnego mieszkańca
      const resident = await this.prisma.resident.findFirst({
        where: { id: dto.residentId, buildingId },
      })
      if (!resident) throw new NotFoundException('Mieszkaniec nie istnieje')

      const notification = await this.prisma.notification.create({
        data: { buildingId, residentId: dto.residentId, title: dto.title, body: dto.body },
        include: { resident: true },
      })
      this.push.sendToResident(dto.residentId, dto.title, dto.body, { type: 'notification' })
        .catch(() => {/* fire-and-forget */})
      return notification
    } else {
      // Wyślij do wszystkich mieszkańców budynku
      const residents = await this.prisma.resident.findMany({ where: { buildingId } })
      const notifications = await this.prisma.$transaction(
        residents.map((r) =>
          this.prisma.notification.create({
            data: { buildingId, residentId: r.id, title: dto.title, body: dto.body },
          }),
        ),
      )
      this.push.sendToBuilding(buildingId, dto.title, dto.body, { type: 'notification' })
        .catch(() => {/* fire-and-forget */})
      return { sent: notifications.length, notifications }
    }
  }

  async findAll(buildingId: number, adminId: number) {
    await this.buildingsService.findOne(buildingId, adminId)
    return this.prisma.notification.findMany({
      where: { buildingId },
      include: { resident: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { sentAt: 'desc' },
      take: 50,
    })
  }

  async findByResident(buildingId: number, residentId: number, adminId: number) {
    await this.buildingsService.findOne(buildingId, adminId)
    return this.prisma.notification.findMany({
      where: { buildingId, residentId },
      orderBy: { sentAt: 'desc' },
    })
  }
}
