'use client'
/**
 * StubModules — placeholders dla modułów które nie mają jeszcze implementacji
 * (CCTV, Lighting, Parcel, SmartBuilding, EdgeAI, Photovoltaics).
 *
 * Każdy zwraca ModuleCard z status `needs` (lub `active` dla Parcel) i
 * ComingSoonBlock w subtab „Sterowanie". W subtab „Konfiguracja" — krótki tekst
 * informacyjny.
 *
 * Wykorzystywane przez page.tsx orchestrator. Gdy moduł będzie miał real impl,
 * przenieś go do własnego pliku (jak IntercomsModule / LprCamerasModule).
 */
import { useState } from 'react'
import {
  Video, Lightbulb, Package, Home, Bot, Sun, Briefcase,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { ModuleCard, ComingSoonBlock, type ModuleStatus } from '../ModuleCard'

interface StubProps {
  icon: LucideIcon
  title: string
  description: string
  status?: ModuleStatus
  controlName: string
  controlIcon?: LucideIcon
}

function StubModule({ icon, title, description, status = 'needs', controlName, controlIcon }: StubProps) {
  const [tab, setTab] = useState<'Konfiguracja' | 'Sterowanie'>('Konfiguracja')
  return (
    <ModuleCard icon={icon} title={title} status={status} activeTab={tab} onTabChange={setTab}>
      {tab === 'Konfiguracja' && (
        <div className="text-[13px] text-muted py-2">{description}</div>
      )}
      {tab === 'Sterowanie' && (
        <ComingSoonBlock name={controlName} icon={controlIcon ?? icon} />
      )}
    </ModuleCard>
  )
}

export function CctvModule() {
  return (
    <StubModule
      icon={Video}
      title="Monitoring CCTV"
      description="Konfiguracja rejestratorów CCTV — wkrótce dostępna."
      controlName="CCTV"
    />
  )
}

export function LightingModule() {
  return (
    <StubModule
      icon={Lightbulb}
      title="Oświetlenie części wspólnych"
      description="Konfiguracja sterownika oświetlenia — wkrótce dostępna."
      controlName="oświetlenia"
    />
  )
}

export function ParcelModule({ mode }: { mode: string }) {
  const [tab, setTab] = useState<'Konfiguracja' | 'Sterowanie'>('Konfiguracja')
  const ModeIcon = mode === 'LOCKER' ? Package : Briefcase
  return (
    <ModuleCard
      icon={Package}
      title="Obsługa przesyłek"
      status="active"
      activeTab={tab}
      onTabChange={setTab}
    >
      {tab === 'Konfiguracja' && (
        <div className="flex items-center gap-3 py-2 px-3 bg-surface-2 rounded-r2 border border-border">
          <ModeIcon size={18} className="text-ink-2" />
          <div>
            <p className="text-[13px] font-medium text-ink">
              {mode === 'LOCKER' ? 'Paczkomat Pointpack' : 'Przez konsjerża'}
            </p>
            <p className="text-[11px] text-muted">
              Tryb obsługi przesyłek skonfigurowany przez administratora
            </p>
          </div>
        </div>
      )}
      {tab === 'Sterowanie' && <ComingSoonBlock name="paczkomatu" icon={Package} />}
    </ModuleCard>
  )
}

export function SmartBuildingModule() {
  return (
    <StubModule
      icon={Home}
      title="Smart Building / KNX"
      description="Konfiguracja systemu KNX/HDL — wkrótce dostępna."
      controlName="Smart Building"
    />
  )
}

export function EdgeAiModule() {
  return (
    <StubModule
      icon={Bot}
      title="GateLynk Edge AI"
      description="Konfiguracja modułu AI — wkrótce dostępna."
      controlName="Edge AI"
    />
  )
}

export function PhotovoltaicsModule() {
  return (
    <StubModule
      icon={Sun}
      title="Fotowoltaika"
      description="Konfiguracja falownika/monitoringu PV — wkrótce dostępna."
      controlName="fotowoltaiki"
    />
  )
}
