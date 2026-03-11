import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { ConfigService } from '@nestjs/config'
import { createHash, randomBytes } from 'crypto'
import { Resend } from 'resend'
import { INVITATION_EXPIRES_DAYS } from '@gatelynk/shared'

@Injectable()
export class InvitationsService {
  private resend: Resend

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {
    this.resend = new Resend(this.config.get('RESEND_API_KEY'))
  }

  async send(buildingId: number, residentId: number, unitId: number, adminId: number) {
    const resident = await this.prisma.resident.findFirst({
      where: { id: residentId, buildingId },
    })
    if (!resident) throw new NotFoundException('Mieszkaniec nie istnieje')

    const unit = await this.prisma.unit.findFirst({
      where: { id: unitId, buildingId },
      include: { unitType: true, building: true },
    })
    if (!unit) throw new NotFoundException('Lokal nie istnieje')

    // Expire old pending invitations
    await this.prisma.invitation.updateMany({
      where: { residentId, unitId, status: 'PENDING' },
      data: { status: 'EXPIRED' },
    })

    const token = randomBytes(32).toString('hex')
    const tokenHash = createHash('sha256').update(token).digest('hex')
    const expiresAt = new Date(Date.now() + INVITATION_EXPIRES_DAYS * 24 * 60 * 60 * 1000)

    const invitation = await this.prisma.invitation.create({
      data: { residentId, unitId, tokenHash, expiresAt },
    })

    const inviteUrl = `${this.config.get('FRONTEND_URL')}/accept-invitation?token=${token}`

    await this.resend.emails.send({
      from: 'GateLynk <noreply@gatelynk.pl>',
      to: resident.email,
      subject: `Zaproszenie do ${unit.building.name}`,
      html: this.buildEmailHtml({
        name: `${resident.firstName} ${resident.lastName}`,
        buildingName: unit.building.name,
        unitLabel: `${unit.unitType.name} ${unit.number}`,
        inviteUrl,
        expiresAt,
      }),
    })

    return { success: true, invitationId: invitation.id, expiresAt }
  }

  async accept(token: string) {
    const tokenHash = createHash('sha256').update(token).digest('hex')
    const invitation = await this.prisma.invitation.findUnique({
      where: { tokenHash },
      include: { resident: true, unit: { include: { building: true } } },
    })

    if (!invitation) throw new NotFoundException('Zaproszenie nie istnieje')
    if (invitation.status !== 'PENDING') {
      throw new BadRequestException('Zaproszenie zostało już wykorzystane lub wygasło')
    }
    if (invitation.expiresAt < new Date()) {
      await this.prisma.invitation.update({
        where: { id: invitation.id },
        data: { status: 'EXPIRED' },
      })
      throw new BadRequestException('Zaproszenie wygasło')
    }

    await this.prisma.invitation.update({
      where: { id: invitation.id },
      data: { status: 'ACCEPTED', acceptedAt: new Date() },
    })

    return {
      success: true,
      resident: invitation.resident,
      unit: invitation.unit,
    }
  }

  async findAll(buildingId: number) {
    return this.prisma.invitation.findMany({
      where: { unit: { buildingId } },
      include: { resident: true, unit: { include: { unitType: true } } },
      orderBy: { sentAt: 'desc' },
    })
  }

  private buildEmailHtml(data: {
    name: string
    buildingName: string
    unitLabel: string
    inviteUrl: string
    expiresAt: Date
  }) {
    return `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Witaj, ${data.name}!</h2>
        <p>Zostałeś/aś zaproszony/a do wspólnoty mieszkaniowej <strong>${data.buildingName}</strong>.</p>
        <p>Lokal: <strong>${data.unitLabel}</strong></p>
        <p>
          <a href="${data.inviteUrl}" style="
            background: #2563eb; color: white; padding: 12px 24px;
            border-radius: 6px; text-decoration: none; display: inline-block;
          ">
            Przyjmij zaproszenie
          </a>
        </p>
        <p style="color: #6b7280; font-size: 14px;">
          Link wygasa: ${data.expiresAt.toLocaleDateString('pl-PL')}
        </p>
      </div>
    `
  }
}
