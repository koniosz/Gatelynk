// PR-3 (2026-07-03) — Health-check „obiekt gotowy" (design doc
// docs/design/onboarding-instalacja-budynku-2026-07.md, Faza 7).
//
// `GET /api/integrator/buildings/:id/readiness` — automatyczna checklista
// gotowości obiektu po instalacji. Zwraca listę checków (ok/warn/fail/skip)
// + zbiorczy status (ready/almost/not_ready). Fundament setup-wizarda
// z fazy 4 + badge na dashboardzie.
//
// Performance budget: endpoint może być pollowany co 30 s przez dashboard
// (batch dla WSZYSTKICH budynków integratora naraz — patrz
// `summarizeForBuildings` wołane z `IntegratorService.getDashboard`).
// Dlatego: 5 zapytań ŁĄCZNIE niezależnie od liczby budynków (scalar
// subqueries po istniejących indeksach), zero N+1, zero tunnel calls.
//
// Degradacje względem design docu (brak danych w schemacie — patrz komentarze
// przy checkach):
//   • Edge „wersja aktualna"    → brak źródła prawdy o najnowszej wersji;
//     raportujemy wersję w details, nie wpływa na status.
//   • Urządzenia „online"       → EdgeDeviceMirror nie trzyma per-device
//     statusu; online = urządzenie przypisane do Edge'a który jest online
//     (identyczna semantyka jak `listDevices` w integrator.service).
//   • AP „test AP_TEST_FIRE"    → AP_TEST_FIRE nie jest audytowany per-AP
//     z wynikiem; dowodem działania jest `access_events.gateOpened=true`
//     w ostatnich 7 dniach (test-fire TAKŻE pisze taki wpis — MANUAL_OPEN
//     z meta.source='integrator-test', więc test przez panel liczy się).
//   • BA „logował się ≥1 raz"   → BuildingAdmin nie ma lastLogin i login
//     nie jest audytowany; sprawdzamy tylko istnienie przypisanego BA.
//   • Mieszkańcy „% zaproszeń"  → liczymy aktywację szerzej: zaakceptowane
//     zaproszenie LUB ustawiony passwordHash (mieszkaniec dodany ręcznie
//     z hasłem też jest „aktywny").
import { Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { EdgeGateway } from '../edge/edge.gateway'
import {
  hasPermission,
  type BuildingFeaturePermissions,
} from '../buildings/feature-permissions.constants'
import {
  isObjectType,
  normalizeFeatures,
  type BuildingFeatures,
  type ObjectType,
} from '../buildings/buildings.constants'
import { NO_EMAIL_DOMAIN } from '../residents-import/no-email.constants'

export type ReadinessCheckStatus = 'ok' | 'warn' | 'fail' | 'skip'
export type ReadinessOverall = 'ready' | 'almost' | 'not_ready'

export interface ReadinessCheck {
  id: string
  label: string
  status: ReadinessCheckStatus
  details?: string
}

export interface ReadinessScore {
  ok: number
  warn: number
  fail: number
}

export interface BuildingReadiness {
  buildingId: number
  generatedAt: string
  overall: ReadinessOverall
  score: ReadinessScore
  checks: ReadinessCheck[]
}

/** Lekki wariant dla dashboardu (bez listy checków — mniejszy payload). */
export interface ReadinessSummary {
  overall: ReadinessOverall
  score: ReadinessScore
}

// Wiersz z batch raw SQL — wszystkie COUNT-y per budynek w 1 query.
type CountRow = {
  id: number
  devicesTotal: number
  apsTotal: number
  apsBound: number
  apsTested7d: number
  lprTotal: number
  lprLinked: number
  lastLprMatchAt: Date | null
  baCount: number
  unitsCount: number
  residentsCount: number
  residentsActivated: number
  // PR-4 (2026-07-05) — nowe checki: concierge + zaproszenia.
  conciergesCount: number
  residentsUninvited: number
  residentsNoEmail: number
}

type AiRow = {
  buildingId: number
  enabled: boolean
  lastTestAt: Date | null
  lastTestOk: boolean | null
  lastTestErr: string | null
}

@Injectable()
export class IntegratorReadinessService {
  constructor(
    private prisma: PrismaService,
    private edgeGateway: EdgeGateway,
  ) {}

  /**
   * GET /integrator/buildings/:id/readiness
   *
   * Tenant-check identyczny jak `IntegratorService.getBuilding` — budynek
   * musi należeć do adminId integratora i nie być zarchiwizowany.
   */
  async getBuildingReadiness(buildingId: number, adminId: number): Promise<BuildingReadiness> {
    const building = await this.prisma.building.findFirst({
      where: { id: buildingId, adminId, isArchived: false },
      select: { id: true },
    })
    if (!building) throw new NotFoundException('Budynek nie istnieje')

    const map = await this.computeForBuildings([buildingId])
    const readiness = map.get(buildingId)
    // computeForBuildings zawsze zwraca wpis dla istniejącego budynku —
    // defensywnie rzucamy zamiast zwrócić undefined.
    if (!readiness) throw new NotFoundException('Budynek nie istnieje')
    return readiness
  }

  /**
   * Batch dla dashboardu — zwraca tylko `{ overall, score }` per budynek.
   * Wołane z `IntegratorService.getDashboard` (1 wywołanie = 5 zapytań SQL
   * dla całego portfolio, bez N+1).
   */
  async summarizeForBuildings(buildingIds: number[]): Promise<Map<number, ReadinessSummary>> {
    const full = await this.computeForBuildings(buildingIds)
    const out = new Map<number, ReadinessSummary>()
    for (const [id, r] of full) out.set(id, { overall: r.overall, score: r.score })
    return out
  }

  // ── Core ──────────────────────────────────────────────────────────────────

  private async computeForBuildings(buildingIds: number[]): Promise<Map<number, BuildingReadiness>> {
    const result = new Map<number, BuildingReadiness>()
    if (buildingIds.length === 0) return result

    const [meta, counts, mirrorGroups, edges, aiRows] = await Promise.all([
      // featurePermissions — do gate'owania checka AI Engine.
      // objectType + features — do gate'owania checka Konsjerż (PR-4:
      // obiekt bez konsjerża = check „nie dotyczy", nie wiecznie czerwony).
      this.prisma.building.findMany({
        where: { id: { in: buildingIds } },
        select: { id: true, featurePermissions: true, objectType: true, features: true },
      }),
      // Wszystkie COUNT-y w jednym query — scalar subqueries po indeksach
      // (buildingId, ...) które już istnieją. Ten sam pattern co getDashboard.
      this.prisma.$queryRaw<CountRow[]>`
        SELECT
          b.id,
          (SELECT COUNT(*)::int FROM edge_device_mirror m
             WHERE m."buildingId" = b.id) AS "devicesTotal",
          (SELECT COUNT(*)::int FROM access_points ap
             WHERE ap."buildingId" = b.id AND ap."isActive" = true) AS "apsTotal",
          (SELECT COUNT(*)::int FROM access_points ap
             WHERE ap."buildingId" = b.id AND ap."isActive" = true
               AND (
                 (ap."outputDeviceId" IS NOT NULL AND ap."outputDeviceId" <> '')
                 OR ap."deviceId" <> ''
               )) AS "apsBound",
          (SELECT COUNT(DISTINCT ae."accessPointId")::int FROM access_events ae
             WHERE ae."buildingId" = b.id
               AND ae."gateOpened" = true
               AND ae."accessPointId" IS NOT NULL
               AND ae.ts > NOW() - INTERVAL '7 days') AS "apsTested7d",
          (SELECT COUNT(*)::int FROM lpr_cameras lc
             WHERE lc."buildingId" = b.id AND lc.role = 'LPR') AS "lprTotal",
          (SELECT COUNT(*)::int FROM lpr_cameras lc
             WHERE lc."buildingId" = b.id AND lc.role = 'LPR'
               AND (
                 (lc."edgeDeviceId" IS NOT NULL AND EXISTS (
                    SELECT 1 FROM lpr_camera_ap_links l
                     WHERE l."buildingId" = b.id
                       AND l."cameraDeviceUuid" = lc."edgeDeviceId"))
                 -- legacy binding sprzed FAZY c (link 1:1 do domofonu)
                 OR lc."linkedIntercomEdgeId" IS NOT NULL
               )) AS "lprLinked",
          (SELECT MAX(ae.ts) FROM access_events ae
             WHERE ae."buildingId" = b.id
               AND ae.type = 'LPR_MATCH') AS "lastLprMatchAt",
          (SELECT COUNT(*)::int FROM building_admin_assignments a
             WHERE a."buildingId" = b.id) AS "baCount",
          (SELECT COUNT(*)::int FROM units u
             WHERE u."buildingId" = b.id) AS "unitsCount",
          (SELECT COUNT(*)::int FROM residents r
             WHERE r."buildingId" = b.id) AS "residentsCount",
          (SELECT COUNT(*)::int FROM residents r
             WHERE r."buildingId" = b.id
               AND (
                 r."passwordHash" IS NOT NULL
                 OR EXISTS (
                   SELECT 1 FROM invitations i
                    WHERE i."residentId" = r.id AND i.status = 'ACCEPTED')
               )) AS "residentsActivated",
          (SELECT COUNT(*)::int FROM concierges cg
             WHERE cg."buildingId" = b.id) AS "conciergesCount",
          -- PR-4: mieszkańcy „bez pokrycia" zaproszeniem — mają prawdziwy
          -- e-mail, nie mają hasła i nie mają żadnego ACCEPTED ani ważnego
          -- PENDING zaproszenia. To licznik do checka „Zaproszenia".
          (SELECT COUNT(*)::int FROM residents r
             WHERE r."buildingId" = b.id
               AND r."passwordHash" IS NULL
               AND r.email NOT LIKE ${'%@' + NO_EMAIL_DOMAIN}
               AND NOT EXISTS (
                 SELECT 1 FROM invitations i
                  WHERE i."residentId" = r.id
                    AND (i.status = 'ACCEPTED'
                         OR (i.status = 'PENDING' AND i."expiresAt" > NOW()))
               )) AS "residentsUninvited",
          (SELECT COUNT(*)::int FROM residents r
             WHERE r."buildingId" = b.id
               AND r.email LIKE ${'%@' + NO_EMAIL_DOMAIN}) AS "residentsNoEmail"
        FROM buildings b
        WHERE b.id = ANY(${buildingIds}::int[])
      `,
      // Per-Edge liczności mirror devices — do policzenia „% online"
      // (online = parent Edge online, patrz komentarz degradacji na górze).
      this.prisma.$queryRaw<Array<{ buildingId: number; edgeDeviceId: string | null; cnt: number }>>`
        SELECT "buildingId", "edgeDeviceId", COUNT(*)::int AS cnt
          FROM edge_device_mirror
         WHERE "buildingId" = ANY(${buildingIds}::int[])
         GROUP BY "buildingId", "edgeDeviceId"
      `,
      this.prisma.edgeDevice.findMany({
        where: { buildingId: { in: buildingIds } },
        select: {
          id: true, buildingId: true, isActivated: true,
          lastSeenAt: true, version: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      // Raw SQL zamiast prisma.aiEngineConfig — ten sam workaround co
      // `getAiEngineConfig` (Prisma client nie zna części kolumn ai_engines).
      this.prisma.$queryRaw<AiRow[]>`
        SELECT "buildingId", enabled, "lastTestAt", "lastTestOk", "lastTestErr"
          FROM ai_engines
         WHERE "buildingId" = ANY(${buildingIds}::int[])
      `,
    ])

    const permsByBuilding = new Map<number, BuildingFeaturePermissions | null>()
    const featuresByBuilding = new Map<number, BuildingFeatures>()
    for (const m of meta) {
      permsByBuilding.set(m.id, (m.featurePermissions ?? null) as BuildingFeaturePermissions | null)
      const objectType: ObjectType = isObjectType(m.objectType) ? m.objectType : 'BUILDING'
      featuresByBuilding.set(
        m.id,
        normalizeFeatures(objectType, (m.features as Partial<BuildingFeatures> | null) ?? null),
      )
    }

    const edgesByBuilding = new Map<number, typeof edges>()
    const onlineEdgeIds = new Set<string>()
    for (const e of edges) {
      const list = edgesByBuilding.get(e.buildingId) ?? []
      list.push(e)
      edgesByBuilding.set(e.buildingId, list)
      if (this.edgeGateway.isOnline(e.id)) onlineEdgeIds.add(e.id)
    }

    // devicesOnline per budynek — suma mirror devices, których Edge żyje.
    // Backfill z migracji 20260513120100 zostawił `edgeDeviceId = NULL`
    // (mirror sprzed pełnego sync) — takie wiersze liczymy jako dostępne
    // gdy JAKIKOLWIEK Edge budynku jest online (mirror pochodzi z tego
    // Edge'a; NULL nie może na stałe blokować statusu „ready").
    const buildingsWithOnlineEdge = new Set<number>()
    for (const e of edges) {
      if (onlineEdgeIds.has(e.id)) buildingsWithOnlineEdge.add(e.buildingId)
    }
    const devicesOnlineByBuilding = new Map<number, number>()
    for (const g of mirrorGroups) {
      const online = g.edgeDeviceId
        ? onlineEdgeIds.has(g.edgeDeviceId)
        : buildingsWithOnlineEdge.has(g.buildingId)
      if (online) {
        devicesOnlineByBuilding.set(
          g.buildingId,
          (devicesOnlineByBuilding.get(g.buildingId) ?? 0) + g.cnt,
        )
      }
    }

    const aiByBuilding = new Map<number, AiRow>()
    for (const a of aiRows) aiByBuilding.set(a.buildingId, a)

    const generatedAt = new Date().toISOString()
    for (const row of counts) {
      const checks = this.buildChecks({
        counts: row,
        edges: edgesByBuilding.get(row.id) ?? [],
        onlineEdgeIds,
        devicesOnline: devicesOnlineByBuilding.get(row.id) ?? 0,
        ai: aiByBuilding.get(row.id) ?? null,
        permissions: permsByBuilding.get(row.id) ?? null,
        features: featuresByBuilding.get(row.id) ?? null,
      })

      const score: ReadinessScore = { ok: 0, warn: 0, fail: 0 }
      for (const c of checks) {
        if (c.status === 'ok') score.ok++
        else if (c.status === 'warn') score.warn++
        else if (c.status === 'fail') score.fail++
        // 'skip' nie liczy się do score ani overall.
      }
      const overall: ReadinessOverall =
        score.fail > 0 ? 'not_ready' : score.warn > 0 ? 'almost' : 'ready'

      result.set(row.id, { buildingId: row.id, generatedAt, overall, score, checks })
    }

    return result
  }

  // ── Reguły checków ─────────────────────────────────────────────────────────

  private buildChecks(input: {
    counts: CountRow
    edges: Array<{ id: string; isActivated: boolean; lastSeenAt: Date | null; version: string | null }>
    onlineEdgeIds: Set<string>
    devicesOnline: number
    ai: AiRow | null
    permissions: BuildingFeaturePermissions | null
    features: BuildingFeatures | null
  }): ReadinessCheck[] {
    const { counts: c, edges, onlineEdgeIds, devicesOnline, ai, permissions, features } = input
    const checks: ReadinessCheck[] = []

    // 1. Edge — aktywowany + online (+ wersja informacyjnie; brak źródła
    //    prawdy o „najnowszej wersji", więc wersja nie wpływa na status).
    const primaryEdge = edges.find((e) => e.isActivated) ?? edges[0] ?? null
    const edgeOnline = !!primaryEdge && onlineEdgeIds.has(primaryEdge.id)
    if (!primaryEdge) {
      checks.push({
        id: 'edge', label: 'Bramka Edge', status: 'fail',
        details: 'Brak urządzenia Edge — wygeneruj kod aktywacyjny w zakładce Urządzenia',
      })
    } else if (!primaryEdge.isActivated) {
      checks.push({
        id: 'edge', label: 'Bramka Edge', status: 'fail',
        details: 'Edge nieaktywowany — wpisz kod aktywacyjny na urządzeniu',
      })
    } else if (!edgeOnline) {
      checks.push({
        id: 'edge', label: 'Bramka Edge', status: 'fail',
        details: primaryEdge.lastSeenAt
          ? `Edge offline — ostatnio widziany ${agoPl(primaryEdge.lastSeenAt)}`
          : 'Edge offline — nigdy nie połączył się z chmurą',
      })
    } else {
      const version = this.edgeGateway.getLastStatus(primaryEdge.id)?.version ?? primaryEdge.version
      checks.push({
        id: 'edge', label: 'Bramka Edge', status: 'ok',
        details: version ? `Online · wersja ${version}` : 'Online · wersja nieznana',
      })
    }

    // 2. Urządzenia — % „online" (mirror; online = Edge nadrzędny online).
    if (c.devicesTotal === 0) {
      checks.push({
        id: 'devices', label: 'Urządzenia', status: 'fail',
        details: 'Brak urządzeń zsynchronizowanych z Edge — skonfiguruj urządzenia w wizardzie Edge',
      })
    } else if (devicesOnline === c.devicesTotal) {
      checks.push({
        id: 'devices', label: 'Urządzenia', status: 'ok',
        details: `${devicesOnline}/${c.devicesTotal} urządzeń dostępnych`,
      })
    } else if (devicesOnline === 0) {
      checks.push({
        id: 'devices', label: 'Urządzenia', status: 'fail',
        details: `0/${c.devicesTotal} urządzeń dostępnych — Edge offline lub urządzenia bez przypisanego Edge`,
      })
    } else {
      checks.push({
        id: 'devices', label: 'Urządzenia', status: 'warn',
        details: `${devicesOnline}/${c.devicesTotal} urządzeń dostępnych`,
      })
    }

    // 3. AccessPointy — ≥1 z bindingiem + dowód działania w 7 dni
    //    (access_events.gateOpened=true; test-fire z panelu też się liczy).
    if (c.apsTotal === 0) {
      checks.push({
        id: 'access_points', label: 'Punkty dostępu', status: 'fail',
        details: 'Brak punktów dostępu — dodaj co najmniej jeden (brama, furtka, drzwi)',
      })
    } else if (c.apsBound === 0) {
      checks.push({
        id: 'access_points', label: 'Punkty dostępu', status: 'fail',
        details: `Żaden z ${c.apsTotal} punktów dostępu nie ma przypisanego urządzenia`,
      })
    } else if (c.apsBound < c.apsTotal) {
      checks.push({
        id: 'access_points', label: 'Punkty dostępu', status: 'warn',
        details: `${c.apsBound}/${c.apsTotal} punktów dostępu z przypisanym urządzeniem`,
      })
    } else if (c.apsTested7d >= c.apsTotal) {
      checks.push({
        id: 'access_points', label: 'Punkty dostępu', status: 'ok',
        details: `${c.apsTotal}/${c.apsTotal} z bindingiem · wszystkie otwarte w ostatnich 7 dniach`,
      })
    } else {
      checks.push({
        id: 'access_points', label: 'Punkty dostępu', status: 'warn',
        details: c.apsTested7d === 0
          ? 'Binding OK, ale brak potwierdzonego otwarcia w 7 dni — użyj „Test" przy punkcie dostępu'
          : `Binding OK · ${c.apsTested7d}/${c.apsTotal} AP z potwierdzonym otwarciem w 7 dni — przetestuj pozostałe`,
      })
    }

    // 4. LPR — każda kamera role=LPR z ≥1 linkiem do AP + testowy przejazd.
    //    „Testowy przejazd" = ≥1 LPR_MATCH KIEDYKOLWIEK (nie 7 dni): to dowód
    //    uruchomienia end-to-end wykonywany raz przy odbiorze; okno 7-dniowe
    //    powodowałoby fałszywe alarmy na obiektach o małym ruchu.
    if (c.lprTotal === 0) {
      checks.push({
        id: 'lpr', label: 'Kamery LPR', status: 'skip',
        details: 'Brak kamer LPR w obiekcie',
      })
    } else if (c.lprLinked < c.lprTotal) {
      checks.push({
        id: 'lpr', label: 'Kamery LPR', status: 'fail',
        details: `${c.lprTotal - c.lprLinked} z ${c.lprTotal} kamer LPR bez powiązania z punktem dostępu`,
      })
    } else if (!c.lastLprMatchAt) {
      checks.push({
        id: 'lpr', label: 'Kamery LPR', status: 'warn',
        details: 'Kamery powiązane, ale brak testowego przejazdu (LPR_MATCH) — przejedź autem z whitelisty',
      })
    } else {
      checks.push({
        id: 'lpr', label: 'Kamery LPR', status: 'ok',
        details: `${c.lprTotal}/${c.lprTotal} kamer powiązanych · ostatni rozpoznany przejazd ${agoPl(c.lastLprMatchAt)}`,
      })
    }

    // 5. Konto BA — istnieje przypisany administrator budynku.
    //    (Design chce też „logował się ≥1 raz" — BuildingAdmin nie ma
    //    lastLogin i login nie jest audytowany, więc tego nie weryfikujemy.)
    if (c.baCount === 0) {
      checks.push({
        id: 'building_admin', label: 'Administrator budynku', status: 'fail',
        details: 'Brak przypisanego administratora budynku — utwórz konto BA',
      })
    } else {
      checks.push({
        id: 'building_admin', label: 'Administrator budynku', status: 'ok',
        details: `${c.baCount === 1 ? '1 konto przypisane' : `${c.baCount} konta przypisane`} (logowania nie są rejestrowane)`,
      })
    }

    // 5b. Konsjerż (PR-4) — TYLKO gdy obiekt ma konsjerża w features
    //     (`has_concierge`). Obiekt bez konsjerża (np. HOUSING_ESTATE) →
    //     „nie dotyczy" (skip), nie wiecznie czerwone.
    const hasConcierge = features?.has_concierge === true
    if (!hasConcierge) {
      checks.push({
        id: 'concierge', label: 'Konsjerż', status: 'skip',
        details: 'Nie dotyczy — obiekt bez konsjerża (ustawienia typu obiektu)',
      })
    } else if (c.conciergesCount === 0) {
      checks.push({
        id: 'concierge', label: 'Konsjerż', status: 'fail',
        details: 'Obiekt ma włączonego konsjerża, ale brak konta konsjerża — utwórz konto',
      })
    } else {
      checks.push({
        id: 'concierge', label: 'Konsjerż', status: 'ok',
        details: c.conciergesCount === 1 ? '1 konto konsjerża' : `${c.conciergesCount} konta konsjerża`,
      })
    }

    // 6. Dane obiektu — ≥1 lokal, ≥1 mieszkaniec, % aktywowanych kont
    //    (zaakceptowane zaproszenie LUB ustawione hasło; próg ok = 50%).
    if (c.unitsCount === 0) {
      checks.push({
        id: 'building_data', label: 'Lokale i mieszkańcy', status: 'fail',
        details: 'Brak lokali — dodaj lub zaimportuj lokale',
      })
    } else if (c.residentsCount === 0) {
      checks.push({
        id: 'building_data', label: 'Lokale i mieszkańcy', status: 'fail',
        details: `${c.unitsCount} lokali, ale brak mieszkańców — dodaj lub zaimportuj mieszkańców`,
      })
    } else {
      const pct = Math.round((c.residentsActivated / c.residentsCount) * 100)
      const base = `${c.unitsCount} lokali · ${c.residentsCount} mieszkańców · ${pct}% z aktywnym kontem`
      checks.push({
        id: 'building_data', label: 'Lokale i mieszkańcy',
        status: pct >= 50 ? 'ok' : 'warn',
        details: pct >= 50 ? base : `${base} — wyślij zaproszenia`,
      })
    }

    // 6b. Zaproszenia mieszkańców (PR-4/PR-6) — każdy mieszkaniec z prawdziwym
    //     e-mailem powinien być aktywny (hasło) albo mieć wysłane zaproszenie.
    //     Mieszkańcy bez e-maila (placeholder z importu CSV) nie blokują.
    if (c.residentsCount === 0) {
      checks.push({
        id: 'invitations', label: 'Zaproszenia mieszkańców', status: 'skip',
        details: 'Brak mieszkańców — najpierw zaimportuj lub dodaj mieszkańców',
      })
    } else if (c.residentsUninvited > 0) {
      checks.push({
        id: 'invitations', label: 'Zaproszenia mieszkańców', status: 'warn',
        details: `${c.residentsUninvited} ${c.residentsUninvited === 1 ? 'mieszkaniec' : 'mieszkańców'} bez zaproszenia — wyślij zaproszenia (Setup → Zaproszenia)`,
      })
    } else {
      checks.push({
        id: 'invitations', label: 'Zaproszenia mieszkańców', status: 'ok',
        details:
          c.residentsNoEmail > 0
            ? `Wszyscy z e-mailem aktywni lub zaproszeni · ${c.residentsNoEmail} bez adresu e-mail`
            : 'Wszyscy mieszkańcy aktywni lub zaproszeni',
      })
    }

    // 7. AI Engine — tylko gdy skonfigurowany + włączony + feature nie jest
    //    jawnie wyłączone w Permissions Matrix. Inaczej skip.
    const aiPermitted = hasPermission(permissions, 'ba', 'feat_ai_engine')
    if (!aiPermitted) {
      checks.push({
        id: 'ai_engine', label: 'AI Engine', status: 'skip',
        details: 'Funkcja AI Engine wyłączona dla tego obiektu',
      })
    } else if (!ai) {
      checks.push({
        id: 'ai_engine', label: 'AI Engine', status: 'skip',
        details: 'AI Engine nieskonfigurowany',
      })
    } else if (!ai.enabled) {
      checks.push({
        id: 'ai_engine', label: 'AI Engine', status: 'skip',
        details: 'AI Engine wyłączony w konfiguracji',
      })
    } else if (ai.lastTestOk === true) {
      checks.push({
        id: 'ai_engine', label: 'AI Engine', status: 'ok',
        details: ai.lastTestAt ? `Test połączenia OK (${agoPl(ai.lastTestAt)})` : 'Test połączenia OK',
      })
    } else if (ai.lastTestOk === false) {
      checks.push({
        id: 'ai_engine', label: 'AI Engine', status: 'fail',
        details: ai.lastTestErr
          ? `Ostatni test połączenia nieudany: ${ai.lastTestErr}`
          : 'Ostatni test połączenia nieudany',
      })
    } else {
      checks.push({
        id: 'ai_engine', label: 'AI Engine', status: 'warn',
        details: 'Nie wykonano testu połączenia — kliknij „Testuj" w karcie AI Engine',
      })
    }

    return checks
  }
}

/** Krótki relative-time po polsku — „5 min temu", „3 dni temu". */
function agoPl(date: Date): string {
  const sec = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000))
  if (sec < 60) return `${sec} s temu`
  if (sec < 3600) return `${Math.floor(sec / 60)} min temu`
  if (sec < 86400) return `${Math.floor(sec / 3600)} h temu`
  const days = Math.floor(sec / 86400)
  return days === 1 ? 'wczoraj' : `${days} dni temu`
}
