'use client'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { buildingAdminApi } from '@/lib/building-admin-api'
import { AnomalyEventsFeed } from '@/components/AnomalyEventsFeed'

/**
 * BA — feed `anomaly_events` (Etap 3+4 fall detection).
 *
 * Dane z Cloud `anomaly_events` (single source of truth zsyncowany z Edge
 * przez WS tunnel). Akcje resolve/false-positive scoped per `buildingIds`
 * z JWT — endpoint waliduje że event należy do budynków admina.
 *
 * Różnice vs `/vision`:
 *   • `/vision` pokazuje całą tabelę vision_detections (notable frames),
 *     anomalia są podświetlone ale wśród innych eventów.
 *   • Ta strona to FOCUS na bezpieczeństwie — tylko anomalia, z akcjami,
 *     polling co 30s, time-range toggle.
 */
export default function BaAnomalyEventsPage() {
  const params = useParams()
  const buildingId = params?.id as string

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">🛡 Alerty bezpieczeństwa</h1>
          <p className="text-sm text-gray-500 mt-1">
            Wykryte anomalia (upadki, w przyszłości: pożar, intruzja).
            Sprawdź szczegóły i oznacz jako obsłużone lub fałszywy alarm.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/building-admin/buildings/${buildingId}/vision`}
            className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-700"
          >
            ← Wizja kamer
          </Link>
        </div>
      </div>

      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <div className="font-semibold mb-1">ℹ️ Jak to działa</div>
        <p>
          System AI analizuje co 60 sekund klatki z kamer. Gdy YOLOv8-pose
          rozpozna pozycję sugerującą upadek (sylwetka pozioma, głowa poniżej
          bioder, niska pozycja w kadrze), tworzony jest alert. Mieszkańcy
          z włączonym opt-in dostają push. <strong>To system wczesnego
          ostrzegania — nie zastępuje numeru 112.</strong> Część alertów to
          fałszywe pozytywy (dziecko siedzące na podłodze, sprzątanie).
          Oznaczanie ich jako „Fałszywy alarm" pomaga w przyszłości doszlifować
          progi.
        </p>
      </div>

      <AnomalyEventsFeed
        apiClient={buildingAdminApi}
        listPath={`/building-admin/buildings/${buildingId}/anomaly-events`}
        itemPath={(id) => `/building-admin/anomaly-events/${id}`}
        canResolve
      />
    </div>
  )
}
