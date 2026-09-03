/**
 * Faza 7.4 — Vehicle duplicate-guard regression test.
 *
 * Powiązany bug: Faza 4 (2026-05-06) — UI LprViewer POST-ował zamiast
 * PATCH-ować przy edycji literówki w marce → tworzył duplikat z tą samą
 * tablicą. Fix był 3-warstwowy (UI PATCH + backend guard + DB unique
 * w Fazie 7.5). Ten test pokrywa **warstwę backend** — sprawdza że POST
 * z duplikatem tablicy zwraca 400, nawet jeśli UI ominie PATCH.
 */
import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { resetDatabase, getTestPrisma, disconnectTestPrisma } from './utils/db-setup'
import { seedFullBuilding, TEST_PASSWORD } from './utils/fixtures'

describe('Vehicle duplicate-guard (e2e)', () => {
  let app: INestApplication
  let baToken: string
  let buildingId: number
  let residentId: number

  beforeAll(async () => {
    await resetDatabase()

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()
    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    await app.init()

    const prisma = getTestPrisma()
    const ctx = await seedFullBuilding(prisma)
    buildingId = ctx.building.id
    residentId = ctx.resident.id

    // Login BA — używamy w testach do POST/PATCH vehicles.
    const loginRes = await request(app.getHttpServer())
      .post('/api/building-admin/auth/login')
      .send({ email: ctx.ba.email, password: TEST_PASSWORD })
    baToken = loginRes.body.access_token
  }, 30_000)

  afterAll(async () => {
    await app?.close()
    await disconnectTestPrisma()
  })

  it('POST same plate twice → drugie wywołanie zwraca 400', async () => {
    const plate = 'TEST123'
    const body = {
      residentId,
      kind: 'RESIDENT',
      make: 'Tesla',
      model: 'Model 3',
      color: 'biały',
      licensePlate: plate,
    }

    // Pierwszy POST — powinien się udać.
    const first = await request(app.getHttpServer())
      .post(`/api/building-admin/buildings/${buildingId}/vehicles`)
      .set('Authorization', `Bearer ${baToken}`)
      .send(body)
    expect(first.status).toBe(201)
    expect(first.body.licensePlate).toBe(plate)

    // Drugi POST z tą samą tablicą — backend duplicate-guard powinien
    // zwrócić 400 z czytelnym message.
    const second = await request(app.getHttpServer())
      .post(`/api/building-admin/buildings/${buildingId}/vehicles`)
      .set('Authorization', `Bearer ${baToken}`)
      .send({ ...body, make: 'Tesla', color: 'czarny' }) // inna marka — bug case
    expect(second.status).toBe(400)
    expect(String(second.body.message ?? '')).toMatch(/zarejestrowana/i)
  })

  it('PATCH istniejącego pojazdu (zmiana literówki) — nie tworzy duplikatu', async () => {
    // Tworzymy z literówką w marce, jak w prawdziwym scenariuszu user-a.
    const plate = 'EDIT9999'
    const create = await request(app.getHttpServer())
      .post(`/api/building-admin/buildings/${buildingId}/vehicles`)
      .set('Authorization', `Bearer ${baToken}`)
      .send({
        residentId, kind: 'RESIDENT',
        make: 'Rangę Rover', // literówka
        color: 'czarny',
        licensePlate: plate,
      })
    expect(create.status).toBe(201)
    const vehicleId = create.body.id

    // PATCH — naprawiamy literówkę. Powinien zaktualizować, NIE utworzyć drugi wpis.
    const patch = await request(app.getHttpServer())
      .patch(`/api/building-admin/buildings/${buildingId}/vehicles/${vehicleId}`)
      .set('Authorization', `Bearer ${baToken}`)
      .send({ make: 'Range Rover' })
    expect(patch.status).toBe(200)
    expect(patch.body.make).toBe('Range Rover')

    // GET listy — powinno być dokładnie 1 wpis dla tej tablicy.
    const list = await request(app.getHttpServer())
      .get(`/api/building-admin/buildings/${buildingId}/vehicles`)
      .set('Authorization', `Bearer ${baToken}`)
    const matching = list.body.filter((v: any) => v.licensePlate === plate)
    expect(matching).toHaveLength(1)
    expect(matching[0].make).toBe('Range Rover')
  })

  it('DB-level unique constraint (Faza 7.5) — odrzuca raw INSERT', async () => {
    // Bezpośredni INSERT przez Prismę z dupes — DB unique index powinien crashować.
    // To weryfikuje że Faza 7.5 migracja faktycznie aplikuje ochronę.
    const prisma = getTestPrisma()
    const plate = 'DBLEVEL123'
    await prisma.vehicle.create({
      data: { buildingId, kind: 'RESIDENT', make: 'A', color: 'a', licensePlate: plate },
    })
    await expect(
      prisma.vehicle.create({
        data: { buildingId, kind: 'RESIDENT', make: 'B', color: 'b', licensePlate: plate },
      }),
    ).rejects.toThrow(/Unique constraint|duplicate key/i)
  })
})
