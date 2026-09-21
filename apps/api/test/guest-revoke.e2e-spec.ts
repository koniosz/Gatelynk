/**
 * 2026-09-21 (audyt UX, P0 3.3) — cofnięcie dostępu gościa.
 *
 * Regresje, które chroni ten test:
 *   • cofnięcie JEDNEJ przepustki nie modyfikuje innej (status, PIN, terminy),
 *   • żywa przepustka → status CANCELLED + `revocation.edgeOnline` (klient nie
 *     może ogłaszać pełnego cofnięcia, gdy sterownik osiedla jest offline —
 *     w e2e Edge nie jest podłączony, więc `edgeOnline === false`),
 *   • ten sam endpoint na przepustce JUŻ cofniętej usuwa tylko wpis z historii
 *     (`deleted: true`) — dwie różne operacje, UI nazywa je osobno,
 *   • cudza przepustka → 404 (uprawnienia także przy bezpośrednim wywołaniu).
 */
import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { resetDatabase, getTestPrisma, disconnectTestPrisma } from './utils/db-setup'
import { seedFullBuilding, TEST_PASSWORD } from './utils/fixtures'

describe('Guest pass revoke (e2e)', () => {
  let app: INestApplication
  let tokenA: string
  let tokenB: string
  let guestKeepId: number
  let guestRevokeId: number

  const login = async (email: string) => {
    const res = await request(app.getHttpServer())
      .post('/api/resident/auth/login')
      .send({ email, password: TEST_PASSWORD })
    expect(res.body.access_token).toBeTruthy()
    return res.body.access_token as string
  }

  const createGuest = async (token: string, name: string) => {
    const now = Date.now()
    const res = await request(app.getHttpServer())
      .post('/api/resident/guests')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name,
        validFrom: new Date(now - 60_000).toISOString(),
        validTo: new Date(now + 4 * 3600_000).toISOString(),
      })
    expect(res.status).toBe(201)
    return res.body as { id: number; pin: string; status: string; validTo: string }
  }

  beforeAll(async () => {
    await resetDatabase()
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()
    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    await app.init()

    const prisma = getTestPrisma()
    const a = await seedFullBuilding(prisma)
    const b = await seedFullBuilding(prisma)
    tokenA = await login(a.resident.email)
    tokenB = await login(b.resident.email)
  }, 30_000)

  afterAll(async () => {
    await app?.close()
    await disconnectTestPrisma()
  })

  it('cofnięcie jednej przepustki nie zmienia drugiej', async () => {
    const keep = await createGuest(tokenA, 'Gość Zostaje')
    const revoke = await createGuest(tokenA, 'Gość Cofany')
    guestKeepId = keep.id
    guestRevokeId = revoke.id

    const res = await request(app.getHttpServer())
      .delete(`/api/resident/guests/${revoke.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('CANCELLED')
    expect(res.body.deleted).toBeUndefined()
    // Edge nie jest podłączony w e2e → API mówi to wprost.
    expect(res.body.revocation).toEqual({ edgeOnline: false })

    const list = await request(app.getHttpServer())
      .get('/api/resident/guests')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(list.status).toBe(200)
    const kept = list.body.find((g: any) => g.id === keep.id)
    const revoked = list.body.find((g: any) => g.id === revoke.id)
    expect(kept).toEqual(expect.objectContaining({ status: 'ACTIVE', pin: keep.pin, validTo: keep.validTo }))
    expect(revoked).toEqual(expect.objectContaining({ status: 'CANCELLED' }))
  })

  it('ten sam endpoint na cofniętej przepustce usuwa tylko wpis z historii', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/api/resident/guests/${guestRevokeId}`)
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.deleted).toBe(true)
    expect(res.body.revocation).toBeUndefined()

    const list = await request(app.getHttpServer())
      .get('/api/resident/guests')
      .set('Authorization', `Bearer ${tokenA}`)
    const ids = list.body.map((g: any) => g.id)
    expect(ids).toContain(guestKeepId)
    expect(ids).not.toContain(guestRevokeId)
  })

  it('cudza przepustka → 404, a przepustka właściciela zostaje aktywna', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/api/resident/guests/${guestKeepId}`)
      .set('Authorization', `Bearer ${tokenB}`)
    expect(res.status).toBe(404)

    const list = await request(app.getHttpServer())
      .get('/api/resident/guests')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(list.body.find((g: any) => g.id === guestKeepId)?.status).toBe('ACTIVE')
  })
})
