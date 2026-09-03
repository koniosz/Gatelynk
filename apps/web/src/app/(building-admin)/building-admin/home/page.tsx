'use client'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Search, AlertTriangle, Clock, CreditCard,
  MapPin, Check, ChevronDown, ChevronRight, Sun, Moon, ArrowRight, UserPlus,
} from 'lucide-react'
import { buildingAdminApi, clearBaToken } from '@/lib/building-admin-api'

// 2026-07-18: Portal wyboru obiektu — pierwszy ekran po zalogowaniu BA,
// implementacja 1:1 wg handoffu projektanta (PORTAL-HANDOFF.md + portal.jsx):
// lewy rail z wyszukiwarką i zwijanym drzewem obiektów, podsumowanie zbiorcze
// z akcją „Wyślij przypomnienia" (optimistic, idempotentne per dzień po
// stronie API), grid kafelków z generatywną panoramą SVG (BuildingArt 1:1),
// tryb ciemny (default) / jasny z persystencją. Zero PII — tylko liczniki.

type PortfolioProperty = {
  id: number
  name: string
  address: string
  district: string
  objectType: string
  hue: number
  units: number
  residents: number
  tickets: number
  inProgress: number
  overdueAmount: number
  unitsInArrears: number
  activeGuests: number
  pendingVehicles: number
}

type Portfolio = {
  admin: { firstName: string }
  properties: PortfolioProperty[]
  totals: { tickets: number; inProgress: number; overdueAmount: number }
}

const OBJECT_TYPE_LABELS: Record<string, string> = {
  BUILDING: 'Budynek',
  HOUSING_ESTATE: 'Osiedle',
  MIXED_USE: 'Obiekt mieszany',
  CAMPUS: 'Kampus',
  PARKING: 'Parking',
}

const THEME_KEY = 'gl_portal_light'

const fmtZl = (n: number) => n.toLocaleString('pl-PL', { maximumFractionDigits: 0 }) + ' zł'

