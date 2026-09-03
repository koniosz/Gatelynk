/**
 * Shared types + helpers dla `anomaly_events` feed (BA + Concierge).
 * Source of truth dla typu eventu po stronie web — backend zwraca string,
 * tu mapujemy na human-readable label + ikonę + kolor.
 */
import { formatBuildingTime } from './time'

export interface AnomalyEvent {
  id: string                // BigInt jako string
  buildingId: number
  cameraDeviceId: string
  ts: string                // ISO 8601
  type: string              // 'FALL' | (przyszłość: 'FIRE', 'INTRUSION')
  likelihood: number        // 0.0–1.0
  indicators: string[]
  imageFilename: string | null
  resolvedAt: string | null
  resolvedBy: string | null
  falsePositive: boolean
  createdAt: string
}

export interface AnomalyEventsResponse {
  events: AnomalyEvent[]
  total: number
  sinceMs: number
  sinceHours: number
}

export const TYPE_LABEL: Record<string, string> = {
  FALL: 'Możliwy upadek',
  FIRE: 'Wykryto pożar',
  INTRUSION: 'Możliwa intruzja',
}

export const TYPE_ICON: Record<string, string> = {
  FALL: '🚨',
  FIRE: '🔥',
  INTRUSION: '⚠️',
}

export const INDICATOR_LABEL: Record<string, string> = {
  horizontal_bbox: 'Sylwetka pozioma',
  head_below_hips: 'Głowa poniżej bioder',
  vertical_shoulders: 'Pionowy układ ramion',
  low_in_frame: 'Niska pozycja w kadrze',
}

export function indicatorLabel(key: string): string {
  return INDICATOR_LABEL[key] ?? key.replace(/_/g, ' ')
}

export function formatTs(iso: string): string {
  // Czas w strefie Edge (Europe/Warsaw), patrz `lib/time.ts`.
  return formatBuildingTime(iso, 'datetime-sec')
}

export function relativeTime(iso: string): string {
  const d = new Date(iso)
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return 'przed chwilą'
  if (diff < 3600) return `${Math.floor(diff / 60)} min temu`
  if (diff < 86400) return `${Math.floor(diff / 3600)} h temu`
  return `${Math.floor(diff / 86400)} dni temu`
}

/** Status badge: open / resolved / false-positive. */
export function statusOf(ev: AnomalyEvent): 'OPEN' | 'RESOLVED' | 'FALSE_POSITIVE' {
  if (ev.falsePositive) return 'FALSE_POSITIVE'
  if (ev.resolvedAt) return 'RESOLVED'
  return 'OPEN'
}

export const STATUS_BADGE: Record<ReturnType<typeof statusOf>, { label: string; cls: string }> = {
  OPEN:           { label: 'Nieobsłużone',  cls: 'bg-red-100 text-red-700 border-red-300' },
  RESOLVED:       { label: 'Obsłużone',      cls: 'bg-blue-100 text-blue-700 border-blue-300' },
  FALSE_POSITIVE: { label: 'Fałszywy alarm', cls: 'bg-gray-100 text-gray-600 border-gray-300' },
}
