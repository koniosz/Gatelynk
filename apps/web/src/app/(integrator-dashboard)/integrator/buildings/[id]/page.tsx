'use client'
/**
 * PropertyPage (handoff §5 `<PropertyPage>`).
 *
 * Orchestrator komponentów z `components/integrator/property/`. Wcześniej był
 * to monolit 1256 linii — refactor Sesja 2 (2026-05-17). Tutaj zostaje:
 *   • data fetching (building + intercoms + LPR cameras)
 *   • integracja z ActivePropertyContext (Sidebar pokazuje aktywny obiekt)
 *   • listener na `integrator:refresh` z TopBar
 *   • layout: PropertyHeader › EdgeStatus › DeviceTree › ActiveSystemsBanner › ModulesGrid
 *
 * Modułowa lista trzymana w array z `condition` — łatwo dodać/usunąć moduł
 * bez kopiowania boilerplate (`hasIntercom && intercoms.length > 0`).
 */
import { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Zap, PowerOff, Bot, ChevronRight, ClipboardCheck, RefreshCw, Cctv } from 'lucide-react'
import { integratorApi } from '@/lib/integrator-api'
import { useActiveProperty } from '@/components/integrator/active-property-context'
import { Spinner } from '@/components/integrator/property/shared/Spinner'
import { PropertyHeader } from '@/components/integrator/property/PropertyHeader'
import { BuildingReadinessCard } from '@/components/integrator/property/BuildingReadinessCard'
import { EdgeStatusSection } from '@/components/integrator/property/EdgeStatusSection'
import { DeviceTreeSection } from '@/components/integrator/property/DeviceTreeSection'
import { IntercomsModule } from '@/components/integrator/property/modules/IntercomsModule'
import { LprCamerasModule } from '@/components/integrator/property/modules/LprCamerasModule'
import {
  CctvModule, LightingModule, ParcelModule, SmartBuildingModule, EdgeAiModule, PhotovoltaicsModule,
} from '@/components/integrator/property/modules/StubModules'
import type { Building, Intercom, LprCamera } from '@/components/integrator/property/types'
import { IntegratorObjectTypeCard } from './IntegratorObjectTypeCard'
import { IntegratorPermissionsMatrix } from './IntegratorPermissionsMatrix'

