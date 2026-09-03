import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Query,
  Request,
  Res,
  UseGuards,
} from '@nestjs/common'
import type { Response } from 'express'
import { AuthGuard } from '@nestjs/passport'
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'
import { IntegratorJwtAuthGuard } from '../integrator/integrator-jwt-auth.guard'
import { BuildingAdminJwtAuthGuard } from '../building-admin/building-admin-jwt-auth.guard'
import { ConciergeJwtAuthGuard } from '../concierge/concierge-jwt-auth.guard'
import { LprReadsService, ReadQueryOpts } from './lpr-reads.service'

// Tailscale userspace HTTP proxy — singleton, ten sam pattern co w EdgeService.
// Cloud na Fly.io nie ma /dev/net/tun, więc tailscaled chodzi w userspace mode
// i wystawia proxy na localhost:1055 (`entrypoint-api.sh`). Bez tego natywny
// `fetch()` nie ma routingu do tailnetu i miniaturki 100.90.244.90:4000
// timeout-ują (504) — co dokładnie obserwowaliśmy w panelu LPR.
// Gdy `TS_HTTP_PROXY` nie jest ustawiony (dev / docker compose) dispatcher
// zostaje undefined i undiciFetch zachowuje się jak natywny fetch.
const edgeDispatcher: Dispatcher | undefined = process.env.TS_HTTP_PROXY
  ? new ProxyAgent(process.env.TS_HTTP_PROXY)
  : undefined

/**
 * Proxy a snapshot from Edge and pipe it back through the HTTP response.
 * Shared by the building-admin and concierge image endpoints (both have the
 * same behaviour, only the auth/scope differs).
 *
 * Fetch timeout: 15 s (było 5 s — podniesione 2026-06-12). Snapshot z Edge
 * to ~780 KB pełnowymiarowego JPEG-a; przy kilkudziesięciu równoległych
 * miniaturkach łącze Cloud→Edge (Tailscale userspace proxy) się zatyka i ogon
 * requestów przekraczał 5 s → 504 mimo że Edge był zdrowy. Frontend od tej
 * samej daty lazy-loaduje miniaturki z limitem współbieżności (max 4 fetche,
 * patrz `apps/web/src/components/LazyLprThumbnail.tsx`), więc 15 s to już
 * tylko bezpieczny margines na wolniejszy link — a wciąż failujemy z 504
 * zamiast wisieć minutami gdy Edge faktycznie jest nieosiągalny.
 */
async function proxySnapshot(
  svc: LprReadsService,
  readId: number,
  buildingId: number,
  res: Response,
): Promise<void> {
  // DROGA PODSTAWOWA: tunel. Edge stoi za NAT-em i łączy się wychodząco, więc
  // to jedyne połączenie, które istnieje ZAWSZE gdy Edge jest online. Droga
  // bezpośrednia (niżej) wymaga dodatkowej sieci VPN — gdy ta padła, miniatury
  // zniknęły po cichu na 8 dni (2026-08-07).
  const viaTunnel = await svc.fetchSnapshotViaTunnel(readId, buildingId)
  if (viaTunnel) {
    res.setHeader('Content-Type', 'image/jpeg')
    res.setHeader('Cache-Control', 'private, max-age=3600')
    res.send(viaTunnel)
    return
  }

  const url = await svc.resolveImageUrl(readId, buildingId)
  if (!url) throw new NotFoundException('No snapshot for this read')
  try {
    // undiciFetch + dispatcher → ruch leci przez Tailscale userspace HTTP proxy
    // (gdy `TS_HTTP_PROXY` jest ustawiony). Bez proxy zachowuje się jak natywny
    // fetch — bezpieczny no-op fallback dla dev.
    const upstream = await undiciFetch(url, {
      // 15 s — patrz komentarz nad funkcją (zatkany ogon Tailscale przy
      // równoległych miniaturkach przekraczał poprzednie 5 s).
      signal: AbortSignal.timeout(15000),
      dispatcher: edgeDispatcher,
    })
    if (!upstream.ok) {
      res.status(upstream.status === 404 ? 404 : 502).send('Edge returned ' + upstream.status)
      return
    }
    const buf = Buffer.from(await upstream.arrayBuffer())
    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'image/jpeg')
    // Short private cache — snapshots never change once stored, but we don't
    // want stale 404s to pin if the Edge was momentarily offline.
    res.setHeader('Cache-Control', 'private, max-age=3600')
    res.send(buf)
  } catch (err: any) {
    // fetch timeout / connection refused / DNS — report as 504 so the client
    // can distinguish "snapshot doesn't exist" (404) from "Edge unreachable".
    res.status(504).send('Edge unreachable: ' + (err?.message ?? 'unknown'))
  }
}

/**
 * Role-scoped read-only LPR history endpoints.
 *
 * The four controllers in this file share one service (`LprReadsService`),
 * but each one is mounted under the prefix that matches the role's JWT guard
 * stack. Scoping rules:
 *
 *   - Integrator  → any building owned by their Admin record (FK check)
 *   - Building-admin → only buildings in the JWT `buildingIds` array
 *   - Concierge   → single `buildingId` baked into the JWT
 *   - Resident    → auto-filtered by plates of vehicles owned by the resident
 */

