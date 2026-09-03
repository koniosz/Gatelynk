/**
 * Faza 7.4 — Multi-tenant isolation regression.
 *
 * Concierge JWT zawiera `buildingId` — wszystkie endpointy w
 * `concierge.service.ts` używają tego z `req.user.buildingId` zamiast brać
 * z params. Ten test pilnuje że konsjerż z budynku A NIE widzi/edytuje
 * obiektów z budynku B (klasyczny IDOR — Insecure Direct Object Reference).
 *
 * BA pokrywamy podobnie, ale BA może mieć multi-building access przez
 * `BuildingAdminAssignment` — sprawdzamy że BA przypisany TYLKO do A nie
 * widzi B.
 */
import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { resetDatabase, getTestPrisma, disconnectTestPrisma } from './utils/db-setup'
import {
  seedAdmin, seedBuilding, seedBuildingAdmin, seedConcierge, seedResident,
  TEST_PASSWORD,
} from './utils/fixtures'

describe('Multi-tenant isolation (e2e)', () => {
  let app: INestApplication
  let buildingA: { id: number }
  let buildingB: { id: number }
  let conciergeA_token: string
  let baA_token: string
  let vehicleB_id: number

  beforeAll(async () => {
    await resetDatabase()
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()
    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    await app.init()

    const prisma = getTestPrisma()
    const admin = await seedAdmin(prisma)
    buildingA = await seedBuilding(prisma, admin.id, { name: 'Building A' })
    buildingB = await seedBuilding(prisma, admin.id, { name: 'Building B' })

    // Concierge i BA tylko dla A.
    const conciergeA = await seedConcierge(prisma, admin.id, buildingA.id)
    const baA = await seedBuildingAdmin(prisma, admin.id, buildingA.id)

    // Resident + vehicle w B (do testu czy A widzi).
    const residentB = await seedResident(prisma, buildingB.id)
    const vehicleB = await prisma.vehicle.create({
      data: {
        buildingId: buildingB.id,
        residentId: residentB.id,
        kind: 'RESIDENT',
        make: 'Toyota',
        color: 'biały',
        licensePlate: 'BLD-B-12345',
        status: 'APPROVED',
      },
    })
    vehicleB_id = vehicleB.id

    // Login concierge A.
    const cLogin = await request(app.getHttpServer())
      .post('/api/concierge/auth/login')
      .send({ email: conciergeA.email, password: TEST_PASSWORD })
    conciergeA_token = cLogin.body.access_token
    expect(conciergeA_token).toBeTruthy()

    // Login BA A.
    const baLogin = await request(app.getHttpServer())
      .post('/api/building-admin/auth/login')
      .send({ email: baA.email, password: TEST_PASSWORD })
    baA_token = baLogin.body.access_token
    expect(baA_token).toBeTruthy()
  }, 30_000)

  afterAll(async () => {
    await app?.close()
    await disconnectTestPrisma()
  })

  it('Concierge A: GET /vehicles widzi tylko vehicles z budynku A', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/concierge/building/vehicles')
      .set('Authorization', `Bearer ${conciergeA_token}`)
    expect(res.status).toBe(200)
    const plates = (res.body as any[]).map((v) => v.licensePlate)
    expect(plates).not.toContain('BLD-B-12345')
  })

  it('Concierge A: PATCH cudzego vehicle (z B) → 404', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/concierge/building/vehicles/${vehicleB_id}`)
      .set('Authorization', `Bearer ${conciergeA_token}`)
      .send({ make: 'Hijacked' })
    expect(res.status).toBe(404)
  })

  it('Concierge A: DELETE cudzego vehicle (z B) → 404', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/api/concierge/building/vehicles/${vehicleB_id}`)
      .set('Authorization', `Bearer ${conciergeA_token}`)
    expect(res.status).toBe(404)
  })

  it('BA A: GET vehicles z budynku B → 403 (guardBuilding)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/building-admin/buildings/${buildingB.id}/vehicles`)
      .set('Authorization', `Bearer ${baA_token}`)
    expect([403, 404]).toContain(res.status) // 403 lub 404 — oba są poprawnym blokowaniem
  })

  it('Concierge A: GET tickets nie zwraca ticket-ów z budynku B', async () => {
    const prisma = getTestPrisma()
    const residentB = await prisma.resident.findFirst({
      where: { buildingId: buildingB.id },
    })
    if (!residentB) throw new Error('residentB missing in seed')

    // Tworzymy ticket w B przez raw SQL (Faza 4 — ticket.type wymaga raw insert).
    await prisma.$executeRaw`
      INSERT INTO "tickets"
        ("buildingId", "residentId", "category", "type", "title", "body", "status", "updatedAt")
      VALUES (
        ${buildingB.id}, ${residentB.id}, 'OTHER'::"TicketCategory",
        'CONCIERGE', 'Sekret z B', 'Nie powinieneś tego widzieć',
        'OPEN'::"TicketStatus", NOW()
      )
    `
    const res = await request(app.getHttpServer())
      .get('/api/concierge/building/tickets')
      .set('Authorization', `Bearer ${conciergeA_token}`)
    expect(res.status).toBe(200)
    const titles = (res.body as any[]).map((t) => t.title)
    expect(titles).not.toContain('Sekret z B')
  })
})
