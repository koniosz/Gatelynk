/**
 * AddDeviceMenu — dropdown z opcjami dodawania urządzenia.
 *
 * 2026-05-15: zmigrowane na nowy WizardPage (React, `/ui/wizard`). Stary
 * Alpine.js wizard (`/ui-legacy/wizard.html`) jest jeszcze dostępny przez
 * `legacyPublic` w `main.ts` dla wstecznej kompatybilności, ale nowe sesje
 * korzystają z `/ui/wizard?type=...`.
 */
import { useState, useRef, useEffect } from 'react'
import { Plus, ChevronDown, Bell, Camera, Car, Power, Cpu, Network } from 'lucide-react'

const WIZARD_BASE = '/ui/wizard'

export function AddDeviceMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const options = [
    { type: 'INTERCOM',   label: 'Domofon',           icon: Bell },
    { type: 'CAMERA',     label: 'Kamera IP',         icon: Camera },
    { type: 'LPR_CAMERA', label: 'Kamera LPR',        icon: Car },
    { type: 'SWITCH',     label: 'Przekaźnik (Shelly)', icon: Power },
    { type: 'LAN_SWITCH', label: 'Switch LAN (UniFi)',  icon: Network },
    { type: 'KNX_BRIDGE', label: 'KNX-IP Bridge',     icon: Cpu },
  ] as const

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        className="btn btn-primary"
        onClick={() => setOpen(!open)}
        title="Otwórz wizard dodawania urządzenia"
      >
        <Plus size={16} strokeWidth={2.5} />
        Dodaj urządzenie
        <ChevronDown size={14} strokeWidth={2.5} />
      </button>

      {open && (
        <div style={{
          position: 'absolute',
          right: 0,
          top: '100%',
          marginTop: 4,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-3)',
          boxShadow: 'var(--shadow-2)',
          minWidth: 220,
          padding: 4,
          zIndex: 50,
        }}>
          {options.map((opt) => {
            const Icon = opt.icon
            return (
              <a
                key={opt.type}
                href={`${WIZARD_BASE}?type=${opt.type}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 12px',
                  borderRadius: 'var(--r-2)',
                  fontSize: 13,
                  color: 'var(--ink)',
                  textDecoration: 'none',
                  transition: 'background 80ms',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                onClick={() => setOpen(false)}
              >
                <Icon size={16} strokeWidth={1.8} style={{ color: 'var(--muted)' }} />
                {opt.label}
              </a>
            )
          })}
          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
          <a
            href={WIZARD_BASE}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 12px',
              borderRadius: 'var(--r-2)',
              fontSize: 12,
              color: 'var(--muted)',
              textDecoration: 'none',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            onClick={() => setOpen(false)}
          >
            Pełny wizard (wszystkie typy + discovery) →
          </a>
        </div>
      )}
    </div>
  )
}
