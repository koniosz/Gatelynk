'use client'
/**
 * ToolsPage (handoff §5 `<ToolsPage>`).
 *
 * Karty narzędzi diagnostycznych i serwisowych dla integratora.
 * Sesja 4: Skaner LAN aktywny (modal z discovery + assignment).
 *
 * Sekcje:
 *   1. Skaner LAN — discovery mDNS + KNXnet/IP SEARCH (Sesja 4 ✓)
 *   2. Diagnostyka — test-matrix per device + log eksport (Sesja 5)
 *   3. Aktualizacja firmware — bulk update dla wybranych Edge (Sesja 5+)
 *   4. Eksport konfiguracji — JSON download per obiekt (Sesja 5)
 */
import { useEffect, useState } from 'react'
import {
  Network, Stethoscope, Download, Upload, ArrowRight, Construction, Activity,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { integratorApi } from '@/lib/integrator-api'
import { LanScanModal } from '@/components/integrator/LanScanModal'
import { DiagnosticsModal } from '@/components/integrator/DiagnosticsModal'
import { ExportConfigModal } from '@/components/integrator/ExportConfigModal'
import { HealthReportModal } from '@/components/integrator/HealthReportModal'

interface ToolCardData {
  id: 'lan-scan' | 'diagnostics' | 'health' | 'firmware' | 'export'
  icon: LucideIcon
  title: string
  description: string
  cta: string
  status: 'available' | 'coming-soon'
}

const TOOLS: ToolCardData[] = [
  {
    id: 'lan-scan',
    icon: Network,
    title: 'Skaner LAN',
    description: 'Wykryj urządzenia w sieci LAN klienta — mDNS, Bonjour, KNXnet/IP SEARCH. Wyniki przypisujesz do modułów obiektu.',
    cta: 'Wybierz obiekt',
    status: 'available',
  },
  {
    id: 'diagnostics',
    icon: Stethoscope,
    title: 'Diagnostyka',
    description: 'Test-matrix per urządzenie: TCP ping, auth, snapshot, RTSP. Wyniki z latency dla każdej zdolności.',
    cta: 'Uruchom diagnostykę',
    status: 'available',
  },
  {
    id: 'health',
    icon: Activity,
    title: 'Health report',
    description: 'Snapshot wszystkich Edge w portfolio — uptime, FW, ostatnia diagnostyka. Drukuj do PDF dla raportów klienta.',
    cta: 'Generuj raport',
    status: 'available',
  },
  {
    id: 'firmware',
    icon: Upload,
    title: 'Aktualizacja firmware',
    description: 'Masowy upload nowej wersji firmware dla wybranych Edge ze stage rollout (10% → 50% → 100%).',
    cta: 'Konfiguruj rollout',
    status: 'coming-soon',
  },
  {
    id: 'export',
    icon: Download,
    title: 'Eksport konfiguracji',
    description: 'Pobierz pełną konfigurację obiektu jako JSON — devices, modules, network, do migracji lub backup.',
    cta: 'Pobierz JSON',
    status: 'available',
  },
]

export default function ToolsPage() {
  const [lanScanOpen, setLanScanOpen] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [healthOpen, setHealthOpen] = useState(false)
  const [buildings, setBuildings] = useState<Array<{ id: number; name: string; address: string }>>([])

  // Fetch buildings — wspólne dla wszystkich modali (dropdown wyboru obiektu).
  useEffect(() => {
    integratorApi.get('/integrator/buildings')
      .then((r) => setBuildings(r.data.map((b: { id: number; name: string; address: string }) => ({
        id: b.id, name: b.name, address: b.address,
      }))))
      .catch(() => { /* unauth → middleware przekieruje */ })
  }, [])

  const handleToolClick = (id: ToolCardData['id']) => {
    if (id === 'lan-scan')    setLanScanOpen(true)
    if (id === 'diagnostics') setDiagnosticsOpen(true)
    if (id === 'health')      setHealthOpen(true)
    if (id === 'export')      setExportOpen(true)
    // firmware — Sesja 7+ (wymaga Edge protokołu)
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-ink">Narzędzia</h1>
        <p className="text-[13px] text-muted mt-1">
          Diagnostyka, masowe operacje, eksport konfiguracji
        </p>
      </div>

      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}
      >
        {TOOLS.map((tool) => (
          <ToolCard key={tool.id} tool={tool} onClick={() => handleToolClick(tool.id)} />
        ))}
      </div>

      {/* Helper note — tylko FW jeszcze niedostępne */}
      <div className="mt-8 p-4 bg-surface-2 border border-border rounded-r3 flex items-start gap-3">
        <Construction size={18} strokeWidth={1.8} className="text-muted-2 flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-[13px] font-semibold text-ink-2">Bulk firmware update — Sesja 6+</p>
          <p className="text-[12px] text-muted mt-1 leading-relaxed">
            Wymaga rozszerzenia Edge protokołu — signed binary upload + stage rollout protocol.
            Skaner LAN, Diagnostyka i Eksport JSON są już aktywne.
          </p>
        </div>
      </div>

      <LanScanModal
        open={lanScanOpen}
        onClose={() => setLanScanOpen(false)}
        buildings={buildings}
      />
      <DiagnosticsModal
        open={diagnosticsOpen}
        onClose={() => setDiagnosticsOpen(false)}
        buildings={buildings}
      />
      <ExportConfigModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        buildings={buildings}
      />
      <HealthReportModal
        open={healthOpen}
        onClose={() => setHealthOpen(false)}
      />
    </div>
  )
}

function ToolCard({ tool, onClick }: { tool: ToolCardData; onClick: () => void }) {
  const Icon = tool.icon
  const [hover, setHover] = useState(false)
  const isAvailable = tool.status === 'available'

  return (
    <button
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={isAvailable ? onClick : undefined}
      disabled={!isAvailable}
      className={`text-left bg-surface border border-border rounded-r3 p-5 transition-all ${
        isAvailable ? 'hover:border-brand hover:shadow-sm cursor-pointer' : 'opacity-60 cursor-not-allowed'
      }`}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="w-10 h-10 rounded-r2 bg-brand-50 flex items-center justify-center">
          <Icon size={18} strokeWidth={1.8} className="text-brand" />
        </div>
        {!isAvailable && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-r1 bg-warn-50 text-warn border border-warn/30 text-[10px] font-semibold">
            Wkrótce
          </span>
        )}
      </div>
      <h3 className="text-[14px] font-semibold text-ink mb-1">{tool.title}</h3>
      <p className="text-[12px] text-muted leading-relaxed mb-4">{tool.description}</p>
      <span
        className={`inline-flex items-center gap-1 text-[12px] font-medium transition-colors ${
          isAvailable
            ? hover ? 'text-brand-600' : 'text-brand'
            : 'text-muted-2'
        }`}
      >
        {tool.cta}
        <ArrowRight size={12} strokeWidth={2} />
      </span>
    </button>
  )
}
