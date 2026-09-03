/**
 * Faza 7.4 — Vehicle approval flow e2e (Faza 1 regression).
 *
 * Critical path: resident → POST vehicle → status PENDING → admin → PATCH
 * approve → status APPROVED. Sprawdzamy że:
 *   • Resident POST forsuje status='PENDING' (nawet gdy resident próbuje go
 *     ustawić na APPROVED w body — backend odrzuca).
 *   • Admin może approve/reject/block.
 *   • Reject wymaga `reason` (BadRequest gdy brak).
 *   • Po approve, resident widzi APPROVED.
 *   • Outbox (Faza 7.6) zapisuje row PLATE_UPSERT przy approve.
 */
import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { resetDatabase, getTestPrisma, disconnectTestPrisma } from './utils/db-setup'
import { seedFullBuilding, TEST_PASSWORD } from './utils/fixtures'

describe('Vehicle approval flow (e2e)', () => {
  let app: INestApplication
  let baToken: string
  let residentToken: string
  let buildingId: number

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

    const baLogin = await request(app.getHttpServer())
      .post('/api/building-admin/auth/login')
      .send({ email: ctx.ba.email, password: TEST_PASSWORD })
    baToken = baLogin.body.access_token

    const residentLogin = await request(app.getHttpServer())
      .post('/api/resident/auth/login')
      .send({ email: ctx.resident.email, password: TEST_PASSWORD })
    residentToken = residentLogin.body.access_token
    expect(residentToken).toBeTruthy()
  }, 30_000)

  afterAll(async () => {
    await app?.close()
    await disconnectTestPrisma()
  })

  it('Resident POST vehicle → status PENDING (nie ufamy body status)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/resident/vehicles')
      .set('Authorization', `Bearer ${residentToken}`)
      .send({
        make: 'Tesla', model: 'Model 3', color: 'biały',
        licensePlate: 'WAR99001', kind: 'RESIDENT',
        status: 'APPROVED', // próba bypass — resident NIE może
      })
    expect(res.status).toBe(201)
    expect(res.body.status).toBe('PENDING')
  })

  it('Admin PATCH approve → status APPROVED + outbox PLATE_UPSERT', async () => {
    // POST nowego pojazdu jako resident.
    const create = await request(app.getHttpServer())
      .post('/api/resident/vehicles')
      .set('Authorization', `Bearer ${residentToken}`)
      .send({ make: 'BMW', color: 'czarny', licensePlate: 'WAR99002', kind: 'RESIDENT' })
    const vehicleId = create.body.id

    // PATCH approve jako admin.
    const approve = await request(app.getHttpServer())
      .patch(`/api/building-admin/buildings/${buildingId}/vehicles/${vehicleId}/status`)
      .set('Authorization', `Bearer ${baToken}`)
      .send({ action: 'approve' })
    expect(approve.status).toBe(200)
    expect(approve.body.status).toBe('APPROVED')
    expect(approve.body.approvedAt).toBeTruthy()

    // Outbox row PLATE_UPSERT — sprawdzamy że Faza 7.6 zapisała intencję.
    // Edge może być offline w testach — to OK, row wciąż musi być w bazie.
    const prisma = getTestPrisma()
    const outboxRows = await prisma.edgeSyncOutboxEntry.findMany({
      where: { buildingId, action: 'PLATE_UPSERT' },
    })
    const matchingPlate = outboxRows.find(
      (r) => (r.payload as any)?.plate === 'WAR99002',
    )
    expect(matchingPlate).toBeTruthy()
  })

  it('Admin PATCH reject bez reason → 400', async () => {
    const create = await request(app.getHttpServer())
      .post('/api/resident/vehicles')
      .set('Authorization', `Bearer ${residentToken}`)
      .send({ make: 'Audi', color: 'srebrny', licensePlate: 'WAR99003', kind: 'RESIDENT' })
    const vehicleId = create.body.id

    const reject = await request(app.getHttpServer())
      .patch(`/api/building-admin/buildings/${buildingId}/vehicles/${vehicleId}/status`)
      .set('Authorization', `Bearer ${baToken}`)
      .send({ action: 'reject' }) // brak reason
    expect(reject.status).toBe(400)
    expect(String(reject.body.message ?? '')).toMatch(/reason|powod|powód/i)
  })

  it('Admin PATCH reject z reason → REJECTED + rejectionReason', async () => {
    const create = await request(app.getHttpServer())
      .post('/api/resident/vehicles')
      .set('Authorization', `Bearer ${residentToken}`)
      .send({ make: 'Skoda', color: 'czerwony', licensePlate: 'WAR99004', kind: 'RESIDENT' })
    const vehicleId = create.body.id

    const reject = await request(app.getHttpServer())
      .patch(`/api/building-admin/buildings/${buildingId}/vehicles/${vehicleId}/status`)
      .set('Authorization', `Bearer ${baToken}`)
      .send({ action: 'reject', reason: 'Pojazd nie należy do mieszkańca' })
    expect(reject.status).toBe(200)
    expect(reject.body.status).toBe('REJECTED')
    expect(reject.body.rejectionReason).toBe('Pojazd nie należy do mieszkańca')
  })

  it('Resident GET widzi APPROVED pojazd po cyklu approve', async () => {
    const list = await request(app.getHttpServer())
      .get('/api/resident/vehicles')
      .set('Authorization', `Bearer ${residentToken}`)
    expect(list.status).toBe(200)
    const approved = (list.body as any[]).filter((v) => v.status === 'APPROVED')
    expect(approved.length).toBeGreaterThan(0)
  })
})
