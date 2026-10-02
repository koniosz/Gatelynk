import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { PushService } from '../push/push.service'
import { warsawTime } from '../push/push-text'

/**
 * Powiadomienie o przyjeździe śmieciarki (2026-10-02).
 *
 * Źródło: Edge (SituationCorrelator, typ WASTE_TRUCK) — kamery wizyjne
 * rozpoznają pojazd odbioru odpadów; zdarzenie powstaje dopiero po
 * potwierdzeniu na ≥2 klatkach. Edge wysyła `WASTE_TRUCK_ARRIVED` przez tunel.
 *
 * Odbiorcy: mieszkańcy, dla których
 *   COALESCE(residents.notifyWasteTruck, buildings.wasteTruckNotifyAll) = true
 * — wybór mieszkańca w aplikacji ma pierwszeństwo nad ustawieniem administratora.
 *
 * Jedna wizyta = jedno powiadomienie: Edge ma 3 h przerwy między zdarzeniami,
 * tu dodatkowo blokada 2 h per budynek (restart Edge, duplikat w tunelu).
 */
@Injectable()
export class WasteTruckService {
  private readonly logger = new Logger(WasteTruckService.name)
  private readonly lastSent = new Map<number, number>()
  static readonly COOLDOWN_MS = 2 * 60 * 60_000

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  /** Lista mieszkańców, którzy dostaną powiadomienie (z uwzględnieniem wyboru). */
  async recipients(buildingId: number): Promise<number[]> {
    const rows = await this.prisma.$queryRaw<{ id: number }[]>`
      SELECT r.id
        FROM "residents" r
        JOIN "buildings" b ON b.id = r."buildingId"
       WHERE r."buildingId" = ${buildingId}
         AND COALESCE(r."notifyWasteTruck", b."wasteTruckNotifyAll") = TRUE
    `
    return rows.map((r) => r.id)
  }

  async onArrival(buildingId: number, data: { ts?: number; confirmedTs?: number }): Promise<number> {
    const now = Date.now()
    if (now - (this.lastSent.get(buildingId) ?? 0) < WasteTruckService.COOLDOWN_MS) {
      this.logger.debug(`WASTE_TRUCK b${buildingId}: w oknie 2 h od poprzedniego — pomijam`)
      return 0
    }
    const ts = Number.isFinite(Number(data.ts)) ? Number(data.ts) : now
    // Świeżość liczymy od POTWIERDZENIA (druga klatka), nie od pierwszej klatki.
    const confirmedTs = Number.isFinite(Number(data.confirmedTs)) ? Number(data.confirmedTs) : ts
    // Zdarzenie spóźnione o >30 min (np. tunel wrócił po awarii) nie jest
    // już „przyjazdem" — nie budzimy ludzi nieaktualną informacją.
    if (now - confirmedTs > 30 * 60_000) {
      this.logger.log(`WASTE_TRUCK b${buildingId}: potwierdzenie sprzed ${Math.round((now - confirmedTs) / 60_000)} min — bez powiadomienia`)
      return 0
    }
    this.lastSent.set(buildingId, now)

    const ids = await this.recipients(buildingId)
    const body = `Kamery zarejestrowały pojazd odbioru odpadów na terenie osiedla o ${warsawTime(ts)}.`
    await Promise.all(
      ids.map((id) =>
        this.push
          .sendToResident(id, 'Śmieciarka na osiedlu', body, { type: 'waste-truck', ts })
          .catch((e: Error) => this.logger.warn(`push waste-truck r${id}: ${e.message}`)),
      ),
    )
    this.logger.log(`WASTE_TRUCK b${buildingId} ${warsawTime(ts)} → ${ids.length} odbiorców`)
    return ids.length
  }
}
