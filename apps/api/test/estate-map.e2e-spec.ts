/**
 * 2026-09-08 — mapa osiedla: przypisania miejsc na mapie do lokali.
 *
 * Scenariusze z wytycznych paczki „gatelynk-mapa-villa-natura":
 *   • odczyt bez mapy, zapis konfiguracji (walidacja), odtworzenie po
 *     ponownym pobraniu (persist),
 *   • przypisanie, zmiana (zastąpienie), przeniesienie, odpięcie,
 *   • część B dla budynku z 1 lokalem → 400; nieznany obszar → 404; lokal
 *     spoza osiedla → 404,
 *   • konflikt dwóch administratorów: równoległe żądania — dokładnie jeden
 *     sukces, drugi 409 (STALE / UNIT_ASSIGNED_ELSEWHERE),
 *   • UNIQUE w bazie jako backstop (bezpośredni INSERT duplikatu pada).
 */
import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { resetDatabase, getTestPrisma, disconnectTestPrisma } from './utils/db-setup'
import { seedFullBuilding, seedAdmin, seedBuilding, seedUnit, TEST_PASSWORD } from './utils/fixtures'

describe('Estate map assignments (e2e)', () => {
  let app: INestApplication
  let baToken: string
  let buildingId: number
  let unit1: number
  let unit2: number
  let unit3: number
  let foreignUnitId: number

  const cfg = {
    name: 'Osiedle testowe',
    imageUrl: '/estate-maps/villa-natura.jpg',
    canvas: { width: 1954, height: 805 },
    buildings: [
      { id: 'b1', label: 'Testowa 1', street: 'Testowa', number: '1', unitCount: 2, x: 100, y: 100, w: 50, h: 40, a: 0, slots: ['A', 'B'] },
      { id: 'b16', label: 'Budynek 16', street: '', number: '16', unitCount: 1, x: 200, y: 200, w: 50, h: 40, a: -29, slots: ['A'] },
    ],
    gates: [{ id: 'in', name: 'Brama wjazdowa', x: 0.8, y: 0.09 }],
    streets: [],
  }

  const base = () => `/api/building-admin/buildings/${buildingId}/estate-map`
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${baToken}`)
  const assign = (b: string, s: string, body: Record<string, unknown>) =>
    auth(request(app.getHttpServer()).put(`${base()}/slots/${b}/${s}`)).send(body)

  beforeAll(async () => {
    await resetDatabase()
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    await app.init()

    const prisma = getTestPrisma()
    const ctx = await seedFullBuilding(prisma)
    buildingId = ctx.building.id
    unit1 = ctx.unit.id
    unit2 = (await seedUnit(prisma, buildingId, '2A')).id
    unit3 = (await seedUnit(prisma, buildingId, '3A')).id

    const otherAdmin = await seedAdmin(prisma)
    const otherBuilding = await seedBuilding(prisma, otherAdmin.id)
    foreignUnitId = (await seedUnit(prisma, otherBuilding.id, '99Z')).id

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

  it('GET bez mapy → map=null, lista lokali osiedla', async () => {
    const res = await auth(request(app.getHttpServer()).get(base()))
    expect(res.status).toBe(200)
    expect(res.body.map).toBeNull()
    expect(res.body.assignments).toEqual([])
    expect(res.body.units.map((u: any) => u.id).sort()).toEqual([unit1, unit2, unit3].sort())
    expect(res.body.units.find((u: any) => u.id === unit1).label).toBe('1A')
  })

  it('PUT konfiguracji: walidacja (powtórzony id → 400), zapis → 200', async () => {
    const dupe = await auth(request(app.getHttpServer()).put(base())).send({
      ...cfg, buildings: [cfg.buildings[0], { ...cfg.buildings[1], id: 'b1' }],
    })
    expect(dupe.status).toBe(400)

    const ok = await auth(request(app.getHttpServer()).put(base())).send(cfg)
    expect(ok.status).toBe(200)
    expect(ok.body.map.buildings).toHaveLength(2)
    expect(ok.body.map.buildings[1].slots).toEqual(['A'])
  })

  it('przypisanie → 200, odtworzenie po ponownym GET (persist)', async () => {
    const res = await assign('b1', 'A', { unitId: unit1, expectedUnitId: null })
    expect(res.status).toBe(200)
    expect(res.body.assigned).toEqual(expect.objectContaining({ mapBuildingId: 'b1', slot: 'A', unitId: unit1, unitLabel: '1A' }))

    const again = await auth(request(app.getHttpServer()).get(base()))
    expect(again.body.assignments).toEqual([
      expect.objectContaining({ mapBuildingId: 'b1', slot: 'A', unitId: unit1, unitLabel: '1A' }),
    ])
  })

  it('ten sam lokal w innym miejscu: bez move → 409, z move → przeniesiony (stare miejsce puste)', async () => {
    const bad = await assign('b1', 'B', { unitId: unit1, expectedUnitId: null })
    expect(bad.status).toBe(409)
    expect(bad.body.code).toBe('UNIT_ASSIGNED_ELSEWHERE')

    const ok = await assign('b1', 'B', { unitId: unit1, expectedUnitId: null, move: true })
    expect(ok.status).toBe(200)
    expect(ok.body.released).toEqual([expect.objectContaining({ mapBuildingId: 'b1', slot: 'A', unitId: unit1 })])
    expect(ok.body.assignments).toEqual([expect.objectContaining({ mapBuildingId: 'b1', slot: 'B', unitId: unit1 })])
  })

  it('zajęte miejsce: bez replace → 409 SLOT_OCCUPIED, z replace → atomowa wymiana', async () => {
    const bad = await assign('b1', 'B', { unitId: unit2, expectedUnitId: unit1 })
    expect(bad.status).toBe(409)
    expect(bad.body.code).toBe('SLOT_OCCUPIED')

    const ok = await assign('b1', 'B', { unitId: unit2, expectedUnitId: unit1, replace: true })
    expect(ok.status).toBe(200)
    expect(ok.body.released).toEqual([expect.objectContaining({ unitId: unit1 })])
    const ids = ok.body.assignments.map((a: any) => a.unitId)
    expect(ids).toEqual([unit2])
  })

  it('kontrola optymistyczna: expectedUnitId niezgodny z bazą → 409 STALE', async () => {
    const res = await assign('b1', 'B', { unitId: unit3, expectedUnitId: null, replace: true })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('STALE')
    expect(res.body.currentUnitId).toBe(unit2)
  })

  it('część B dla budynku z 1 lokalem → 400; nieznany obszar → 404; lokal spoza osiedla → 404', async () => {
    expect((await assign('b16', 'B', { unitId: unit3 })).status).toBe(400)
    expect((await assign('nope', 'A', { unitId: unit3 })).status).toBe(404)
    expect((await assign('b16', 'A', { unitId: foreignUnitId })).status).toBe(404)
  })

  it('odpięcie: zły expectedUnitId → 409; poprawny → 200 i miejsce puste', async () => {
    const bad = await auth(request(app.getHttpServer()).delete(`${base()}/slots/b1/B`)).send({ expectedUnitId: unit3 })
    expect(bad.status).toBe(409)

    const ok = await auth(request(app.getHttpServer()).delete(`${base()}/slots/b1/B`)).send({ expectedUnitId: unit2 })
    expect(ok.status).toBe(200)
    expect(ok.body.removedUnitId).toBe(unit2)
    expect(ok.body.assignments).toEqual([])
  })

  it('dwóch administratorów naraz: ten sam lokal do dwóch miejsc → dokładnie 1 sukces + 1× 409', async () => {
    const [r1, r2] = await Promise.all([
      assign('b1', 'A', { unitId: unit3, expectedUnitId: null }),
      assign('b16', 'A', { unitId: unit3, expectedUnitId: null }),
    ])
    const statuses = [r1.status, r2.status].sort()
    expect(statuses).toEqual([200, 409])
    const conflict = r1.status === 409 ? r1 : r2
    expect(['UNIT_ASSIGNED_ELSEWHERE', 'RACE']).toContain(conflict.body.code)

    const state = await auth(request(app.getHttpServer()).get(base()))
    expect(state.body.assignments.filter((a: any) => a.unitId === unit3)).toHaveLength(1)
  })

  it('dwóch administratorów naraz: różne lokale do TEGO SAMEGO miejsca → 1 sukces + 1× 409', async () => {
    // Zwolnij b1/B i wyścig o nie.
    await auth(request(app.getHttpServer()).delete(`${base()}/slots/b1/B`)).send({})
    const [r1, r2] = await Promise.all([
      assign('b1', 'B', { unitId: unit1, expectedUnitId: null }),
      assign('b1', 'B', { unitId: unit2, expectedUnitId: null }),
    ])
    expect([r1.status, r2.status].sort()).toEqual([200, 409])
    const state = await auth(request(app.getHttpServer()).get(base()))
    expect(state.body.assignments.filter((a: any) => a.mapBuildingId === 'b1' && a.slot === 'B')).toHaveLength(1)
  })

  it('UNIQUE w bazie: bezpośredni duplikat lokalu w innym miejscu pada na constraint', async () => {
    const prisma = getTestPrisma()
    const existing = await prisma.estateMapSlot.findFirst({ where: { buildingId } })
    expect(existing).toBeTruthy()
    await expect(
      prisma.estateMapSlot.create({
        data: { buildingId, mapBuildingId: 'b16', slot: 'A', unitId: existing!.unitId },
      }),
    ).rejects.toMatchObject({ code: 'P2002' })
  })

  it('PUT nowej konfiguracji bez obszaru → przypisania do niego usunięte (jawnie raportowane)', async () => {
    const before = await auth(request(app.getHttpServer()).get(base()))
    const onB16 = before.body.assignments.filter((a: any) => a.mapBuildingId === 'b16').length
    const res = await auth(request(app.getHttpServer()).put(base())).send({ ...cfg, buildings: [cfg.buildings[0]] })
    expect(res.status).toBe(200)
    expect(res.body.removedAssignments).toBe(onB16)
    expect(res.body.assignments.every((a: any) => a.mapBuildingId === 'b1')).toBe(true)
  })
})
