/**
 * 2026-09-07 — pojazd przypisany do LOKALU (obok / zamiast mieszkańca).
 *
 * Krytyczna ścieżka administratora:
 *   • POST pojazdu RESIDENT z samym `unitId` (bez mieszkańca) → 201, w odpowiedzi
 *     `unit.label` (format common/unit-label.ts) i `residentId = null`.
 *   • POST bez mieszkańca I bez lokalu → 400 (RESIDENT wymaga jednego z dwóch).
 *   • PATCH odpinający lokal (`unitId: null`) przy braku mieszkańca → 400,
 *     a z jednoczesnym wskazaniem mieszkańca → 200 i `unit = null`.
 *   • Lokal z innego budynku → 404 (tenant guard po `buildingId`).
 *   • Lista pojazdów niesie `unit` dla wpisu z lokalem.
 */
import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { resetDatabase, getTestPrisma, disconnectTestPrisma } from './utils/db-setup'
import { seedFullBuilding, seedAdmin, seedBuilding, seedUnit, TEST_PASSWORD } from './utils/fixtures'

describe('Vehicle ↔ unit assignment (e2e)', () => {
  let app: INestApplication
  let baToken: string
  let buildingId: number
  let unitId: number
  let residentId: number
  let foreignUnitId: number

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
    unitId = ctx.unit.id
    residentId = ctx.resident.id

    // Drugi budynek innego integratora — lokal spoza tenant-a.
    const otherAdmin = await seedAdmin(prisma)
    const otherBuilding = await seedBuilding(prisma, otherAdmin.id)
    const foreignUnit = await seedUnit(prisma, otherBuilding.id, '99Z')
    foreignUnitId = foreignUnit.id

    const baLogin = await request(app.getHttpServer())
      .post('/api/building-admin/auth/login')
      .send({ email: ctx.ba.email, password: TEST_PASSWORD })
    baToken = baLogin.body.access_token
    expect(baToken).toBeTruthy()
  }, 30_000)

  afterAll(async () => {
    await app?.close()
    await disconnectTestPrisma()
  })

  const base = () => `/api/building-admin/buildings/${buildingId}/vehicles`

  it('POST RESIDENT z samym lokalem → 201 + unit.label, bez mieszkańca', async () => {
    const res = await request(app.getHttpServer())
      .post(base())
      .set('Authorization', `Bearer ${baToken}`)
      .send({ kind: 'RESIDENT', unitId, make: 'Skoda', color: 'szary', licensePlate: 'WU10001' })
    expect(res.status).toBe(201)
    expect(res.body.residentId).toBeNull()
    expect(res.body.unitId).toBe(unitId)
    expect(res.body.unit).toEqual(expect.objectContaining({ id: unitId, number: '1A', label: '1A' }))
  })

  it('POST RESIDENT bez mieszkańca i bez lokalu → 400', async () => {
    const res = await request(app.getHttpServer())
      .post(base())
      .set('Authorization', `Bearer ${baToken}`)
      .send({ kind: 'RESIDENT', make: 'Skoda', color: 'szary', licensePlate: 'WU10002' })
    expect(res.status).toBe(400)
  })

  it('POST z lokalem innego budynku → 404', async () => {
    const res = await request(app.getHttpServer())
      .post(base())
      .set('Authorization', `Bearer ${baToken}`)
      .send({ kind: 'RESIDENT', unitId: foreignUnitId, make: 'Skoda', color: 'szary', licensePlate: 'WU10003' })
    expect(res.status).toBe(404)
  })

  it('PATCH: odpięcie lokalu bez mieszkańca → 400; z mieszkańcem → 200 i unit=null', async () => {
    const create = await request(app.getHttpServer())
      .post(base())
      .set('Authorization', `Bearer ${baToken}`)
      .send({ kind: 'RESIDENT', unitId, make: 'Fiat', color: 'biały', licensePlate: 'WU10004' })
    expect(create.status).toBe(201)
    const vehicleId = create.body.id

    const bad = await request(app.getHttpServer())
      .patch(`${base()}/${vehicleId}`)
      .set('Authorization', `Bearer ${baToken}`)
      .send({ unitId: null })
    expect(bad.status).toBe(400)

    const ok = await request(app.getHttpServer())
      .patch(`${base()}/${vehicleId}`)
      .set('Authorization', `Bearer ${baToken}`)
      .send({ unitId: null, residentId })
    expect(ok.status).toBe(200)
    expect(ok.body.unit).toBeNull()
    expect(ok.body.residentId).toBe(residentId)
  })

  it('PATCH: mieszkaniec + lokal jednocześnie → oba zapisane', async () => {
    const create = await request(app.getHttpServer())
      .post(base())
      .set('Authorization', `Bearer ${baToken}`)
      .send({ kind: 'RESIDENT', residentId, make: 'Kia', color: 'czerwony', licensePlate: 'WU10005' })
    expect(create.status).toBe(201)
    expect(create.body.unit).toBeNull()

    const res = await request(app.getHttpServer())
      .patch(`${base()}/${create.body.id}`)
      .set('Authorization', `Bearer ${baToken}`)
      .send({ unitId })
    expect(res.status).toBe(200)
    expect(res.body.residentId).toBe(residentId)
    expect(res.body.unit?.label).toBe('1A')
  })

  it('GET lista pojazdów niesie unit dla wpisów z lokalem', async () => {
    const res = await request(app.getHttpServer())
      .get(base())
      .set('Authorization', `Bearer ${baToken}`)
    expect(res.status).toBe(200)
    const withUnit = (res.body as any[]).filter((v) => v.licensePlate === 'WU10001')
    expect(withUnit).toHaveLength(1)
    expect(withUnit[0].unit?.label).toBe('1A')
  })
})
