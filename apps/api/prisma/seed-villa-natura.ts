/**
 * Faza 6 — Demo seed Villa Natura.
 *
 * Idempotentny seed do reproducowania spójnego scenariusza demo. Po uruchomieniu:
 *   pnpm --filter @gatelynk/api db:seed:demo
 * w bazie powinno być:
 *   • 1 Admin (`admin@villanatura.demo`)
 *   • 1 BuildingAdmin (`ba@villanatura.demo`)
 *   • 1 Concierge (`concierge@villanatura.demo`)
 *   • 1 Building „Villa Natura" (Sopot, Bałtycka 12)
 *   • 1 stairwell + 3 lokale (15A, 15B, 15C)
 *   • 5 rezydentów (anna, marek, kasia, piotr, zofia @villanatura.demo)
 *   • 5 pojazdów (3 APPROVED, 2 PENDING)
 *   • 3 gości (1 ACTIVE z PIN-em, 1 future, 1 expired)
 *   • 5 access pointów (Wjazd LPR, Wyjazd LPR, Wejście, Brama poż., Furtka)
 *   • 2 EdgeDevice (1 aktywowane, 1 do aktywacji)
 *   • 2 BuildingIntercom (Akuvox) + 2 LprCamera (Hikvision)
 *   • 10 access events (mix LPR_MATCH/PIN_USED/REMOTE_OPEN/MANUAL_OPEN)
 *   • 3 ticket-y (1 ADMIN open, 1 ADMIN in-progress z reply, 1 CONCIERGE open)
 *   • PaymentConfig dla 3 lokali + kilka PaymentEntry per lokal
 *
 * Hasła wszystkich kont demo: `villa2024`. Bcrypt 10 rounds.
 *
 * Idempotentny przez `upsert` po unikalnych kluczach (email/name). Bez `--clean`
 * — żeby nie usunąć produkcyjnych danych przy pomyłce. Re-run aktualizuje
 * istniejące rekordy do stanu "świeży demo", ale nie kasuje innych.
 */
import { PrismaClient } from '@prisma/client'
import * as bcrypt from 'bcrypt'

// Standardowy PrismaClient (Rust query engine) — spójnie z `PrismaService`.
const prisma = new PrismaClient()

const DEMO_PASSWORD = 'villa2024'
const DOMAIN = '@villanatura.demo'

async function hashPwd() {
  return bcrypt.hash(DEMO_PASSWORD, 10)
}

async function seedAdminAndPlan(passwordHash: string) {
  // License key — żeby BA mogli logować się przez `/buildings/:id` flow.
  const plan = await prisma.licensePlan.findUnique({ where: { code: 'pro' } })
  if (!plan) throw new Error('LicensePlan "pro" nie istnieje — uruchom najpierw `pnpm db:seed`')

  const admin = await prisma.admin.upsert({
    where: { email: 'admin' + DOMAIN },
    update: { name: 'Demo Admin' },
    create: {
      email: 'admin' + DOMAIN,
      passwordHash,
      name: 'Demo Admin',
    },
  })
  return admin
}

async function seedBuilding(adminId: number) {
  // Building name nie jest unique — używamy combo (adminId, name) implicit.
  // findFirst + create/update żeby się nie zduplikować przy re-run.
  let building = await prisma.building.findFirst({
    where: { adminId, name: 'Villa Natura' },
  })
  const data = {
    adminId,
    name: 'Villa Natura',
    address: 'ul. Bałtycka 12, 81-755 Sopot',
    objectType: 'ESTATE',
    numberOfFloors: 3,
    numberOfHouses: 1,
    hasElevator: true,
    hasCctv: true,
    hasIntercom: true,
    intercomManufacturer: 'Akuvox',
    intercomModel: 'R29S',
    hasLprSystem: true,
    lprManufacturer: 'Hikvision',
    lprModel: 'iDS-TCM403',
    hasEdge: true,
    hasGym: true,
    hasSauna: true,
    entranceCount: 1,
    packageHandling: 'CONCIERGE',
  } as const
  if (building) {
    building = await prisma.building.update({ where: { id: building.id }, data })
  } else {
    building = await prisma.building.create({ data })
  }
  return building
}

