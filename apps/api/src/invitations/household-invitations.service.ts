import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { ConfigService } from '@nestjs/config'
import { randomBytes } from 'crypto'

// ─── Domownicy (2026-08-09) ───────────────────────────────────────────────────
//
// Mieszkaniec zaprasza domownika (żona/mąż/dziecko) ze swojej aplikacji iOS.
// Flow: POST /resident/household/invitations → link → ShareLink (iMessage) →
// domownik otwiera /accept-household?token=…, podaje SWÓJ e-mail + hasło →
// powstaje pełnoprawny Resident + pivot unit_residents do lokalu zapraszającego.
//
// Decyzje projektowe (dlaczego tak):
//   • Zero nowych ról — domownik to zwykły Resident (otwiera bramy, zaprasza
//     gości, dzwoni domofonem). Tryb dziecka świadomie poza MVP; miejsce
//     w designie: przyszła kolumna Resident.householdProfile (patrz schema).
//   • Pivot z role=TENANT — zaproszenie z aplikacji NIE nadaje własności
//     lokalu; OWNER pozostaje decyzją administratora (struktura wspólnoty).
//   • Token 7 dni / jednorazowy / limit 5 PENDING na lokal / anulowanie
//     z apki — parametry bezpieczeństwa opisane przy metodach.
//   • Administrator ma pełną widoczność: domownik pojawia się w panelu jak
//     każdy mieszkaniec (zwykły Resident + pivot), a `invitedByResidentId`
//     + wiersz household_invitations (kto, kogo, kiedy, do którego lokalu)
//     stanowią trwały ślad audytowy — żadnych ukrytych kont.

const HOUSEHOLD_INVITE_EXPIRES_DAYS = 7
/** Anty-spam: max aktywnych (PENDING, nie wygasłych) zaproszeń per lokal. */
const MAX_PENDING_PER_UNIT = 5

@Injectable()
export class HouseholdInvitationsService {
  private readonly logger = new Logger(HouseholdInvitationsService.name)

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Aktywne pivoty (untilDate NULL) zapraszającego — warunek wstępny
   *  KAŻDEJ operacji: były mieszkaniec (zamknięty pivot) nie może zapraszać
   *  ani przeglądać domowników. */
  private async activePivots(residentId: number) {
    return this.prisma.unitResident.findMany({
      where: { residentId, untilDate: null },
      include: { unit: { include: { unitType: true } } },
      orderBy: { sinceDate: 'desc' },
    })
  }

  private unitLabel(unit: { number: string; unitType?: { name: string } | null }) {
    return `${unit.unitType?.name ?? 'Lokal'} ${unit.number}`
  }

  private inviteUrl(token: string) {
    return `${this.config.get('FRONTEND_URL')}/accept-household?token=${token}`
  }

  /** Lazy-expire: PENDING po terminie → EXPIRED. Wołane przy każdym odczycie
   *  i akceptacji — bez osobnego crona (skala: pojedyncze wiersze). */
  private async expireStale(unitIds: number[]) {
    if (!unitIds.length) return
    await this.prisma.householdInvitation.updateMany({
      where: { unitId: { in: unitIds }, status: 'PENDING', expiresAt: { lt: new Date() } },
      data: { status: 'EXPIRED' },
    })
  }

  // ── Resident: przegląd domowników + zaproszeń ──────────────────────────────

