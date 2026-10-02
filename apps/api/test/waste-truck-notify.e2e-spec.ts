/**
 * 2026-10-02 — powiadomienie o przyjeździe śmieciarki.
 *
 *   • domyślnie nikt nie dostaje (budynek wyłączony, mieszkaniec bez wyboru),
 *   • mieszkaniec włącza u siebie → jest odbiorcą; /resident/me pokazuje true,
 *   • administrator włącza dla wszystkich → odbiorcami są wszyscy, KTÓRZY
 *     nie wyłączyli u siebie (wybór mieszkańca ma pierwszeństwo),
 *   • cudzy budynek → 403/404 dla administratora, nie-boolean → 400.
 */
import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { resetDatabase, getTestPrisma, disconnectTestPrisma } from './utils/db-setup'
import { seedFullBuilding, seedResident, TEST_PASSWORD } from './utils/fixtures'
import { WasteTruckService } from '../src/waste-truck/waste-truck.service'

describe('Waste truck notify (e2e)', () => {
  let app: INestApplication
  let svc: WasteTruckService
  let buildingId: number
  let otherBuildingId: number
  let baToken: string
  let tokenA: string
  let tokenB: string
  let residentA: number
  let residentB: number

  const login = async (path: string, email: string) => {
    const res = await request(app.getHttpServer()).post(path).send({ email, password: TEST_PASSWORD })
    expect(res.body.access_token).toBeTruthy()
    return res.body.access_token as string
  }

  beforeAll(async () => {
    await resetDatabase()
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    await app.init()
    svc = app.get(WasteTruckService)

    const prisma = getTestPrisma()
    const ctx = await seedFullBuilding(prisma)
    buildingId = ctx.building.id
    residentA = ctx.resident.id
    const second = await seedResident(prisma, buildingId)
    residentB = second.id
    const other = await seedFullBuilding(prisma)
    otherBuildingId = other.building.id

    baToken = await login('/api/building-admin/auth/login', ctx.ba.email)
    tokenA = await login('/api/resident/auth/login', ctx.resident.email)
    tokenB = await login('/api/resident/auth/login', second.email)
  }, 30_000)

  afterAll(async () => {
    await app?.close()
    await disconnectTestPrisma()
  })

  it('domyślnie nikt nie jest odbiorcą', async () => {
    expect(await svc.recipients(buildingId)).toEqual([])
    const me = await request(app.getHttpServer()).get('/api/resident/me').set('Authorization', `Bearer ${tokenA}`)
    expect(me.body.notifyWasteTruck).toBe(false)
    const ba = await request(app.getHttpServer())
      .get(`/api/building-admin/buildings/${buildingId}/waste-truck-notify`)
      .set('Authorization', `Bearer ${baToken}`)
    expect(ba.status).toBe(200)
    expect(ba.body).toEqual(expect.objectContaining({ enabled: false, recipients: 0 }))
  })

  it('mieszkaniec włącza u siebie → tylko on jest odbiorcą', async () => {
    const res = await request(app.getHttpServer())
      .patch('/api/resident/profile/notify-waste-truck')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ enabled: true })
    expect(res.status).toBe(200)
    expect(await svc.recipients(buildingId)).toEqual([residentA])
    const me = await request(app.getHttpServer()).get('/api/resident/me').set('Authorization', `Bearer ${tokenA}`)
    expect(me.body.notifyWasteTruck).toBe(true)
  })

  it('administrator włącza dla wszystkich → wszyscy, poza tymi, którzy wyłączyli u siebie', async () => {
    const off = await request(app.getHttpServer())
      .patch('/api/resident/profile/notify-waste-truck')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ enabled: false })
    expect(off.status).toBe(200)

    const res = await request(app.getHttpServer())
      .patch(`/api/building-admin/buildings/${buildingId}/waste-truck-notify`)
      .set('Authorization', `Bearer ${baToken}`)
      .send({ enabled: true })
    expect(res.status).toBe(200)
    expect(res.body).toEqual(expect.objectContaining({ enabled: true, recipients: 1, optedOut: 1, optedIn: 1 }))
    expect(await svc.recipients(buildingId)).toEqual([residentA])

    // Mieszkaniec B zmienia zdanie — wybór mieszkańca nadal decyduje.
    await request(app.getHttpServer())
      .patch('/api/resident/profile/notify-waste-truck')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ enabled: true })
    expect((await svc.recipients(buildingId)).sort()).toEqual([residentA, residentB].sort())
  })

  it('walidacja i uprawnienia', async () => {
    const bad = await request(app.getHttpServer())
      .patch('/api/resident/profile/notify-waste-truck')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ enabled: 'tak' })
    expect(bad.status).toBe(400)
    const badBa = await request(app.getHttpServer())
      .patch(`/api/building-admin/buildings/${buildingId}/waste-truck-notify`)
      .set('Authorization', `Bearer ${baToken}`)
      .send({ enabled: 1 })
    expect(badBa.status).toBe(400)
    const foreign = await request(app.getHttpServer())
      .patch(`/api/building-admin/buildings/${otherBuildingId}/waste-truck-notify`)
      .set('Authorization', `Bearer ${baToken}`)
      .send({ enabled: true })
    expect([403, 404]).toContain(foreign.status)
  })

  it('stare zdarzenie (>30 min) i drugie w oknie 2 h nie wysyłają ponownie', async () => {
    expect(await svc.onArrival(buildingId, { ts: Date.now() - 45 * 60_000 })).toBe(0)
    expect(await svc.onArrival(buildingId, { ts: Date.now() })).toBe(2)
    expect(await svc.onArrival(buildingId, { ts: Date.now() })).toBe(0)
  })
})