function parseOpts(q: {
  plate?: string
  matched?: string
  cameraDeviceId?: string
  limit?: string
  offset?: string
  q?: string
  identified?: string
  day?: string
}): ReadQueryOpts {
  const matched =
    q.matched === 'true' ? true : q.matched === 'false' ? false : undefined
  const identified =
    q.identified === 'true' ? true : q.identified === 'false' ? false : undefined
  const limitNum = q.limit ? parseInt(q.limit, 10) : NaN
  const offsetNum = q.offset ? parseInt(q.offset, 10) : NaN
  // `day` = pojedynczy dzień YYYY-MM-DD (czas lokalny Europe/Warsaw — patrz
  // queryReads). Walidujemy format, śmieci ignorujemy (brak filtra).
  const day = q.day && /^\d{4}-\d{2}-\d{2}$/.test(q.day) ? q.day : undefined
  return {
    plate: q.plate,
    matched,
    cameraDeviceId: q.cameraDeviceId,
    identified,
    limit: Number.isFinite(limitNum) && limitNum > 0 ? limitNum : undefined,
    offset: Number.isFinite(offsetNum) && offsetNum >= 0 ? offsetNum : undefined,
    q: q.q,
    day,
  }
}

// ── Integrator ────────────────────────────────────────────────────────────────
@Controller('integrator')
export class IntegratorLprReadsController {
  constructor(private readonly svc: LprReadsService) {}

  @UseGuards(IntegratorJwtAuthGuard)
  @Get('buildings/:id/lpr-reads')
  async list(
    @Param('id') id: string,
    @Request() req: any,
    @Query('plate') plate?: string,
    @Query('matched') matched?: string,
    @Query('cameraDeviceId') cameraDeviceId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('q') q?: string,
    @Query('day') day?: string,
  ) {
    return this.svc.listForIntegrator(
      +id,
      req.user.adminId,
      parseOpts({ plate, matched, cameraDeviceId, limit, offset, q, day }),
    )
  }
}

// ── Building admin ────────────────────────────────────────────────────────────
@Controller('building-admin')
export class BuildingAdminLprReadsController {
  constructor(private readonly svc: LprReadsService) {}

  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/lpr-reads')
  async list(
    @Param('id') id: string,
    @Request() req: any,
    @Query('plate') plate?: string,
    @Query('matched') matched?: string,
    @Query('cameraDeviceId') cameraDeviceId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('q') q?: string,
    @Query('identified') identified?: string,
    @Query('day') day?: string,
  ) {
    return this.svc.listForBuildingAdmin(
      +id,
      req.user.buildingIds ?? [],
      parseOpts({ plate, matched, cameraDeviceId, limit, offset, q, identified, day }),
    )
  }

  // Zwraca zdjęcie z odczytu, pobierając z Edge (proxy). Sprawdzamy, że admin
  // ma dostęp do tego budynku, zanim w ogóle spytamy service'a o URL.
  @UseGuards(BuildingAdminJwtAuthGuard)
  @Get('buildings/:id/lpr-reads/:readId/image')
  async getImage(
    @Param('id') id: string,
    @Param('readId') readId: string,
    @Request() req: any,
    @Res() res: Response,
  ) {
    const buildingIds: number[] = req.user.buildingIds ?? []
    if (!buildingIds.includes(+id)) throw new ForbiddenException()
    await proxySnapshot(this.svc, +readId, +id, res)
  }
}

// ── Concierge ─────────────────────────────────────────────────────────────────
@Controller('concierge')
export class ConciergeLprReadsController {
  constructor(private readonly svc: LprReadsService) {}

  @UseGuards(ConciergeJwtAuthGuard)
  @Get('lpr-reads')
  async list(
    @Request() req: any,
    @Query('plate') plate?: string,
    @Query('matched') matched?: string,
    @Query('cameraDeviceId') cameraDeviceId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('q') q?: string,
    @Query('identified') identified?: string,
    @Query('day') day?: string,
  ) {
    return this.svc.listForConcierge(
      req.user.buildingId,
      parseOpts({ plate, matched, cameraDeviceId, limit, offset, q, identified, day }),
    )
  }

  // Concierge ma jeden budynek w JWT — scope jest automatyczny, nie trzeba
  // porównywać `id` z URL.
  @UseGuards(ConciergeJwtAuthGuard)
  @Get('lpr-reads/:readId/image')
  async getImage(
    @Param('readId') readId: string,
    @Request() req: any,
    @Res() res: Response,
  ) {
    await proxySnapshot(this.svc, +readId, req.user.buildingId, res)
  }
}

// ── Resident ──────────────────────────────────────────────────────────────────
@Controller('resident')
export class ResidentLprReadsController {
  constructor(private readonly svc: LprReadsService) {}

  @UseGuards(AuthGuard('jwt-resident'))
  @Get('lpr-reads')
  async list(
    @Request() req: any,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const limitNum = limit ? parseInt(limit, 10) : NaN
    const offsetNum = offset ? parseInt(offset, 10) : NaN
    return this.svc.listForResident(req.user.residentId, req.user.buildingId, {
      limit: Number.isFinite(limitNum) && limitNum > 0 ? limitNum : undefined,
      offset: Number.isFinite(offsetNum) && offsetNum >= 0 ? offsetNum : undefined,
    })
  }
}
