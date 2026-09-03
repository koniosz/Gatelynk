import { Module } from '@nestjs/common'
import { BuildingKnowledgeController } from './building-knowledge.controller'
import { BuildingKnowledgeService } from './building-knowledge.service'
import { PrismaModule } from '../prisma/prisma.module'
import { EdgeModule } from '../edge/edge.module'
import { BuildingAdminModule } from '../building-admin/building-admin.module'

@Module({
  imports: [PrismaModule, EdgeModule, BuildingAdminModule],
  controllers: [BuildingKnowledgeController],
  providers: [BuildingKnowledgeService],
  exports: [BuildingKnowledgeService],
})
export class BuildingKnowledgeModule {}
