import type { Request, Response, NextFunction } from 'express'
import { UiAuthService } from './ui-auth.service'

/**
 * PR-2 (2026-07) — Express middleware chroniący Edge HTTP :4000.
 *
 * Rejestrowany w `main.ts` przez `app.use()` PRZED statycznymi handlerami
 * `/ui` — dzięki temu łapie zarówno statyczne strony (SPA, legacy html),
 * jak i wszystkie route'y NestJS (Nest montuje swój router później).
 *
 * Model decyzyjny (kolejność ma znaczenie):
 *   1. kill-switch `EDGE_UI_AUTH_ENABLED=false`      → przepuść wszystko
 *   2. ścieżka MASZYNOWA (allowlista niżej)          → przepuść (dowolna metoda)
 *   3. PIN nie ustawiony (tryb bootstrap/parowanie)  → przepuść wszystko
 *   4. ważna sesja cookie                            → przepuść
 *   5. GET/HEAD poza stronami UI i wrażliwymi GET-ami → przepuść (odczyty
 *      są otwarte, bo Cloud→Edge przez Tailscale proxy robi GET-y snapshot/
 *      obraz LPR/vision/devices i nie ma jak dziś przekazać sekretu)
 *   6. reszta (mutacje + strony UI): przeglądarka → 302 /auth/login,
 *      API → 401 JSON.
 *
 * ALLOWLISTA MASZYNOWA — konsumenci którzy NIE mają sesji przeglądarkowej
 * i muszą dalej działać (inwentaryzacja 2026-07, patrz raport PR-2):
 *   • Akuvox domofon      → POST/GET /akuvox/event (Action URL, walidacja PIN bram)
 *   • Kamery Hikvision    → POST /events/lpr/hikvision/:id (ANPR push)
 *   • Cloud (Tailscale)   → POST /devices/:id/relay/:n        (otwarcie AP z apki!)
 *                           POST /devices/:id/hold-open[/cancel] (BA)
 *                           POST /devices/:id/restart           (integrator)
 *                           POST /devices/discover              (LanScanModal)
 *                           POST /devices/:id/test-matrix       (DiagnosticsModal)
 *                           POST /assistant/* (ask, intercom-open — asystent+domofon)
 *   • ai-prototype (localhost:8000) → POST /knowledge/search, GET /ai-engine
 *     (GET-y i tak otwarte — regułą 5)
 *   • /auth/* — endpointy logowania (zmiana PIN-u pilnuje sesji sama).
 *
 * ŚWIADOMY KOMPROMIS (TODO w raporcie): ścieżki maszynowe z tej listy są
 * osiągalne z LAN bez PIN-u (np. relay przez curl). Cloud nie przechowuje
 * dziś żadnego sekretu per-EdgeDevice który Edge mógłby zweryfikować
 * (token z aktywacji NIE jest persystowany w Cloud), więc wariant
 * wspólnego sekretu wymaga zmiany schematu + ~25 call-site'ów w apps/api
 * — poza zakresem PR-2. Cel P0 (przypadkowa osoba w LAN nie otworzy bramy
 * z PRZEGLĄDARKI) jest osiągnięty: UI i przyciski są za PIN-em.
 */

export const SESSION_COOKIE = 'gatelynk_edge_session'

const MACHINE_PATHS: RegExp[] = [
  /^\/akuvox\/event$/,                          // Akuvox Action URL
  /^\/events\/lpr(\/|$)/,                       // Hikvision ANPR push
  /^\/devices\/[^/]+\/relay\/\d+$/,             // Cloud: resident/guest-portal/integrator
  /^\/devices\/[^/]+\/hold-open(\/cancel)?$/,   // Cloud: BA hold-open
  /^\/devices\/[^/]+\/restart$/,                // Cloud: integrator restart urządzenia
  /^\/devices\/discover(\/|$)/,                 // Cloud: integrator LAN scan (POST+GET)
  /^\/devices\/[^/]+\/test-matrix$/,            // Cloud: integrator diagnostyka
  /^\/assistant(\/|$)/,                         // Cloud: asystent (ask/ask-stream/intercom-open/…)
  /^\/knowledge\/search$/,                      // ai-prototype (localhost)
  /^\/auth(\/|$)/,                              // logowanie PIN
]

/** Strony UI + wrażliwe GET-y — wymagają sesji mimo reguły „GET-y otwarte". */
const PROTECTED_GET: RegExp[] = [
  /^\/ui(\/|$)/,               // SPA React (strony + assety)
  /^\/ui-legacy(\/|$)/,        // legacy index.html / wizard.html
  /\.html$/,                   // dowolny stray .html (np. /ui/ai-engine.html)
  /^\/api\/system\/backup$/,   // pełny dump sqlite — zawiera hasła urządzeń!
]

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const key = part.slice(0, idx).trim()
    const val = part.slice(idx + 1).trim()
    if (key) out[key] = decodeURIComponent(val)
  }
  return out
}

export function sessionTokenFromRequest(req: Request): string | null {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null
}

export function createUiAuthMiddleware(auth: UiAuthService) {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Kill-switch
    if (!auth.isEnabled()) return next()

    const pathOnly = (req.path ?? (req.url ?? '/').split('?')[0]) || '/'

    // 2. Ścieżki maszynowe — zawsze otwarte (dowolna metoda)
    if (MACHINE_PATHS.some((re) => re.test(pathOnly))) return next()

    // 3. Bootstrap: bez ustawionego PIN-u nie ma czego pilnować (pierwsze
    //    uruchomienie / parowanie — instalator ustawia PIN przy aktywacji)
    if (!auth.isPinSet()) return next()

    // 4. Ważna sesja
    if (auth.validateSession(sessionTokenFromRequest(req))) return next()

    // 5. Odczyty otwarte (Cloud robi GET-y: snapshot, lpr image, vision,
    //    devices, status…) — poza stronami UI i wrażliwymi GET-ami
    const method = (req.method ?? 'GET').toUpperCase()
    const isProtectedGet = PROTECTED_GET.some((re) => re.test(pathOnly))
    if ((method === 'GET' || method === 'HEAD') && !isProtectedGet) return next()

    // 6. Zablokowane — przeglądarka na login, API dostaje 401
    const wantsHtml = (req.headers.accept ?? '').includes('text/html')
    if (method === 'GET' && wantsHtml) {
      const target = req.originalUrl && req.originalUrl.startsWith('/') ? req.originalUrl : pathOnly
      res.redirect(302, `/auth/login?next=${encodeURIComponent(target)}`)
      return
    }
    res.status(401).json({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Edge UI: wymagane logowanie PIN (POST /auth/login)',
    })
  }
}
