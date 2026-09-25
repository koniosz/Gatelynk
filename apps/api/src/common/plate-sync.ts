import { formatUnitLabel } from './unit-label'
import type { VehicleRow } from '../building-admin/building-admin.service'

/**
 * Pełny payload `PLATE_UPSERT` dla pojazdu — JEDNA definicja dla ścieżek
 * mieszkańca i konsjerża (BA ma równoważny `buildPlateSyncPayload`).
 *
 * Dlaczego pełny: Edge zapisuje wpis przez `INSERT OR REPLACE` — częściowy
 * payload (np. samo `{plate, owner}` po zmianie koloru albo przełączeniu
 * powiadomień) KASOWAŁ na Edge etykietę lokalu, typ, tagi i okno ważności
 * (błąd wykryty 2026-09-25 przy dodawaniu przełącznika `autoOpen`).
 *
 * Konwencje jak w BA: `unitLabel` = jawny lokal pojazdu, dla RESIDENT
 * fallback na lokal mieszkańca; `owner` tylko dla usług (bez PII); tagi
 * rozszerzone o serviceName/markę/model/kolor (asystent AI na Edge);
 * Edge oczekuje `validUntil`, nie `validTo`.
 */
export async function vehiclePlateSyncPayload(
  prisma: { $queryRaw: (...args: any[]) => Promise<any> },
  v: VehicleRow,
): Promise<Record<string, any>> {
  const isService = v.kind === 'SERVICE' || v.kind === 'DELIVERY'
  const extra: string[] = []
  if (isService && v.serviceName) extra.push(v.serviceName)
  if (v.make) extra.push(v.make)
  if (v.model) extra.push(v.model)
  if (v.color) extra.push(v.color)
  let unitLabel: string | null = v.unit?.label ?? null
  if (!unitLabel && v.kind === 'RESIDENT' && v.residentId) {
    const rows: Array<{ number: string; street: string | null; stairwell: string | null }> =
      await prisma.$queryRaw`
        SELECT u.number, u.street, s.name AS stairwell
          FROM "unit_residents" ur
          JOIN "units" u ON u.id = ur."unitId"
          LEFT JOIN "stairwells" s ON s.id = u."stairwellId"
         WHERE ur."residentId" = ${v.residentId}
           AND (ur."untilDate" IS NULL OR ur."untilDate" > NOW())
         ORDER BY ur."sinceDate" DESC
         LIMIT 1
      `.catch(() => [] as any[])
    const r = rows[0]
    if (r) unitLabel = formatUnitLabel({ number: r.number, street: r.street, stairwellName: r.stairwell })
  }
  return {
    plate: v.licensePlate,
    owner: isService && v.serviceName ? v.serviceName : '',
    kind: v.kind,
    tags: Array.from(new Set([...extra, ...(Array.isArray(v.tags) ? v.tags : [])])),
    unitLabel,
    // 2026-09-25 — przełącznik mieszkańca; brak kolumny (stare wiersze) = true.
    autoOpen: v.autoOpen ?? true,
    ...(v.validFrom ? { validFrom: v.validFrom.toISOString() } : {}),
    ...(v.validTo ? { validUntil: v.validTo.toISOString() } : {}),
  }
}
