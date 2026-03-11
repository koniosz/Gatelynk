import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { LicenseKeyStatus } from '@prisma/client'

@Injectable()
export class LicenseService {
  constructor(private prisma: PrismaService) {}

  async activate(key: string, adminId: number) {
    const licenseKey = await this.prisma.licenseKey.findUnique({
      where: { key },
      include: { plan: true },
    })

    if (!licenseKey) throw new NotFoundException('Klucz licencyjny nie istnieje')
    if (licenseKey.status !== LicenseKeyStatus.ACTIVE) {
      throw new BadRequestException('Klucz licencyjny jest nieaktywny lub już użyty')
    }
    if (licenseKey.validUntil && licenseKey.validUntil < new Date()) {
      throw new BadRequestException('Klucz licencyjny wygasł')
    }

    // Check if admin already has a license
    const existing = await this.prisma.licenseKey.findFirst({
      where: { activatedBy: adminId, status: LicenseKeyStatus.USED },
    })
    if (existing) throw new ForbiddenException('Masz już aktywną licencję')

    const updated = await this.prisma.licenseKey.update({
      where: { id: licenseKey.id },
      data: {
        status: LicenseKeyStatus.USED,
        activatedBy: adminId,
        activatedAt: new Date(),
      },
      include: { plan: true },
    })

    return { success: true, plan: updated.plan, validUntil: updated.validUntil }
  }

  async getMyLicense(adminId: number) {
    const licenseKey = await this.prisma.licenseKey.findFirst({
      where: { activatedBy: adminId },
      include: { plan: true },
    })
    if (!licenseKey) throw new NotFoundException('Brak aktywnej licencji')
    return licenseKey
  }

  async checkLimit(adminId: number, resource: 'buildings' | 'units') {
    const licenseKey = await this.prisma.licenseKey.findFirst({
      where: { activatedBy: adminId },
      include: { plan: true },
    })
    if (!licenseKey) throw new ForbiddenException('Brak aktywnej licencji')

    const plan = licenseKey.plan
    const maxKey = resource === 'buildings' ? 'maxBuildings' : 'maxUnits'
    const max = plan[maxKey]
    if (max === null) return // unlimited

    let current: number
    if (resource === 'buildings') {
      current = await this.prisma.building.count({ where: { adminId } })
    } else {
      const buildings = await this.prisma.building.findMany({
        where: { adminId },
        select: { id: true },
      })
      const buildingIds = buildings.map((b) => b.id)
      current = await this.prisma.unit.count({ where: { buildingId: { in: buildingIds } } })
    }

    if (current >= max) {
      throw new ForbiddenException(
        `Osiągnięto limit ${resource === 'buildings' ? 'budynków' : 'lokali'} (${max}) dla Twojego planu`,
      )
    }
  }

  // Admin tool: generate a license key
  async generateKey(planCode: string, validDays?: number) {
    const plan = await this.prisma.licensePlan.findUnique({ where: { code: planCode } })
    if (!plan) throw new NotFoundException('Plan nie istnieje')

    const key = this.generateKeyString(planCode)
    const validUntil = validDays
      ? new Date(Date.now() + validDays * 24 * 60 * 60 * 1000)
      : null

    return this.prisma.licenseKey.create({
      data: { key, planId: plan.id, validUntil },
      include: { plan: true },
    })
  }

  private generateKeyString(planCode: string): string {
    const prefixMap: Record<string, string> = {
      starter: 'STRT',
      standard: 'STND',
      pro: 'PRO_',
    }
    const prefix = prefixMap[planCode] ?? 'UNKN'
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const rand = (n: number) =>
      Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
    const year = new Date().getFullYear()
    return `GL-${prefix}-${rand(4)}-${rand(4)}-${year}`
  }
}