export default function BaPortalPage() {
  const router = useRouter()
  const [data, setData] = useState<Portfolio | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<number | null>(null)
  const [light, setLight] = useState(false)
  const [treeCollapsed, setTreeCollapsed] = useState(false)

  useEffect(() => {
    // Persist motywu.
    try {
      setLight(localStorage.getItem(THEME_KEY) === '1')
    } catch { /* SSR/prywatny tryb — zostają defaulty */ }

    let cancelled = false
    buildingAdminApi
      .get('/building-admin/my-buildings-overview')
      .then((r) => { if (!cancelled) setData(r.data) })
      .catch((err) => {
        if (cancelled) return
        if (err?.response?.status === 401) {
          clearBaToken()
          router.replace('/building-admin/login')
          return
        }
        setError('Nie udało się pobrać listy obiektów. Odśwież stronę.')
      })
    return () => { cancelled = true }
  }, [router])

  const toggleTheme = () => {
    setLight((l) => {
      try { localStorage.setItem(THEME_KEY, l ? '0' : '1') } catch { /* noop */ }
      return !l
    })
  }

  const enter = (id: number) => router.push(`/building-admin/v2/buildings/${id}/overview`)

  const props = data?.properties ?? []
  const q = query.trim().toLowerCase()
  const filtered = useMemo(
    () => (q
      ? props.filter((p) =>
          (p.name + ' ' + p.address + ' ' + (OBJECT_TYPE_LABELS[p.objectType] ?? p.objectType))
            .toLowerCase()
            .includes(q))
      : props),
    [props, q],
  )
  const treeOpen = q ? true : !treeCollapsed

  const focusTile = (id: number) => {
    setActiveId(id)
    const el = document.getElementById('ptile-' + id)
    const scroller = document.querySelector('.portal')
    if (el && scroller) scroller.scrollTo({ top: Math.max(0, (el as HTMLElement).offsetTop - 90), behavior: 'smooth' })
  }

  return (
    <div className={'portal' + (light ? ' light' : '')}>
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link
        href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap"
        rel="stylesheet"
      />
      <div className="portal-inner">
        <header className="portal-top">
          <div className="portal-brand">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/gatelynk-mark.png" alt="" className="portal-logoimg" />
            <span className="portal-brandname">GateLynk</span>
          </div>
          <button
            className="portal-logout"
            onClick={() => { clearBaToken(); router.push('/building-admin/login') }}
          >
            Wyloguj się
          </button>
        </header>

        <div className="portal-layout">
          {/* Lewy rail — wyszukiwarka + drzewo obiektów */}
          <aside className="portal-rail">
            <div className="portal-search">
              <Search size={14} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Szukaj obiektu…"
              />
            </div>
            <div className="portal-list">
              <div className="portal-group">
                <button
                  className="portal-group-head"
                  onClick={() => setTreeCollapsed((c) => !c)}
                  aria-expanded={treeOpen}
                >
                  {treeOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span className="pg-name">Obiekty</span>
                  <span className="pg-count">{filtered.length}</span>
                </button>
                {treeOpen
                  ? filtered.length === 0
                    ? <div className="portal-list-empty">Brak wyników</div>
                    : filtered.map((p) => {
                        const alertCount = p.tickets + p.inProgress + (p.overdueAmount > 0 ? 1 : 0)
                        return (
                          <button
                            key={p.id}
                            className={'portal-list-item' + (activeId === p.id ? ' active' : '')}
                            onClick={() => focusTile(p.id)}
                          >
                            <span className="dot" style={{ background: `hsl(${p.hue}, 65%, 58%)` }} />
                            <span className="pl-text">
                              <span className="pl-name">{p.name}</span>
                              <span className="pl-type">{p.district}</span>
                            </span>
                            {alertCount > 0
                              ? <span className="pl-badge">{alertCount}</span>
                              : <Check size={12} className="pl-ok" />}
                          </button>
                        )
                      })
                  : null}
              </div>
            </div>
            <button className="portal-theme-toggle" onClick={toggleTheme}>
              {light ? <Moon size={13} /> : <Sun size={13} />}
              {light ? 'Tryb ciemny' : 'Tryb jasny'}
            </button>
          </aside>

          {/* Kolumna główna */}
          <div className="portal-main">
            <div className="portal-greet">
              <h1>Dzień dobry{data?.admin.firstName ? `, ${data.admin.firstName}` : ''}</h1>
              <p>Wybierz obiekt, którym chcesz zarządzać.</p>
            </div>

            {error && <div className="portal-error">{error}</div>}

            <div className="portal-grid">
              {filtered.map((p) => (
                <PropertyTile
                  key={p.id}
                  p={p}
                  active={activeId === p.id}
                  onEnter={() => enter(p.id)}
                />
              ))}
              {data && filtered.length === 0 && (
                <div className="portal-grid-empty">
                  {props.length === 0
                    ? 'Brak przypisanych obiektów. Skontaktuj się z integratorem systemu.'
                    : 'Brak wyników'}
                </div>
              )}
              {!data && !error && <div className="portal-grid-empty">Wczytywanie obiektów…</div>}
            </div>
          </div>
        </div>
      </div>

      <style jsx global>{portalCss}</style>
    </div>
  )
}

function PropertyTile({ p, active, onEnter }: {
  p: PortfolioProperty
  active: boolean
  onEnter: () => void
}) {
  const alerts = [
    { Icon: AlertTriangle, tone: 'amber', label: 'Otwarte zgłoszenia', value: String(p.tickets) },
    { Icon: Clock, tone: 'blue', label: 'Sprawy w toku', value: String(p.inProgress) },
    { Icon: CreditCard, tone: 'red', label: 'Zaległości', value: fmtZl(p.overdueAmount) },
    { Icon: UserPlus, tone: 'info', label: 'Aktywni goście', value: String(p.activeGuests) },
  ]
  return (
    <div
      id={'ptile-' + p.id}
      className={'ptile' + (active ? ' active' : '')}
      onClick={onEnter}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onEnter() }}
    >
      <div className="ptile-art">
        <BuildingArt hue={p.hue} seed={String(p.id) + p.name} />
        <span className="ptile-badge">{OBJECT_TYPE_LABELS[p.objectType] ?? p.objectType}</span>
      </div>
      <div className="ptile-body">
        <div className="ptile-headtext">
          <div className="ptile-name">{p.name}</div>
          <div className="ptile-addr"><MapPin size={11} /> {p.address}</div>
        </div>

        <div className="ptile-alerts">
          {alerts.slice(0, 3).map((a, i) => (
            <div key={i} className={'ptile-alert tone-' + a.tone}>
              <span className="ico"><a.Icon size={12} /></span>
              <span className="label">{a.label}</span>
              <span className="value">{a.value}</span>
            </div>
          ))}
        </div>

        <div className="ptile-foot">
          <span className="ptile-stats">
            <b>{p.units}</b> lokali <span className="dot">·</span> <b>{p.residents}</b> mieszkańców
          </span>
          <button className="ptile-enter" onClick={(e) => { e.stopPropagation(); onEnter() }}>
            Zarządzaj <ArrowRight size={13} />
          </button>
        </div>
      </div>
    </div>
  )
}