async function seedBuildingAdmin(adminId: number, buildingId: number, passwordHash: string) {
  const ba = await prisma.buildingAdmin.upsert({
    where: { email: 'ba' + DOMAIN },
    update: { name: 'Anna Zielińska' },
    create: {
      adminId,
      email: 'ba' + DOMAIN,
      passwordHash,
      name: 'Anna Zielińska',
    },
  })
  // Assignment do budynku (composite PK).
  await prisma.buildingAdminAssignment.upsert({
    where: { buildingAdminId_buildingId: { buildingAdminId: ba.id, buildingId } },
    update: {},
    create: { buildingAdminId: ba.id, buildingId },
  })
  return ba
}

async function seedConcierge(adminId: number, buildingId: number, passwordHash: string) {
  return prisma.concierge.upsert({
    where: { email: 'concierge' + DOMAIN },
    update: { name: 'Marek Nowicki', buildingId },
    create: {
      adminId,
      buildingId,
      email: 'concierge' + DOMAIN,
      passwordHash,
      name: 'Marek Nowicki',
    },
  })
}

async function seedStairwellAndUnits(buildingId: number) {
  // Stairwell — name unikalna w obrębie budynku (nie ma constraint, ale dla
  // demo wystarczy jeden o stałej nazwie).
  let sw = await prisma.stairwell.findFirst({ where: { buildingId, name: 'Klatka A' } })
  if (!sw) sw = await prisma.stairwell.create({ data: { buildingId, name: 'Klatka A' } })

  const apartmentType = await prisma.unitType.findFirst({
    where: { isSystem: true, code: 'apartment' },
  })
  if (!apartmentType) throw new Error('UnitType "apartment" brak — `pnpm db:seed` najpierw')

  const numbers = ['15A', '15B', '15C'] as const
  const units: { id: number; number: string }[] = []
  for (const number of numbers) {
    const u = await prisma.unit.upsert({
      where: { buildingId_number: { buildingId, number } },
      update: { stairwellId: sw.id, unitTypeId: apartmentType.id },
      create: {
        buildingId,
        unitTypeId: apartmentType.id,
        stairwellId: sw.id,
        number,
        floor: numbers.indexOf(number) + 1,
        areaSqm: [62.5, 78.4, 91.2][numbers.indexOf(number)],
      },
    })
    units.push({ id: u.id, number: u.number })
  }
  return { stairwell: sw, units }
}

async function seedResidents(buildingId: number, passwordHash: string, units: { id: number }[]) {
  const people: { firstName: string; lastName: string; emailPrefix: string; unitIdx: number }[] = [
    { firstName: 'Anna',  lastName: 'Kowalska',     emailPrefix: 'anna',   unitIdx: 0 },
    { firstName: 'Marek', lastName: 'Wiśniewski',   emailPrefix: 'marek',  unitIdx: 0 }, // anna+marek razem 15A
    { firstName: 'Kasia', lastName: 'Lewandowska',  emailPrefix: 'kasia',  unitIdx: 1 },
    { firstName: 'Piotr', lastName: 'Wójcik',       emailPrefix: 'piotr',  unitIdx: 2 },
    { firstName: 'Zofia', lastName: 'Kamińska',     emailPrefix: 'zofia',  unitIdx: 2 }, // piotr+zofia 15C
  ]
  const residents: { id: number }[] = []
  for (const p of people) {
    const r = await prisma.resident.upsert({
      where: { buildingId_email: { buildingId, email: p.emailPrefix + DOMAIN } },
      update: { firstName: p.firstName, lastName: p.lastName, passwordHash },
      create: {
        buildingId,
        email: p.emailPrefix + DOMAIN,
        passwordHash,
        firstName: p.firstName,
        lastName: p.lastName,
        phone: `+48 600 ${100 + people.indexOf(p)} ${200 + people.indexOf(p) * 11}`,
      },
    })
    // Pivot UnitResident — bez @@unique nie da się upsert; sprawdzamy ręcznie.
    const exists = await prisma.unitResident.findFirst({
      where: { unitId: units[p.unitIdx].id, residentId: r.id, untilDate: null },
    })
    if (!exists) {
      await prisma.unitResident.create({
        data: {
          unitId: units[p.unitIdx].id,
          residentId: r.id,
          role: 'OWNER',
          sinceDate: new Date('2023-01-15T00:00:00Z'),
        },
      })
    }
    residents.push({ id: r.id })
  }
  return residents
}

