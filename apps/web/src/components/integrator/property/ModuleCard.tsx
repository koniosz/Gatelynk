'use client'
/**
 * ModuleCard — generic kafelek modułu w PropertyPage (handoff §5).
 *
 * Layout:
 *   ┌────────────────────────────────────────────┐
 *   │ [icon] Nazwa modułu       [status pill]    │ header
 *   │ N urządzeń · M online                       │ mini-stat
 *   ├────────────────────────────────────────────┤
 *   │ [Konfiguracja] [Sterowanie]                │ subtabs
 *   │                                            │
 *   │ {children}                                 │ body
 *   │                                            │
 *   ├────────────────────────────────────────────┤
 *   │ [+ Dodaj urządzenie]                       │ footer (opcjonalny)
 *   └────────────────────────────────────────────┘
 *
 * Subtabs są CONTROLLED z parent — moduł renderuje różne childrn dla
 * Konfiguracja vs Sterowanie. Status pill ma 3 warianty (configured/needs/active)
 * pełniący rolę handoff `<ModuleCard>` z handoff §5.
 */
import type { ReactNode } from 'react'
import { Check, AlertTriangle, Zap, Plus } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export type ModuleStatus = 'configured' | 'needs' | 'active'

interface ModuleCardProps {
  icon: LucideIcon
  title: string
  status?: ModuleStatus
  /** Mini-stat row pod tytułem — np. „4 urządzenia · 3 online". */
  stat?: string
  /** Currently active subtab. */
  activeTab: 'Konfiguracja' | 'Sterowanie'
  onTabChange: (tab: 'Konfiguracja' | 'Sterowanie') => void
  children: ReactNode
  /** „+ Dodaj urządzenie" — full-width footer button (opcjonalny). */
  onAddClick?: () => void
  addLabel?: string
}

const STATUS_META: Record<ModuleStatus, { label: string; icon: LucideIcon; cls: string }> = {
  configured: {
    label: 'Skonfigurowano',
    icon: Check,
    cls: 'bg-success-50 text-success border-success/40',
  },
  needs: {
    label: 'Wymaga konfiguracji',
    icon: AlertTriangle,
    cls: 'bg-warn-50 text-warn border-warn/40',
  },
  active: {
    label: 'Aktywna',
    icon: Zap,
    cls: 'bg-brand-50 text-brand border-brand/30',
  },
}

export function ModuleCard({
  icon: Icon, title, status, stat,
  activeTab, onTabChange,
  children, onAddClick, addLabel = '+ Dodaj urządzenie',
}: ModuleCardProps) {
  const StatusIcon = status ? STATUS_META[status].icon : null

  return (
    <div className="bg-surface border border-border rounded-r3 overflow-hidden flex flex-col">
      {/* Header */}
      <div className="px-5 py-4 border-b border-border">
        <div className="flex items-center justify-between gap-3 mb-1">
          <div className="flex items-center gap-2.5 min-w-0">
            <Icon size={18} strokeWidth={1.8} className="text-ink-2 flex-shrink-0" />
            <h3 className="text-[14px] font-semibold text-ink truncate">{title}</h3>
          </div>
          {status && StatusIcon && (
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-r1 text-[10px] font-semibold border ${STATUS_META[status].cls}`}
            >
              <StatusIcon size={10} strokeWidth={2.5} />
              {STATUS_META[status].label}
            </span>
          )}
        </div>
        {stat && (
          <p className="text-[11px] text-muted">{stat}</p>
        )}
      </div>

      {/* Subtabs */}
      <div className="flex bg-surface-2 px-3 pt-2">
        {(['Konfiguracja', 'Sterowanie'] as const).map((t) => (
          <button
            key={t}
            onClick={() => onTabChange(t)}
            className={`px-3 py-1.5 text-[12px] font-medium rounded-t-r1 transition-colors ${
              activeTab === t
                ? 'bg-surface text-ink border-t border-x border-border'
                : 'text-muted hover:text-ink-2'
            }`}
            style={activeTab === t ? { marginBottom: -1 } : undefined}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="p-5 flex-1 border-t border-border -mt-px">
        {children}
      </div>

      {/* Footer add button */}
      {onAddClick && (
        <button
          onClick={onAddClick}
          className="border-t border-border px-5 py-3 text-[12px] font-medium text-brand hover:bg-brand-50 transition-colors flex items-center justify-center gap-1.5"
        >
          <Plus size={14} strokeWidth={2} />
          {addLabel}
        </button>
      )}
    </div>
  )
}

/**
 * ComingSoon placeholder — używamy dla nieukończonych modułów w subtabie
 * „Sterowanie" lub w całych modułach (CCTV, Lighting, …).
 */
export function ComingSoonBlock({ name, icon: Icon }: { name: string; icon?: LucideIcon }) {
  return (
    <div className="flex items-center gap-4 py-6 px-4 bg-surface-2 rounded-r2 border border-dashed border-border">
      {Icon && <Icon size={28} strokeWidth={1.5} className="text-muted-2 flex-shrink-0" />}
      <div>
        <p className="text-[13px] font-semibold text-muted">Sterowanie {name} — wkrótce</p>
        <p className="text-[11px] text-muted-2 mt-0.5">Moduł jest w trakcie realizacji</p>
      </div>
    </div>
  )
}
