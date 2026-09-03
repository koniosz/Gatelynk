/**
 * Faza 7.4 — Factory functions dla e2e testów.
 *
 * Każda funkcja tworzy minimalny obiekt z deterministycznymi defaultami,
 * pozwalając testom przekazywać overrides. Bcrypt hash używa salt rounds=4
 * (zamiast 10 produkcyjnych) żeby testy szybciej szły.
 *
 * Konwencja: `seedXxx()` zwraca obiekt z DB włącznie z plain-text password
 * (gdzie ma sens), żeby testy mogły go użyć w login flow.
 */
import * as bcrypt from 'bcrypt'
import { PrismaClient } from '@prisma/client'

export const TEST_PASSWORD = 'TestPass!23'
const TEST_BCRYPT_ROUNDS = 4

async function hashPassword(): Promise<string> {
  return bcrypt.hash(TEST_PASSWORD, TEST_BCRYPT_ROUNDS)
}

let _emailCounter = 0
function uniqueEmail(prefix: string): string {
  _emailCounter++
  return `${prefix}+${Date.now()}-${_emailCounter}@test.local`
}

export async function seedAdmin(prisma: PrismaClient) {
  const passwordHash = await hashPassword()
  return prisma.admin.create({
    data: {
      email: uniqueEmail('admin'),
      passwordHash,
      name: 'Test Admin',
    },
  })
}

export async function seedBuilding(
  prisma: PrismaClient,
  adminId: number,
  overrides: Partial<{ name: string; address: string }> = {},
) {
  return prisma.building.create({
    data: {
      adminId,
      name: overrides.name ?? `Test Building ${Date.now()}`,
      address: overrides.address ?? 'ul. Testowa 1, 80-001 Sopot',
    },
  })
}

export async function seedBuildingAdmin(
  prisma: PrismaClient,
  adminId: number,
  buildingId: number,
) {
  const passwordHash = await hashPassword()
  const ba = await prisma.buildingAdmin.create({
    data: {
      adminId,
      email: uniqueEmail('ba'),
      passwordHash,
      name: 'Test BA',
    },
  })
  await prisma.buildingAdminAssignment.create({
    data: { buildingAdminId: ba.id, buildingId },
  })
  return ba
}

export async function seedConcierge(
  prisma: PrismaClient,
  adminId: number,
  buildingId: number,
) {
  const passwordHash = await hashPassword()
  return prisma.concierge.create({
    data: {
      adminId,
      buildingId,
      email: uniqueEmail('concierge'),
      passwordHash,
      name: 'Test Concierge',
    },
  })
}

export async function seedResident(
  prisma: PrismaClient,
  buildingId: number,
  overrides: Partial<{ firstName: string; lastName: string }> = {},
) {
  const passwordHash = await hashPassword()
  return prisma.resident.create({
    data: {
      buildingId,
      email: uniqueEmail('resident'),
      passwordHash,
      firstName: overrides.firstName ?? 'Anna',
      lastName: overrides.lastName ?? 'Test',
    },
  })
}

export async function seedUnit(
  prisma: PrismaClient,
  buildingId: number,
  number = '1A',
) {
  // UnitType "apartment" jest seedowany przez `resetDatabase()`.
  const apartmentType = await prisma.unitType.findFirst({
    where: { isSystem: true, code: 'apartment' },
  })
  if (!apartmentType) throw new Error('UnitType "apartment" missing — call resetDatabase() first')
  return prisma.unit.create({
    data: { buildingId, unitTypeId: apartmentType.id, number, floor: 1 },
  })
}

/**
 * Helper: tworzy pełen kontekst budynku (admin + building + BA + concierge +
 * 1 unit + 1 resident przypisany do unit-u) i loguje wszystkich, zwracając
 * tokeny + id-y. Używane przez większość testów które chcą gotowy setup.
 */
export async function seedFullBuilding(prisma: PrismaClient) {
  const admin = await seedAdmin(prisma)
  const building = await seedBuilding(prisma, admin.id)
  const ba = await seedBuildingAdmin(prisma, admin.id, building.id)
  const concierge = await seedConcierge(prisma, admin.id, building.id)
  const unit = await seedUnit(prisma, building.id)
  const resident = await seedResident(prisma, building.id)
  await prisma.unitResident.create({
    data: {
      unitId: unit.id,
      residentId: resident.id,
      role: 'OWNER',
      sinceDate: new Date('2024-01-01T00:00:00Z'),
    },
  })
  return { admin, building, ba, concierge, unit, resident }
}
