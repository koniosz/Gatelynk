/**
 * Inline SVG icons port z `Guest Invite.html`. Wszystkie 24x24 viewBox,
 * stroke-based 1.8-2px, z `currentColor` żeby kolor brał z parent-a (`access-icon.fire`,
 * `pin-icon` itd.).
 */
import { SVGProps } from 'react'

type Props = SVGProps<SVGSVGElement> & { size?: number }

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
})

export const IconShield = ({ size = 12, ...p }: Props) => (
  <svg {...base(size)} strokeWidth={2} {...p}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
)

/** Kłódka — chip „Bezpieczne zaproszenie" (wzorzec z Guest Invite.html). */
export const IconLock = ({ size = 12, ...p }: Props) => (
  <svg {...base(size)} strokeWidth={2.2} {...p}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
)

/** Strzałka nawigacji (paper-plane) — przycisk „Nawiguj". */
export const IconNavigate = ({ size = 17, ...p }: Props) => (
  <svg {...base(size)} strokeWidth={2} {...p}>
    <path d="M3 11l18-8-8 18-2-8-8-2Z" />
  </svg>
)

export const IconGate = ({ size = 22, ...p }: Props) => (
  <svg {...base(size)} strokeWidth={1.9} {...p}>
    <path d="M3 21V8m18 13V8M3 8h18M7 13v8M11 13v8M15 13v8" />
  </svg>
)

export const IconDoor = ({ size = 22, ...p }: Props) => (
  <svg {...base(size)} strokeWidth={1.9} {...p}>
    <rect x="6" y="3" width="12" height="18" rx="1.5" />
    <circle cx="15" cy="12" r="0.8" fill="currentColor" />
  </svg>
)

export const IconElevator = ({ size = 22, ...p }: Props) => (
  <svg {...base(size)} strokeWidth={1.9} {...p}>
    <rect x="5" y="3" width="14" height="18" rx="2" />
    <path d="M9 9l3-3 3 3M9 15l3 3 3-3" />
  </svg>
)

export const IconHome = ({ size = 22, ...p }: Props) => (
  <svg {...base(size)} strokeWidth={1.9} {...p}>
    <path d="M3 11 12 3l9 8" />
    <path d="M5 10v10h14V10" />
    <path d="M10 20v-6h4v6" />
  </svg>
)

/** Klucz — drzwi mieszkania (zamek Nuki, UNIT_DOOR). */
export const IconKey = ({ size = 22, ...p }: Props) => (
  <svg {...base(size)} strokeWidth={1.9} {...p}>
    <circle cx="7.5" cy="15.5" r="4.5" />
    <path d="M10.8 12.2 21 2" />
    <path d="M15 8l3 3" />
    <path d="M18.5 4.5l2 2" />
  </svg>
)

export const IconFire = ({ size = 22, ...p }: Props) => (
  <svg {...base(size)} strokeWidth={1.9} {...p}>
    <path d="M12 3c1.5 3 4 5 4 8a4 4 0 0 1-8 0c0-2 1-3 2-4" />
    <path d="M12 21a3 3 0 0 0 3-3c0-2-3-3-3-5" />
  </svg>
)

export const IconWarning = ({ size = 18, ...p }: Props) => (
  <svg {...base(size)} strokeWidth={2} {...p}>
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
    <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
  </svg>
)

export const IconEye = ({ size = 18, ...p }: Props) => (
  <svg {...base(size)} strokeWidth={1.8} {...p}>
    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

export const IconCopy = ({ size = 18, ...p }: Props) => (
  <svg {...base(size)} strokeWidth={1.8} {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
)

export const IconCheck = ({ size = 14, ...p }: Props) => (
  <svg {...base(size)} strokeWidth={2} {...p}>
    <path d="M20 6 9 17l-5-5" />
  </svg>
)

export const IconClock = ({ size = 12, ...p }: Props) => (
  <svg {...base(size)} strokeWidth={2} {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
)

export const IconArrowRight = ({ size = 13, ...p }: Props) => (
  <svg {...base(size)} strokeWidth={2} {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
)

/** Hand wave emoji jako Unicode — używamy w hero greeting "Cześć, Marek 👋" */
export const HandWave = () => <span aria-hidden>👋</span>
