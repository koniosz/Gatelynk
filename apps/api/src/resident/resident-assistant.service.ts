/**
 * ResidentAssistantService — Cloud-side intent classifier dla pytań o
 * dane budynku/admina/mieszkańca.
 *
 * Dlaczego osobno od Edge prototype:
 *   • Edge ma tylko LPR/devices/event_log w sqlite.
 *   • Cloud ma Building/Admin/Resident/Unit w Postgres.
 *   • Resident pyta o oba zestawy → Cloud najpierw spróbuje lokalnie,
 *     jeśli nic nie pasuje → forward do Edge prototype.
 *
 * Light-weight: regex + 6 typowych intencji. Bez LLM (deterministic, ~30ms).
 * Dla bardziej skomplikowanych pytań poza tym zakresem, Edge prototype
 * przejmuje (z własnym LLM fallback).
 *
 * Intencje:
 *   • building_name      "jak nazywa się osiedle/budynek"
 *   • building_address   "adres osiedla / gdzie znajduje się"
 *   • building_admin     "administrator / kto zarządza"
 *   • building_stats     "ile mieszkań / domów / pięter / lokali"
 *   • residents_count    "ilu mieszkańców ma to osiedle / ile osób mieszka"   (8.h.32)
 *   • my_rent            "ile wynosi czynsz / jakie są opłaty / ile płacę"    (8.h.32)
 *   • my_unit            "moje mieszkanie / mój lokal"
 *   • building_amenities "udogodnienia / co jest w budynku"
 *
 * 8.h.32 (2026-07-05, transkrypt właściciela): "Ilu mieszkańców ma to
 * osiedle?" szło na Edge → unknown ("ilu" nie matchowało regexa "ile",
 * a Edge nie zna Postgresa), a "Ile wynosi czynsz dla mieszkańca?" → KB miss
 * mimo skonfigurowanych PaymentComponent/PaymentCharge (system płatności
 * 2026-07-03). Oba odpowiadamy teraz cloud-local. UWAGA: regexy WĄSKIE —
 * "ile osób" bez "mieszka/zamieszkuje" NIE może połknąć pytań o osoby
 * z kamer (te idą na Edge do count_objects_today).
 */
import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { computeChargeStatus } from '../payments/payments-admin.service'
import { ResidentService } from './resident.service'

export interface BuildingAssistantResponse {
  answer: string
  intent: string
  parameters: Record<string, unknown>
  totalMs: number
  modelUsed: 'cloud-building-info'
  data: unknown
}

@Injectable()
export class ResidentAssistantService {
  private readonly logger = new Logger(ResidentAssistantService.name)

  constructor(
    private readonly prisma: PrismaService,
    // 2026-08-16 — akcja „zaproś gościa" z czatu wykonuje TĘ SAMĄ ścieżkę
    // co formularz w apce (walidacje, anty-stalking guard, PIN, sync na Edge).
    private readonly residentService: ResidentService,
  ) {}

  /**
   * Próbuje odpowiedzieć na pytanie używając Cloud Postgres.
   * Zwraca null gdy intent nie pasuje — caller (controller) ma wtedy
   * forward do Edge.
   */
  async tryAnswerLocally(
    question: string,
    buildingId: number,
    residentId: number,
  ): Promise<BuildingAssistantResponse | null> {
    const q = question.toLowerCase().trim()
    const start = Date.now()

    const intent = this.classifyBuildingIntent(q)
    if (!intent) return null

    try {
      switch (intent) {
        case 'building_name':
          return await this.handleBuildingName(buildingId, start)
        case 'building_address':
          return await this.handleBuildingAddress(buildingId, start)
        case 'building_admin':
          return await this.handleBuildingAdmin(buildingId, start)
        case 'building_stats':
          return await this.handleBuildingStats(buildingId, start)
        case 'residents_count':
          return await this.handleResidentsCount(buildingId, start)
        case 'my_rent':
          return await this.handleMyRent(buildingId, residentId, start)
        case 'my_arrears':
          return await this.handleMyArrears(buildingId, residentId, start)
        case 'guest_status':
          return await this.handleGuestStatus(buildingId, residentId, question, start)
        case 'invite_guest':
          return await this.handleInviteGuest(buildingId, residentId, question, start)
        case 'my_unit':
          return await this.handleMyUnit(residentId, start)
        case 'building_amenities':
          return await this.handleBuildingAmenities(buildingId, start)
        default:
          return null
      }
    } catch (err: any) {
      this.logger.error(`Building info query failed: ${err.message}`)
      return null // fallback do Edge
    }
  }

  // ─── intent classifier ───────────────────────────────────────────────

