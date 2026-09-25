/**
 * 2026-09-25 — przełącznik „otwieraj bramę po rozpoznaniu tablicy" (vehicles.autoOpen).
 *
 * Chroni:
 *   • nowy pojazd ma autoOpen=true (zachowanie dotychczasowe),
 *   • PATCH /resident/vehicles/:id { autoOpen:false } → 200, pole w odpowiedzi i w liście,
 *   • zmiana idzie do Edge PEŁNYM wpisem PLATE_UPSERT (autoOpen + kind + unitLabel) —
 *     wcześniej ścieżka „kosmetyczna" słała `{plate, owner}` i kasowała metadane na Edge,
 *   • PATCH z wartością nie-boolean → 400,
 *   • cudzy pojazd → 404,
 *   • pojazd PENDING: ustawienie zapisuje się, ale NIE ma syncu do Edge (nie był w allowliście).
 */
import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { resetDatabase, getTestPrisma, disconnectTestPrisma } from './utils/db-setup'
import { seedFullBuilding, TEST_PASSWORD } from './utils/fixtures'

describe('Vehicle autoOpen switch (e2e)', () => {
  let app: INestApplication
  let prisma: ReturnType<typeof getTestPrisma>
  let buildingId: number
  let edgeDeviceId: string
  let baToken: string
  let residentToken: string
  let otherResidentToken: string
  let vehicleId: number

  const login = async (path: string, email: string) => {
    const res = await request(app.getHttpServer()).post(path).send({ email, password: TEST_PASSWORD })
    expect(res.body.access_token).toBeTruthy()
    return res.body.access_token as string
  }

  const outboxUpserts = async (plate: string) => {
    const rows = await prisma.edgeSyncOutboxEntry.findMany({
      where: { edgeDeviceId, action: 'PLATE_UPSERT' },
      orderBy: { createdAt: 'asc' },
    })
    return rows.map((r) => r.payload as any).filter((p) => p?.plate === plate)
  }

  /** `sendToBuilding` kolejkuje do outboxa asynchronicznie (fire-and-forget) —
   *  czekamy aż pojawi się oczekiwana liczba wpisów (max ~3 s). */
  const waitForUpserts = async (plate: string, count: number) => {
    for (let i = 0; i < 30; i++) {
      const rows = await outboxUpserts(plate)
      if (rows.length >= count) return rows
      await new Promise((r) => setTimeout(r, 100))
    }
    return outboxUpserts(plate)
  }

  beforeAll(async () => {
    await resetDatabase()
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    await app.init()

    prisma = getTestPrisma()
    const ctx = await seedFullBuilding(prisma)
    buildingId = ctx.building.id
    // Aktywowany Edge — bez niego outbox nic nie kolejkuje (enqueueForBuilding).
    const edge = await prisma.edgeDevice.create({
      data: { buildingId, isActivated: true, activatedAt: new Date(), name: 'e2e-edge' },
    })
    edgeDeviceId = edge.id
    const other = await seedFullBuilding(prisma)

    baToken = await login('/api/building-admin/auth/login', ctx.ba.email)
    residentToken = await login('/api/resident/auth/login', ctx.resident.email)
    otherResidentToken = await login('/api/resident/auth/login', other.resident.email)
  }, 30_000)

  afterAll(async () => {
    await app?.close()
    await disconnectTestPrisma()
  })

  it('nowy pojazd: autoOpen=true; po zatwierdzeniu Edge dostaje autoOpen=true', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/resident/vehicles')
      .set('Authorization', `Bearer ${residentToken}`)
      .send({ make: 'BMW', model: 'X7', color: 'czarny', licensePlate: 'WE387YT' })
    expect(created.status).toBe(201)
    expect(created.body.autoOpen).toBe(true)
    vehicleId = created.body.id

    const approved = await request(app.getHttpServer())
      .patch(`/api/building-admin/buildings/${buildingId}/vehicles/${vehicleId}/status`)
      .set('Authorization', `Bearer ${baToken}`)
      .send({ action: 'approve' })
    expect(approved.status).toBe(200)

    const upserts = await waitForUpserts('WE387YT', 1)
    expect(upserts.length).toBeGreaterThanOrEqual(1)
    expect(upserts[upserts.length - 1]).toEqual(expect.objectContaining({ autoOpen: true, kind: 'RESIDENT' }))
  })

  it('PATCH autoOpen=false → 200, w liście, do Edge PEŁNY wpis z autoOpen=false', async () => {
    const before = (await outboxUpserts('WE387YT')).length
    const res = await request(app.getHttpServer())
      .patch(`/api/resident/vehicles/${vehicleId}`)
      .set('Authorization', `Bearer ${residentToken}`)
      .send({ autoOpen: false })
    expect(res.status).toBe(200)
    expect(res.body.autoOpen).toBe(false)
    // Kosmetyka nie cofa pojazdu do PENDING.
    expect(res.body.status).toBe('APPROVED')

    const list = await request(app.getHttpServer())
      .get('/api/resident/vehicles')
      .set('Authorization', `Bearer ${residentToken}`)
    expect(list.body.find((v: any) => v.id === vehicleId)?.autoOpen).toBe(false)

    const upserts = await waitForUpserts('WE387YT', before + 1)
    expect(upserts.length).toBe(before + 1)
    const last = upserts[upserts.length - 1]
    expect(last.autoOpen).toBe(false)
    // Pełny wpis — Edge robi INSERT OR REPLACE, częściowy payload kasowałby metadane.
    expect(last.kind).toBe('RESIDENT')
    expect(last.unitLabel).toBeTruthy()
    expect(Array.isArray(last.tags)).toBe(true)
  })

  it('PATCH autoOpen=true → Edge dostaje autoOpen=true', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/resident/vehicles/${vehicleId}`)
      .set('Authorization', `Bearer ${residentToken}`)
      .send({ autoOpen: true })
    expect(res.status).toBe(200)
    expect(res.body.autoOpen).toBe(true)
    const upserts = await waitForUpserts('WE387YT', 3)
    expect(upserts[upserts.length - 1].autoOpen).toBe(true)
  })

  it('PATCH autoOpen nie-boolean → 400, wartość bez zmian', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/resident/vehicles/${vehicleId}`)
      .set('Authorization', `Bearer ${residentToken}`)
      .send({ autoOpen: 'nie' })
    expect(res.status).toBe(400)
    const list = await request(app.getHttpServer())
      .get('/api/resident/vehicles')
      .set('Authorization', `Bearer ${residentToken}`)
    expect(list.body.find((v: any) => v.id === vehicleId)?.autoOpen).toBe(true)
  })

  it('cudzy pojazd → 404', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/resident/vehicles/${vehicleId}`)
      .set('Authorization', `Bearer ${otherResidentToken}`)
      .send({ autoOpen: false })
    expect(res.status).toBe(404)
  })

  it('pojazd PENDING: ustawienie zapisane, bez syncu do Edge', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/resident/vehicles')
      .set('Authorization', `Bearer ${residentToken}`)
      .send({ make: 'Skoda', color: 'szary', licensePlate: 'WE100PD' })
    expect(created.status).toBe(201)
    const res = await request(app.getHttpServer())
      .patch(`/api/resident/vehicles/${created.body.id}`)
      .set('Authorization', `Bearer ${residentToken}`)
      .send({ autoOpen: false })
    expect(res.status).toBe(200)
    expect(res.body.autoOpen).toBe(false)
    expect(res.body.status).toBe('PENDING')
    await new Promise((r) => setTimeout(r, 300))
    expect(await outboxUpserts('WE100PD')).toHaveLength(0)
  })
})
