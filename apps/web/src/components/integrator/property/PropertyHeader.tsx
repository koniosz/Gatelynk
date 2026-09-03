'use client'
/**
 * PropertyHeader — sticky-ish header dla PropertyPage.
 * Zawiera back-link, ikonę typu obiektu, nazwę, adres.
 *
 * Aktywny obiekt jest ustawiany w ActivePropertyContext przez `useEffect`
 * w PropertyPage parent — TopBar i Sidebar pokażą kontekst.
 */
import Link from 'next/link'
import { ArrowLeft, Building2, ParkingSquare, Home, Hotel } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Building } from './types'

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

export function PropertyHeader({ building }: { building: Building }) {
  const Icon = TYPE_ICONS[building.objectType ?? 'BUILDING'] ?? Building2
  const typeLabel = TYPE_LABELS[building.objectType ?? 'BUILDING'] ?? 'Obiekt'

  return (
    <div className="mb-6">
      <Link
        href="/integrator/buildings"
        className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink transition-colors mb-3"
      >
        <ArrowLeft size={12} strokeWidth={2} />
        Obiekty
      </Link>

      <div className="flex items-start gap-3">
        <div className="w-12 h-12 rounded-r2 bg-brand-50 flex items-center justify-center flex-shrink-0">
          <Icon size={24} strokeWidth={1.8} className="text-brand" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-semibold text-ink leading-tight">{building.name}</h1>
          <p className="text-[13px] text-muted mt-0.5">{building.address}</p>
          <p className="text-[10px] text-muted-2 uppercase tracking-wider mt-1">{typeLabel}</p>
        </div>
      </div>
    </div>
  )
}
