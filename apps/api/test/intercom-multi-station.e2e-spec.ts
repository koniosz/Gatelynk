/**
 * Multi-station intercom (2026-07-05) — testy routingu sesji połączeń
 * domofonowych przy N stacjach per budynek.
 *
 * Pokrywają (bez sprzętu — bezpośrednie wywołania IntercomCallService):
 *   • listStations — tylko bridgeEnabled + edgeDeviceId
 *   • callStation (outbound):
 *       - 0 stacji → 400
 *       - 1 stacja bez intercomId → działa jak dotąd (backward-compat)
 *       - >1 stacji bez intercomId → 400 STATION_CHOICE_REQUIRED z listą
 *       - >1 stacji z intercomId → sesja z WYBRANĄ stacją (uuid + nazwa)
 *       - zły intercomId → 400 STATION_NOT_FOUND
 *       - busy-guard: aktywna sesja w budynku → 409 STATION_BUSY
 *   • handleInvite (incoming):
 *       - intercomDeviceId = UUID stacji → sesja niesie nazwę TEJ stacji,
 *         residenci rozwiązani (brama zbiorcza = cały budynek)
 *       - stacja z bridgeEnabled=false → MISSED (nikt nie jest wołany)
 *       - legacy fromUri (nie-UUID) → fallback-building (o ile jakikolwiek
 *         most aktywny) — stara ścieżka Villa Natura bez rekonfiguracji
 *
 * Wzorzec: edge-outbox.e2e-spec.ts (direct service, bez WS/sprzętu).
 * Flaga INTERCOM_CALL_ENABLED ustawiana w beforeAll i zdejmowana w afterAll
 * (service czyta ją dynamicznie w getterze) — nie cieknie do innych suite
 * przy --runInBand.
 */
import { Test, TestingModule } from '@nestjs/testing'
import { AppModule } from '../src/app.module'
import { IntercomCallService } from '../src/resident/intercom-call.service'
import { resetDatabase, getTestPrisma, disconnectTestPrisma } from './utils/db-setup'
import { seedAdmin, seedBuilding, seedResident, seedUnit } from './utils/fixtures'