  /**
   * Jeden endpoint dla sekcji „Domownicy" w iOS: aktywni współlokatorzy
   * (wszyscy mieszkańcy z aktywnym pivotem do lokali zapraszającego, bez
   * niego samego) + aktywne zaproszenia. Zaproszenia pokazujemy per LOKAL,
   * nie per zapraszający — transparentność w rodzinie (żona widzi i może
   * anulować zaproszenie wysłane przez męża; oboje są gospodarzami lokalu).
   */
  async overview(residentId: number, buildingId: number) {
    const pivots = await this.activePivots(residentId)
    const unitIds = pivots.map((p) => p.unitId)
    if (!unitIds.length) return { members: [], invitations: [] }

    await this.expireStale(unitIds)

    const cohabitants = await this.prisma.unitResident.findMany({
      where: { unitId: { in: unitIds }, untilDate: null, residentId: { not: residentId } },
      include: {
        resident: true,
        unit: { include: { unitType: true } },
      },
      orderBy: { sinceDate: 'asc' },
    })

    // Relacja („żona"/„syn") — z ACCEPTED zaproszenia, które stworzyło konto.
    const memberIds = [...new Set(cohabitants.map((c) => c.residentId))]
    const acceptedInvites = memberIds.length
      ? await this.prisma.householdInvitation.findMany({
          where: { acceptedResidentId: { in: memberIds }, status: 'ACCEPTED' },
          select: { acceptedResidentId: true, relationLabel: true },
        })
      : []
    const relationByResident = new Map(
      acceptedInvites.map((i) => [i.acceptedResidentId, i.relationLabel]),
    )

    // Dedupe po residentId (ktoś może dzielić z nami 2 lokale).
    const seen = new Set<number>()
    const members = cohabitants
      .filter((c) => (seen.has(c.residentId) ? false : (seen.add(c.residentId), true)))
      .map((c) => ({
        residentId: c.residentId,
        firstName: c.resident.firstName,
        lastName: c.resident.lastName,
        email: c.resident.email,
        role: c.role,
        unitLabel: this.unitLabel(c.unit),
        relationLabel: relationByResident.get(c.residentId) ?? null,
        // Ma hasło = może się logować; false = konto z importu/niedokończone.
        hasAccount: !!c.resident.passwordHash,
        // Audyt widoczny też dla mieszkańca: czy to konto powstało z zaproszenia.
        invitedByMe: c.resident.invitedByResidentId === residentId,
      }))

    const pending = await this.prisma.householdInvitation.findMany({
      where: { unitId: { in: unitIds }, status: 'PENDING' },
      include: {
        invitedBy: { select: { firstName: true, lastName: true } },
        unit: { include: { unitType: true } },
      },
      orderBy: { createdAt: 'desc' },
    })

    return {
      members,
      invitations: pending.map((i) => ({
        id: i.id,
        inviteeName: i.inviteeName,
        relationLabel: i.relationLabel,
        unitLabel: this.unitLabel(i.unit),
        createdAt: i.createdAt,
        expiresAt: i.expiresAt,
        invitedByName: `${i.invitedBy.firstName} ${i.invitedBy.lastName}`,
        // Token jawny w DB (wzór Guest.urlToken) → re-share z listy działa.
        inviteUrl: this.inviteUrl(i.token),
      })),
    }
  }

  // ── Resident: nowe zaproszenie ─────────────────────────────────────────────

  async create(
    residentId: number,
    buildingId: number,
    dto: { name?: string; relationLabel?: string | null; unitId?: number | null },
  ) {
    const name = (dto.name ?? '').trim()
    if (name.length < 2 || name.length > 80) {
      throw new BadRequestException('Podaj imię domownika (2–80 znaków)')
    }
    const relationLabel = dto.relationLabel?.trim() ? dto.relationLabel.trim().slice(0, 40) : null

    // Bezpieczeństwo: zapraszający musi mieć AKTYWNY pivot do lokalu.
    const pivots = await this.activePivots(residentId)
    if (!pivots.length) {
      throw new BadRequestException('Nie masz aktywnego lokalu — nie możesz zapraszać domowników')
    }
    // Lokal: jawnie wskazany (musi należeć do zapraszającego) albo najświeższy.
    const pivot = dto.unitId ? pivots.find((p) => p.unitId === dto.unitId) : pivots[0]
    if (!pivot) throw new BadRequestException('Ten lokal nie jest przypisany do Twojego konta')

    await this.expireStale([pivot.unitId])

    // Anty-spam: rozsądny limit aktywnych zaproszeń per lokal.
    const pendingCount = await this.prisma.householdInvitation.count({
      where: { unitId: pivot.unitId, status: 'PENDING' },
    })
    if (pendingCount >= MAX_PENDING_PER_UNIT) {
      throw new BadRequestException(
        `Limit ${MAX_PENDING_PER_UNIT} aktywnych zaproszeń dla lokalu — anuluj któreś, aby dodać nowe`,
      )
    }

    // 32 bajty entropii — token jest jedyną autoryzacją publicznego acceptu.
    const token = randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + HOUSEHOLD_INVITE_EXPIRES_DAYS * 24 * 60 * 60 * 1000)