async function seedVehicles(buildingId: number, residents: { id: number }[]) {
  // 3 APPROVED (anna, kasia, piotr) + 2 PENDING (marek, zofia).
  // Tablice celowo różne formaty (WX/GA/GD) żeby demo było realistyczne dla
  // Trójmiasta. Tags żeby pokazać TagPicker filtr.
  type V = {
    residentIdx: number; plate: string; make: string; model: string; color: string;
    status: 'APPROVED' | 'PENDING'; tags?: string[]; kind?: string;
  }
  const vehicles: V[] = [
    { residentIdx: 0, plate: 'GA12345',  make: 'Tesla',   model: 'Model 3', color: 'biały',     status: 'APPROVED', tags: ['rodzina'] },
    { residentIdx: 2, plate: 'GD99887',  make: 'Toyota',  model: 'RAV4',    color: 'czarny',    status: 'APPROVED', tags: ['rodzina'] },
    { residentIdx: 3, plate: 'WX55512',  make: 'BMW',     model: 'iX1',     color: 'srebrny',   status: 'APPROVED' },
    { residentIdx: 1, plate: 'GA77711',  make: 'Skoda',   model: 'Octavia', color: 'granatowy', status: 'PENDING' },
    { residentIdx: 4, plate: 'GD12399',  make: 'Mini',    model: 'Cooper',  color: 'czerwony',  status: 'PENDING' },
  ]
  for (const v of vehicles) {
    const plate = v.plate.toUpperCase()
    const existing = await prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM "vehicles"
       WHERE "buildingId" = ${buildingId} AND "licensePlate" = ${plate}
       LIMIT 1
    `
    if (existing[0]) continue // idempotent — nie nadpisujemy gdy już jest

    // Status enum + kind enum + tags array — raw SQL bo Prisma generate broken.
    await prisma.$executeRaw`
      INSERT INTO "vehicles"
        ("buildingId", "residentId", "kind", "make", "model", "color",
         "licensePlate", "status", "tags", "approvedAt")
      VALUES (
        ${buildingId},
        ${residents[v.residentIdx].id},
        'RESIDENT'::"VehicleKind",
        ${v.make}, ${v.model}, ${v.color},
        ${plate},
        ${v.status}::"VehicleStatus",
        ${v.tags ?? []}::text[],
        ${v.status === 'APPROVED' ? new Date() : null}
      )
    `
  }
}

async function seedAccessPoints(buildingId: number, edgeDeviceId: string) {
  // 5 punktów dostępu — odpowiadają realnemu setupowi Villa Natura
  // (1 brama z LPR wjazd/wyjazd, 1 wejście pieszo, 1 brama pożarowa, 1 furtka).
  // `deviceId` to UUID device-u jaki Edge zwraca w syncAccessPoints — tu
  // mockujemy 2 (intercom-A, intercom-fire); LPR generuje events bez relay-u.
  const aps: { label: string; icon: string; deviceId: string; relayIndex: number; sortOrder: number }[] = [
    { label: 'Wjazd LPR (główny)',     icon: 'barrier', deviceId: 'mock-intercom-a',    relayIndex: 0, sortOrder: 0 },
    { label: 'Wyjazd LPR',             icon: 'barrier', deviceId: 'mock-intercom-a',    relayIndex: 1, sortOrder: 1 },
    { label: 'Wejście pieszo',         icon: 'door',    deviceId: 'mock-intercom-a',    relayIndex: 2, sortOrder: 2 },
    { label: 'Furtka boczna',          icon: 'gate',    deviceId: 'mock-intercom-fire', relayIndex: 0, sortOrder: 3 },
    { label: 'Brama pożarowa',         icon: 'gate',    deviceId: 'mock-intercom-fire', relayIndex: 1, sortOrder: 4 },
  ]
  for (const ap of aps) {
    await prisma.accessPoint.upsert({
      where: {
        buildingId_deviceId_relayIndex: {
          buildingId, deviceId: ap.deviceId, relayIndex: ap.relayIndex,
        },
      },
      update: { label: ap.label, icon: ap.icon, sortOrder: ap.sortOrder, edgeDeviceId },
      create: {
        buildingId,
        deviceId: ap.deviceId,
        relayIndex: ap.relayIndex,
        label: ap.label,
        icon: ap.icon,
        sortOrder: ap.sortOrder,
        edgeDeviceId,
        isActive: true,
      },
    })
  }
}

async function seedDevices(buildingId: number) {
  // 2 EdgeDevice (1 aktywowany — ten do którego linkowane są access points,
  // 1 do aktywacji żeby zobaczyć badge „Nieaktywowany" w panelu).
  let edge1 = await prisma.edgeDevice.findFirst({
    where: { buildingId, name: 'Mac Mini Demo' },
  })
  if (!edge1) {
    edge1 = await prisma.edgeDevice.create({
      data: {
        buildingId,
        type: 'EDGE',
        name: 'Mac Mini Demo',
        isActivated: true,
        activatedAt: new Date('2024-09-15T10:00:00Z'),
        ipAddress: '192.168.1.127',
        version: '0.4.2-demo',
        lastSeenAt: new Date(),
      },
    })
  }
  let edge2 = await prisma.edgeDevice.findFirst({
    where: { buildingId, name: 'Edge AI (zapasowe)' },
  })
  if (!edge2) {
    edge2 = await prisma.edgeDevice.create({
      data: {
        buildingId,
        type: 'EDGE_AI',
        name: 'Edge AI (zapasowe)',
        isActivated: false,
        activationCode: 'VILLA-EDGE2-DEMO',
        activationCodeExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    })
  }

  // Intercom-y — Akuvox R29 wejściowy, Akuvox R29 brama pożarowa.
  // Raw SQL bo Prisma client nie zna `edgeDeviceId` (drift 5.22/7.5).
  for (const i of [
    { name: 'Akuvox R29 — wejście',     model: 'R29S', edgeId: edge1.id, ip: '192.168.1.20' },
    { name: 'Akuvox R29 — brama poż.',  model: 'R29S', edgeId: edge1.id, ip: '192.168.1.21' },
  ]) {
    const existing = await prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM "building_intercoms"
       WHERE "buildingId" = ${buildingId} AND "name" = ${i.name}
       LIMIT 1
    `
    if (!existing[0]) {
      await prisma.$executeRaw`
        INSERT INTO "building_intercoms" ("buildingId", "name", "model", "ipAddress", "edgeDeviceId", "updatedAt")
        VALUES (${buildingId}, ${i.name}, ${i.model}, ${i.ip}, ${i.edgeId}, NOW())
      `
    }
  }

  // 2 LPR camera (wjazd + wyjazd).
  for (const c of [
    { name: 'Hikvision wjazd',  model: 'iDS-TCM403-AI', edgeId: edge1.id, ip: '192.168.1.30' },
    { name: 'Hikvision wyjazd', model: 'iDS-TCM403-AI', edgeId: edge1.id, ip: '192.168.1.31' },
  ]) {
    const existing = await prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM "lpr_cameras"
       WHERE "buildingId" = ${buildingId} AND "name" = ${c.name}
       LIMIT 1
    `
    if (!existing[0]) {
      await prisma.$executeRaw`
        INSERT INTO "lpr_cameras"
          ("buildingId", "name", "manufacturer", "model", "ipAddress", "edgeDeviceId",
           "whitelistMode", "updatedAt")
        VALUES
          (${buildingId}, ${c.name}, 'Hikvision', ${c.model}, ${c.ip},
           ${c.edgeId}, 'edge', NOW())
      `
    }
  }

  return { edge1, edge2 }
}

async function seedGuests(buildingId: number, residents: { id: number }[]) {
  // 3 gości pokazujące 3 stany: ACTIVE w trakcie, future (jutro), expired (wczoraj).
  // PIN-y deterministyczne dla łatwości demo (123456 / 234567 / 345678).
  const now = new Date()
  const oneDay = 24 * 60 * 60 * 1000
  const guests: { name: string; pin: string; from: Date; to: Date; status: 'ACTIVE'|'EXPIRED'; residentIdx: number; plate?: string }[] = [
    {
      name: 'Janek Demo (active)', pin: '123456',
      from: new Date(now.getTime() - 30 * 60 * 1000),
      to: new Date(now.getTime() + 6 * 60 * 60 * 1000),
      status: 'ACTIVE', residentIdx: 0, plate: 'WI11111',
    },
    {
      name: 'Ola Demo (jutro)', pin: '234567',
      from: new Date(now.getTime() + oneDay),
      to: new Date(now.getTime() + 2 * oneDay),
      status: 'ACTIVE', residentIdx: 2,
    },
    {
      name: 'Tomek Demo (expired)', pin: '345678',
      from: new Date(now.getTime() - 3 * oneDay),
      to: new Date(now.getTime() - 2 * oneDay),
      status: 'EXPIRED', residentIdx: 3, plate: 'WI33333',
    },
  ]
  for (const g of guests) {
    // PIN unique per (buildingId, pin) — raw SQL bo Prisma client przez drift
    // (5.22/7.5) nie zna `guest` modelu. Idempotent: skip gdy już istnieje.
    const existing = await prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM "guests"
       WHERE "buildingId" = ${buildingId} AND "pin" = ${g.pin}
       LIMIT 1
    `
    if (existing[0]) continue
    await prisma.$executeRaw`
      INSERT INTO "guests"
        ("buildingId", "residentId", "name", "phone", "vehiclePlate", "pin",
         "validFrom", "validTo", "status", "urlToken")
      VALUES (
        ${buildingId},
        ${residents[g.residentIdx].id},
        ${g.name},
        NULL,
        ${g.plate ?? null},
        ${g.pin},
        ${g.from}, ${g.to},
        ${g.status}::"GuestStatus",
        ${'demo-' + g.pin + '-' + Math.random().toString(36).slice(2, 8)}
      )
    `
  }
}

