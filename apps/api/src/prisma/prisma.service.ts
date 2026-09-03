import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

// Standardowy PrismaClient bez `adapter` — używa swojego Rust query engine
// i czyta `DATABASE_URL` z env. Wcześniej tu był `PrismaPg` adapter, ale w
// dockerze peer resolution daje `@prisma/adapter-pg@7.5` z niezgodnym API
// dla `@prisma/client@5.22` (hoisted top-level). Bez adaptera obie wersje
// działają zgodnie, a brakuje tylko wbudowanego connection poolingu — który
// i tak jest przewidziany dopiero na produkcji (PgBouncer / Prisma Accelerate).

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect()
  }

  async onModuleDestroy() {
    await this.$disconnect()
  }
}