    const invitation = await this.prisma.householdInvitation.create({
      data: {
        buildingId,
        unitId: pivot.unitId,
        invitedByResidentId: residentId,
        inviteeName: name,
        relationLabel,
        token,
        expiresAt,
      },
    })

    this.logger.log(
      `Household invite created: building=${buildingId} unit=${pivot.unitId} by resident=${residentId} for "${name}"`,
    )

    return {
      id: invitation.id,
      inviteeName: invitation.inviteeName,
      relationLabel: invitation.relationLabel,
      unitLabel: this.unitLabel(pivot.unit),
      expiresAt: invitation.expiresAt,
      inviteUrl: this.inviteUrl(token),
    }
  }

  // ── Resident: anulowanie ───────────────────────────────────────────────────

  /** Anulować może KAŻDY aktywny mieszkaniec lokalu zaproszenia (nie tylko
   *  autor) — spójne z overview: gospodarze lokalu współdzielą kontrolę. */
  async cancel(residentId: number, invitationId: number) {
    const invitation = await this.prisma.householdInvitation.findUnique({
      where: { id: invitationId },
    })
    if (!invitation) throw new NotFoundException('Zaproszenie nie istnieje')

    const pivot = await this.prisma.unitResident.findFirst({
      where: { unitId: invitation.unitId, residentId, untilDate: null },
    })
    if (!pivot) throw new NotFoundException('Zaproszenie nie istnieje')

    if (invitation.status !== 'PENDING') {
      throw new BadRequestException('To zaproszenie nie jest już aktywne')
    }
    await this.prisma.householdInvitation.update({
      where: { id: invitation.id },
      data: { status: 'CANCELLED' },
    })
    this.logger.log(`Household invite ${invitationId} cancelled by resident=${residentId}`)
    return { success: true }
  }

  // ── Public: podgląd na stronie akceptacji ──────────────────────────────────

  async preview(token: string) {
    const invitation = await this.findByToken(token)
    // Lazy-expire pojedynczego zaproszenia przy podglądzie.
    if (invitation.status === 'PENDING' && invitation.expiresAt.getTime() < Date.now()) {
      await this.prisma.householdInvitation.update({
        where: { id: invitation.id },
        data: { status: 'EXPIRED' },
      })
      invitation.status = 'EXPIRED'
    }
    return {
      valid: invitation.status === 'PENDING',
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      inviteeName: invitation.inviteeName,
      relationLabel: invitation.relationLabel,
      inviterName: `${invitation.invitedBy.firstName} ${invitation.invitedBy.lastName}`,
      buildingName: invitation.unit.building.name,
      unitLabel: this.unitLabel(invitation.unit),
    }
  }

  // ── Public: akceptacja — powstaje konto domownika ──────────────────────────

  /**
   * Domownik podaje WŁASNY e-mail + hasło (opcjonalnie poprawia imię/nazwisko
   * prefillowane z zaproszenia). W jednej transakcji: Resident + pivot
   * unit_residents (TENANT) + zaproszenie → ACCEPTED (jednorazowość).
   */
  async accept(
    token: string,
    body: { email?: string; password?: string; firstName?: string; lastName?: string },
  ) {
    const email = (body.email ?? '').trim().toLowerCase()
    // Minimalna walidacja formatu — pełną poprawność i tak weryfikuje
    // logowanie (mieszkaniec sam wpisuje swój adres, literówka = jego login).
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('Podaj poprawny adres e-mail')
    }
    if (typeof body.password !== 'string' || body.password.length < 8) {
      throw new BadRequestException('Hasło musi mieć co najmniej 8 znaków')
    }

    const invitation = await this.findByToken(token)
    if (invitation.status !== 'PENDING') {
      throw new BadRequestException('Zaproszenie zostało już wykorzystane lub anulowane')
    }
    if (invitation.expiresAt.getTime() < Date.now()) {
      await this.prisma.householdInvitation.update({
        where: { id: invitation.id },
        data: { status: 'EXPIRED' },
      })
      throw new BadRequestException('Zaproszenie wygasło — poproś o nowe')
    }

    // Bezpieczeństwo: zapraszający musi NADAL mieszkać w lokalu. Jeśli w
    // międzyczasie się wyprowadził (admin zamknął pivot), link jest martwy.
    const inviterPivot = await this.prisma.unitResident.findFirst({
      where: {
        unitId: invitation.unitId,
        residentId: invitation.invitedByResidentId,
        untilDate: null,
      },
    })
    if (!inviterPivot) {
      throw new BadRequestException(
        'Zaproszenie jest nieaktualne — osoba zapraszająca nie jest już mieszkańcem tego lokalu',
      )
    }

    // Imię/nazwisko: poprawione przez domownika albo z zaproszenia.
    // Fallback nazwiska = nazwisko zapraszającego (domownicy zwykle je dzielą).
    const nameParts = invitation.inviteeName.split(/\s+/)
    const firstName = body.firstName?.trim() || nameParts[0]
    const lastName =
      body.lastName?.trim() || nameParts.slice(1).join(' ') || invitation.invitedBy.lastName

    const bcrypt = await import('bcrypt')
    const passwordHash = await bcrypt.hash(body.password, 10)

    // Resident jest unique per (buildingId, email) — sprawdzamy kolizję.
    const existing = await this.prisma.resident.findUnique({
      where: { buildingId_email: { buildingId: invitation.buildingId, email } },
    })
    if (existing?.passwordHash) {
      // Aktywne konto z tym adresem już istnieje w TYM budynku. Nie łączymy
      // go automatycznie z lokalem — token dowodzi zaufania zapraszającego,
      // ale NIE dowodzi, że akceptujący kontroluje ten adres e-mail
      // (mógłby podpiąć cudze konto do swojego lokalu / odwrotnie).
      throw new ConflictException(
        'Ten adres e-mail ma już konto w tym obiekcie — zaloguj się nim w aplikacji GateLynk',
      )
    }

    const resident = await this.prisma.$transaction(async (tx) => {
      let residentRow
      if (existing) {
        // Konto istnieje bez hasła (np. import CSV przez admina) — adoptujemy:
        // to ta sama osoba (ten sam e-mail w tym samym budynku), więc zamiast
        // duplikatu domykamy aktywację i dopinamy lokal.
        residentRow = await tx.resident.update({
          where: { id: existing.id },
          data: {
            passwordHash,
            // Audyt tylko gdy jeszcze pusty — nie nadpisujemy historii importu.
            ...(existing.invitedByResidentId == null
              ? { invitedByResidentId: invitation.invitedByResidentId }
              : {}),
          },
        })
      } else {
        residentRow = await tx.resident.create({
          data: {
            buildingId: invitation.buildingId,
            firstName,
            lastName,
            email,
            passwordHash,
            // Audyt dla administratora: skąd wzięło się to konto.
            invitedByResidentId: invitation.invitedByResidentId,
          },
        })
      }

      // Pivot do lokalu zapraszającego — TENANT (własność lokalu to decyzja
      // administratora, nie efekt zaproszenia z aplikacji).
      const activePivot = await tx.unitResident.findFirst({
        where: { unitId: invitation.unitId, residentId: residentRow.id, untilDate: null },
      })
      if (!activePivot) {
        await tx.unitResident.create({
          data: {
            unitId: invitation.unitId,
            residentId: residentRow.id,
            role: 'TENANT',
            sinceDate: new Date(),
          },
        })
      }

      // Jednorazowość: PENDING → ACCEPTED w tej samej transakcji.
      await tx.householdInvitation.update({
        where: { id: invitation.id },
        data: {
          status: 'ACCEPTED',
          acceptedAt: new Date(),
          acceptedResidentId: residentRow.id,
        },
      })
      return residentRow
    })

    this.logger.log(
      `Household invite ${invitation.id} accepted: resident=${resident.id} (${email}) ` +
        `joined unit=${invitation.unitId} invited by resident=${invitation.invitedByResidentId}`,
    )

    return {
      success: true,
      email,
      buildingName: invitation.unit.building.name,
    }
  }

  // ── Lookup ─────────────────────────────────────────────────────────────────

  private async findByToken(token: string) {
    if (typeof token !== 'string' || token.length < 16) {
      throw new BadRequestException('Nieprawidłowy token zaproszenia')
    }
    const invitation = await this.prisma.householdInvitation.findUnique({
      where: { token },
      include: {
        invitedBy: true,
        unit: { include: { building: true, unitType: true } },
      },
    })
    if (!invitation) throw new NotFoundException('Zaproszenie nie istnieje')
    return invitation
  }
}
