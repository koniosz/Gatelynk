/**
 * Wspólne typy dla Panel Integratora — PropertyPage i submoduły.
 *
 * Backend zwraca data shape z istniejących endpointów `/integrator/buildings/*`.
 * Tu trzymamy interfejsy w jednym miejscu zamiast wszędzie `any`. Zdefiniowane
 * minimalnie — pola które naprawdę używamy. Bez over-engineeringu.
 */

// 2026-06-02 (FAZA b) — Universal object types. Wartości i flagi muszą być
// zsynchronizowane z `apps/api/src/buildings/buildings.constants.ts`.
export type ObjectType =
  | 'BUILDING'
  | 'HOUSING_ESTATE'
  | 'MIXED_USE'
  | 'CAMPUS'
  | 'PARKING'

export interface BuildingFeatures {
  has_concierge: boolean
  has_central_mailbox: boolean
  delivery_to_door: boolean
  has_security_guard: boolean
  has_common_parking: boolean
}

export const OBJECT_TYPE_LABELS: Record<ObjectType, string> = {
  BUILDING: 'Budynek wielorodzinny',
  HOUSING_ESTATE: 'Osiedle domów',
  MIXED_USE: 'Wielofunkcyjny (sklepy + mieszkania)',
  CAMPUS: 'Kampus / wielobudynkowe',
  PARKING: 'Tylko parking',
}

export const DEFAULT_FEATURES: Record<ObjectType, BuildingFeatures> = {
  BUILDING: {
    has_concierge: true,
    has_central_mailbox: true,
    delivery_to_door: false,
    has_security_guard: false,
    has_common_parking: true,
  },
  HOUSING_ESTATE: {
    has_concierge: false,
    has_central_mailbox: false,
    delivery_to_door: true,
    has_security_guard: true,
    has_common_parking: false,
  },
  MIXED_USE: {
    has_concierge: true,
    has_central_mailbox: true,
    delivery_to_door: false,
    has_security_guard: true,
    has_common_parking: true,
  },
  CAMPUS: {
    has_concierge: false,
    has_central_mailbox: false,
    delivery_to_door: true,
    has_security_guard: true,
    has_common_parking: false,
  },
  PARKING: {
    has_concierge: false,
    has_central_mailbox: false,
    delivery_to_door: false,
    has_security_guard: false,
    has_common_parking: true,
  },
}

export const FEATURE_LABELS: Record<keyof BuildingFeatures, string> = {
  has_concierge: 'Konsjerż',
  has_central_mailbox: 'Centralna paczkarnia',
  delivery_to_door: 'Dostawa pod dom',
  has_security_guard: 'Ochrona fizyczna',
  has_common_parking: 'Parking wspólny',
}

export interface Building {
  id: number
  name: string
  address: string
  objectType?: ObjectType | string
  features?: BuildingFeatures | null
  stairwells?: { id: number }[]
  hasEdge?: boolean
  hasIntercom?: boolean
  hasLprSystem?: boolean
  hasCctv?: boolean
  hasLightingControl?: boolean
  hasEdgeAI?: boolean
  hasPhotovoltaics?: boolean
  hasSmartBuilding?: boolean
  packageHandling?: 'NONE' | 'LOCKER' | 'CONCIERGE' | string
}

export interface Intercom {
  id: number
  name: string
  model?: string
  edgeDeviceId?: string | null
  ipAddress?: string | null
  sipAccount?: string | null
  sipPassword?: string | null
  /**
   * Multi-station call bridge (2026-07-05) — most rozmów domofon↔apka dla tej
   * stacji (Janus na Edge). Wiele stacji per budynek może mieć true; iOS
   * pokazuje wtedy wybór stacji przy połączeniu wychodzącym.
   */
  bridgeEnabled?: boolean
}

// FAZA 8.h (2026-06-03) — Camera role + AI toggle.
// Mirror konstantów z `apps/api/src/cameras/cameras.constants.ts`.
export type CameraRole = 'STANDARD' | 'LPR'

export const CAMERA_ROLE_LABELS: Record<CameraRole, string> = {
  STANDARD: 'Kamera wizyjna',
  LPR: 'Kamera LPR',
}

export interface LprCamera {
  id: number
  name: string
  manufacturer?: string
  model?: string
  edgeDeviceId?: string | null
  ipAddress?: string | null
  login?: string | null
  password?: string | null
  linkedIntercomEdgeId?: string | null
  linkedRelayIndex?: number | null
  // FAZA 8.h — rozdzielenie typu. Backend zawsze zwraca te pola (default
  // 'LPR' + true dla pre-8.h rekordów). Optional w typie żeby nie wybuchać
  // starym backend response-em.
  role?: CameraRole
  aiAnalysisEnabled?: boolean
}

export interface EdgeAppliance {
  id: string  // CUID z Prisma EdgeDevice
  name?: string
  ipAddress?: string | null
  version?: string | null
  lastSeenAt?: string | null
  isOnline?: boolean
}

export interface EdgeDevice {
  deviceId: string
  type: 'INTERCOM' | 'CAMERA' | 'LPR_CAMERA' | 'ELEVATOR' | 'LIGHTING' | 'SWITCH' | 'LAN_SWITCH' | 'KNX_BRIDGE' | string
  status: 'online' | 'offline' | string
  config: {
    name?: string
    manufacturer?: string
    model?: string
    ipAddress?: string
    relays?: Array<{ index: number; name: string }>
    doorRelayIndex?: number
    [key: string]: unknown
  }
}

export interface DeviceTreeGroup {
  type: string
  label: string
  icon: string
  devices: DeviceTreeNode[]
}

export interface DeviceTreeNode {
  deviceId: string
  name: string
  manufacturer?: string
  model?: string
  ipAddress?: string | null
  online?: boolean
  relays?: Array<{ index: number; name: string }>
}

export type ActionState = 'idle' | 'loading' | 'ok' | 'err'
