'use client'
import { conciergeApi } from '@/lib/concierge-api'
import { AnomalyEventsFeed } from '@/components/AnomalyEventsFeed'

/**
 * Concierge — feed `anomaly_events`. Scoped do swojego budynku (z JWT
 * `buildingId`). Identyczny UI co BA, ale endpointy bez `/buildings/:id` w URL.
 *
 * Konsjerż widzi alerty, może je oznaczyć jako obsłużone / fałszywy alarm.
 * Akcja zapisuje `resolvedBy='CONCIERGE:<id>'` — audyt zachowany.
 */
export default function ConciergeAnomalyEventsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">🛡 Alerty bezpieczeństwa</h1>
        <p className="text-sm text-gray-500 mt-1">
          Wykryte anomalia w budynku. Sprawdź czy potrzebna interwencja.
          Oznacz jako obsłużone gdy zweryfikujesz na żywo, lub fałszywy alarm
          gdy zdjęcie pokazuje normalną aktywność.
        </p>
      </div>

      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
        <div className="font-semibold mb-1">⚠️ Procedura przy alercie</div>
        <ol className="list-decimal list-inside space-y-0.5">
          <li>Sprawdź klatkę z kamery — czy widać upadek osoby</li>
          <li>Jeśli tak — zadzwoń na 112 i biegnij sprawdzić</li>
          <li>Jeśli to fałszywy alarm — kliknij „Fałszywy alarm"</li>
          <li>Po interwencji kliknij „Obsłużone"</li>
        </ol>
      </div>

      <AnomalyEventsFeed
        apiClient={conciergeApi}
        listPath="/concierge/anomaly-events"
        itemPath={(id) => `/concierge/anomaly-events/${id}`}
        canResolve
      />
    </div>
  )
}
