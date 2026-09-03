import { Controller, Get, Query, Request, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { PrismaService } from '../prisma/prisma.service'

@UseGuards(JwtAuthGuard)
@Controller('search')
export class SearchController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async search(@Query('q') q: string, @Request() req: any) {
    if (!q || q.trim().length < 2) return { buildings: [], residents: [], units: [] }

    const adminId = req.user.id
    const term = q.trim()

    const [buildings, residents, units] = await Promise.all([
      this.prisma.building.findMany({
        where: {
          adminId,
          OR: [
            { name: { contains: term, mode: 'insensitive' } },
            { address: { contains: term, mode: 'insensitive' } },
          ],
        },
        take: 5,
      }),
      this.prisma.resident.findMany({
        where: {
          building: { adminId },
          OR: [
            { firstName: { contains: term, mode: 'insensitive' } },
            { lastName: { contains: term, mode: 'insensitive' } },
            { email: { contains: term, mode: 'insensitive' } },
          ],
        },
        include: { building: { select: { id: true, name: true } } },
        take: 5,
      }),
      this.prisma.unit.findMany({
        where: {
          building: { adminId },
          OR: [
            { number: { contains: term, mode: 'insensitive' } },
            { description: { contains: term, mode: 'insensitive' } },
            { unitType: { name: { contains: term, mode: 'insensitive' } } },
          ],
        },
        include: {
          building: { select: { id: true, name: true } },
          unitType: { select: { name: true, icon: true } },
        },
        take: 5,
      }),
    ])

    return { buildings, residents, units }
  }
}
