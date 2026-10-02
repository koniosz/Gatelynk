/**
 * EdgeService.syncAccessPoints — wejścia tworzone z configu przekaźników Edge.
 *
 * Incydent VN 27.09: zmiana numeru przekaźnika domofonu na Edge (0 → 1)
 * utworzyła drugi, WIDOCZNY „Wjazd"/„Wyjazd" — mieszkańcy mieli duplikaty
 * w górnym pasku apki. Nowy przekaźnik urządzenia, które ma już wejście,
 * powstaje teraz ukryty; wejście ukryte przez admina nie wraca po syncu.
 *
 * Edge to lokalny serwer HTTP na 127.0.0.1:4000 (`GET /devices`) — sync
 * pyta zawsze `http://<ip>:4000/devices`.
 */
import { createServer, Server } from 'http'
import { Test, TestingModule } from '@nestjs/testing'
import { AppModule } from '../src/app.module'
import { EdgeService } from '../src/edge/edge.service'
import { resetDatabase, getTestPrisma, disconnectTestPrisma } from './utils/db-setup'
import { seedAdmin, seedBuilding } from './utils/fixtures'

type FakeDevice = { deviceId: string; type: string; config: Record<string, unknown> }

describe('EdgeService.syncAccessPoints (e2e)', () => {
  let app: TestingModule
  let edge: EdgeService
  let server: Server
  let devices: FakeDevice[] = []
  let buildingId: number
  let edgeDeviceId: string

  const intercom = (deviceId: string, name: string, relays: number[]): FakeDevice => ({
    deviceId,
    type: 'INTERCOM',
    config: { name, relays: relays.map((index) => ({ index, name })) },
  })

  const apsOf = (deviceId: string) =>
    getTestPrisma().accessPoint.findMany({
      where: { buildingId, deviceId },
      orderBy: { relayIndex: 'asc' },
      select: { id: true, relayIndex: true, isActive: true },
    })

  beforeAll(async () => {
    await resetDatabase()
    server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(req.url === '/devices' ? devices : []))
    })
    await new Promise<void>((resolve) => server.listen(4000, '127.0.0.1', resolve))

    app = await Test.createTestingModule({ imports: [AppModule] }).compile()
    edge = app.get(EdgeService)

    const prisma = getTestPrisma()
    const admin = await seedAdmin(prisma)
    buildingId = (await seedBuilding(prisma, admin.id)).id
    edgeDeviceId = (await prisma.edgeDevice.create({
      data: { buildingId, type: 'EDGE', name: 'Test Edge', isActivated: true, activatedAt: new Date() },
    })).id
  }, 30_000)

  afterAll(async () => {
    await app?.close()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    await disconnectTestPrisma()
  })

  it('nowe urządzenie dostaje widoczne wejścia (także wiele przekaźników)', async () => {
    devices = [intercom('dev-new', 'Brama', [0, 1])]
    await edge.syncAccessPoints(edgeDeviceId, buildingId, '127.0.0.1')

    expect(await apsOf('dev-new')).toEqual([
      expect.objectContaining({ relayIndex: 0, isActive: true }),
      expect.objectContaining({ relayIndex: 1, isActive: true }),
    ])
  })

  it('zmiana numeru przekaźnika na Edge tworzy ukryte wejście, stare zostaje widoczne', async () => {
    devices = [intercom('dev-entry', 'Wjazd', [0])]
    await edge.syncAccessPoints(edgeDeviceId, buildingId, '127.0.0.1')

    devices = [intercom('dev-entry', 'Wjazd', [1])]
    await edge.syncAccessPoints(edgeDeviceId, buildingId, '127.0.0.1')

    expect(await apsOf('dev-entry')).toEqual([
      expect.objectContaining({ relayIndex: 0, isActive: true }),
      expect.objectContaining({ relayIndex: 1, isActive: false }),
    ])
  })

  it('wejście ukryte przez admina nie wraca po kolejnym syncu', async () => {
    devices = [intercom('dev-hidden', 'Wyjazd', [0])]
    await edge.syncAccessPoints(edgeDeviceId, buildingId, '127.0.0.1')
    const [ap] = await apsOf('dev-hidden')
    await getTestPrisma().accessPoint.update({ where: { id: ap.id }, data: { isActive: false } })

    await edge.syncAccessPoints(edgeDeviceId, buildingId, '127.0.0.1')

    expect(await apsOf('dev-hidden')).toEqual([
      expect.objectContaining({ relayIndex: 0, isActive: false }),
    ])
  })

  it('wejście włączone przez admina zostaje włączone po kolejnym syncu', async () => {
    const [, hidden] = await apsOf('dev-entry')
    await getTestPrisma().accessPoint.update({ where: { id: hidden.id }, data: { isActive: true } })

    await edge.syncAccessPoints(edgeDeviceId, buildingId, '127.0.0.1')

    expect((await apsOf('dev-entry')).every((ap) => ap.isActive)).toBe(true)
  })
})
