/**
 * 2026-10-08 — karta „Najnowsze na osiedlu" (GET /resident/assistant/estate-today).
 *
 * Chroni:
 *   • ogłoszenie = najnowsze od ADMINISTRACJI (senderBaId) z ostatniego tygodnia;
 *     przypomnienie o zaległości i ogłoszenia starsze niż 7 dni nie są „aktualne",
 *   • przejazdy MOICH aut dziś: kilka odczytów jednego przejazdu liczy się raz,
 *     cudze auta i wczorajsze przejazdy się nie liczą,
 *   • mieszkaniec bez pojazdu → myVehicles = null (wiersz ukryty w apce),
 *   • Edge nieosiągalny → estate = null, odbiór odpadów pusty (bez 5xx).
 */
import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { ARREARS_REMINDER_TITLE } from '../src/building-admin/building-admin.service'
import { countPasses } from '../src/resident/daily-brief.service'
import { resetDatabase, getTestPrisma, disconnectTestPrisma } from './utils/db-setup'
import { seedFullBuilding, TEST_PASSWORD } from './utils/fixtures'

describe('Estate today card (e2e)', () => {
  let app: INestApplication
  let prisma: ReturnType<typeof getTestPrisma>
  let residentToken: string
  let otherResidentToken: string

  const login = async (email: string) => {
    const res = await request(app.getHttpServer())
      .post('/api/resident/auth/login')
      .send({ email, password: TEST_PASSWORD })
    expect(res.body.access_token).toBeTruthy()
    return res.body.access_token as string
  }

  const get = (token: string) =>
    request(app.getHttpServer())
      .get('/api/resident/assistant/estate-today')
      .set('Authorization', `Bearer ${token}`)

  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)

  beforeAll(async () => {
    await resetDatabase()
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    await app.init()

    prisma = getTestPrisma()
    const ctx = await seedFullBuilding(prisma)
    const buildingId = ctx.building.id
    const residentId = ctx.resident.id

    // Drugi mieszkaniec TEGO SAMEGO budynku — bez pojazdu.
    const other = await prisma.resident.create({
      data: {
        buildingId,
        firstName: 'Ola',
        lastName: 'Bezauta',
        email: `ola-${Date.now()}@test.local`,
        passwordHash: (await prisma.resident.findUniqueOrThrow({ where: { id: residentId } })).passwordHash,
      },
    })

    const mine = await prisma.vehicle.create({
      data: { buildingId, residentId, licensePlate: 'WX1111A', make: 'Skoda', color: 'biały', status: 'APPROVED' },
    })
    const foreign = await prisma.vehicle.create({
      data: { buildingId, residentId: other.id, licensePlate: 'WX2222B', make: 'Kia', color: 'czarny', status: 'APPROVED' },
    })
    // Pojazd Oli nie liczy się jej jako „mój" w teście braku pojazdu — usuwamy
    // go po dodaniu przejazdu (przejazd zostaje z vehicleId=NULL przez SetNull).

    const ev = (vehicleId: number, direction: string, ts: Date) =>
      prisma.$executeRaw`
        INSERT INTO access_events ("buildingId", ts, type, direction, "gateOpened", "vehicleId", plate)
        VALUES (${buildingId}, ${ts}, 'LPR_MATCH', ${direction}, true, ${vehicleId}, 'X')
      `
    // Dzisiejszy wjazd: dwa odczyty jednego przejazdu (30 s) → 1 wjazd.
    // Wyjazd 10 min później. Przejazdy tworzymy blisko „teraz", żeby test
    // nie zależał od godziny uruchomienia (północ czasu osiedla).
    await ev(mine.id, 'IN', minutesAgo(12))
    await ev(mine.id, 'IN', new Date(minutesAgo(12).getTime() + 30_000))
    await ev(mine.id, 'OUT', minutesAgo(2))
    // Wczorajszy przejazd i cudzy pojazd — nie liczą się.
    await ev(mine.id, 'IN', new Date(Date.now() - 30 * 3600_000))
    await ev(foreign.id, 'IN', minutesAgo(5))
    await prisma.vehicle.delete({ where: { id: foreign.id } })

    const note = (title: string, sentAt: Date, senderBaId: number | null, rid: number | null) =>
      prisma.$executeRaw`
        INSERT INTO notifications ("buildingId", "residentId", title, body, "sentAt", "senderBaId")
        VALUES (${buildingId}, ${rid}, ${title}, 'Treść', ${sentAt}, ${senderBaId})
      `
    await note('Stare ogłoszenie', new Date(Date.now() - 8 * 24 * 3600_000), ctx.ba.id, residentId)
    await note('Awaria szlabanu wjazdowego', minutesAgo(90), ctx.ba.id, residentId)
    // Nowsze, ale to nie są ogłoszenia administracji:
    await note(ARREARS_REMINDER_TITLE, minutesAgo(30), ctx.ba.id, residentId)
    await note('Paczka czeka w recepcji', minutesAgo(20), null, residentId)

    residentToken = await login(ctx.resident.email)
    otherResidentToken = await login(other.email)
  }, 30_000)

  afterAll(async () => {
    await app?.close()
    await disconnectTestPrisma()
  })

  it('pokazuje aktualne ogłoszenie administracji, nie przypomnienie ani paczkę', async () => {
    const res = await get(residentToken).expect(200)
    expect(res.body.announcement).toMatchObject({ title: 'Awaria szlabanu wjazdowego', body: 'Treść' })
  })

  it('liczy dzisiejsze przejazdy moich aut (jeden przejazd = jeden wjazd)', async () => {
    const res = await get(residentToken).expect(200)
    expect(res.body.myVehicles).toMatchObject({ vehicles: 1, entries: 1, exits: 1 })
    expect(res.body.myVehicles.lastAt).toBeTruthy()
  })

  it('mieszkaniec bez pojazdu: myVehicles = null', async () => {
    const res = await get(otherResidentToken).expect(200)
    expect(res.body.myVehicles).toBeNull()
  })

  it('bez Edge: estate = null i pusty harmonogram, zamiast błędu', async () => {
    const res = await get(residentToken).expect(200)
    expect(res.body.estate).toBeNull()
    expect(res.body.wastePickup).toEqual({ today: null, tomorrow: null })
  })

  it('countPasses: oba pokolenia kierunków i deduplikacja', () => {
    const t = (m: number) => new Date(Date.UTC(2026, 9, 8, 10, m))
    expect(
      countPasses([
        { ts: t(0), direction: 'forward' },
        { ts: t(1), direction: 'IN' }, // ten sam przejazd
        { ts: t(9), direction: 'reverse' },
        { ts: t(30), direction: 'IN' }, // nowy wjazd
        { ts: t(31), direction: null },
      ]),
    ).toMatchObject({ entries: 2, exits: 1 })
  })
})
