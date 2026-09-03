/**
 * Faza 7.6 — Edge outbox e2e testy.
 *
 * Pokrywają niezależnie od `vehicle-approval-flow.e2e-spec.ts`:
 *   • Replay przy reconnect: pending entries lecą do Edge gdy WS przychodzi online
 *   • Deadletter: po `OUTBOX_MAX_ATTEMPTS` (10) → `failedAt` ustawione
 *   • Cleanup: delivered > 30 dni są usuwane przez `cleanupOldDelivered`
 *
 * Bezpośredni unit test serwisu — bez prawdziwego WS, bo replay/deadletter
 * wymaga stricte sterowania kiedy ACK przychodzi. Symulujemy markAttempted
 * /markDelivered ręcznie żeby pokazać semantykę.
 */
import { Test, TestingModule } from '@nestjs/testing'
import { AppModule } from '../src/app.module'
import { EdgeOutboxService, OUTBOX_MAX_ATTEMPTS } from '../src/edge/edge-outbox.service'
import { resetDatabase, getTestPrisma, disconnectTestPrisma } from './utils/db-setup'
import { seedAdmin, seedBuilding } from './utils/fixtures'

describe('EdgeOutboxService (e2e)', () => {
  let app: TestingModule
  let outbox: EdgeOutboxService
  let buildingId: number
  let edgeDeviceId: string

  beforeAll(async () => {
    await resetDatabase()
    app = await Test.createTestingModule({ imports: [AppModule] }).compile()
    outbox = app.get(EdgeOutboxService)

    const prisma = getTestPrisma()
    const admin = await seedAdmin(prisma)
    const building = await seedBuilding(prisma, admin.id)
    buildingId = building.id

    // Tworzymy aktywowany Edge device — `enqueueForBuilding` go znajdzie.
    const edge = await prisma.edgeDevice.create({
      data: {
        buildingId,
        type: 'EDGE',
        name: 'Test Edge',
        isActivated: true,
        activatedAt: new Date(),
      },
    })
    edgeDeviceId = edge.id
  }, 30_000)

  afterAll(async () => {
    await app?.close()
    await disconnectTestPrisma()
  })

  describe('enqueue + markDelivered', () => {
    it('enqueueForDevice tworzy row z attempts=0', async () => {
      const id = await outbox.enqueueForDevice(buildingId, edgeDeviceId, 'PLATE_UPSERT', {
        plate: 'TEST-ENQ-1',
      })
      expect(id).toMatch(/^[A-Za-z0-9_-]{8}$/)

      const prisma = getTestPrisma()
      const row = await prisma.edgeSyncOutboxEntry.findUnique({ where: { id } })
      expect(row).toBeTruthy()
      expect(row!.action).toBe('PLATE_UPSERT')
      expect(row!.attempts).toBe(0)
      expect(row!.deliveredAt).toBeNull()
      expect((row!.payload as any).plate).toBe('TEST-ENQ-1')
    })

    it('markDelivered ustawia deliveredAt i wyciąga z pendingForDevice', async () => {
      const id = await outbox.enqueueForDevice(buildingId, edgeDeviceId, 'PIN_UPSERT', {
        pin: '999000',
      })

      // Sprawdź że na liście pending
      const before = await outbox.pendingForDevice(edgeDeviceId)
      expect(before.find((e) => e.id === id)).toBeTruthy()

      await outbox.markDelivered(id)

      const after = await outbox.pendingForDevice(edgeDeviceId)
      expect(after.find((e) => e.id === id)).toBeUndefined()

      const prisma = getTestPrisma()
      const row = await prisma.edgeSyncOutboxEntry.findUnique({ where: { id } })
      expect(row!.deliveredAt).toBeInstanceOf(Date)
    })

    it('markDelivered nieistniejącego id — silent (P2025)', async () => {
      // Legacy ACK z random-id nie powinien crashować servisu.
      await expect(outbox.markDelivered('NONEXIST')).resolves.toBeUndefined()
    })
  })

  describe('enqueueForBuilding', () => {
    it('tworzy 1 row PER aktywowany Edge w budynku', async () => {
      const prisma = getTestPrisma()
      // Drugi Edge w tym samym budynku — broadcast powinien trafić do obu.
      const edge2 = await prisma.edgeDevice.create({
        data: {
          buildingId, type: 'EDGE', name: 'Test Edge 2',
          isActivated: true, activatedAt: new Date(),
        },
      })
      // Trzeci Edge — nieaktywowany. NIE powinien dostać row-a.
      await prisma.edgeDevice.create({
        data: {
          buildingId, type: 'EDGE', name: 'Test Edge 3 (nieaktywowany)',
          isActivated: false,
        },
      })

      const result = await outbox.enqueueForBuilding(buildingId, 'PLATE_DELETE', {
        plate: 'TEST-BCAST',
      })
      expect(result).toHaveLength(2) // tylko aktywowane
      const deviceIds = result.map((r) => r.edgeDeviceId)
      expect(deviceIds).toContain(edgeDeviceId)
      expect(deviceIds).toContain(edge2.id)
    })
  })

  describe('Replay scenario (reconnect)', () => {
    it('pendingForDevice zwraca chronologicznie + respect limit', async () => {
      const prisma = getTestPrisma()
      // Wyczyść outbox dla edge-a żeby test był deterministyczny.
      await prisma.edgeSyncOutboxEntry.deleteMany({ where: { edgeDeviceId } })

      const ids: string[] = []
      for (let i = 0; i < 5; i++) {
        const id = await outbox.enqueueForDevice(
          buildingId, edgeDeviceId, 'PLATE_UPSERT',
          { plate: `REPLAY${i}` },
        )
        ids.push(id)
        // Sleep 1ms żeby createdAt różniło się — Postgres timestamp(3) ma
        // milisekundową precyzję.
        await new Promise((r) => setTimeout(r, 2))
      }

      const pending = await outbox.pendingForDevice(edgeDeviceId, 3)
      expect(pending).toHaveLength(3)
      // Chronologicznie — najstarsze pierwsze (replay w kolejności wysyłki).
      expect(pending[0].id).toBe(ids[0])
      expect(pending[1].id).toBe(ids[1])
      expect(pending[2].id).toBe(ids[2])
    })
  })

  describe('Deadletter (markAttempted)', () => {
    it('po OUTBOX_MAX_ATTEMPTS prób → failedAt + zwraca {failed: true}', async () => {
      const id = await outbox.enqueueForDevice(buildingId, edgeDeviceId, 'PLATE_UPSERT', {
        plate: 'DEAD-LETTER',
      })

      // Symulujemy 9 nieudanych prób — ciągle pending.
      for (let i = 0; i < OUTBOX_MAX_ATTEMPTS - 1; i++) {
        const r = await outbox.markAttempted(id, `attempt ${i + 1}`)
        expect(r.failed).toBe(false)
      }

      // 10-ta próba — deadletter.
      const final = await outbox.markAttempted(id, 'final fail')
      expect(final.failed).toBe(true)

      const prisma = getTestPrisma()
      const row = await prisma.edgeSyncOutboxEntry.findUnique({ where: { id } })
      expect(row!.attempts).toBe(OUTBOX_MAX_ATTEMPTS)
      expect(row!.failedAt).toBeInstanceOf(Date)
      expect(row!.lastError).toBe('final fail')
    })

    it('failed entry NIE pojawia się w pendingForDevice', async () => {
      const id = await outbox.enqueueForDevice(buildingId, edgeDeviceId, 'PLATE_UPSERT', {
        plate: 'FAILED-1',
      })
      // Wpychamy bezpośrednio failedAt — symulacja deadletter.
      const prisma = getTestPrisma()
      await prisma.edgeSyncOutboxEntry.update({
        where: { id },
        data: { failedAt: new Date() },
      })

      const pending = await outbox.pendingForDevice(edgeDeviceId)
      expect(pending.find((e) => e.id === id)).toBeUndefined()
    })

    it('statsForBuilding zlicza pending vs failed osobno', async () => {
      const prisma = getTestPrisma()
      // Wyczyść outbox + dodaj 3 pending + 2 failed.
      await prisma.edgeSyncOutboxEntry.deleteMany({ where: { edgeDeviceId } })

      for (let i = 0; i < 3; i++) {
        await outbox.enqueueForDevice(buildingId, edgeDeviceId, 'PLATE_UPSERT', { plate: `P${i}` })
      }
      for (let i = 0; i < 2; i++) {
        const id = await outbox.enqueueForDevice(buildingId, edgeDeviceId, 'PLATE_UPSERT', { plate: `F${i}` })
        await prisma.edgeSyncOutboxEntry.update({
          where: { id }, data: { failedAt: new Date() },
        })
      }

      const stats = await outbox.statsForBuilding(buildingId)
      const mine = stats.get(edgeDeviceId)
      expect(mine).toBeTruthy()
      expect(mine!.pending).toBe(3)
      expect(mine!.failed).toBe(2)
    })
  })

  describe('Cleanup cron', () => {
    it('cleanupOldDelivered usuwa delivered > 30 dni, zachowuje świeże + failed', async () => {
      const prisma = getTestPrisma()
      await prisma.edgeSyncOutboxEntry.deleteMany({ where: { edgeDeviceId } })

      const oldDelivered = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
      const recentDelivered = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)

      // 1) Stary delivered — kandydat do usunięcia.
      const oldId = await outbox.enqueueForDevice(buildingId, edgeDeviceId, 'PLATE_UPSERT', { x: 1 })
      await prisma.edgeSyncOutboxEntry.update({
        where: { id: oldId }, data: { deliveredAt: oldDelivered },
      })
      // 2) Świeży delivered — zostaje.
      const recentId = await outbox.enqueueForDevice(buildingId, edgeDeviceId, 'PLATE_UPSERT', { x: 2 })
      await prisma.edgeSyncOutboxEntry.update({
        where: { id: recentId }, data: { deliveredAt: recentDelivered },
      })
      // 3) Failed (stary, ale nie delivered) — zostaje (audit-log).
      const failedId = await outbox.enqueueForDevice(buildingId, edgeDeviceId, 'PLATE_UPSERT', { x: 3 })
      await prisma.edgeSyncOutboxEntry.update({
        where: { id: failedId },
        data: { failedAt: oldDelivered, attempts: OUTBOX_MAX_ATTEMPTS },
      })

      await outbox.cleanupOldDelivered()

      expect(await prisma.edgeSyncOutboxEntry.findUnique({ where: { id: oldId } })).toBeNull()
      expect(await prisma.edgeSyncOutboxEntry.findUnique({ where: { id: recentId } })).toBeTruthy()
      expect(await prisma.edgeSyncOutboxEntry.findUnique({ where: { id: failedId } })).toBeTruthy()
    })
  })
})
