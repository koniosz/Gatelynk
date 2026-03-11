import { PrismaClient } from '@prisma/client'

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
  const systemUnitTypes = [
    { code: 'apartment', name: 'Mieszkanie', icon: 'home' },
    { code: 'garage', name: 'Garaż', icon: 'car' },
    { code: 'storage', name: 'Komórka lokatorska', icon: 'archive' },
    { code: 'pool', name: 'Basen', icon: 'waves' },
    { code: 'gym', name: 'Siłownia', icon: 'dumbbell' },
    { code: 'banquet_hall', name: 'Sala bankietowa', icon: 'party-popper' },
    { code: 'playroom', name: 'Sala zabaw', icon: 'gamepad' },
  ]

  for (const type of systemUnitTypes) {
    await prisma.unitType.upsert({
      where: { buildingId_code: { buildingId: null as any, code: type.code } },
      update: { name: type.name, icon: type.icon },
      create: { ...type, buildingId: null, isSystem: true },
    })
  }
  console.log('✅ System unit types seeded')
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