async function seedTickets(buildingId: number, residents: { id: number }[], baId: number, conciergeId: number) {
  // 3 ticket-y: (1) ADMIN OPEN, (2) ADMIN IN_PROGRESS z reply admina,
  // (3) CONCIERGE OPEN „odebraliście paczkę?".
  type T = {
    residentIdx: number; type: 'ADMIN' | 'CONCIERGE'; category: string;
    title: string; body: string; status: 'OPEN' | 'IN_PROGRESS' | 'DONE';
    reply?: { authorType: 'ADMIN' | 'CONCIERGE'; authorId: number; body: string }
  }
  const tickets: T[] = [
    {
      residentIdx: 0, type: 'ADMIN', category: 'ISSUE',
      title: 'Cieknący kran w łazience',
      body: 'Od wczoraj cieknie kran w łazience głównej. Czy można umówić hydraulika?',
      status: 'OPEN',
    },
    {
      residentIdx: 2, type: 'ADMIN', category: 'QUESTION',
      title: 'Czy można karmić koty na klatce?',
      body: 'Sąsiadka karmi koty na podeście. Czy regulamin to dopuszcza?',
      status: 'IN_PROGRESS',
      reply: {
        authorType: 'ADMIN', authorId: baId,
        body: 'Zgodnie z regulaminem § 7 — nie można dokarmiać zwierząt w częściach wspólnych. Przekażę uwagę sąsiadce.',
      },
    },
    {
      residentIdx: 3, type: 'CONCIERGE', category: 'OTHER',
      title: 'Czy odebraliście moją paczkę z Allegro?',
      body: 'Przesyłka miała być wczoraj. Numer śledzenia AL12345.',
      status: 'OPEN',
    },
  ]
  for (const t of tickets) {
    // Idempotent po (buildingId, title, residentId) — zakładamy unikalność tytułu w demo.
    const existing = await prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM "tickets"
       WHERE "buildingId" = ${buildingId}
         AND "residentId" = ${residents[t.residentIdx].id}
         AND title = ${t.title}
       LIMIT 1
    `
    if (existing[0]) continue
    const [row] = await prisma.$queryRaw<{ id: number }[]>`
      INSERT INTO "tickets"
        ("buildingId", "residentId", "category", "type", "title", "body",
         "status", "updatedAt")
      VALUES (
        ${buildingId},
        ${residents[t.residentIdx].id},
        ${t.category}::"TicketCategory",
        ${t.type},
        ${t.title}, ${t.body},
        ${t.status}::"TicketStatus",
        NOW()
      )
      RETURNING id
    `
    if (t.reply) {
      await prisma.$executeRaw`
        INSERT INTO "ticket_replies" ("ticketId", "authorType", "authorId", "body")
        VALUES (${row.id}, ${t.reply.authorType}, ${t.reply.authorId}, ${t.reply.body})
      `
    }
  }
}

async function seedAccessEvents(buildingId: number, residents: { id: number }[]) {
  // 10 event-ów rozłożonych w czasie ostatnich 24h. Mix typów żeby demo
  // pokazało wszystkie filtry (LPR_MATCH, LPR_NO_MATCH, PIN_USED, REMOTE_OPEN,
  // MANUAL_OPEN, INTERCOM_CALL).
  const ap = await prisma.accessPoint.findFirst({
    where: { buildingId, sortOrder: 0 },
  })
  if (!ap) return // brak AP — pewnie pierwsze uruchomienie, pomiń
  const now = Date.now()
  const events: Array<{
    minsAgo: number; type: string; gateOpened: boolean;
    plate?: string; openedByType?: string; openedById?: number;
    residentId?: number; reason?: string;
  }> = [
    { minsAgo: 5,    type: 'LPR_MATCH',     gateOpened: true,  plate: 'GA12345', residentId: residents[0].id },
    { minsAgo: 35,   type: 'LPR_NO_MATCH',  gateOpened: false, plate: 'WX99000', reason: 'plate not in allowlist' },
    { minsAgo: 90,   type: 'PIN_USED',      gateOpened: true,  openedByType: 'EDGE' },
    { minsAgo: 120,  type: 'REMOTE_OPEN',   gateOpened: true,  openedByType: 'RESIDENT', openedById: residents[2].id, residentId: residents[2].id },
    { minsAgo: 180,  type: 'INTERCOM_CALL', gateOpened: false, openedByType: 'EDGE' },
    { minsAgo: 240,  type: 'LPR_MATCH',     gateOpened: true,  plate: 'GD99887', residentId: residents[2].id },
    { minsAgo: 360,  type: 'MANUAL_OPEN',   gateOpened: true,  openedByType: 'EDGE' },
    { minsAgo: 480,  type: 'LPR_MATCH',     gateOpened: true,  plate: 'WX55512', residentId: residents[3].id },
    { minsAgo: 720,  type: 'LPR_NO_MATCH',  gateOpened: false, plate: 'KR00111', reason: 'plate not in allowlist' },
    { minsAgo: 1320, type: 'REMOTE_OPEN',   gateOpened: true,  openedByType: 'RESIDENT', openedById: residents[0].id, residentId: residents[0].id },
  ]
  for (const e of events) {
    const ts = new Date(now - e.minsAgo * 60_000)
    // Idempotent: dedup po (buildingId, ts, type, plate). W produkcji
    // mielibyśmy lprReadId, ale dla demo to wystarczy.
    const existing = await prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM "access_events"
       WHERE "buildingId" = ${buildingId}
         AND ts = ${ts}
         AND type = ${e.type}::"AccessEventType"
       LIMIT 1
    `
    if (existing[0]) continue
    await prisma.$executeRaw`
      INSERT INTO "access_events"
        ("buildingId", "accessPointId", "ts", "type", "gateOpened", "plate",
         "residentId", "openedById", "openedByType", "reason")
      VALUES (
        ${buildingId},
        ${ap.id},
        ${ts},
        ${e.type}::"AccessEventType",
        ${e.gateOpened},
        ${e.plate ?? null},
        ${e.residentId ?? null},
        ${e.openedById ?? null},
        ${e.openedByType ?? null},
        ${e.reason ?? null}
      )
    `
  }
}

