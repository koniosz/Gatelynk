import { PrismaClient } from '@prisma/client'

// Standardowy PrismaClient (Rust query engine) — spójnie z `PrismaService`
// w produkcji (patrz src/prisma/prisma.service.ts). DATABASE_URL z env.
const prisma = new PrismaClient()

async function main() {
  // Seed license plans
  const plans = [
    { code: 'starter', name: 'Starter', maxUnits: 50, maxBuildings: 1, maxAdmins: 1 },
    { code: 'standard', name: 'Standard', maxUnits: 200, maxBuildings: 5, maxAdmins: 3 },
    { code: 'pro', name: 'Pro', maxUnits: null, maxBuildings: null, maxAdmins: 10 },
  ]

  for (const plan of plans) {
    await prisma.licensePlan.upsert({
      where: { code: plan.code },
      update: plan,
      create: plan,
    })
  }
  console.log('✅ License plans seeded')

  // Seed system unit types (buildingId = null)
  // isCommonArea=true → udogodnienia rezerwowalne (sauna, siłownia itp.)
  const systemUnitTypes: { code: string; name: string; icon: string; isCommonArea?: boolean }[] = [
    { code: 'apartment',    name: 'Mieszkanie',       icon: 'home' },
    // Dom wolnostojący — dla obiektów typu HOUSING_ESTATE (osiedle domów).
    // Zgłoszenie 2026-08-09: przy dodawaniu lokalu na osiedlu domów jedynym
    // sensownym wyborem było „Mieszkanie", co jest po prostu nieprawdą i myli
    // zarówno administratora, jak i mieszkańca w aplikacji.
    { code: 'house',        name: 'Dom',               icon: 'house' },
    { code: 'garage',       name: 'Garaż',             icon: 'car' },
    { code: 'storage',      name: 'Komórka lokatorska', icon: 'archive' },
    { code: 'pool',         name: 'Basen',             icon: 'waves',         isCommonArea: true },
    { code: 'gym',          name: 'Siłownia',          icon: 'dumbbell',      isCommonArea: true },
    { code: 'sauna',        name: 'Sauna',             icon: 'flame',         isCommonArea: true },
    { code: 'banquet_hall', name: 'Sala bankietowa',   icon: 'party-popper',  isCommonArea: true },
    { code: 'playroom',     name: 'Sala zabaw',        icon: 'gamepad',       isCommonArea: true },
  ]

  for (const type of systemUnitTypes) {
    const existing = await prisma.unitType.findFirst({
      where: { isSystem: true, code: type.code },
    })
    if (existing) {
      await prisma.unitType.update({
        where: { id: existing.id },
        data: { name: type.name, icon: type.icon, isCommonArea: type.isCommonArea ?? false },
      })
    } else {
      await prisma.unitType.create({
        data: { ...type, buildingId: null, isSystem: true, isCommonArea: type.isCommonArea ?? false },
      })
    }
  }
  console.log('✅ System unit types seeded')
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