  private classifyBuildingIntent(q: string): string | null {
    // PRIORITY: most specific first.

    // "moje mieszkanie" / "mój lokal" / "który mam numer"
    if (/(moj\w*|mój)\s+(mieszk|lokal|adres|numer)/i.test(q)) return 'my_unit'
    if (/jaki\s+mam\s+(numer|lokal|mieszk)/i.test(q)) return 'my_unit'

    // "administrator" / "zarządca" / "kto zarządza" / "do kogo dzwonić"
    if (/(administr\w*|zarządc\w*|kto.{0,15}zarządz)/i.test(q))
      return 'building_admin'

    // "adres" / "gdzie się znajduje" / "lokalizacja"
    if (/(adres|gdzie.{0,15}(znajd|jest|leży)|lokalizacj)/i.test(q))
      return 'building_address'

    // "nazwa" / "jak nazywa się" osiedle/budynek
    if (
      /jak.{0,5}naz/.test(q) &&
      /(osiedl|budynk|wspóln|naszego|naszą)/i.test(q)
    )
      return 'building_name'

    // 8.h.32 — "ilu mieszkańców" / "ile osób mieszka" / "liczba mieszkańców".
    // PRZED building_stats (tam też matchuje "mieszk"). Celowo wymagamy
    // "mieszkańc*"/"mieszka"/"zamieszkuje" — samo "ile osób" MUSI zostać
    // dla Edge (licznik osób z kamer, count_objects_today).
    if (
      /il[eu]\s+mieszka[nń]c/i.test(q) ||
      /il[eu]\s+os[óo]b\s+(mieszka|zamieszkuje|żyje)/i.test(q) ||
      /liczba\s+mieszka[nń]c/i.test(q) ||
      /ilu\s+ludzi\s+(mieszka|zamieszkuje)/i.test(q)
    )
      return 'residents_count'

    // 2026-08-16 — Guest Pass status (Event Intelligence spec §11): "czy mój
    // gość już przyjechał?", "czy Marek wjechał?", "do kiedy działa Guest
    // Pass?", "które moje zaproszenia są aktywne?". PRZED invite_guest —
    // pytania o STAN nie zawierają czasownika zapraszania.
    if (
      (/go[sś][cć]\w*|guest\s*pass\w*|zaproszeni\w*|przepustk\w*/i.test(q) &&
        /(przyjecha|wjecha|dotar[lł]|jest\s+ju[żz]|ju[żz]\s+jest|wyjecha|opu[sś]ci|aktywn|wa[żz]n|do\s+kiedy|kiedy\s+wygasa)/i.test(q)) ||
      /kt[oó]r\w*\s+.{0,20}(guest\s*pass|zaproszeni)/i.test(q)
    )
      return 'guest_status'

    // 2026-08-16 — AKCJA: zaproszenie gościa z czatu ("zaproś gościa Jan
    // Kowalski na jutro"). Wymagamy czasownika zapraszania + słowa gość —
    // samo "gość" ("kiedy był mój gość?") zostaje dla Edge (historia gości).
    if (/(zapro[sś]\w*|dodaj)\s+(go[sś]ci\w*|go[sś]cia)/i.test(q) ||
        /zaproszenie\s+dla\s+/i.test(q))
      return 'invite_guest'

    // 2026-08-16 — zaległości płatnicze mieszkańca. PRZED my_rent ("czy mam
    // zaległości w opłatach" zawiera "opłat*" i wpadłoby w naliczenie
    // bieżącego miesiąca zamiast pełnego bilansu).
    if (
      /\bzaleg/i.test(q) || // zalegam / zaległości / zalegał / zaległy
      (/\bd[lł]ug\w*\b/i.test(q) && /(mam|moj|mój|czynsz|op[lł]at)/i.test(q)) ||
      /na\s+bie[żz][aą]co\s+z\s+(op[lł]at|czynsz|p[lł]atno)/i.test(q)
    )
      return 'my_arrears'

    // 8.h.32 — czynsz / opłaty mieszkańca. Wąsko: "czynsz" + kontekst kwoty
    // LUB frazy "jakie są opłaty"/"ile płacę"/"z czego składa się czynsz".
    // Wyjątek: pytania o TREŚĆ dokumentów ("co mówi uchwała o czynszu",
    // "regulamin") → KB na Edge, nie naliczenie.
    if (!/(uchwa[lł]|regulamin|co\s+m[oó]wi|co\s+pisze)/i.test(q)) {
      if (
        /(ile|jaki|jaka|jak\s+wysoki)\s+(wynosi\s+)?.{0,15}czynsz/i.test(q) ||
        /czynsz\w*.{0,20}(wynosi|kwota|wysoko|p[lł]ac)/i.test(q) ||
        /z\s+czego\s+sk[lł]ada\s+si[eę].{0,15}(czynsz|op[lł]at)/i.test(q) ||
        /sk[lł]adow\w*\s+(czynszu|op[lł]at)/i.test(q) || // "jakie są składowe czynszu"
        /jakie\s+(s[aą]\s+)?op[lł]aty/i.test(q) ||
        /ile\s+p[lł]ac[eę]/i.test(q) ||
        /ile\s+mam\s+(do\s+)?zap[lł]a/i.test(q)
      )
        return 'my_rent'
    }

    // "ile/ilu mieszkań / domów / pięter / lokali"
    if (
      /il[eu].{0,10}(mieszk|dom\w*|piętr|pieter|lokal|kondygnacji|kondygnacja)/i.test(q)
    )
      return 'building_stats'

    // "udogodnienia / co jest" — basen, siłownia, sauna, lobby, plac zabaw
    if (
      /(udogodn\w*|amenit|basen|siłown\w*|sauna|playroom|lobby|sala\s+bankietow|plac\s+zabaw|winda|cctv)/i.test(q)
    )
      return 'building_amenities'

    return null
  }

  // ─── handlers ────────────────────────────────────────────────────────

  private async handleBuildingName(
    buildingId: number,
    start: number,
  ): Promise<BuildingAssistantResponse> {
    const b = await this.prisma.building.findUnique({
      where: { id: buildingId },
      select: { name: true },
    })
    const name = b?.name ?? 'nieznane'
    return {
      answer: `Twoje osiedle: ${name}.`,
      intent: 'building_name',
      parameters: {},
      totalMs: Date.now() - start,
      modelUsed: 'cloud-building-info',
      data: { name },
    }
  }

  private async handleBuildingAddress(
    buildingId: number,
    start: number,
  ): Promise<BuildingAssistantResponse> {
    const b = await this.prisma.building.findUnique({
      where: { id: buildingId },
      select: { name: true, address: true },
    })
    const address = b?.address ?? 'brak adresu w bazie'
    return {
      answer: `Adres osiedla "${b?.name}": ${address}.`,
      intent: 'building_address',
      parameters: {},
      totalMs: Date.now() - start,
      modelUsed: 'cloud-building-info',
      data: { name: b?.name, address },
    }
  }

