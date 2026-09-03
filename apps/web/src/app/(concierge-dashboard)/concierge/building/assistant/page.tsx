'use client'
/**
 * Concierge Assistant page — /concierge/building/assistant
 *
 * Pełnoekranowy chat z GateLynk AI Assistant. Concierge ma JWT z buildingId
 * w payloadzie — Cloud sam wybiera Edge IP (nie ma URL param tutaj).
 */
import Link from 'next/link'
import AssistantPanel from '@/components/AssistantPanel'
import { conciergeApi } from '@/lib/concierge-api'

const CONCIERGE_SAMPLE_PROMPTS = [
  'Co ciekawego działo się w ostatniej godzinie?',
  'Czy był dzisiaj kurier?',
  'Ile aut dziś wjechało?',
  'Pokaż 5 ostatnich nieznanych tablic',
  'Czy widziałeś dziś DHL?',
  'Kto jest administratorem osiedla?',
]

export default function ConciergeAssistantPage() {
  return (
    <div className="flex h-[calc(100vh-2rem)] flex-col p-4 gap-3">
      <div className="flex items-center gap-3 text-sm text-gray-600">
        <Link href="/concierge/building" className="hover:text-blue-600">
          ← Powrót
        </Link>
        <span className="text-gray-300">|</span>
        <h1 className="text-base font-semibold text-gray-900">
          ✨ Asystent AI
        </h1>
      </div>

      <div className="flex-1 min-h-0">
        <AssistantPanel
          apiClient={conciergeApi}
          endpointPath="/concierge/assistant/ask"
          title="Asystent AI — konsjerż"
          samplePrompts={CONCIERGE_SAMPLE_PROMPTS}
        />
      </div>
    </div>
  )
}
