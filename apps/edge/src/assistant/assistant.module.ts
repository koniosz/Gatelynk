import { Module } from '@nestjs/common'
import { AssistantController } from './assistant.controller'
import { AssistantService } from './assistant.service'
import { KnowledgeModule } from '../knowledge/knowledge.module'

/**
 * AssistantModule — Edge AI Assistant z lokalnym Ollama (qwen2.5:3b).
 *
 * StoreService jest @Global() więc nie ma `imports`. Provider + controller.
 *
 * Dependencies hardware:
 *  • Ollama serve na localhost:11434 (instalacja: `setup-ollama.sh`)
 *  • Model `qwen2.5:3b` (~2 GB, pobierany przez `ollama pull`)
 *  • macOS 13.x: Ollama 0.5.13 (max wersja z wsparciem Ventura)
 */
@Module({
  imports:     [KnowledgeModule],
  controllers: [AssistantController],
  providers:   [AssistantService],
  exports:     [AssistantService],
})
export class AssistantModule {}