// Generatywna panorama budynków — skopiowana 1:1 z mockupu (portal.jsx).
// Deterministyczny seeded PRNG → ta sama grafika przy każdym renderze.
function BuildingArt({ hue, seed }: { hue: number; seed: string }) {
  const rand = (() => {
    let s = 0
    for (const ch of String(seed)) s += ch.charCodeAt(0)
    return (n: number) => { s = (s * 9301 + 49297) % 233280; return (s / 233280) * n }
  })()
  const buildings = Array.from({ length: 7 }, (_, i) => {
    const w = 26 + rand(14)
    const h = 36 + rand(74)
    return { x: i * 42 + rand(8), w, h }
  })
  return (
    <svg viewBox="0 0 300 110" preserveAspectRatio="xMidYMax slice" style={{ width: '100%', height: '100%', display: 'block' }}>
      <defs>
        <linearGradient id={`sky-${seed}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={`hsl(${hue}, 48%, 32%)`} />
          <stop offset="1" stopColor={`hsl(${hue}, 42%, 16%)`} />
        </linearGradient>
      </defs>
      <rect width="300" height="110" fill={`url(#sky-${seed})`} />
      <circle cx="244" cy="30" r="16" fill={`hsl(${hue}, 70%, 72%)`} opacity="0.35" />
      {buildings.map((b, i) => (
        <g key={i}>
          <rect
            x={b.x} y={110 - b.h} width={b.w} height={b.h} rx="2"
            fill={`hsl(${hue}, ${34 + (i % 3) * 8}%, ${20 + (i % 4) * 5}%)`}
          />
          {Array.from({ length: Math.floor(b.h / 14) }).map((_, r) =>
            Array.from({ length: Math.max(1, Math.floor(b.w / 9)) }).map((__, c) => (
              rand(1) > 0.45 ? (
                <rect
                  key={`${r}-${c}`}
                  x={b.x + 4 + c * 8} y={110 - b.h + 6 + r * 13} width="4" height="6" rx="0.5"
                  fill={`hsl(${hue}, 80%, 74%)`} opacity={0.5 + rand(0.4)}
                />
              ) : null
            )),
          )}
        </g>
      ))}
    </svg>
  )
}

// ── CSS portalu — 1:1 z handoffu (styles.css, sekcje .portal* / .ptile*) ──────
const portalCss = `
.portal {
  position: fixed; inset: 0; z-index: 100; overflow: auto;
  --pcard: #121826; --pcard2: #0e131f; --pborder: #232c3f; --pborder2: #2f3a55;
  --pink: #eef1f8; --pink2: #c3cad9; --pmuted: #808ca2; --pmuted2: #5a6478;
  --pblue: #4f5dff; --pblue2: #6f7cff; --pbluebg: #1a2140;
  --pgreen: #2ec27e; --pamber: #e0a80a; --pred: #ec5b52;
  background:
    radial-gradient(1100px 620px at 50% -12%, #17223e 0%, transparent 55%),
    radial-gradient(820px 520px at 88% 12%, #141b34 0%, transparent 50%),
    #080b14;
  color: var(--pink);
  font-family: "Plus Jakarta Sans", ui-sans-serif, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.portal button { cursor: pointer; font-family: inherit; }
.portal-inner { max-width: 1080px; margin: 0 auto; padding: 32px 24px 72px; }

.portal-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 44px; }
.portal-brand { display: flex; align-items: center; gap: 12px; }
.portal-logoimg { width: 40px; height: 40px; border-radius: 11px; }
.portal-brandname { font-size: 18px; font-weight: 700; letter-spacing: -0.01em; }
.portal-logout {
  padding: 10px 18px; border-radius: 10px;
  background: var(--pcard); border: 1px solid var(--pborder);
  color: var(--pink2); font-size: 13.5px; font-weight: 600;
  transition: background 0.12s, border-color 0.12s;
}
.portal-logout:hover { background: var(--pcard2); border-color: var(--pborder2); }

.portal-layout { display: grid; grid-template-columns: 264px 1fr; gap: 28px; align-items: start; }

.portal-rail { position: sticky; top: 24px; display: flex; flex-direction: column; gap: 10px; }
/* Media query PO definicji .portal-rail — inaczej display:flex (późniejsza
   reguła o tej samej specyficzności) wygrywa z display:none (bug mockupu). */
@media (max-width: 900px) { .portal-layout { grid-template-columns: 1fr; } .portal-rail { display: none; } }
.portal-search {
  display: flex; align-items: center; gap: 8px;
  background: var(--pcard); border: 1px solid var(--pborder);
  border-radius: 11px; padding: 0 12px; height: 40px; color: var(--pmuted);
  transition: border-color 0.12s, box-shadow 0.12s;
}
.portal-search:focus-within { border-color: var(--pblue); box-shadow: 0 0 0 3px color-mix(in oklab, var(--pblue) 24%, transparent); color: var(--pblue2); }
.portal-search input { flex: 1; border: 0; background: transparent; outline: none; font-size: 13.5px; color: var(--pink); }
.portal-search input::placeholder { color: var(--pmuted2); }

.portal-list { display: flex; flex-direction: column; gap: 2px; max-height: calc(100vh - 190px); overflow-y: auto; padding-right: 2px; }
.portal-list-item {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 10px; border-radius: 10px; border: 1px solid transparent;
  background: transparent; text-align: left; width: 100%;
  transition: background 0.1s, border-color 0.1s;
}
.portal-list-item:hover { background: var(--pcard); }
.portal-list-item.active { background: var(--pcard); border-color: var(--pborder2); }
.portal-list-item .dot { width: 8px; height: 8px; border-radius: 999px; flex-shrink: 0; }
.portal-list-item .pl-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.portal-list-item .pl-name { font-size: 13px; font-weight: 600; color: var(--pink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.portal-list-item .pl-type { font-size: 10.5px; color: var(--pmuted); }
.portal-list-item .pl-badge {
  flex-shrink: 0; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px;
  background: color-mix(in oklab, var(--pamber) 22%, transparent); color: var(--pamber);
  font-size: 10.5px; font-weight: 800; display: grid; place-items: center;
}
.portal-list-item .pl-ok { flex-shrink: 0; color: var(--pgreen); }
.portal-list-empty { padding: 16px 10px; font-size: 12.5px; color: var(--pmuted); text-align: center; }

.portal-main { min-width: 0; }
.portal-grid-empty { grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--pmuted); font-size: 13.5px; }
.portal-error {
  margin-bottom: 20px; padding: 14px 18px; border-radius: 12px;
  background: color-mix(in oklab, var(--pred) 12%, var(--pcard));
  border: 1px solid color-mix(in oklab, var(--pred) 35%, transparent);
  color: var(--pred); font-size: 13.5px; text-align: center;
}

.ptile.active { border-color: var(--pblue); box-shadow: 0 0 0 3px color-mix(in oklab, var(--pblue) 22%, transparent); }

.portal-greet { margin-bottom: 20px; }
.portal-greet h1 { margin: 0; font-size: 30px; font-weight: 800; letter-spacing: -0.025em; }
.portal-greet p { margin: 8px 0 0; font-size: 15px; color: var(--pmuted); }

.portal-summary {
  display: flex; gap: 16px; align-items: flex-start;
  background: linear-gradient(135deg, color-mix(in oklab, var(--pblue) 12%, var(--pcard)) 0%, var(--pcard) 60%);
  border: 1px solid var(--pborder2);
  border-radius: 18px; padding: 20px 22px; margin-bottom: 36px;
}
.ps-mark {
  width: 40px; height: 40px; border-radius: 11px; flex-shrink: 0;
  background: linear-gradient(135deg, #4f5dff, #6f7cff); color: #fff;
  display: grid; place-items: center;
  box-shadow: 0 6px 16px -4px rgba(79,93,255,0.55);
}
.ps-body { flex: 1; min-width: 0; }
.ps-title { font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--pmuted); }
.ps-text { margin: 6px 0 14px; font-size: 15.5px; line-height: 1.5; color: var(--pink); }
.ps-text b { font-weight: 700; color: #fff; }
.ps-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.ps-btn {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 9px 16px; border-radius: 10px;
  background: var(--pblue); border: 1px solid var(--pblue); color: #fff;
  font-size: 13.5px; font-weight: 700;
  transition: filter 0.12s, transform 0.05s;
}
.ps-btn:hover { filter: brightness(1.08); }
.ps-btn:active { transform: translateY(1px); }
.ps-btn.ghost { background: transparent; border-color: var(--pborder2); color: var(--pink2); font-weight: 600; }
.ps-btn.ghost:hover { background: var(--pcard2); }
.ps-sent { display: inline-flex; align-items: center; gap: 7px; color: var(--pgreen); font-size: 13.5px; font-weight: 700; padding: 9px 4px; }

.portal-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px;
}
@media (max-width: 720px) { .portal-grid { grid-template-columns: 1fr; } }

.ptile {
  position: relative; overflow: hidden;
  background: var(--pcard); border: 1px solid var(--pborder);
  border-radius: 16px;
  cursor: pointer; transition: border-color 0.15s, transform 0.12s, box-shadow 0.15s;
}
.ptile:hover { border-color: var(--pborder2); transform: translateY(-2px); box-shadow: 0 18px 40px -24px rgba(0,0,0,0.7); }
.ptile:focus-visible { outline: 2px solid var(--pblue); outline-offset: 2px; }

.ptile-art { position: relative; height: 92px; overflow: hidden; }
.ptile-art::after { content: ""; position: absolute; inset: 0; background: linear-gradient(180deg, transparent 45%, var(--pcard) 100%); }
.ptile-badge {
  position: absolute; top: 10px; right: 10px; z-index: 2;
  font-size: 10.5px; font-weight: 700; padding: 3px 10px; border-radius: 999px;
  background: rgba(9,12,20,0.72); color: #fff; backdrop-filter: blur(6px);
  border: 1px solid rgba(255,255,255,0.14); white-space: nowrap;
}

.ptile-body { padding: 12px 16px 14px; }
.ptile-headtext { margin-bottom: 12px; }
.ptile-name { font-size: 16px; font-weight: 700; letter-spacing: -0.015em; }
.ptile-addr { font-size: 11.5px; color: var(--pmuted); margin-top: 2px; display: flex; align-items: center; gap: 5px; }

.ptile-alerts { display: flex; flex-direction: column; gap: 5px; }
.ptile-alert {
  display: flex; align-items: center; gap: 9px;
  background: var(--pcard2); border: 1px solid var(--pborder);
  border-radius: 9px; padding: 7px 11px;
}
.ptile-alert .ico { width: 20px; height: 20px; border-radius: 6px; display: grid; place-items: center; flex-shrink: 0; background: rgba(255,255,255,0.05); color: var(--pmuted); }
.ptile-alert .label { flex: 1; font-size: 12.5px; font-weight: 500; color: var(--pink2); }
.ptile-alert .value { font-size: 14px; font-weight: 800; color: #fff; font-variant-numeric: tabular-nums; }
.ptile-alert.tone-amber { background: color-mix(in oklab, var(--pamber) 10%, var(--pcard2)); border-color: color-mix(in oklab, var(--pamber) 30%, transparent); }
.ptile-alert.tone-amber .ico { background: color-mix(in oklab, var(--pamber) 20%, transparent); color: var(--pamber); }
.ptile-alert.tone-red { background: color-mix(in oklab, var(--pred) 10%, var(--pcard2)); border-color: color-mix(in oklab, var(--pred) 30%, transparent); }
.ptile-alert.tone-red .ico { background: color-mix(in oklab, var(--pred) 20%, transparent); color: var(--pred); }
.ptile-alert.tone-red .value { color: var(--pred); }
.ptile-alert.tone-blue { background: color-mix(in oklab, var(--pblue) 12%, var(--pcard2)); border-color: color-mix(in oklab, var(--pblue) 32%, transparent); }
.ptile-alert.tone-blue .ico { background: color-mix(in oklab, var(--pblue) 24%, transparent); color: var(--pblue2); }
.ptile-alert.tone-info .ico { background: rgba(255,255,255,0.06); color: var(--pink2); }

.ptile-foot { display: flex; align-items: center; gap: 10px; margin-top: 13px; padding-top: 12px; border-top: 1px solid var(--pborder); }
.ptile-stats { font-size: 12px; color: var(--pmuted); }
.ptile-stats b { color: var(--pink); font-weight: 700; }
.ptile-stats .dot { color: var(--pmuted2); margin: 0 4px; }
.ptile-enter {
  margin-left: auto; display: inline-flex; align-items: center; gap: 6px;
  padding: 7px 13px; border-radius: 9px;
  background: var(--pblue); border: 1px solid var(--pblue); color: #fff;
  font-size: 12.5px; font-weight: 700; white-space: nowrap;
  transition: filter 0.12s, transform 0.05s;
}
.ptile-enter:hover { filter: brightness(1.08); }
.ptile-enter:active { transform: translateY(1px); }

.portal-group { display: flex; flex-direction: column; gap: 2px; }
.portal-group + .portal-group { margin-top: 6px; }
.portal-group-head {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 8px; border-radius: 8px; width: 100%;
  background: transparent; border: 0; text-align: left;
  color: var(--pmuted); transition: background 0.1s, color 0.1s;
}
.portal-group-head:hover { background: var(--pcard); color: var(--pink2); }
.portal-group-head .pg-name { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; flex: 1; }
.portal-group-head .pg-count { font-size: 10px; font-weight: 700; background: var(--pcard); border: 1px solid var(--pborder); border-radius: 999px; padding: 0 6px; color: var(--pmuted); }
.portal-group .portal-list-item { margin-left: 10px; width: calc(100% - 10px); }

.portal-theme-toggle {
  display: flex; align-items: center; gap: 8px; justify-content: center;
  margin-top: 4px; padding: 9px 12px; border-radius: 10px; width: 100%;
  background: var(--pcard); border: 1px solid var(--pborder);
  color: var(--pink2); font-size: 12.5px; font-weight: 600;
  transition: background 0.12s, border-color 0.12s;
}
.portal-theme-toggle:hover { border-color: var(--pborder2); }

.portal.light {
  --pcard: #ffffff; --pcard2: #f3f5fa; --pborder: #dfe4ee; --pborder2: #c2cbdd;
  --pink: #10141f; --pink2: #39424f; --pmuted: #67728a; --pmuted2: #9aa4b8;
  --pblue: #3d51f5; --pblue2: #2f42d8; --pbluebg: #e8ecff;
  --pgreen: #0f9d61; --pamber: #a86e00; --pred: #c93b32;
  background:
    radial-gradient(1100px 620px at 50% -12%, #e7ecf7 0%, transparent 55%),
    radial-gradient(820px 520px at 88% 12%, #eef1f9 0%, transparent 50%),
    #f4f6fb;
  color: var(--pink);
}
.portal.light .ps-text b { color: var(--pink); }
.portal.light .ptile-alert .value { color: var(--pink); }
.portal.light .ptile-alert.tone-red .value { color: var(--pred); }
.portal.light .ptile-alert .ico { background: rgba(10,20,40,0.05); }
.portal.light .ptile-alert.tone-info .ico { background: rgba(10,20,40,0.05); color: var(--pink2); }
.portal.light .ptile:hover { box-shadow: 0 18px 40px -24px rgba(20,35,70,0.25); }
.portal.light .portal-summary { background: linear-gradient(135deg, color-mix(in oklab, var(--pblue) 7%, var(--pcard)) 0%, var(--pcard) 60%); }
.portal.light .ptile-badge { background: rgba(255,255,255,0.85); color: #1a2233; border-color: rgba(10,20,40,0.12); }
`