  private async handleBuildingAdmin(
    buildingId: number,
    start: number,
  ): Promise<BuildingAssistantResponse> {
    // Raw SQL — Prisma drift sprawia że relation `buildingAdminAssignment.buildingAdmin`
    // nie istnieje w typed Client. JOIN przez surowy SQL.
    const admins = await this.prisma.$queryRaw<
      Array<{ name: string; email: string }>
    >`
      SELECT ba."name", ba."email"
        FROM "BuildingAdminAssignment" baa
        JOIN "building_admins" ba ON ba."id" = baa."buildingAdminId"
       WHERE baa."buildingId" = ${buildingId}
    `

    if (admins.length > 0) {
      const names = admins.map((a) => a.name).filter(Boolean).join(', ')
      const contact = admins[0]
      const lines = [
        `${admins.length === 1 ? 'Administrator' : 'Administratorzy'}: ${names}.`,
      ]
      if (contact.email) lines.push(`Email: ${contact.email}.`)
      return {
        answer: lines.join(' '),
        intent: 'building_admin',
        parameters: {},
        totalMs: Date.now() - start,
        modelUsed: 'cloud-building-info',
        data: { admins },
      }
    }

    // Fallback — top-level Admin (Integrator) z Building.adminId
    const adminInfo = await this.prisma.$queryRaw<
      Array<{ name: string; email: string }>
    >`
      SELECT a."name", a."email"
        FROM "buildings" b
        JOIN "admins" a ON a."id" = b."adminId"
       WHERE b."id" = ${buildingId}
       LIMIT 1
    `
    return {
      answer: adminInfo.length > 0
        ? `Osiedle zarządzane przez: ${adminInfo[0].name}. Email: ${adminInfo[0].email}.`
        : 'Nie znalazłem administratora w bazie.',
      intent: 'building_admin',
      parameters: {},
      totalMs: Date.now() - start,
      modelUsed: 'cloud-building-info',
      data: adminInfo[0] ?? null,
    }
  }

  private async handleBuildingStats(
    buildingId: number,
    start: number,
  ): Promise<BuildingAssistantResponse> {
    const b = await this.prisma.building.findUnique({
      where: { id: buildingId },
      select: {
        name: true,
        numberOfFloors: true,
        numberOfHouses: true,
      },
    })
    const unitCount = await this.prisma.unit.count({ where: { buildingId } })
    const residentCount = await this.prisma.resident.count({ where: { buildingId } })

    const parts: string[] = []
    if (b?.numberOfHouses) parts.push(`${b.numberOfHouses} ${plural(b.numberOfHouses, 'dom', 'domy', 'domów')}`)
    if (b?.numberOfFloors) parts.push(`${b.numberOfFloors} ${plural(b.numberOfFloors, 'piętro', 'piętra', 'pięter')}`)
    if (unitCount > 0) parts.push(`${unitCount} ${plural(unitCount, 'mieszkanie', 'mieszkania', 'mieszkań')}`)
    if (residentCount > 0) parts.push(`${residentCount} ${plural(residentCount, 'mieszkaniec', 'mieszkańców', 'mieszkańców')}`)

    const answer = parts.length > 0
      ? `Osiedle "${b?.name}" ma ${parts.join(', ')}.`
      : 'Brak danych statystycznych o osiedlu.'

    return {
      answer,
      intent: 'building_stats',
      parameters: {},
      totalMs: Date.now() - start,
      modelUsed: 'cloud-building-info',
      data: {
        name: b?.name,
        numberOfHouses: b?.numberOfHouses,
        numberOfFloors: b?.numberOfFloors,
        unitCount,
        residentCount,
      },
    }
  }

  /**
   * 8.h.32 — "Ilu mieszkańców ma to osiedle?" / "Ile osób tu mieszka?".
   * Liczby wprost z Postgresa: konta mieszkańców + lokale + pojazdy
   * na białej liście (APPROVED). Deterministyczne, ~3 zapytania.
   */
  private async handleResidentsCount(
    buildingId: number,
    start: number,
  ): Promise<BuildingAssistantResponse> {
    const [b, residentCount, unitCount, vehicleCount] = await Promise.all([
      this.prisma.building.findUnique({
        where: { id: buildingId },
        select: { name: true },
      }),
      this.prisma.resident.count({ where: { buildingId } }),
      this.prisma.unit.count({ where: { buildingId } }),
      this.prisma.vehicle.count({ where: { buildingId, status: 'APPROVED' } }),
    ])

    const parts = [
      `Osiedle${b?.name ? ` "${b.name}"` : ''} ma ${residentCount} ${plural(residentCount, 'mieszkańca', 'mieszkańców', 'mieszkańców')}` +
        ` (zarejestrowane konta) w ${unitCount} ${plural(unitCount, 'lokalu', 'lokalach', 'lokalach')}.`,
    ]
    if (vehicleCount > 0) {
      parts.push(
        `Na białej liście pojazdów: ${vehicleCount} ${plural(vehicleCount, 'pojazd', 'pojazdy', 'pojazdów')}.`,
      )
    }
    return {
      answer: parts.join(' '),
      intent: 'residents_count',
      parameters: {},
      totalMs: Date.now() - start,
      modelUsed: 'cloud-building-info',
      data: { name: b?.name, residentCount, unitCount, vehicleCount },
    }
  }