describe('Intercom multi-station (e2e)', () => {
  let app: TestingModule
  let calls: IntercomCallService
  let buildingId: number
  let residentId: number

  const STATION_A_UUID = '11111111-aaaa-4aaa-8aaa-111111111111'
  const STATION_B_UUID = '22222222-bbbb-4bbb-8bbb-222222222222'
  const STATION_OFF_UUID = '33333333-cccc-4ccc-8ccc-333333333333'
  let stationAId = 0
  let stationBId = 0

  /** INSERT stacji raw SQL (spójnie z resztą kodu building_intercoms). */
  async function insertStation(opts: {
    name: string
    edgeDeviceId: string | null
    bridgeEnabled: boolean
  }): Promise<number> {
    const prisma = getTestPrisma()
    const rows = await prisma.$queryRaw<{ id: number }[]>`
      INSERT INTO building_intercoms
        ("buildingId", name, model, "edgeDeviceId", "bridgeEnabled", "createdAt", "updatedAt")
      VALUES (${buildingId}, ${opts.name}, 'R29', ${opts.edgeDeviceId}, ${opts.bridgeEnabled}, NOW(), NOW())
      RETURNING id
    `
    return rows[0].id
  }

  beforeAll(async () => {
    process.env.INTERCOM_CALL_ENABLED = 'true'
    await resetDatabase()
    app = await Test.createTestingModule({ imports: [AppModule] }).compile()
    calls = app.get(IntercomCallService)

    const prisma = getTestPrisma()
    const admin = await seedAdmin(prisma)
    const building = await seedBuilding(prisma, admin.id)
    buildingId = building.id
    const unit = await seedUnit(prisma, buildingId, '4')
    const resident = await seedResident(prisma, buildingId)
    residentId = resident.id
    await prisma.unitResident.create({
      data: {
        unitId: unit.id,
        residentId,
        role: 'OWNER',
        sinceDate: new Date('2024-01-01T00:00:00Z'),
      },
    })
  }, 30_000)

  afterAll(async () => {
    delete process.env.INTERCOM_CALL_ENABLED
    await app?.close()
    await disconnectTestPrisma()
  })

  beforeEach(async () => {
    // Sesje z poprzednich testów aktywowałyby busy-guard — czyścimy.
    await getTestPrisma().intercomCallSession.deleteMany({})
    await getTestPrisma().$executeRaw`DELETE FROM building_intercoms WHERE "buildingId" = ${buildingId}`
  })

  describe('listStations', () => {
    it('zwraca tylko stacje z bridgeEnabled=true i edgeDeviceId', async () => {
      stationAId = await insertStation({ name: 'Wejście główne', edgeDeviceId: STATION_A_UUID, bridgeEnabled: true })
      stationBId = await insertStation({ name: 'Brama wschodnia', edgeDeviceId: STATION_B_UUID, bridgeEnabled: true })
      await insertStation({ name: 'Klatka B (bez mostu)', edgeDeviceId: STATION_OFF_UUID, bridgeEnabled: false })
      await insertStation({ name: 'Bez urządzenia', edgeDeviceId: null, bridgeEnabled: true })

      const stations = await calls.listStations(buildingId)
      expect(stations).toHaveLength(2)
      expect(stations.map((s) => s.name)).toEqual(['Wejście główne', 'Brama wschodnia'])
      expect(stations[0]).toEqual({ id: stationAId, name: 'Wejście główne', edgeDeviceId: STATION_A_UUID })
    })
  })

  describe('callStation (outbound)', () => {
    it('0 stacji → 400', async () => {
      await expect(calls.callStation(residentId, buildingId)).rejects.toMatchObject({
        status: 400,
      })
    })

    it('1 stacja bez intercomId → dzwoni do niej (backward-compat)', async () => {
      stationAId = await insertStation({ name: 'Wjazd', edgeDeviceId: STATION_A_UUID, bridgeEnabled: true })
      const res = await calls.callStation(residentId, buildingId)
      expect(res.intercomName).toBe('Wjazd')
      expect(res.intercomId).toBe(stationAId)

      const session = await getTestPrisma().intercomCallSession.findUnique({ where: { id: res.sessionId } })
      expect(session).toBeTruthy()
      expect(session!.intercomDeviceId).toBe(STATION_A_UUID)
      expect(session!.intercomName).toBe('Wjazd')
      expect(session!.state).toBe('ACTIVE')
      expect((session!.meta as any).intercomId).toBe(stationAId)
    })

    it('>1 stacji bez intercomId → 400 STATION_CHOICE_REQUIRED z listą', async () => {
      stationAId = await insertStation({ name: 'Wejście główne', edgeDeviceId: STATION_A_UUID, bridgeEnabled: true })
      stationBId = await insertStation({ name: 'Brama wschodnia', edgeDeviceId: STATION_B_UUID, bridgeEnabled: true })

      let caught: any
      await calls.callStation(residentId, buildingId).catch((err) => { caught = err })
      expect(caught).toBeTruthy()
      expect(caught.getStatus()).toBe(400)
      const body = caught.getResponse()
      expect(body.code).toBe('STATION_CHOICE_REQUIRED')
      expect(body.stations).toEqual([
        { id: stationAId, name: 'Wejście główne' },
        { id: stationBId, name: 'Brama wschodnia' },
      ])
    })

    it('>1 stacji z intercomId → sesja z WYBRANĄ stacją', async () => {
      stationAId = await insertStation({ name: 'Wejście główne', edgeDeviceId: STATION_A_UUID, bridgeEnabled: true })
      stationBId = await insertStation({ name: 'Brama wschodnia', edgeDeviceId: STATION_B_UUID, bridgeEnabled: true })

      const res = await calls.callStation(residentId, buildingId, stationBId)
      expect(res.intercomName).toBe('Brama wschodnia')

      const session = await getTestPrisma().intercomCallSession.findUnique({ where: { id: res.sessionId } })
      expect(session!.intercomDeviceId).toBe(STATION_B_UUID)
      expect(session!.intercomName).toBe('Brama wschodnia')
      expect((session!.meta as any).intercomId).toBe(stationBId)
    })

    it('zły / nie-bridge intercomId → 400 STATION_NOT_FOUND', async () => {
      stationAId = await insertStation({ name: 'Wjazd', edgeDeviceId: STATION_A_UUID, bridgeEnabled: true })
      const offId = await insertStation({ name: 'Bez mostu', edgeDeviceId: STATION_OFF_UUID, bridgeEnabled: false })

      let caught: any
      await calls.callStation(residentId, buildingId, offId).catch((err) => { caught = err })
      expect(caught.getStatus()).toBe(400)
      expect(caught.getResponse().code).toBe('STATION_NOT_FOUND')
    })

    it('busy-guard: aktywna sesja w budynku → 409 STATION_BUSY', async () => {
      stationAId = await insertStation({ name: 'Wejście główne', edgeDeviceId: STATION_A_UUID, bridgeEnabled: true })
      stationBId = await insertStation({ name: 'Brama wschodnia', edgeDeviceId: STATION_B_UUID, bridgeEnabled: true })

      // Trwa rozmowa z stacji A (incoming ACTIVE)...
      await getTestPrisma().intercomCallSession.create({
        data: {
          id: 'busy-session-1',
          buildingId,
          intercomDeviceId: STATION_A_UUID,
          intercomName: 'Wejście główne',
          state: 'ACTIVE',
          answeredById: residentId,
        },
      })

      // ...mieszkaniec próbuje zadzwonić do stacji B → 409 (most = 1 rozmowa).
      let caught: any
      await calls.callStation(residentId, buildingId, stationBId).catch((err) => { caught = err })
      expect(caught).toBeTruthy()
      expect(caught.getStatus()).toBe(409)
      expect(caught.getResponse().code).toBe('STATION_BUSY')
    })

    it('busy-guard NIE blokuje po zakończeniu sesji', async () => {
      stationAId = await insertStation({ name: 'Wjazd', edgeDeviceId: STATION_A_UUID, bridgeEnabled: true })
      await getTestPrisma().intercomCallSession.create({
        data: {
          id: 'ended-session-1',
          buildingId,
          intercomDeviceId: STATION_A_UUID,
          state: 'ENDED',
          endedAt: new Date(),
        },
      })
      const res = await calls.callStation(residentId, buildingId)
      expect(res.sessionId).toBeTruthy()
    })
  })

  describe('handleInvite (incoming)', () => {
    it('UUID stacji → sesja niesie nazwę TEJ stacji + residenci budynku', async () => {
      stationAId = await insertStation({ name: 'Wejście główne', edgeDeviceId: STATION_A_UUID, bridgeEnabled: true })
      stationBId = await insertStation({ name: 'Brama wschodnia', edgeDeviceId: STATION_B_UUID, bridgeEnabled: true })

      const sessionId = 'invite-station-b-1'
      await calls.handleInvite(buildingId, {
        sessionId,
        intercomDeviceId: STATION_B_UUID,
        residentIds: [],
      })

      const session = await getTestPrisma().intercomCallSession.findUnique({ where: { id: sessionId } })
      expect(session).toBeTruthy()
      expect(session!.state).toBe('RINGING')
      // Nazwa stacji B (nie A!) — iOS pokaże ją w CallKit (intercomName w push).
      expect(session!.intercomName).toBe('Brama wschodnia')
      expect((session!.meta as any).routedVia).toBe('building-intercom-units')
      expect((session!.meta as any).residentCount).toBe(1)
    })

    it('nazwa z Edge (INTERCOM_SYNC_ALL mirror) ma pierwszeństwo', async () => {
      stationAId = await insertStation({ name: 'Wejście główne', edgeDeviceId: STATION_A_UUID, bridgeEnabled: true })
      const sessionId = 'invite-edge-name-1'
      await calls.handleInvite(buildingId, {
        sessionId,
        intercomDeviceId: STATION_A_UUID,
        intercomName: 'Wejście główne',
        residentIds: [],
      })
      const session = await getTestPrisma().intercomCallSession.findUnique({ where: { id: sessionId } })
      expect(session!.intercomName).toBe('Wejście główne')
    })

    it('stacja z bridgeEnabled=false → MISSED (nikt nie wołany)', async () => {
      await insertStation({ name: 'Klatka B', edgeDeviceId: STATION_OFF_UUID, bridgeEnabled: false })

      const sessionId = 'invite-bridge-off-1'
      await calls.handleInvite(buildingId, {
        sessionId,
        intercomDeviceId: STATION_OFF_UUID,
        residentIds: [],
      })

      const session = await getTestPrisma().intercomCallSession.findUnique({ where: { id: sessionId } })
      expect(session!.state).toBe('MISSED')
      expect(session!.endReason).toBe('NO_DEVICE')
    })

    it('legacy fromUri (nie-UUID) → fallback-building gdy most aktywny', async () => {
      stationAId = await insertStation({ name: 'Wjazd', edgeDeviceId: STATION_A_UUID, bridgeEnabled: true })

      const sessionId = 'invite-legacy-uri-1'
      await calls.handleInvite(buildingId, {
        sessionId,
        // Stary Edge wysyła SIP URI zamiast UUID — routing spada na fallback.
        intercomDeviceId: 'sip:192.168.1.100@192.168.1.100:5060',
        residentIds: [],
      })

      const session = await getTestPrisma().intercomCallSession.findUnique({ where: { id: sessionId } })
      expect(session!.state).toBe('RINGING')
      expect((session!.meta as any).routedVia).toBe('fallback-building')
      expect((session!.meta as any).residentCount).toBe(1)
    })

    it('2 sesje z 2 stacji nie nadpisują się (intercomId per sesja)', async () => {
      stationAId = await insertStation({ name: 'Wejście główne', edgeDeviceId: STATION_A_UUID, bridgeEnabled: true })
      stationBId = await insertStation({ name: 'Brama wschodnia', edgeDeviceId: STATION_B_UUID, bridgeEnabled: true })

      await calls.handleInvite(buildingId, { sessionId: 'parallel-a', intercomDeviceId: STATION_A_UUID, residentIds: [] })
      await calls.handleInvite(buildingId, { sessionId: 'parallel-b', intercomDeviceId: STATION_B_UUID, residentIds: [] })

      const a = await getTestPrisma().intercomCallSession.findUnique({ where: { id: 'parallel-a' } })
      const b = await getTestPrisma().intercomCallSession.findUnique({ where: { id: 'parallel-b' } })
      expect(a!.intercomName).toBe('Wejście główne')
      expect(a!.intercomDeviceId).toBe(STATION_A_UUID)
      expect(b!.intercomName).toBe('Brama wschodnia')
      expect(b!.intercomDeviceId).toBe(STATION_B_UUID)
    })
  })
})
