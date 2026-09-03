// Shared types for Devices tab (ba-v2).
// Endpoints used:
//   GET /building-admin/buildings/:id/devices → DevicesResponse
//   GET /building-admin/buildings/:id/access-points → AccessPoint[]

export interface EdgeDevice {
  id: string;
  buildingId: number;
  type: string;
  name: string | null;
  isActivated: boolean;
  activatedAt: string | null;
  lastSeenAt: string | null;
  ipAddress: string | null;
  version: string | null;
  createdAt: string;
  online: boolean;
  outbox: { pending: number; failed: number };
}

export interface IntercomDevice {
  id: number;
  name: string;
  model: string | null;
  ipAddress: string | null;
  edgeDeviceId: string | null;
  online: boolean;
}

export interface CameraDevice {
  id: number;
  name: string;
  manufacturer: string;
  model: string | null;
  ipAddress: string | null;
  edgeDeviceId: string | null;
  whitelistMode: string;
  online: boolean;
  // 2026-06-02 — z `edge_device_mirror`, używane do `PATCH .../linked-ap`.
  deviceUuid?: string | null;
  linkedAccessPointId?: number | null;
}

export interface DevicesResponse {
  edges: EdgeDevice[];
  intercoms: IntercomDevice[];
  cameras: CameraDevice[];
}

export interface AccessPoint {
  id: number;
  buildingId: number;
  label: string;
  icon: string;
  edgeDeviceId: string | null;
  deviceId: string;
  relayIndex: number;
  isActive: boolean;
  sortOrder: number;
  // Refactor 2026-06-01 — binding/scope/duration:
  outputDeviceId?: string | null;
  outputIndex?: number | null;
  durationMs?: number;
  scope?: "PUBLIC" | "RESIDENT" | "ADMIN_ONLY";
}

export interface AccessPointSchedule {
  id: number;
  accessPointId: number;
  cronExpr: string;
  label: string | null;
  enabled: boolean;
  lastFiredAt: string | null;
}
