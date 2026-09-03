/**
 * Unit testy cloud-local routingu ResidentAssistantService (8.h.32).
 *
 * Kluczowe kontrakty:
 *   • "Ilu mieszkańców ma to osiedle?" → residents_count (transkrypt 2026-07-05
 *     — wcześniej szło na Edge → unknown, bo regex wymagał "ile", nie "ilu")
 *   • "Ile wynosi czynsz dla mieszkańca?" → my_rent (naliczenie z PaymentCharge;
 *     fallback do składowych PaymentComponent; null gdy nieskonfigurowane)
 *   • Cloud-local NIE MOŻE połknąć pytań Edge-owych: "ile osób przeszło przez
 *     bramę" (kamery), "co mówi uchwała o czynszu" (KB) → null.
 *
 * PrismaService mockowany płytko — testujemy klasyfikację + kształt odpowiedzi.
 */
import { ResidentAssistantService } from './resident-assistant.service'

function buildPrismaMock(overrides: Record<string, unknown> = {}) {
  const base: any = {
    building: {
      findUnique: jest.fn().mockResolvedValue({ name: 'Villa Natura' }),
    },
    resident: { count: jest.fn().mockResolvedValue(7) },
    unit: { count: jest.fn().mockResolvedValue(13) },
    vehicle: { count: jest.fn().mockResolvedValue(68) },
    paymentCharge: { findUnique: jest.fn().mockResolvedValue(null) },
    paymentComponent: { findMany: jest.fn().mockResolvedValue([]) },
    paymentEntry: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  }
  return Object.assign(base, overrides)
}

describe('ResidentAssistantService — cloud-local routing (8.h.32)', () => {
  function make(prisma: any) {
    // ResidentService potrzebny tylko dla intentu invite_guest — testy
    // routingu go nie dotykają, wystarczy stub.
    return new ResidentAssistantService(prisma, { createGuest: jest.fn() } as any)
  }

  it('"Ilu mieszkańców ma to osiedle ?" → residents_count z liczbami z Postgresa', async () => {
    const svc = make(buildPrismaMock())
    const res = await svc.tryAnswerLocally('Ilu mieszkańców ma to osiedle ?', 9, 16)
    expect(res).not.toBeNull()
    expect(res!.intent).toBe('residents_count')
    expect(res!.answer).toContain('7 mieszkańców')
    expect(res!.answer).toContain('13 lokalach')
    expect(res!.answer).toContain('68 pojazdów')
  })

  it('"Ile osób mieszka na osiedlu?" → residents_count', async () => {
    const svc = make(buildPrismaMock())
    const res = await svc.tryAnswerLocally('Ile osób mieszka na osiedlu?', 9, 16)
    expect(res?.intent).toBe('residents_count')
  })

  it('"Ile osób dziś przeszło przez bramę?" NIE jest łapane (Edge count_objects)', async () => {
    const svc = make(buildPrismaMock())
    const res = await svc.tryAnswerLocally('Ile osób dziś przeszło przez bramę?', 9, 16)
    expect(res).toBeNull()
  })

  it('"Ile mieszkań ma osiedle?" dalej idzie w building_stats (regresja)', async () => {
    const prisma = buildPrismaMock()
    prisma.building.findUnique.mockResolvedValue({
      name: 'Villa Natura',
      numberOfFloors: null,
      numberOfHouses: 55,
    })
    const svc = make(prisma)
    const res = await svc.tryAnswerLocally('Ile mieszkań ma osiedle?', 9, 16)
    expect(res?.intent).toBe('building_stats')
  })

  it('"Ile wynosi czynsz dla mieszkańca ?" z naliczeniem → my_rent (suma, termin, składowe)', async () => {
    const prisma = buildPrismaMock({
      $queryRaw: jest
        .fn()
        .mockResolvedValue([{ unitId: 30, unitNumber: '4/2', areaSqm: null }]),
    })
    prisma.paymentCharge.findUnique.mockResolvedValue({
      id: 1,
      totalAmount: 642,
      dueDate: new Date('2026-07-10T00:00:00Z'),
      components: [
        { name: 'Fundusz remontowy', amount: 90 },
        { name: 'Koszty ochrony', amount: 200 },
      ],
    })
    const svc = make(prisma)
    const res = await svc.tryAnswerLocally('Ile wynosi czynsz dla mieszkańca ?', 9, 16)
    expect(res?.intent).toBe('my_rent')
    expect(res!.answer).toContain('642,00 zł')
    expect(res!.answer).toContain('Fundusz remontowy 90,00 zł')
    expect(res!.answer).toContain('lokal 4/2')
  })

  it('czynsz bez naliczenia, ale ze składowymi → "zarządca nie wygenerował" + składowe', async () => {
    const prisma = buildPrismaMock({
      $queryRaw: jest
        .fn()
        .mockResolvedValue([{ unitId: 30, unitNumber: '4/2', areaSqm: null }]),
    })
    prisma.paymentComponent.findMany.mockResolvedValue([
      { name: 'Fundusz remontowy', amount: 90, calcType: 'FIXED' },
      { name: 'Utrzymanie zieleni', amount: 46, calcType: 'FIXED' },
    ])
    const svc = make(prisma)
    const res = await svc.tryAnswerLocally('Jakie są opłaty?', 9, 16)
    expect(res?.intent).toBe('my_rent')
    expect(res!.answer).toContain('nie wygenerował jeszcze naliczenia')
    expect(res!.answer).toContain('razem ok. 136,00 zł')
  })

  it('czynsz przy braku konfiguracji płatności → null (fallback do Edge/KB)', async () => {
    const svc = make(buildPrismaMock())
    const res = await svc.tryAnswerLocally('Ile wynosi czynsz dla mieszkańca ?', 9, 16)
    expect(res).toBeNull()
  })

  it('"Co mówi uchwała o czynszu?" → null (KB na Edge, nie naliczenie)', async () => {
    const svc = make(buildPrismaMock())
    const res = await svc.tryAnswerLocally('Co mówi uchwała o czynszu?', 9, 16)
    expect(res).toBeNull()
  })
})
