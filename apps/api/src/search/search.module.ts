import { Module } from '@nestjs/common'
import { SearchController } from './search.controller'
import { PrismaModule } from '../prisma/prisma.module'

@Module({
  imports: [PrismaModule],
  controllers: [SearchController],
})
export class SearchModule {}