  /**
   * 8.h.32 — "Ile wynosi czynsz?" / "Jakie są opłaty?" / "Ile płacę?".
   * Ścieżki (prywatność naturalna — JWT wskazuje mieszkańca i jego lokal):
   *   1. Naliczenie bieżącego miesiąca (PaymentCharge) → suma + termin +
   *      składowe ze snapshotu + wpłaty/status.
   *   2. Brak naliczenia, ale budynek MA aktywne PaymentComponent →
   *      "zarządca nie wygenerował jeszcze naliczenia; składowe to: …".
   *   3. Płatności w ogóle nieskonfigurowane → null (fallback do Edge/KB —
   *      dotychczasowe zachowanie).
   */
  private async handleMyRent(
    buildingId: number,
    residentId: number,
    start: number,
  ): Promise<BuildingAssistantResponse | null> {
    // Aktywny lokal mieszkańca (pivot unit_residents — jak getMyPayments).
    const unitRows = await this.prisma.$queryRaw<
      Array<{ unitId: number; unitNumber: string; areaSqm: unknown }>
    >`
      SELECT ur."unitId", u.number AS "unitNumber", u."areaSqm" AS "areaSqm"
        FROM unit_residents ur
        JOIN units u ON u.id = ur."unitId"
       WHERE ur."residentId" = ${residentId}
         AND u."buildingId" = ${buildingId}
         AND ur."sinceDate" <= NOW()
         AND (ur."untilDate" IS NULL OR ur."untilDate" > NOW())
       LIMIT 1
    `
    const now = new Date()
    const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
    const fmtZl = (n: number) =>
      `${(Math.round(n * 100) / 100).toFixed(2).replace('.', ',')} zł`
    const fmtDate = (d: Date) =>
      d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'long', year: 'numeric' })

    // Aktywne składowe budynku/lokalu — potrzebne w ścieżce 2 i do detekcji
    // "czy płatności w ogóle skonfigurowane" (ścieżka 3 → null).
    const unitId = unitRows[0]?.unitId ?? null
    const components = await this.prisma.paymentComponent.findMany({
      where: {
        buildingId,
        activeFrom: { lte: now },
        OR: [{ activeTo: null }, { activeTo: { gte: now } }],
        AND: [{ OR: [{ unitId: null }, ...(unitId ? [{ unitId }] : [])] }],
      },
      orderBy: { id: 'asc' },
    })

    // ── Ścieżka 1: naliczenie bieżącego miesiąca ──
    if (unitId) {
      const charge = await this.prisma.paymentCharge
        .findUnique({ where: { unitId_period: { unitId, period } } })
        .catch(() => null)
      if (charge) {
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
        const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
        const payments = await this.prisma.paymentEntry.findMany({
          where: {
            unitId,
            type: 'PAYMENT',
            OR: [
              { chargeId: charge.id },
              { chargeId: null, date: { gte: monthStart, lt: monthEnd } },
            ],
          },
          select: { amount: true },
        })
        const paid =
          Math.round(payments.reduce((s, p) => s + Number(p.amount), 0) * 100) / 100
        const total = Number(charge.totalAmount)
        const { status, daysOverdue } = computeChargeStatus(total, paid, charge.dueDate, now)
        const comps = Array.isArray(charge.components)
          ? (charge.components as Array<{ name?: string; amount?: number }>)
          : []
        const compStr = comps
          .filter((c) => c && c.name)
          .map((c) => `${c.name} ${fmtZl(Number(c.amount ?? 0))}`)
          .join(', ')
        const lines = [
          `Twój czynsz za bieżący miesiąc (lokal ${unitRows[0].unitNumber}) wynosi ${fmtZl(total)},` +
            ` termin płatności: ${fmtDate(charge.dueDate)}.`,
        ]
        if (compStr) lines.push(`Składowe: ${compStr}.`)
        if (status === 'PAID') lines.push('Naliczenie jest w całości opłacone.')
        else if (paid > 0) lines.push(`Zapłacono ${fmtZl(paid)}, do zapłaty pozostaje ${fmtZl(total - paid)}.`)
        else if (status === 'OVERDUE') lines.push(`Naliczenie jest przeterminowane o ${daysOverdue} dni.`)
        return {
          answer: lines.join(' '),
          intent: 'my_rent',
          parameters: { period },
          totalMs: Date.now() - start,
          modelUsed: 'cloud-building-info',
          data: {
            period,
            unitNumber: unitRows[0].unitNumber,
            totalAmount: total,
            dueDate: charge.dueDate,
            components: comps,
            paidAmount: paid,
            status,
          },
        }
      }
    }

    // ── Ścieżka 3: płatności nieskonfigurowane → fallback do Edge/KB ──
    if (components.length === 0) return null

    // ── Ścieżka 2: brak naliczenia, są składowe → wylicz z komponentów ──
    const area = unitRows[0]?.areaSqm != null ? Number(unitRows[0].areaSqm) : null
    let total = 0
    const compParts: string[] = []
    for (const c of components) {
      const amount =
        c.calcType === 'PER_SQM'
          ? area != null
            ? Number(c.amount) * area
            : 0
          : Number(c.amount)
      total += amount
      compParts.push(
        c.calcType === 'PER_SQM' && area == null
          ? `${c.name} (${fmtZl(Number(c.amount))}/m² — brak metrażu lokalu)`
          : `${c.name} ${fmtZl(amount)}`,
      )
    }
    const answer =
      `Zarządca nie wygenerował jeszcze naliczenia czynszu za ten miesiąc. ` +
      `Miesięczne składowe opłat${unitRows[0] ? ` dla lokalu ${unitRows[0].unitNumber}` : ''}: ` +
      `${compParts.join(', ')} — razem ok. ${fmtZl(total)}.`
    return {
      answer,
      intent: 'my_rent',
      parameters: { period },
      totalMs: Date.now() - start,
      modelUsed: 'cloud-building-info',
      data: {
        period,
        unitNumber: unitRows[0]?.unitNumber ?? null,
        charge: null,
        components: components.map((c) => ({
          name: c.name,
          amount: Number(c.amount),
          calcType: c.calcType,
        })),
        estimatedTotal: Math.round(total * 100) / 100,
      },
    }
  }

  /**
   * 2026-08-16 — "Czy mam zaległości?" / "Ile zalegam?". Pełny bilans
   * mieszkańca: wszystkie naliczenia jego lokalu (ostatnie 12 okresów),
   * per naliczenie wpłaty (po chargeId + nieprzypisane z miesiąca okresu —
   * ta sama semantyka co handleMyRent), status z computeChargeStatus.
   * Prywatność naturalna: JWT wskazuje mieszkańca, odpowiadamy TYLKO o nim.
   */
  /**
   * Day Summary v2 (2026-08-17) — osobiste linie do sekcji „Twój dzień"
   * w podsumowaniu iOS. Liczone ŚWIEŻO per request (cache day-summary jest
   * per-BUDYNEK — nie może trzymać danych jednego mieszkańca): goście
   * (dzisiejszy wjazd / aktywne zaproszenie), zaległości w opłatach, nowe
   * ogłoszenia z 24 h. Zwraca [] gdy nic osobistego się nie dzieje.
   */
  async buildPersonalDayLines(
    buildingId: number,
    residentId: number,
    opts?: { includeArrears?: boolean },
  ): Promise<string[]> {
    const lines: string[] = []
    const tz = 'Europe/Warsaw'
    const fmtT = (d: Date) =>
      d.toLocaleString('pl-PL', { timeZone: tz, hour: '2-digit', minute: '2-digit' })
    const fmtD = (d: Date) =>
      d.toLocaleString('pl-PL', { timeZone: tz, day: 'numeric', month: 'long' })

    // Goście: dzisiejszy wjazd (ostatnie 18 h ≈ dziś) albo aktywne zaproszenie.
    const guests = await this.prisma.$queryRaw<
      Array<{ id: number; name: string; validTo: Date; arrivedAt: Date | null }>
    >`
      SELECT g.id, g.name, g."validTo",
             (SELECT MAX(ae.ts) FROM access_events ae
               WHERE ae."guestId" = g.id AND ae."gateOpened" = true
                 AND ae.ts >= NOW() - INTERVAL '18 hours') AS "arrivedAt"
        FROM guests g
       WHERE g."residentId" = ${residentId} AND g."buildingId" = ${buildingId}
         AND g.status = 'ACTIVE' AND g."validFrom" <= NOW() AND g."validTo" > NOW()
       ORDER BY g."createdAt" DESC
       LIMIT 2
    `
    for (const g of guests) {
      if (g.arrivedAt) lines.push(`👥 Twój gość ${g.name} wjechał dziś o ${fmtT(g.arrivedAt)}.`)
      else lines.push(`👥 ${g.name} ma aktywne zaproszenie (do ${fmtD(g.validTo)}).`)
    }

    // Zaległości — pełna logika naliczeń/wpłat z handleMyArrears.
    // opts.includeArrears=false → pomiń (poranny brief push przypomina
    // o zaległości tylko pn/czw, żeby nie męczyć codziennie tym samym).
    if (opts?.includeArrears !== false) {
      try {
        const arrears = await this.handleMyArrears(buildingId, residentId, Date.now())
        const data = arrears?.data as { overdueTotal?: number } | null
        if (data?.overdueTotal && data.overdueTotal > 0) {
          const zl = `${(Math.round(data.overdueTotal * 100) / 100).toFixed(2).replace('.', ',')} zł`
          lines.push(`💰 Masz zaległość ${zl} — szczegóły w zakładce Płatności.`)
        }
      } catch {
        // płatności nieskonfigurowane — pomijamy linię
      }
    }

    // Nowe ogłoszenie z ostatnich 24 h (broadcast albo adresowane do mnie).
    const ann = await this.prisma.$queryRaw<Array<{ title: string }>>`
      SELECT title FROM notifications
       WHERE "buildingId" = ${buildingId}
         AND ("residentId" IS NULL OR "residentId" = ${residentId})
         AND "sentAt" >= NOW() - INTERVAL '24 hours'
       ORDER BY "sentAt" DESC
       LIMIT 1
    `
    if (ann[0]?.title)
      lines.push(`📢 Nowe ogłoszenie: „${ann[0].title.slice(0, 70)}” — otwórz w Ogłoszeniach.`)

    return lines
  }

  private async handleMyArrears(
    buildingId: number,
    residentId: number,
    start: number,
  ): Promise<BuildingAssistantResponse | null> {
    const unitRows = await this.prisma.$queryRaw<
      Array<{ unitId: number; unitNumber: string }>
    >`
      SELECT ur."unitId", u.number AS "unitNumber"
        FROM unit_residents ur
        JOIN units u ON u.id = ur."unitId"
       WHERE ur."residentId" = ${residentId}
         AND u."buildingId" = ${buildingId}
         AND ur."sinceDate" <= NOW()
         AND (ur."untilDate" IS NULL OR ur."untilDate" > NOW())
       LIMIT 1
    `
    const unitId = unitRows[0]?.unitId
    if (!unitId) return null // brak lokalu → Edge/KB fallback

    const charges = await this.prisma.paymentCharge.findMany({
      where: { unitId },
      orderBy: { period: 'desc' },
      take: 12,
    })
    if (charges.length === 0) return null // płatności nieskonfigurowane

    const now = new Date()
    const fmtZl = (n: number) =>
      `${(Math.round(n * 100) / 100).toFixed(2).replace('.', ',')} zł`

    let overdueTotal = 0
    const overdueLines: string[] = []
    let currentUnpaid: string | null = null
    for (const charge of charges) {
      const [y, m] = String(charge.period).split('-').map(Number)
      if (!y || !m) continue
      const monthStart = new Date(Date.UTC(y, m - 1, 1))
      const monthEnd = new Date(Date.UTC(y, m, 1))
      const payments = await this.prisma.paymentEntry.findMany({
        where: {
          unitId,
          type: 'PAYMENT',
          OR: [
            { chargeId: charge.id },
            { chargeId: null, date: { gte: monthStart, lt: monthEnd } },
          ],
        },
        select: { amount: true },
      })
      const paid =
        Math.round(payments.reduce((s, p) => s + Number(p.amount), 0) * 100) / 100
      const total = Number(charge.totalAmount)
      const { status, daysOverdue } = computeChargeStatus(total, paid, charge.dueDate, now)
      if (status === 'OVERDUE') {
        const missing = Math.round((total - paid) * 100) / 100
        overdueTotal += missing
        overdueLines.push(
          `okres ${charge.period} — brakuje ${fmtZl(missing)} (${daysOverdue} dni po terminie)`,
        )
      } else if (status !== 'PAID' && charge.dueDate >= now && !currentUnpaid) {
        const missing = Math.round((total - paid) * 100) / 100
        currentUnpaid =
          `Bieżące naliczenie (${charge.period}) na ${fmtZl(missing)} ` +
          `ma termin ${charge.dueDate.toLocaleDateString('pl-PL', {
            day: 'numeric', month: 'long',
          })} — jeszcze nie jest zaległością.`
      }
    }

    let answer: string
    if (overdueLines.length === 0) {
      answer =
        `Nie masz żadnych zaległości — wszystkie naliczenia dla lokalu ` +
        `${unitRows[0].unitNumber} są uregulowane.` +
        (currentUnpaid ? ` ${currentUnpaid}` : '')
    } else {
      answer =
        `Masz zaległość łącznie ${fmtZl(overdueTotal)} (lokal ${unitRows[0].unitNumber}): ` +
        overdueLines.join('; ') + '.' +
        (currentUnpaid ? ` ${currentUnpaid}` : '') +
        ' Szczegóły i historia wpłat są w zakładce Płatności.'
    }
    return {
      answer,
      intent: 'my_arrears',
      parameters: {},
      totalMs: Date.now() - start,
      modelUsed: 'cloud-building-info',
      data: {
        unitNumber: unitRows[0].unitNumber,
        overdueTotal: Math.round(overdueTotal * 100) / 100,
        overdueCount: overdueLines.length,
      },
    }
  }

  /**
   * 2026-08-16 — Guest Pass status (Event Intelligence §11). Prywatność
   * naturalna: WYŁĄCZNIE goście zaproszeni przez TEGO mieszkańca (JWT).
   * Odpowiedzi oparte na dowodach (§6): wjazd/wyjazd czytamy z access_events
   * (PIN_USED / LPR_MATCH z guestId), nie zgadujemy. Czasy w strefie osiedla.
   */
  private async handleGuestStatus(
    buildingId: number,
    residentId: number,
    question: string,
    start: number,
  ): Promise<BuildingAssistantResponse | null> {
    const guests = await this.prisma.$queryRaw<
      Array<{
        id: number; name: string; status: string; validFrom: Date; validTo: Date
        usedAt: Date | null; vehiclePlate: string | null
      }>
    >`
      SELECT id, name, status, "validFrom", "validTo", "usedAt", "vehiclePlate"
        FROM guests
       WHERE "residentId" = ${residentId} AND "buildingId" = ${buildingId}
       ORDER BY "createdAt" DESC
       LIMIT 12
    `
    const done = (answer: string, data: unknown = null): BuildingAssistantResponse => ({
      answer,
      intent: 'guest_status',
      parameters: {},
      totalMs: Date.now() - start,
      modelUsed: 'cloud-building-info',
      data,
    })
    if (guests.length === 0)
      return done(
        'Nie masz żadnych zaproszeń dla gości. Możesz utworzyć je w zakładce Goście ' +
          'albo napisać tu np. „Zaproś gościa Jan Kowalski na jutro”.',
      )

    const tz = 'Europe/Warsaw'
    const now = new Date()
    const fmtT = (d: Date) =>
      d.toLocaleString('pl-PL', { timeZone: tz, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })

    // Konkretny gość po imieniu? ("Czy Marek już przyjechał?") — dopasowanie
    // tokenów pytania do imion MOICH gości (nigdy odwrotnie — brak szukania
    // po cudzych gościach).
    const qLower = question.toLowerCase()
    const named = guests.filter((g) =>
      g.name.toLowerCase().split(/\s+/).some((part) => part.length >= 3 && qLower.includes(part)),
    )
    const active = guests.filter(
      (g) => g.status === 'ACTIVE' && g.validFrom <= now && g.validTo > now,
    )

    // "które passy aktywne?" — lista bez korelacji zdarzeń.
    if (/kt[oó]r\w*|jakie|aktywn|lista/i.test(qLower) && named.length === 0) {
      if (active.length === 0)
        return done('Nie masz teraz żadnego aktywnego zaproszenia dla gościa.', { active: [] })
      const parts = active.map((g) => `${g.name} (ważne do ${fmtT(g.validTo)})`)
      return done(
        `Masz ${active.length === 1 ? 'jedno aktywne zaproszenie' : `${active.length} aktywne zaproszenia`}: ${parts.join('; ')}.`,
        { active: active.map((g) => ({ id: g.id, name: g.name, validTo: g.validTo })) },
      )
    }

    // Status konkretnego gościa (albo najnowszego aktywnego).
    const target = named[0] ?? active[0] ?? guests[0]
    const events = await this.prisma.$queryRaw<
      Array<{ ts: Date; type: string; direction: string | null; gateOpened: boolean; apLabel: string | null }>
    >`
      SELECT ae.ts, ae.type::text AS type, ae.direction, ae."gateOpened",
             ap.label AS "apLabel"
        FROM access_events ae
        LEFT JOIN access_points ap ON ap.id = ae."accessPointId"
       WHERE ae."guestId" = ${target.id} AND ae."gateOpened" = true
       ORDER BY ae.ts ASC
       LIMIT 50
    `
    const arrivals = events.filter((e) => e.direction !== 'OUT')
    const exits = events.filter((e) => e.direction === 'OUT')
    const lastArrival = arrivals[arrivals.length - 1] ?? null
    const lastExit = exits[exits.length - 1] ?? null
    const asksExit = /wyjecha|opu[sś]ci/i.test(qLower)

    const lines: string[] = []
    if (asksExit) {
      if (lastExit) lines.push(`${target.name} wyjechał(a) ${fmtT(lastExit.ts)}${lastExit.apLabel ? ` (${lastExit.apLabel})` : ''}.`)
      else if (lastArrival)
        lines.push(
          `Widzę wjazd gościa ${target.name} ${fmtT(lastArrival.ts)}, ale nie mam zarejestrowanego wyjazdu — ` +
            `mógł wyjechać wejściem bez rejestracji.`,
        )
      else lines.push(`Nie widzę żadnego wjazdu ani wyjazdu gościa ${target.name}.`)
    } else if (lastArrival) {
      const via = lastArrival.type === 'PIN_USED' ? 'wpisując PIN' : lastArrival.type === 'LPR_MATCH' ? 'rozpoznany po tablicy' : ''
      lines.push(`Tak — ${target.name} wjechał(a) ${fmtT(lastArrival.ts)}${lastArrival.apLabel ? ` przez ${lastArrival.apLabel}` : ''}${via ? ` (${via})` : ''}.`)
      if (lastExit && lastExit.ts > lastArrival.ts) lines.push(`Wyjazd zarejestrowany ${fmtT(lastExit.ts)}.`)
    } else if (target.usedAt) {
      lines.push(`PIN gościa ${target.name} został użyty ${fmtT(target.usedAt)}.`)
    } else {
      lines.push(`Nie widzę jeszcze wjazdu gościa ${target.name}.`)
    }
    if (target.status === 'ACTIVE' && target.validTo > now)
      lines.push(`Zaproszenie jest ważne do ${fmtT(target.validTo)}.`)
    else if (target.validTo <= now) lines.push(`Zaproszenie wygasło ${fmtT(target.validTo)}.`)

    return done(lines.join(' '), {
      guest: { id: target.id, name: target.name, status: target.status, validTo: target.validTo },
      arrivals: arrivals.length,
      exits: exits.length,
    })
  }

  /**
   * 2026-08-16 — AKCJA z czatu: "Zaproś gościa Jan Kowalski na jutro".
   * Wykonuje PEŁNĄ ścieżkę formularza (walidacje, anty-stalking guard dla
   * tablic, PIN, link portalu, sync na Edge) — createGuest z ResidentService.
   * Zaproszenie widać od razu w zakładce Goście, gdzie można je anulować.
   */
  private async handleInviteGuest(
    buildingId: number,
    residentId: number,
    question: string,
    start: number,
  ): Promise<BuildingAssistantResponse | null> {
    const fail = (answer: string): BuildingAssistantResponse => ({
      answer,
      intent: 'invite_guest',
      parameters: {},
      totalMs: Date.now() - start,
      modelUsed: 'cloud-building-info',
      data: { created: false },
    })

    // Imię: po „gościa"/„dla", 1-3 słowa zaczynające się wielką literą
    // (oryginalny case pytania). „na jutro"/„z tablicą…" ucinamy niżej.
    const nameMatch = question.match(
      /(?:go[sś]cia|dla)\s+([A-ZĄĆĘŁŃÓŚŹŻ][\p{L}'-]+(?:\s+[A-ZĄĆĘŁŃÓŚŹŻ][\p{L}'-]+){0,2})/u,
    )
    let name = nameMatch?.[1]?.trim() ?? ''
    name = name.replace(/\s+(?:na|do|od|z)$/iu, '').trim()
    if (!name) {
      return fail(
        'Podaj imię gościa, np. „Zaproś gościa Jan Kowalski na jutro” — ' +
          'utworzę zaproszenie z PIN-em i linkiem.',
      )
    }

    // Okres ważności: „na N dni/godzin", „na jutro/do jutra", domyślnie 24 h.
    const q = question.toLowerCase()
    const now = new Date()
    let validTo = new Date(now.getTime() + 24 * 3600_000)
    const dur = q.match(/na\s+(\d{1,2})\s*(dni|dzie[nń]|dob[eęy]|godzin\w*|tygod\w*)/)
    if (dur) {
      const n = parseInt(dur[1], 10)
      const unit = dur[2]
      const hours = unit.startsWith('godzin') ? n : unit.startsWith('tygod') ? n * 168 : n * 24
      validTo = new Date(now.getTime() + Math.min(hours, 90 * 24) * 3600_000)
    } else if (/\b(na|do)\s+jutr/.test(q)) {
      // Koniec JUTRZEJSZEGO dnia w strefie osiedla (serwer Fly działa w UTC).
      const tz = 'Europe/Warsaw'
      const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(
        new Date(now.getTime() + 24 * 3600_000),
      )
      const offset =
        new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
          .formatToParts(now)
          .find((p) => p.type === 'timeZoneName')
          ?.value.replace('GMT', '') || '+00:00'
      validTo = new Date(`${dayKey}T23:59:00${offset}`)
    }

    // Tablica — tylko gdy user jawnie ją podał („z tablicą WD5005P").
    const plateMatch = question
      .toUpperCase()
      .match(/TABLIC\w*\s+([A-Z]{1,3}\s?[A-Z0-9]{4,6})/)
    const vehiclePlate = plateMatch?.[1]?.replace(/\s+/g, '')

    try {
      const guest = await this.residentService.createGuest(residentId, buildingId, {
        name,
        validTo: validTo.toISOString(),
        ...(vehiclePlate ? { vehiclePlate } : {}),
      })
      const fmtDate = validTo.toLocaleString('pl-PL', {
        timeZone: 'Europe/Warsaw',
        day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
      })
      const link = guest.urlToken ? ` Link dla gościa: https://gatelynk.com/g/${guest.urlToken}.` : ''
      const plateStr = vehiclePlate ? ` Tablica ${vehiclePlate} otworzy bramę automatycznie.` : ''
      return {
        answer:
          `Gotowe — zaprosiłem gościa ${guest.name}. Zaproszenie ważne do ${fmtDate}. ` +
          `PIN do bramy: ${guest.pin}.${plateStr}${link} ` +
          `Zaproszenie znajdziesz (i możesz anulować) w zakładce Goście.`,
        intent: 'invite_guest',
        parameters: { name: guest.name },
        totalMs: Date.now() - start,
        modelUsed: 'cloud-building-info',
        data: { created: true, guestId: guest.id, pin: guest.pin, validTo: guest.validTo },
      }
    } catch (err: any) {
      // Walidacje (np. anty-stalking dla tablicy z rejestru) → komunikat 1:1.
      const msg = err?.response?.message ?? err?.message ?? 'Nie udało się utworzyć zaproszenia.'
      return fail(`Nie mogę utworzyć zaproszenia: ${Array.isArray(msg) ? msg.join('; ') : msg}`)
    }
  }

  private async handleMyUnit(
    residentId: number,
    start: number,
  ): Promise<BuildingAssistantResponse> {
    // Raw SQL — UnitResident.unit relation nie w typed Client (drift).
    // Resident → unit_residents (pivot) → units → stairwells (optional)
    // Filtrujemy aktualne przypisania (untilDate IS NULL OR > NOW()).
    const rows = await this.prisma.$queryRaw<
      Array<{ number: string; stairwell: string | null }>
    >`
      SELECT u."number" as number, s."name" as stairwell
        FROM "unit_residents" ur
        JOIN "units" u ON u."id" = ur."unitId"
        LEFT JOIN "stairwells" s ON s."id" = u."stairwellId"
       WHERE ur."residentId" = ${residentId}
         AND (ur."untilDate" IS NULL OR ur."untilDate" > NOW())
       ORDER BY ur."sinceDate" DESC
    `

    if (rows.length === 0) {
      return {
        answer: 'Nie mam danych o Twoim lokalu — sprawdź ustawienia profilu.',
        intent: 'my_unit',
        parameters: {},
        totalMs: Date.now() - start,
        modelUsed: 'cloud-building-info',
        data: null,
      }
    }
    const units = rows.map((r) =>
      r.stairwell
        ? `klatka ${r.stairwell}, lokal ${r.number}`
        : `lokal ${r.number}`,
    )
    const answer = units.length === 1
      ? `Twój lokal: ${units[0]}.`
      : `Masz przypisane lokale: ${units.join('; ')}.`
    return {
      answer,
      intent: 'my_unit',
      parameters: {},
      totalMs: Date.now() - start,
      modelUsed: 'cloud-building-info',
      data: { units },
    }
  }

  private async handleBuildingAmenities(
    buildingId: number,
    start: number,
  ): Promise<BuildingAssistantResponse> {
    const b = await this.prisma.building.findUnique({
      where: { id: buildingId },
      select: {
        name: true,
        hasElevator: true,
        hasCctv: true,
        hasLightingControl: true,
        hasPhotovoltaics: true,
        hasPool: true,
        hasGym: true,
        hasSauna: true,
        hasPlayroom: true,
        hasBanquetHall: true,
        hasLobby: true,
        hasIntercom: true,
      },
    })
    if (!b) {
      return {
        answer: 'Brak danych o osiedlu.',
        intent: 'building_amenities',
        parameters: {},
        totalMs: Date.now() - start,
        modelUsed: 'cloud-building-info',
        data: null,
      }
    }
    const amenities: string[] = []
    if (b.hasElevator) amenities.push('winda')
    if (b.hasCctv) amenities.push('CCTV')
    if (b.hasIntercom) amenities.push('domofon')
    if (b.hasLightingControl) amenities.push('sterowanie oświetleniem')
    if (b.hasPhotovoltaics) amenities.push('fotowoltaika')
    if (b.hasPool) amenities.push('basen')
    if (b.hasGym) amenities.push('siłownia')
    if (b.hasSauna) amenities.push('sauna')
    if (b.hasPlayroom) amenities.push('plac zabaw')
    if (b.hasBanquetHall) amenities.push('sala bankietowa')
    if (b.hasLobby) amenities.push('lobby')

    const answer = amenities.length > 0
      ? `Udogodnienia osiedla "${b.name}": ${amenities.join(', ')}.`
      : `Osiedle "${b.name}" nie ma zarejestrowanych udogodnień w bazie.`

    return {
      answer,
      intent: 'building_amenities',
      parameters: {},
      totalMs: Date.now() - start,
      modelUsed: 'cloud-building-info',
      data: { amenities },
    }
  }
}

/** Polski plural — `plural(1,'dom','domy','domów')` → 'dom' / 'domy' / 'domów'. */
function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one
  const lastTwo = n % 100
  const last = n % 10
  if (12 <= lastTwo && lastTwo <= 14) return many
  if (2 <= last && last <= 4) return few
  return many
}