export default function IntegratorBuildingPage() {
  const { id } = useParams()
  const buildingId = id as string
  const router = useRouter()
  const { setActive } = useActiveProperty()

  const [building, setBuilding] = useState<Building | null>(null)
  const [intercoms, setIntercoms] = useState<Intercom[]>([])
  const [lprCameras, setLprCameras] = useState<LprCamera[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const [bRes, camRes, icRes] = await Promise.all([
        integratorApi.get(`/integrator/buildings/${buildingId}`),
        integratorApi.get(`/integrator/buildings/${buildingId}/lpr-cameras`),
        integratorApi.get(`/integrator/buildings/${buildingId}/intercoms`),
      ])
      setBuilding(bRes.data)
      setLprCameras(camRes.data)
      setIntercoms(icRes.data)
    } catch {
      router.push('/integrator/login')
    } finally {
      setLoading(false)
    }
  }, [buildingId, router])

  // Initial fetch + Topbar refresh listener
  useEffect(() => {
    load()
    const onRefresh = () => load()
    window.addEventListener('integrator:refresh', onRefresh)
    return () => window.removeEventListener('integrator:refresh', onRefresh)
  }, [load])

  // Sidebar „Aktywny obiekt" — set/clear based on building data
  useEffect(() => {
    if (building) setActive({ id: building.id, name: building.name, address: building.address })
  }, [building, setActive])

  if (loading || !building) {
    return (
      <div className="flex items-center gap-2 py-12 text-muted text-[13px]">
        <Spinner size={14} /> Ładowanie…
      </div>
    )
  }

  const activeSystemsCount = [
    building.hasIntercom,
    building.hasLprSystem,
    building.hasCctv,
    building.hasLightingControl,
    building.hasEdgeAI,
    building.hasPhotovoltaics,
    building.packageHandling && building.packageHandling !== 'NONE',
    building.hasSmartBuilding,
  ].filter(Boolean).length

  return (
    <div className="max-w-6xl mx-auto">
      <PropertyHeader building={building} />

      {/* PR-4 — Setup-hub: checklista uruchomienia obiektu (2026-07-05). */}
      <SetupHubLink buildingId={buildingId} />

      {/* PR-3 — Health-check „obiekt gotowy" (2026-07-03). */}
      <BuildingReadinessCard buildingId={buildingId} />

      {/* FAZA b — Universal object types (2026-06-02). */}
      <IntegratorObjectTypeCard buildingId={buildingId} onSaved={load} />

      {/* FAZA e — Permissions Matrix (2026-06-02). */}
      <IntegratorPermissionsMatrix buildingId={buildingId} onSaved={load} />

      {/* 2026-09-27 — podstrona „Urządzenia" (mirror Edge, powiązania kamer
          LPR → punkty dostępu, ustawienia kamer) NIE miała żadnego linku
          w nawigacji; dało się na nią wejść tylko z ręcznie wpisanego adresu
          (właściciel nie znalazł jej przy incydencie VN 26.09). */}
      <DevicesLink buildingId={buildingId} />

      {/* FAZA 8.h.25 — tymczasowy panel oceny odpowiedzi GateLynk AI */}
      <AssistantLogsLink buildingId={buildingId} />

      {/* 2026-07-30 — Akuvox Directory Sync v2. Link także tutaj (nie tylko
          karta na podstronie Urządzenia) — właściciel 2× nie mógł go znaleźć. */}
      <DirectorySyncLink buildingId={buildingId} />

      {/* Sekcja „Urządzenia Edge" */}
      {building.hasEdge && <EdgeStatusSection buildingId={buildingId} />}

      {/* Sekcja „Sieć LAN — Urządzenia Edge" */}
      {building.hasEdge && (
        <DeviceTreeSection
          buildingId={buildingId}
          intercoms={intercoms}
          lprCameras={lprCameras}
          onAssigned={load}
        />
      )}

      {/* Banner: aktywne systemy */}
      {activeSystemsCount > 0 ? (
        <ActiveSystemsBanner count={activeSystemsCount} />
      ) : (
        <EmptyModulesState />
      )}

      {/* Modules grid — handoff §5 auto-fill, minmax(320px, 1fr) */}
      {activeSystemsCount > 0 && (
        <div
          className="grid gap-4"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))' }}
        >
          {building.hasIntercom && intercoms.length > 0 && (
            <IntercomsModule buildingId={buildingId} intercoms={intercoms} onUpdated={load} />
          )}
          {building.hasLprSystem && lprCameras.length > 0 && (
            <LprCamerasModule buildingId={buildingId} cameras={lprCameras} onUpdated={load} />
          )}
          {building.hasCctv && <CctvModule />}
          {building.hasLightingControl && <LightingModule />}
          {building.hasSmartBuilding && <SmartBuildingModule />}
          {building.packageHandling && building.packageHandling !== 'NONE' && (
            <ParcelModule mode={building.packageHandling} />
          )}
          {building.hasEdgeAI && <EdgeAiModule />}
          {building.hasPhotovoltaics && <PhotovoltaicsModule />}
        </div>
      )}
    </div>
  )
}

/**
 * PR-4 — link do setup-huba (checklista uruchomienia obiektu). Prowadzi do
 * `/integrator/buildings/[id]/setup` — kart per check readiness z linkami
 * do właściwych miejsc panelu + import CSV + zaproszenia.
 */
function SetupHubLink({ buildingId }: { buildingId: string }) {
  return (
    <Link
      href={`/integrator/buildings/${buildingId}/setup`}
      className="bg-white rounded-xl border border-gray-200 p-4 mb-5 flex items-center gap-3 hover:border-brand/40 transition-colors group"
    >
      <div className="w-9 h-9 rounded-xl bg-brand-50 flex items-center justify-center flex-shrink-0">
        <ClipboardCheck size={16} className="text-brand" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-semibold text-ink-2">Uruchomienie obiektu (setup)</p>
        <p className="text-[11px] text-muted">
          Checklista krok po kroku: Edge, urządzenia, punkty dostępu, LPR, import mieszkańców, zaproszenia
        </p>
      </div>
      <ChevronRight size={16} className="text-gray-300 group-hover:text-brand transition-colors" />
    </Link>
  )
}

/**
 * 2026-09-27 — link do podstrony „Urządzenia": mirror urządzeń Edge,
 * POWIĄZANIA KAMER LPR Z PUNKTAMI DOSTĘPU (bez nich Edge nie otwiera bramy
 * po rozpoznaniu tablicy — reason `camera_not_linked`), ustawienia kamer.
 */
