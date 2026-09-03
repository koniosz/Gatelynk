// 2026-06-03 (FAZA 8.h) — Camera role constants.
//
// Każda kamera w `lpr_cameras` ma `role`:
//   STANDARD — kamera wizyjna (CCTV / vision AI). NIE bindowana do AP, nie
//              wyzwala bramy. Może być analizowana przez VisionDetectService
//              (yolov8 / OCR brand) jeśli `aiAnalysisEnabled=true`.
//   LPR      — kamera rozpoznawania tablic. Może mieć linkedIntercom/linkedRelay
//              lub powiązania w `lpr_camera_ap_links` (FAZA c).
//
// Źródło prawdy dla TypeScript + walidacji. Mirror w `apps/web/src/components/
// integrator/property/types.ts` (CameraRole + CAMERA_ROLE_LABELS).

export const CAMERA_ROLES = ['STANDARD', 'LPR'] as const
export type CameraRole = (typeof CAMERA_ROLES)[number]

export const CAMERA_ROLE_LABELS: Record<CameraRole, string> = {
  STANDARD: 'Kamera wizyjna',
  LPR: 'Kamera LPR (rozpoznawanie tablic)',
}

export function isCameraRole(value: unknown): value is CameraRole {
  return typeof value === 'string' && (CAMERA_ROLES as readonly string[]).includes(value)
}
