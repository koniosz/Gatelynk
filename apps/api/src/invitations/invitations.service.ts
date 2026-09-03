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
import { isPlaceholderEmail } from '../residents-import/no-email.constants'

const INVITATION_EXPIRES_DAYS = 7

// PR-6 (2026-07-05) — status mieszkańca w UI zaproszeń.
//   active      — ma hasło (konto działa, może logować się w iOS)
//   invited     — wysłane ważne zaproszenie (PENDING, nie wygasło)
//   expired     — ostatnie zaproszenie wygasło (można wysłać ponownie)
//   no_email    — placeholder e-mail z importu CSV (zaproszenie niemożliwe)
//   not_invited — ma e-mail, brak hasła i brak zaproszenia
export type ResidentInvitationStatus =
  | 'active' | 'invited' | 'expired' | 'no_email' | 'not_invited'

export interface ResidentInvitationRow {
  residentId: number
  firstName: string
  lastName: string
  email: string | null
  unitNumber: string | null
  status: ResidentInvitationStatus
  lastSentAt: string | null
  lastExpiresAt: string | null
}

export interface BulkSendResult {
  sent: number
  skipped: number
  failed: number
  results: Array<{
    residentId: number
    email: string | null
    status: 'sent' | 'skipped' | 'failed'
    reason?: string
    /** Zwracany TYLKO gdy Resend nie jest skonfigurowany (dev/log transport) —
     *  operator może skopiować link ręcznie. */
    inviteUrl?: string
  }>
}

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
    if (isPlaceholderEmail(resident.email)) {
      throw new BadRequestException('Mieszkaniec nie ma adresu e-mail — nie można wysłać zaproszenia')
    }

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
        from: this.config.get<string>('MAIL_FROM') ?? 'GateLynk <noreply@gatelynk.com>',
        to: resident.email,
        subject: `Zaproszenie do ${unit.building.name} — aktywuj konto GateLynk`,
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

  // ── PR-6: bulk send + resend + statusy ─────────────────────────────────────

  /**
   * Masowa wysyłka do wszystkich mieszkańców budynku bez konta (brak hasła),
   * z prawdziwym e-mailem i bez ważnego PENDING zaproszenia. Lokal brany
   * z aktywnego pivotu `unit_residents` (najświeższy).
   */
  async bulkSend(buildingId: number): Promise<BulkSendResult> {
    const residents = await this.prisma.resident.findMany({
      where: { buildingId, passwordHash: null },
      include: {
        unitResidents: {
          where: { untilDate: null },
          orderBy: { sinceDate: 'desc' },
          take: 1,
        },
        invitations: {
          where: { status: 'PENDING', expiresAt: { gt: new Date() } },
          take: 1,
        },
      },
    })

    const result: BulkSendResult = { sent: 0, skipped: 0, failed: 0, results: [] }
    for (const r of residents) {
      const email = isPlaceholderEmail(r.email) ? null : r.email
      if (!email) {
        result.skipped++
        result.results.push({ residentId: r.id, email: null, status: 'skipped', reason: 'Brak adresu e-mail' })
        continue
      }
      if (r.invitations.length > 0) {
        result.skipped++
        result.results.push({ residentId: r.id, email, status: 'skipped', reason: 'Ma już ważne zaproszenie' })
        continue
      }
      const unitId = r.unitResidents[0]?.unitId
      if (!unitId) {
        result.skipped++
        result.results.push({ residentId: r.id, email, status: 'skipped', reason: 'Brak przypisanego lokalu' })
        continue
      }
      try {
        const sent = await this.send(buildingId, r.id, unitId, 0)
        result.sent++
        result.results.push({ residentId: r.id, email, status: 'sent', inviteUrl: sent.inviteUrl })
      } catch (err: any) {
        result.failed++
        result.results.push({
          residentId: r.id, email, status: 'failed',
          reason: err?.message ?? 'Błąd wysyłki',
        })
        this.logger.warn(`bulkSend: resident ${r.id} failed: ${err?.message}`)
      }
    }
    this.logger.log(
      `bulkSend budynek=${buildingId}: wysłano=${result.sent}, pominięto=${result.skipped}, błędy=${result.failed}`,
    )
    return result
  }

  /** Ponowna wysyłka do jednego mieszkańca (unieważnia poprzednie PENDING). */
  async resendForResident(buildingId: number, residentId: number) {
    const resident = await this.prisma.resident.findFirst({
      where: { id: residentId, buildingId },
      include: {
        unitResidents: { where: { untilDate: null }, orderBy: { sinceDate: 'desc' }, take: 1 },
      },
    })
    if (!resident) throw new NotFoundException('Mieszkaniec nie istnieje')
    if (resident.passwordHash) {
      throw new BadRequestException('Mieszkaniec ma już aktywne konto')
    }
    const unitId = resident.unitResidents[0]?.unitId
    if (!unitId) throw new BadRequestException('Mieszkaniec nie ma przypisanego lokalu')
    return this.send(buildingId, residentId, unitId, 0)
  }

  /** Lista mieszkańców budynku ze statusem zaproszenia — UI setup-hub / BA. */
  async listResidentStatuses(buildingId: number): Promise<ResidentInvitationRow[]> {
    const residents = await this.prisma.resident.findMany({
      where: { buildingId },
      include: {
        unitResidents: {
          where: { untilDate: null },
          orderBy: { sinceDate: 'desc' },
          take: 1,
          include: { unit: { select: { number: true } } },
        },
        invitations: { orderBy: { sentAt: 'desc' }, take: 1 },
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    })

    const now = Date.now()
    return residents.map((r) => {
      const last = r.invitations[0] ?? null
      let status: ResidentInvitationStatus
      if (r.passwordHash) status = 'active'
      else if (isPlaceholderEmail(r.email)) status = 'no_email'
      else if (last && last.status === 'PENDING' && last.expiresAt.getTime() > now) status = 'invited'
      else if (last) status = 'expired'
      else status = 'not_invited'
      return {
        residentId: r.id,
        firstName: r.firstName,
        lastName: r.lastName,
        email: isPlaceholderEmail(r.email) ? null : r.email,
        unitNumber: r.unitResidents[0]?.unit?.number ?? null,
        status,
        lastSentAt: last ? last.sentAt.toISOString() : null,
        lastExpiresAt: last ? last.expiresAt.toISOString() : null,
      }
    })
  }

  // ── PR-6: accept flow (publiczny) ──────────────────────────────────────────

  /** Podgląd zaproszenia na publicznej stronie accept — token = autoryzacja. */
  async preview(token: string) {
    const invitation = await this.findByToken(token)
    const valid =
      invitation.status === 'PENDING' && invitation.expiresAt.getTime() > Date.now()
    return {
      valid,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      residentName: `${invitation.resident.firstName} ${invitation.resident.lastName}`,
      email: invitation.resident.email,
      buildingName: invitation.unit.building.name,
      unitLabel: `${invitation.unit.unitType?.name ?? 'Lokal'} ${invitation.unit.number}`,
      alreadyActive: !!invitation.resident.passwordHash,
    }
  }

  /**
   * Akceptacja zaproszenia + ustawienie hasła (jedna operacja).
   * Po sukcesie mieszkaniec może logować się w iOS (email + hasło).
   */
  async acceptWithPassword(token: string, password: string) {
    if (typeof password !== 'string' || password.length < 8) {
      throw new BadRequestException('Hasło musi mieć co najmniej 8 znaków')
    }
    const invitation = await this.findByToken(token)
    if (invitation.status !== 'PENDING') {
      throw new BadRequestException('Zaproszenie zostało już wykorzystane lub wygasło')
    }
    if (invitation.expiresAt < new Date()) {
      await this.prisma.invitation.update({
        where: { id: invitation.id },
        data: { status: 'EXPIRED' },
      })
      throw new BadRequestException('Zaproszenie wygasło — poproś administratora o nowe')
    }

    const bcrypt = await import('bcrypt')
    const passwordHash = await bcrypt.hash(password, 10)
    await this.prisma.$transaction([
      this.prisma.invitation.update({
        where: { id: invitation.id },
        data: { status: 'ACCEPTED', acceptedAt: new Date() },
      }),
      this.prisma.resident.update({
        where: { id: invitation.residentId },
        data: { passwordHash },
      }),
    ])

    return {
      success: true,
      email: invitation.resident.email,
      buildingName: invitation.unit.building.name,
    }
  }

  /** Legacy accept (bez hasła) — zostaje dla wstecznej kompatybilności.
   *  Nowy flow (PR-6) używa `acceptWithPassword`. Zwrot zsanityzowany
   *  (wcześniej wyciekał pełny rekord Resident z passwordHash). */
  async accept(token: string) {
    const invitation = await this.findByToken(token)
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
      resident: {
        id: invitation.resident.id,
        firstName: invitation.resident.firstName,
        lastName: invitation.resident.lastName,
        email: invitation.resident.email,
      },
      unit: {
        id: invitation.unit.id,
        number: invitation.unit.number,
        buildingName: invitation.unit.building.name,
      },
    }
  }

  async findAll(buildingId: number) {
    return this.prisma.invitation.findMany({
      where: { unit: { buildingId } },
      include: { resident: true, unit: { include: { unitType: true } } },
      orderBy: { sentAt: 'desc' },
    })
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async findByToken(token: string) {
    if (typeof token !== 'string' || token.length < 16) {
      throw new BadRequestException('Nieprawidłowy token zaproszenia')
    }
    const tokenHash = createHash('sha256').update(token).digest('hex')
    const invitation = await this.prisma.invitation.findUnique({
      where: { tokenHash },
      include: {
        resident: true,
        unit: { include: { building: true, unitType: true } },
      },
    })
    if (!invitation) throw new NotFoundException('Zaproszenie nie istnieje')
    return invitation
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
        <h2>Witaj, ${escapeHtml(data.name)}!</h2>
        <p>Zarządca obiektu <strong>${escapeHtml(data.buildingName)}</strong> utworzył dla Ciebie
           konto mieszkańca w systemie GateLynk.</p>
        <p>Lokal: <strong>${escapeHtml(data.unitLabel)}</strong></p>
        <p>Kliknij poniżej, ustaw własne hasło i zaloguj się w aplikacji GateLynk
           (App Store) — otworzysz bramę i furtkę z telefonu, dodasz swoje pojazdy
           i zaprosisz gości.</p>
        <p>
          <a href="${data.inviteUrl}" style="
            background: #2563eb; color: white; padding: 12px 24px;
            border-radius: 6px; text-decoration: none; display: inline-block;
          ">
            Ustaw hasło i aktywuj konto
          </a>
        </p>
        <p style="color: #6b7280; font-size: 14px;">
          Link wygasa: ${data.expiresAt.toLocaleDateString('pl-PL')}.
          Jeśli nie spodziewasz się tej wiadomości, zignoruj ją.
        </p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
        <p style="color: #9ca3af; font-size: 12px;">GateLynk — system zarządzania obiektem ${escapeHtml(data.buildingName)}</p>
      </div>
    `
  }
}

/** Escape HTML — dane (imię, nazwa budynku) pochodzą z importu CSV. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