function DevicesLink({ buildingId }: { buildingId: string }) {
  return (
    <Link
      href={`/integrator/buildings/${buildingId}/devices`}
      className="bg-white rounded-xl border border-gray-200 p-4 mb-5 flex items-center gap-3 hover:border-emerald-300 transition-colors group"
    >
      <div className="w-9 h-9 rounded-xl bg-emerald-100 flex items-center justify-center flex-shrink-0">
        <Cctv size={16} className="text-emerald-600" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-semibold text-ink-2">Urządzenia i powiązania kamer LPR</p>
        <p className="text-[11px] text-muted">
          Która kamera otwiera który punkt dostępu (wjazd / wyjazd), ustawienia kamer, lista urządzeń z Edge
        </p>
      </div>
      <ChevronRight size={16} className="text-gray-300 group-hover:text-emerald-400 transition-colors" />
    </Link>
  )
}

/**
 * 2026-07-30 — link do Akuvox Directory Sync v2 (synchronizacja katalogu
 * kontaktów ze stacjami domofonowymi: mapowanie, dry-run, template-driven
 * eksport/import). Ta sama strona ma też kartę na podstronie Urządzenia.
 */
function DirectorySyncLink({ buildingId }: { buildingId: string }) {
  return (
    <Link
      href={`/integrator/buildings/${buildingId}/akuvox-directory`}
      className="bg-white rounded-xl border border-gray-200 p-4 mb-5 flex items-center gap-3 hover:border-blue-300 transition-colors group"
    >
      <div className="w-9 h-9 rounded-xl bg-blue-100 flex items-center justify-center flex-shrink-0">
        <RefreshCw size={16} className="text-blue-600" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-semibold text-ink-2">Akuvox → Directory Sync</p>
        <p className="text-[11px] text-muted">
          Kontakty na ekranie domofonu: grupy, mapowanie lokali, dry-run, generowanie pliku importu
        </p>
      </div>
      <ChevronRight size={16} className="text-gray-300 group-hover:text-blue-400 transition-colors" />
    </Link>
  )
}

/**
 * FAZA 8.h.25 — link do tymczasowego panelu oceny odpowiedzi GateLynk AI.
 * Celowo skromna karta (panel jest tymczasowy — zniknie po zebraniu datasetu).
 */
function AssistantLogsLink({ buildingId }: { buildingId: string }) {
  return (
    <Link
      href={`/integrator/buildings/${buildingId}/assistant-logs`}
      className="bg-white rounded-xl border border-gray-200 p-4 mb-5 flex items-center gap-3 hover:border-violet-300 transition-colors group"
    >
      <div className="w-9 h-9 rounded-xl bg-violet-100 flex items-center justify-center flex-shrink-0">
        <Bot size={16} className="text-violet-600" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-semibold text-ink-2">
          Logi GateLynk AI{' '}
          <span className="ml-1 px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[10px] font-medium align-middle">
            tymczasowe
          </span>
        </p>
        <p className="text-[11px] text-muted">
          Pytania i odpowiedzi asystenta z oceną OK / NIE OK — dataset do dostrojenia LLM
        </p>
      </div>
      <ChevronRight size={16} className="text-gray-300 group-hover:text-violet-400 transition-colors" />
    </Link>
  )
}

function ActiveSystemsBanner({ count }: { count: number }) {
  const label = count === 1 ? 'aktywny system' : count < 5 ? 'aktywne systemy' : 'aktywnych systemów'
  return (
    <div className="bg-brand-50 border border-brand/20 rounded-r3 p-4 mb-5 flex items-center gap-3">
      <div className="w-9 h-9 rounded-r2 bg-brand flex items-center justify-center flex-shrink-0">
        <Zap size={16} strokeWidth={2} className="text-white" />
      </div>
      <div>
        <p className="text-[13px] font-semibold text-brand">
          {count} {label}
        </p>
        <p className="text-[11px] text-brand-600">
          Każdy moduł ma zakładki Konfiguracja i Sterowanie
        </p>
      </div>
    </div>
  )
}

function EmptyModulesState() {
  return (
    <div className="text-center py-12 text-muted mb-4">
      <PowerOff size={40} strokeWidth={1.5} className="text-muted-2 mx-auto mb-3" />
      <p className="text-[14px] font-medium text-ink-2">Żaden system nie jest aktywny</p>
      <p className="text-[12px] mt-1">
        Administrator musi włączyć systemy w ustawieniach obiektu
      </p>
    </div>
  )
}
