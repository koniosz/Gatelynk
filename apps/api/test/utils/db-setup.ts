/**
 * Faza 7.4 — Test database setup helper.
 *
 * E2E testy mają osobną bazę `gatelynk_test` (lub `DATABASE_URL_TEST` env).
 * Każdy `describe` block woła `resetDatabase()` w `beforeAll`, co:
 *   1) Uruchamia `prisma migrate deploy` (idempotent — applies all migrations)
 *   2) TRUNCATE wszystkich tabel poza `_prisma_migrations` żeby start ze
 *      sterylną bazą.
 *   3) Seed-uje system unit types (apartment, garage, …) bo bez nich nie da
 *      się utworzyć Building-ów (UnitType wymagany w `Unit.unitTypeId`).
 *
 * Uwaga: testy NIE uruchamiają migration:dev — używają wcześniej zdefiniowanej
 * bazy (lokalnie ręcznie utworzona, w CI z Docker postgres service).
 */
import { execSync } from 'child_process'
import { PrismaClient } from '@prisma/client'

let _prisma: PrismaClient | null = null

export function getTestPrisma(): PrismaClient {
  if (_prisma) return _prisma
  const url = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL_TEST (lub DATABASE_URL) nie ustawione dla testów e2e')
  _prisma = new PrismaClient({ datasources: { db: { url } } })
  return _prisma
}

export async function disconnectTestPrisma(): Promise<void> {
  if (_prisma) {
    await _prisma.$disconnect()
    _prisma = null
  }
}

/**
 * Apply migracje + reset wszystkich tabel + minimal seed (license plans + unit types).
 * Wywoływane raz w `beforeAll` per test-suite.
 *
 * UWAGA: TRUNCATE jest agresywne — używamy tylko gdy `DATABASE_URL_TEST` jest
 * ustawione i wskazuje na bazę z `_test` w nazwie (defensive guard żeby nie
 * skasować produkcji przez pomyłkę).
 */
export async function resetDatabase(): Promise<void> {
  const url = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL_TEST nie ustawione')
  if (!url.includes('_test') && !url.includes('localhost')) {
    throw new Error(
      `DATABASE_URL_TEST musi zawierać "_test" lub "localhost" — ` +
      `nie pozwalamy na TRUNCATE dowolnej bazy. Got: ${url.replace(/:[^@]*@/, ':****@')}`,
    )
  }

  // 1) Apply migrations (idempotent).
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe', // wycisz output żeby test runner był czysty
  })

  const prisma = getTestPrisma()

  // 2) TRUNCATE wszystkich user-tabel z RESTART IDENTITY (sekwencje od 1).
  //    Pomijamy `_prisma_migrations` — żeby nie re-applikować przy każdym teście.
  const tables: { tablename: string }[] = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename NOT LIKE '_prisma%'
  `
  if (tables.length > 0) {
    const list = tables.map((t) => `"${t.tablename}"`).join(', ')
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`)
  }

  // 3) Minimal seed — license plans + unit types (system-wide).
  const plans = [
    { code: 'starter', name: 'Starter', maxUnits: 50, maxBuildings: 1, maxAdmins: 1 },
    { code: 'pro',     name: 'Pro',     maxUnits: null, maxBuildings: null, maxAdmins: 10 },
  ]
  for (const p of plans) {
    await prisma.licensePlan.upsert({
      where: { code: p.code }, update: p, create: p,
    })
  }
  await prisma.unitType.upsert({
    where: { id: 1 }, // pierwszy id po RESTART IDENTITY
    update: { code: 'apartment', name: 'Mieszkanie', icon: 'home', isSystem: true, isCommonArea: false },
    create: { code: 'apartment', name: 'Mieszkanie', icon: 'home', isSystem: true, isCommonArea: false },
  })
}
