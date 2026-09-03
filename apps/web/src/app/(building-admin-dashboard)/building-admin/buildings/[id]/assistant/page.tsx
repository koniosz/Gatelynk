'use client'
/**
 * BA Assistant page — /building-admin/buildings/:id/assistant
 *
 * Pełnoekranowy chat z GateLynk AI Assistant przez Cloud-side proxy do Edge.
 * Identyczny komponent jak w panelu konsjerża i iOS — różni się tylko auth +
 * endpointPath (BA ma multi-building w URL).
 */
import { useParams } from 'next/navigation'
import Link from 'next/link'
import AssistantPanel from '@/components/AssistantPanel'
import { buildingAdminApi } from '@/lib/building-admin-api'

const BA_SAMPLE_PROMPTS = [
  'Co ciekawego działo się w ostatniej godzinie?',
  'Podsumuj ostatnie 4 godziny',
  'Ile białych aut dziś wjechało?',
  'Czy widziałeś dziś DHL?',
  'Pokaż 5 ostatnich nieznanych tablic',
  'Co mówi uchwała o psach?',
]

export default function BaAssistantPage() {
  const params = useParams<{ id: string }>()
  const buildingId = Number(params.id)

  return (
    <div className="flex h-[calc(100vh-2rem)] flex-col p-4 gap-3">
      {/* Breadcrumb / back link */}
      <div className="flex items-center gap-3 text-sm text-gray-600">
        <Link
          href={`/building-admin/buildings/${buildingId}`}
          className="hover:text-purple-600"
        >
          ← Powrót do budynku
        </Link>
        <span className="text-gray-300">|</span>
        <h1 className="text-base font-semibold text-gray-900">
          ✨ Asystent AI budynku #{buildingId}
        </h1>
      </div>

      {/* Chat panel — wypełnia całą resztę wysokości */}
      <div className="flex-1 min-h-0">
        <AssistantPanel
          apiClient={buildingAdminApi}
          endpointPath={`/building-admin/buildings/${buildingId}/assistant/ask`}
          title="Asystent AI — administracja"
          samplePrompts={BA_SAMPLE_PROMPTS}
        />
      </div>
    </div>
  )
}
