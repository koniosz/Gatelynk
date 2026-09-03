import { Injectable, Logger } from '@nestjs/common'
import { Interval } from '@nestjs/schedule'
import { PrismaService } from '../prisma/prisma.service'
import { EdgeGateway } from '../edge/edge.gateway'

/**
 * GuestExpiryService — cron Faza 2B/3 Villa Natura.
 *
 * Co 5 minut bierze gości którzy mają `status = ACTIVE` ale `validTo` minął
 * i:
 *   1. Flipuje status na EXPIRED w DB.
 *   2. Wysyła `PLATE_DELETE` do Edge dla tablic, które miały samochód
 *      (żeby tablica zniknęła z allowlisty LPR).
 *
 * 5-minutowa kadencja jest kompromisem:
 *   - Akceptujemy do 5 min "okienka" gdzie wygasły gość teoretycznie mógłby
 *     wjechać po ważności (Edge sam waliduje `validUntil`, więc i tak
 *     odrzuci tablicę po stronie LPR — to tylko porządek w bazie).
 *   - Częstsze wykonanie (np. 1 min) niepotrzebnie obciąża DB i WS bez
 *     realnej korzyści.
 *
 * Per CLAUDE.md: używamy raw SQL, bo `prisma generate` w monorepo sypie się
 * przez konflikt wersji 7.5/5.22.
 */
@Injectable()
export class GuestsExpiryService {
  private readonly logger = new Logger(GuestsExpiryService.name)

  constructor(
    private prisma: PrismaService,
    private edgeGateway: EdgeGateway,
  ) {}

  @Interval(5 * 60 * 1000) // 5 minut
  async expireGuests() {
    try {
      // Wyciągamy do EXPIRED w jednym RETURNING — bez drugiego round-tripu.
      // Bierzemy też tablicę, PIN i buildingId, żeby wysłać PLATE_DELETE +
      // PIN_DELETE do Edge w jednym zamachu (Faza 2D).
      const rows = await this.prisma.$queryRaw<
        { id: number; buildingId: number; vehiclePlate: string | null; pin: string | null }[]
      >`
        UPDATE "guests"
           SET status = 'EXPIRED'::"GuestStatus"
         WHERE status = 'ACTIVE'
           AND "validTo" <= NOW()
        RETURNING id, "buildingId", "vehiclePlate", "pin"
      `

      if (rows.length === 0) return

      this.logger.log(`Expired ${rows.length} guest invitation(s)`)

      // Tablice → wyrzucamy z allowlisty LPR. Edge i tak by odrzucił po
      // `validUntil`, ale czysta lista = mniej entries = szybszy match.
      // PIN-y → identycznie z `guest_pins` na Edge (Faza 2D Akuvox).
      // Fire-and-forget — `sendToBuilding` zwraca count i nie throwuje.
      for (const row of rows) {
        if (row.vehiclePlate) {
          this.edgeGateway.sendToBuilding(row.buildingId, 'PLATE_DELETE', {
            plate: row.vehiclePlate,
          })
        }
        if (row.pin) {
          this.edgeGateway.sendToBuilding(row.buildingId, 'PIN_DELETE', {
            pin: row.pin,
            guestId: row.id,
          })
        }
      }
    } catch (err: any) {
      this.logger.warn(`Guest expiry sweep failed: ${err.message}`)
    }
  }
}
