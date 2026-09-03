import { Controller, Get, Query } from '@nestjs/common'
import { StoreService } from '../store/store.service'

/**
 * REST dla zdarzeń sytuacyjnych (2026-08-26) — czyta `situation_events`
 * wypełniane przez SituationCorrelatorService. Konsumenci: panel BA (feed
 * „Zdarzenia"), Cloud (Kronika dnia), debug przez curl na LAN.
 */
@Controller('situations')
export class SituationsController {
  constructor(private readonly store: StoreService) {}

  @Get()
  list(
    @Query('since_hours') sinceHoursRaw?: string,
    @Query('since_ts') sinceTsRaw?: string,
    @Query('until_ts') untilTsRaw?: string,
    @Query('types') typesRaw?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const sinceHours = Math.min(Math.max(parseInt(sinceHoursRaw ?? '24', 10) || 24, 1), 24 * 30)
    const sinceTs = parseInt(sinceTsRaw ?? '', 10)
    const untilTs = parseInt(untilTsRaw ?? '', 10)
    const types = (typesRaw ?? '')
      .split(',')
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean)
    const limit = Math.min(Math.max(parseInt(limitRaw ?? '100', 10) || 100, 1), 500)

    const rows = this.store.situationList({
      sinceMs: Number.isFinite(sinceTs) && sinceTs > 0 ? sinceTs : Date.now() - sinceHours * 3_600_000,
      untilMs: Number.isFinite(untilTs) && untilTs > 0 ? untilTs : undefined,
      types: types.length ? types : undefined,
      limit,
    })

    // Zdjęcia dowodowe: evidence trzyma id klatek wizji — mapujemy na
    // image_path (panel BA pobiera obrazy przez proxy `/vision/frame/:file`).
    const visionIds = new Set<number>()
    const parsed = rows.map((r) => {
      const evidence = (safeParse(r.evidenceJson) ?? []) as Array<{ src: string; id: number }>
      for (const e of evidence) if (e.src === 'vision') visionIds.add(e.id)
      return { row: r, evidence }
    })
    const imagePaths = this.store.situationVisionImagePaths([...visionIds])

    return {
      events: parsed.map(({ row: r, evidence }) => ({
        id: r.id,
        type: r.type,
        cameraDeviceId: r.cameraDeviceId,
        startedTs: r.startedTs,
        endedTs: r.endedTs,
        confidence: r.confidence,
        title: r.title,
        // VLM-detektyw (2026-09-01): „—" = brak kadru do opisania, nie pokazuj.
        vlmNote: r.vlmNote && r.vlmNote !== '—' ? r.vlmNote : null,
        details: safeParse(r.detailsJson),
        evidence,
        evidenceImages: evidence
          .filter((e) => e.src === 'vision')
          .map((e) => imagePaths.get(e.id))
          .filter((p): p is string => Boolean(p))
          .slice(0, 4),
      })),
    }
  }
}

function safeParse(json: string | null): any {
  if (!json) return null
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}
