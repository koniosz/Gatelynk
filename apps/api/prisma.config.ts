import { defineConfig } from 'prisma/config'
import { PrismaPg } from '@prisma/adapter-pg'

const connectionString = process.env.DATABASE_URL ?? 'postgresql://konradsz@localhost:5432/gatelynk'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: connectionString,
  },
  migrate: {
    adapter: () => new PrismaPg({ connectionString }),
  },
})
