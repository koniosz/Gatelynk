'use client'
/**
 * PropertiesPage (handoff §5 `<PropertiesPage>`).
 *
 * Lista obiektów integratora. Grid `auto-fill, minmax(380px, 1fr)`.
 * Per kartę:
 *   - ikona typu (Building/Parking/Estate/AparthHotel)
 *   - nazwa + adres
 *   - KPI row: klatki / lokale / Edge online
 *   - pille modułów aktywnych (LPR, Domofon)
 *
 * IBM Plex Sans + tokeny + Lucide. Aktywny obiekt jest CZYSZCZONY przy mount
 * (user wraca z detal-u do listy = traci kontekst, ale Sidebar wciąż wie żeby
 * NIE pokazywać sekcji „Aktywny obiekt"). Detail page sam set-uje.
 */
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Building2, ParkingSquare, Home, Hotel, Car, Bell, Server, AlertTriangle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { integratorApi } from '@/lib/integrator-api'
import { useActiveProperty } from '@/components/integrator/active-property-context'

interface Building {
  id: number
  name: string
  address: string
  objectType?: 'BUILDING' | 'PARKING' | 'ESTATE' | 'APART_HOTEL'
  stairwells?: { id: number }[]
  hasLprSystem?: boolean
  hasIntercom?: boolean
  edgeOnline?: boolean   // optional w starym API, dodamy w nast. sesji
  unitsCount?: number    // jak wyżej
}

const TYPE_ICONS: Record<string, LucideIcon> = {
  BUILDING:    Building2,
  PARKING:     ParkingSquare,
  ESTATE:      Home,
  APART_HOTEL: Hotel,
}

const TYPE_LABELS: Record<string, string> = {
  BUILDING:    'Budynek',
  PARKING:     'Parking',
  ESTATE:      'Osiedle',
  APART_HOTEL: 'Aparthotel',
}

export default function IntegratorBuildingsPage() {
  const router = useRouter()
  const { clear: clearActive } = useActiveProperty()
  const [buildings, setBuildings] = useState<Building[]>([])
  const [loading, setLoading] = useState(true)

  // Czyść aktywny obiekt przy wejściu na listę
  useEffect(() => { clearActive() }, [clearActive])

  // Fetch + reagowanie na refresh button w Topbar
  useEffect(() => {
    const fetchAll = () => {
      setLoading(true)
      integratorApi.get('/integrator/buildings')
        .then((r) => setBuildings(r.data))
        .catch(() => router.push('/integrator/login'))
        .finally(() => setLoading(false))
    }
    fetchAll()
    const onRefresh = () => fetchAll()
    window.addEventListener('integrator:refresh', onRefresh)
    return () => window.removeEventListener('integrator:refresh', onRefresh)
  }, [router])

  return (
    <div className="max-w-7xl mx-auto">
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-ink">Obiekty</h1>
          <p className="text-[13px] text-muted mt-1">
            {loading
              ? 'Ładowanie…'
              : `${buildings.length} ${pluralizeObjects(buildings.length)} w portfolio`}
          </p>
        </div>
      </div>

      {/* Empty / Loading / Grid */}
      {loading ? (
        <LoadingGrid />
      ) : buildings.length === 0 ? (
        <EmptyState />
      ) : (
        <div
          className="grid gap-4"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))' }}
        >
          {buildings.map((b) => (
            <PropertyCard key={b.id} building={b} />
          ))}
        </div>
      )}
    </div>
  )
}

function PropertyCard({ building: b }: { building: Building }) {
  const Icon = TYPE_ICONS[b.objectType ?? 'BUILDING'] ?? Building2
  const typeLabel = TYPE_LABELS[b.objectType ?? 'BUILDING'] ?? 'Obiekt'
  const stairwellsCount = b.stairwells?.length ?? 0

  return (
    <Link
      href={`/integrator/buildings/${b.id}`}
      className="block bg-surface border border-border rounded-r3 p-5 hover:border-brand hover:shadow-sm transition-all group"
    >
      {/* Header — ikona + nazwa + typ */}
      <div className="flex items-start gap-3 mb-4">
        <div className="w-10 h-10 rounded-r2 bg-brand-50 flex items-center justify-center flex-shrink-0">
          <Icon size={20} strokeWidth={1.8} className="text-brand" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <h3 className="font-semibold text-ink truncate">{b.name}</h3>
          </div>
          <p className="text-[12px] text-muted truncate">{b.address}</p>
          <p className="text-[10px] text-muted-2 uppercase tracking-wider mt-1">{typeLabel}</p>
        </div>
      </div>

      {/* KPI row */}
      <div className="flex items-center gap-4 text-[12px] text-ink-2 mb-3">
        <KpiItem icon={Building2} value={stairwellsCount} label={stairwellsCount === 1 ? 'klatka' : 'klatek'} />
        {typeof b.unitsCount === 'number' && (
          <KpiItem icon={Home} value={b.unitsCount} label="lokali" />
        )}
        {b.edgeOnline !== undefined && (
          <div className="flex items-center gap-1.5 ml-auto">
            <div
              className={`w-1.5 h-1.5 rounded-full ${b.edgeOnline ? 'bg-success' : 'bg-danger'}`}
            />
            <span className="text-[11px] text-muted">
              Edge {b.edgeOnline ? 'online' : 'offline'}
            </span>
          </div>
        )}
      </div>

      {/* Pille modułów aktywnych */}
      {(b.hasLprSystem || b.hasIntercom) && (
        <div className="flex gap-1.5 flex-wrap">
          {b.hasLprSystem && <ModulePill icon={Car} label="LPR" />}
          {b.hasIntercom && <ModulePill icon={Bell} label="Domofon" />}
        </div>
      )}
    </Link>
  )
}

function KpiItem({ icon: Icon, value, label }: { icon: LucideIcon; value: number; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <Icon size={13} strokeWidth={1.8} className="text-muted-2" />
      <span className="font-semibold text-ink">{value}</span>
      <span className="text-muted">{label}</span>
    </div>
  )
}

function ModulePill({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-r1 bg-surface-2 border border-border text-[11px] text-ink-2">
      <Icon size={11} strokeWidth={2} />
      {label}
    </span>
  )
}

function EmptyState() {
  return (
    <div className="bg-surface border border-border rounded-r3 p-12 text-center">
      <Server size={40} strokeWidth={1.5} className="text-muted-2 mx-auto mb-4" />
      <h3 className="text-base font-semibold text-ink mb-1">Brak obiektów</h3>
      <p className="text-[13px] text-muted">
        Nie masz jeszcze przypisanych obiektów. Skontaktuj się z administratorem GateLynk.
      </p>
    </div>
  )
}

function LoadingGrid() {
  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))' }}>
      {[1, 2, 3].map((i) => (
        <div key={i} className="bg-surface border border-border rounded-r3 p-5 animate-pulse">
          <div className="flex items-start gap-3 mb-4">
            <div className="w-10 h-10 rounded-r2 bg-surface-2" />
            <div className="flex-1 space-y-2">
              <div className="h-4 bg-surface-2 rounded w-3/4" />
              <div className="h-3 bg-surface-2 rounded w-1/2" />
            </div>
          </div>
          <div className="h-3 bg-surface-2 rounded w-1/3" />
        </div>
      ))}
    </div>
  )
}

function pluralizeObjects(n: number): string {
  if (n === 1) return 'obiekt'
  if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) return 'obiekty'
  return 'obiektów'
}
