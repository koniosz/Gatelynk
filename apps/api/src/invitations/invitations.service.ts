import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { ConfigService } from '@nestjs/config'
import { createHash, randomBytes } from 'crypto'
import { Resend } from 'resend'

const INVITATION_EXPIRES_DAYS = 7

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name)
  // null gdy RESEND_API_KEY nie jest ustawiony (np. pierwszy deploy na Fly).
  // Resend SDK rzuca w konstruktorze gdy klucz jest pusty — bez tej obrony
  // cały moduł nie startuje (cf. MailService, który ma analogiczny pattern).
  // Tworzenie invitation w DB nadal działa; tylko wysyłka maila jest skipowana
  // — admin może ręcznie skopiować link z odpowiedzi.
  private resend: Resend | null

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {
    const apiKey = this.config.get<string>('RESEND_API_KEY')
    if (apiKey) {
      this.resend = new Resend(apiKey)
    } else {
      this.resend = null
      this.logger.warn('RESEND_API_KEY not configured — invitation emails will be skipped')
    }
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

    if (this.resend) {
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
    } else {
      // Bez Resend nie wyślemy maila — zwracamy `inviteUrl` w response,
      // żeby admin mógł skopiować link ręcznie. Lepsze niż twardy 500.
      this.logger.warn(`Invitation email skipped (no RESEND_API_KEY) — link: ${inviteUrl}`)
    }

    return { success: true, invitationId: invitation.id, expiresAt, inviteUrl: this.resend ? undefined : inviteUrl }
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