async function seedPayments(units: { id: number; number: string }[]) {
  // PaymentConfig + PaymentEntry — raw SQL bo Prisma client nie zna tych modeli
  // (drift 5.22/7.5). Rents różne per lokal (15A 750 / 15B 1100 / 15C 1450 PLN).
  const RENTS: Record<string, number> = { '15A': 750, '15B': 1100, '15C': 1450 }
  for (const u of units) {
    const rent = RENTS[u.number] ?? 800
    // Upsert PaymentConfig — `unitId` jest @unique.
    await prisma.$executeRaw`
      INSERT INTO "payment_configs"
        ("unitId", "monthlyRent", "dueDay", "openingBalance", "openingDate", "updatedAt")
      VALUES (${u.id}, ${rent}, 10, 0, ${new Date('2024-01-01T00:00:00Z')}, NOW())
      ON CONFLICT ("unitId") DO UPDATE SET
        "monthlyRent" = EXCLUDED."monthlyRent",
        "dueDay"      = EXCLUDED."dueDay",
        "updatedAt"   = NOW()
    `
    // Idempotent: dodajemy entries tylko gdy pusto, żeby re-run nie multiplikował.
    const countRows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "payment_entries" WHERE "unitId" = ${u.id}
    `
    if (Number(countRows[0]?.count ?? 0) > 0) continue

    const now = new Date()
    type Entry = { amount: number; type: 'CHARGE' | 'PAYMENT'; date: Date; description: string; source: string }
    const entries: Entry[] = [
      { amount: -rent, type: 'CHARGE',  date: new Date(now.getFullYear(), now.getMonth() - 2, 10), description: `Czynsz ${formatMonth(now, -2)}`, source: 'system' },
      { amount:  rent, type: 'PAYMENT', date: new Date(now.getFullYear(), now.getMonth() - 2, 12), description: 'Wpłata bank', source: 'mt940' },
      { amount: -rent, type: 'CHARGE',  date: new Date(now.getFullYear(), now.getMonth() - 1, 10), description: `Czynsz ${formatMonth(now, -1)}`, source: 'system' },
      { amount:  rent, type: 'PAYMENT', date: new Date(now.getFullYear(), now.getMonth() - 1, 14), description: 'Wpłata bank', source: 'mt940' },
      { amount: -rent, type: 'CHARGE',  date: new Date(now.getFullYear(), now.getMonth(),     10), description: `Czynsz ${formatMonth(now, 0)}`,  source: 'system' },
    ]
    for (const e of entries) {
      await prisma.$executeRaw`
        INSERT INTO "payment_entries"
          ("unitId", "amount", "type", "date", "description", "source")
        VALUES
          (${u.id}, ${e.amount}, ${e.type}::"PaymentType", ${e.date}, ${e.description}, ${e.source})
      `
    }
  }
}

function formatMonth(now: Date, deltaMonths: number): string {
  const d = new Date(now.getFullYear(), now.getMonth() + deltaMonths, 1)
  return d.toLocaleDateString('pl-PL', { month: 'long', year: 'numeric' })
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🌱 Villa Natura demo seed — start')
  const passwordHash = await hashPwd()

  const admin = await seedAdminAndPlan(passwordHash)
  console.log(`  ✓ Admin id=${admin.id}`)

  const building = await seedBuilding(admin.id)
  console.log(`  ✓ Building "${building.name}" id=${building.id}`)

  const ba = await seedBuildingAdmin(admin.id, building.id, passwordHash)
  console.log(`  ✓ BuildingAdmin ${ba.email} id=${ba.id}`)

  const concierge = await seedConcierge(admin.id, building.id, passwordHash)
  console.log(`  ✓ Concierge ${concierge.email} id=${concierge.id}`)

  const { units } = await seedStairwellAndUnits(building.id)
  console.log(`  ✓ Stairwell + ${units.length} lokali`)

  const residents = await seedResidents(building.id, passwordHash, units)
  console.log(`  ✓ ${residents.length} rezydentów`)

  await seedVehicles(building.id, residents)
  console.log(`  ✓ Pojazdy (5 — 3 APPROVED, 2 PENDING)`)

  const { edge1 } = await seedDevices(building.id)
  console.log(`  ✓ Devices (2 Edge + 2 Intercom + 2 LprCamera)`)

  await seedAccessPoints(building.id, edge1.id)
  console.log(`  ✓ 5 access pointów`)

  await seedGuests(building.id, residents)
  console.log(`  ✓ 3 gości (active/future/expired)`)

  await seedTickets(building.id, residents, ba.id, concierge.id)
  console.log(`  ✓ 3 ticket-y (ADMIN open + ADMIN in-progress + CONCIERGE)`)

  await seedAccessEvents(building.id, residents)
  console.log(`  ✓ 10 access events (24h history)`)

  await seedPayments(units)
  console.log(`  ✓ PaymentConfig + entries dla 3 lokali`)

  console.log(`
✅ Villa Natura demo gotowy.

   Logowania (hasło: ${DEMO_PASSWORD})
     • Admin osiedla:  ${ba.email}
     • Konsjerż:       ${concierge.email}
     • Rezydenci:      anna${DOMAIN}, marek${DOMAIN}, kasia${DOMAIN}, piotr${DOMAIN}, zofia${DOMAIN}

   Building id: ${building.id}
`)
}

main()
  .catch((err) => { console.error('❌ Seed failed:', err); process.exit(1) })
  .finally(() => prisma.$disconnect())
