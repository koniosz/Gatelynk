/**
 * Mapowanie typu urządzenia (`DeviceType`) na ikonę Lucide i klucz i18n label-a.
 *
 * Z handoff doc sek. 4: „Brak emoji w UI. Tylko ikony z biblioteki." — używamy
 * `lucide-react` exclusively.
 *
 * Label zwracany jest jako KLUCZ i18n (`'deviceType.CAMERA'`), nie surowy string —
 * callerzy resolve-ują przez `t()` z `useTranslation`. Wcześniejsza wersja
 * zwracała hardcoded „Kamera IP"/„Domofon" co psuło przełącznik PL/EN.
 *
 * Dla wygody dodany jest hook `useDeviceLabel(type)` — gdy komponent już używa
 * `useTranslation`, można po prostu zrobić `t(deviceMeta(type).labelKey)`.
 */
import {
  Bell,         // INTERCOM
  Camera,       // CAMERA
  Car,          // LPR_CAMERA
  ArrowUpDown,  // ELEVATOR
  Lightbulb,    // LIGHTING / KNX_OBJECT
  Power,        // SWITCH
  Network,      // LAN_SWITCH
  Lock,         // LOCK
  Cpu,          // KNX_BRIDGE
  Cog,          // fallback
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { DeviceType } from './types'

interface DeviceMeta {
  icon: LucideIcon
  /** Klucz i18n (np. `'deviceType.CAMERA'`). Resolve przez `t()`. */
  labelKey: string
}

const TYPE_META: Record<DeviceType, DeviceMeta> = {
  INTERCOM:   { icon: Bell,        labelKey: 'deviceType.INTERCOM' },
  CAMERA:     { icon: Camera,      labelKey: 'deviceType.CAMERA' },
  LPR_CAMERA: { icon: Car,         labelKey: 'deviceType.LPR_CAMERA' },
  ELEVATOR:   { icon: ArrowUpDown, labelKey: 'deviceType.ELEVATOR' },
  LIGHTING:   { icon: Lightbulb,   labelKey: 'deviceType.LIGHTING' },
  SWITCH:     { icon: Power,       labelKey: 'deviceType.SWITCH' },
  LAN_SWITCH: { icon: Network,     labelKey: 'deviceType.LAN_SWITCH' },
  LOCK:       { icon: Lock,        labelKey: 'deviceType.LOCK' },
  KNX_BRIDGE: { icon: Cpu,         labelKey: 'deviceType.KNX_BRIDGE' },
  KNX_OBJECT: { icon: Lightbulb,   labelKey: 'deviceType.KNX_OBJECT' },
}

export function deviceMeta(type: DeviceType): DeviceMeta {
  return TYPE_META[type] ?? { icon: Cog, labelKey: 'deviceType.unknown' }
}

/**
 * Krótki MAC display (ostatnie 8 znaków, uppercase, z `:`).
 *  - "B0:1F:81:AB:CD:EF" → "AB:CD:EF"
 *  - "B01F81ABCDEF"      → "AB:CD:EF"
 */
export function shortMac(mac?: string): string {
  if (!mac) return '—'
  const norm = mac.replace(/[^0-9A-Fa-f]/g, '').toUpperCase()
  if (norm.length < 6) return mac
  const last = norm.slice(-6)
  return `${last.slice(0, 2)}:${last.slice(2, 4)}:${last.slice(4, 6)}`
}
