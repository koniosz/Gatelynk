"use client";
// Guests tab — redesign 2026-07-23 (czytelność + kluczowe informacje na
// pierwszy rzut oka):
//   • kafle: Aktywne zaproszenia / Wejścia gości dziś / Wygasają w 24 h,
//   • dwukolumnowy układ: lista gości + CHRONOLOGICZNA oś wejść gości
//     (feed access_events?guestsOnly=true, grupowanie Dziś/Wczoraj/data,
//     klik wpisu otwiera drawer gościa),
//   • ludzkie terminy ważności („wygasa za 3 godz." na bursztynowo,
//     „do jutra 18:00"), aktywni goście sortowani na górę,
//   • drawer bez zmian funkcjonalnych: szczegóły + pełna historia gościa
//     (?guestId=) + wyślij email ponownie + anuluj zaproszenie.
//
// Endpointy: GET /guests, GET /access-events?guestsOnly=true|?guestId=,
// POST /guests, POST /guests/:id/resend-email, DELETE /guests/:id.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  CalendarClock,
  Clock,
  DoorOpen,
  KeyRound,
  Mail,
  Pencil,
  Plus,
  Search,
  ShieldAlert,
  UserCheck,
  X,
} from "lucide-react";
import { buildingAdminApi } from "@/lib/building-admin-api";
import { ResidentDrawer } from "@/components/ba-v2/ResidentDrawer";
import {
  AccessEvent,
  TYPE_ICON,
  TYPE_LABEL,
  formatEventTs,
  gateStatus,
} from "@/lib/access-events";
import { GuestRestrictions, formatRestrictions, hasRestrictions } from "@/lib/guest-restrictions";
import { BUILDING_TZ, buildingDayKey } from "@/lib/building-time";

type GuestStatus = "ACTIVE" | "USED" | "EXPIRED" | "CANCELLED";

interface Guest extends GuestRestrictions {
  id: number;
  name: string;
  phone?: string | null;
  email?: string | null;
  pin?: string | null;
  vehiclePlate?: string | null;
  status: GuestStatus;
  validFrom: string;
  validTo: string;
  usedAt?: string | null;
  createdAt: string;
  residentId?: number;
  resident?: {
    id: number;
    firstName: string;
    lastName: string;
  } | null;
}

type GuestFilter = "ALL" | GuestStatus;

const FILTERS: { key: GuestFilter; label: string }[] = [
  { key: "ALL", label: "Wszyscy" },
  { key: "ACTIVE", label: "Aktywni" },
  { key: "USED", label: "Wykorzystani" },
  { key: "EXPIRED", label: "Wygasłe" },
  { key: "CANCELLED", label: "Anulowane" },
];

const STATUS_META: Record<GuestStatus, { label: string; tone: "amber" | "green" | "red" | "default" }> = {
  ACTIVE: { label: "Aktywny", tone: "green" },
  USED: { label: "Wykorzystany", tone: "default" },
  EXPIRED: { label: "Wygasł", tone: "default" },
  CANCELLED: { label: "Anulowany", tone: "red" },
};

// Sort listy: aktywni na górze (nimi się zarządza), reszta po dacie utworzenia.
const STATUS_ORDER: Record<GuestStatus, number> = { ACTIVE: 0, USED: 1, EXPIRED: 2, CANCELLED: 3 };

const fmtDate = (iso?: string | null) =>
  iso
    ? new Date(iso).toLocaleString("pl-PL", { timeZone: BUILDING_TZ,
        day: "2-digit",
        month: "2-digit",
        year: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

const timeAgo = (iso: string): string => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "przed chwilą";
  if (s < 3600) return `${Math.floor(s / 60)} min temu`;
  if (s < 86400) return `${Math.floor(s / 3600)} godz. temu`;
  return `${Math.floor(s / 86400)} dni temu`;
};

/** Ludzki opis ważności AKTYWNEGO zaproszenia + czy niedługo wygasa. */
const validityHuman = (validToIso: string): { text: string; soon: boolean } => {
  const validTo = new Date(validToIso);
  const ms = validTo.getTime() - Date.now();
  const time = validTo.toLocaleTimeString("pl-PL", { timeZone: BUILDING_TZ, hour: "2-digit", minute: "2-digit" });
  if (ms <= 0) return { text: "wygasa lada moment", soon: true };
  const hours = ms / 3_600_000;
  if (hours < 1) return { text: `wygasa za ${Math.max(1, Math.round(ms / 60_000))} min`, soon: true };
  if (hours < 24) return { text: `wygasa za ${Math.round(hours)} godz. (${time})`, soon: true };
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(validTo) - startOfDay(new Date())) / 86_400_000);
  if (days === 1) return { text: `do jutra ${time}`, soon: false };
  return {
    text: `do ${validTo.toLocaleDateString("pl-PL", { timeZone: BUILDING_TZ, day: "numeric", month: "long" })}, ${time}`,
    soon: false,
  };
};

/** Nagłówek grupy dnia w osi wejść. */
const dayHeader = (iso: string): string => {
  const d = new Date(iso);
  // Nagłówki dni po kalendarzu OSIEDLA, nie przeglądarki widza.
  const key = buildingDayKey(d.getTime());
  const diff = key === buildingDayKey(Date.now()) ? 0
    : key === buildingDayKey(Date.now() - 86_400_000) ? 1 : 99;
  if (diff === 0) return "Dziś";
  if (diff === 1) return "Wczoraj";
  return d.toLocaleDateString("pl-PL", { timeZone: BUILDING_TZ, weekday: "long", day: "numeric", month: "long" });
};

export default function GuestsPage() {
  const params = useParams();
  const idStr = Array.isArray(params?.id) ? params.id[0] : params?.id;
  const buildingId = Number(idStr);

  const [guests, setGuests] = useState<Guest[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<GuestFilter>("ALL");
  const [query, setQuery] = useState("");

  const [sel, setSel] = useState<Guest | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const [residents, setResidents] = useState<{ id: number; firstName: string; lastName: string }[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [gName, setGName] = useState("");
  const [gResidentId, setGResidentId] = useState("");
  const [gValidTo, setGValidTo] = useState("");
  const [gPhone, setGPhone] = useState("");
  const [gEmail, setGEmail] = useState("");
  const [gPlate, setGPlate] = useState("");
  const [gAdding, setGAdding] = useState(false);
  const [gError, setGError] = useState<string | null>(null);

  // Pełny feed wejść gości (chronologiczna oś, prawa kolumna) + mapa
  // „ostatnia aktywność" per gość do listy.
  const [feed, setFeed] = useState<AccessEvent[]>([]);
  const [lastActivity, setLastActivity] = useState<Map<number, AccessEvent>>(new Map());
  const [guestEvents, setGuestEvents] = useState<AccessEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);

  const load = useCallback(async () => {
    if (!Number.isFinite(buildingId)) return;
    setLoading(true);
    try {
      const [gRes, evRes, rRes] = await Promise.all([
        buildingAdminApi.get<Guest[]>(`/building-admin/buildings/${buildingId}/guests`),
        buildingAdminApi
          .get<{ events: AccessEvent[] }>(
            `/building-admin/buildings/${buildingId}/access-events?guestsOnly=true&limit=200`,
          )
          .catch(() => null),
        buildingAdminApi
          .get<{ id: number; firstName: string; lastName: string }[]>(
            `/building-admin/buildings/${buildingId}/residents`,
          )
          .catch(() => ({ data: [] as { id: number; firstName: string; lastName: string }[] })),
      ]);
      setGuests(gRes.data);
      setResidents(rRes.data ?? []);
      if (evRes) {
        setFeed(evRes.data.events);
        const map = new Map<number, AccessEvent>();
        for (const ev of evRes.data.events) {
          if (ev.guestId != null && !map.has(ev.guestId)) map.set(ev.guestId, ev);
        }
        setLastActivity(map);
      }
      return gRes.data;
    } finally {
      setLoading(false);
    }
  }, [buildingId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!drawerOpen || !sel) return;
    let cancelled = false;
    setEventsLoading(true);
    setGuestEvents([]);
    buildingAdminApi
      .get<{ events: AccessEvent[] }>(
        `/building-admin/buildings/${buildingId}/access-events?guestId=${sel.id}&limit=50`,
      )
      .then((res) => {
        if (!cancelled) setGuestEvents(res.data.events);
      })
      .catch(() => {
        if (!cancelled) setGuestEvents([]);
      })
      .finally(() => {
        if (!cancelled) setEventsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [drawerOpen, sel, buildingId]);

  const counts = useMemo(() => {
    const c = { ALL: guests.length, ACTIVE: 0, USED: 0, EXPIRED: 0, CANCELLED: 0 } as Record<GuestFilter, number>;
    for (const g of guests) c[g.status] = (c[g.status] ?? 0) + 1;
    return c;
  }, [guests]);

  // ── Kafle: kluczowe liczby ────────────────────────────────────────────────
  const stats = useMemo(() => {
    const now = Date.now();
    const activeGuests = guests.filter((g) => g.status === "ACTIVE");
    const withCar = activeGuests.filter((g) => (g.vehiclePlate ?? "").trim()).length;
    const expiringSoon = activeGuests.filter((g) => {
      const ms = new Date(g.validTo).getTime() - now;
      return ms > 0 && ms < 24 * 3_600_000;
    }).length;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayEvents = feed.filter((ev) => new Date(ev.ts).getTime() >= startOfToday.getTime());
    const todayOpened = todayEvents.filter((ev) => ev.gateOpened).length;
    const todayDenied = todayEvents.length - todayOpened;
    return { active: activeGuests.length, withCar, expiringSoon, todayOpened, todayDenied };
  }, [guests, feed]);

  const filtered = useMemo(() => {
    return guests
      .filter((g) => (filter === "ALL" ? true : g.status === filter))
      .filter((g) => {
        if (!query.trim()) return true;
        const q = query.trim().toLowerCase();
        const txt = `${g.name} ${g.resident?.firstName ?? ""} ${g.resident?.lastName ?? ""} ${g.phone ?? ""} ${g.vehiclePlate ?? ""}`.toLowerCase();
        return txt.includes(q);
      })
      .sort((a, b) => {
        const so = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
        if (so !== 0) return so;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
  }, [guests, filter, query]);

  // Oś wejść pogrupowana po dniach (feed jest DESC po ts).
  const feedGroups = useMemo(() => {
    const groups: { header: string; events: AccessEvent[] }[] = [];
    for (const ev of feed.slice(0, 60)) {
      const header = dayHeader(ev.ts);
      const last = groups[groups.length - 1];
      if (last && last.header === header) last.events.push(ev);
      else groups.push({ header, events: [ev] });
    }
    return groups;
  }, [feed]);

  const guestById = useMemo(() => new Map(guests.map((g) => [g.id, g])), [guests]);

  const openDrawer = (g: Guest) => {
    setSel(g);
    setDrawerOpen(true);
  };
  const closeDrawer = () => {
    setDrawerOpen(false);
    setTimeout(() => setSel(null), 320);
  };

  // Po edycji/wysyłce zaproszenia: przeładuj listę i podmień otwartego
  // gościa na świeży obiekt (żeby drawer pokazał nowe dane bez zamykania).
  const refreshSel = async (guestId: number) => {
    const fresh = await load();
    const ng = (fresh ?? []).find((g) => g.id === guestId) ?? null;
    setSel(ng);
    if (!ng) closeDrawer();
  };

  const onCancel = async (guestId: number) => {
    if (!window.confirm("Anulować zaproszenie? PIN przestanie działać.")) return;
    try {
      await buildingAdminApi.delete(`/building-admin/buildings/${buildingId}/guests/${guestId}`);
      closeDrawer();
      await load();
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      alert(e2.response?.data?.message ?? "Nie udało się anulować gościa");
    }
  };

  const onAddGuest = async (e: React.FormEvent) => {
    e.preventDefault();
    setGAdding(true);
    setGError(null);
    try {
      await buildingAdminApi.post(`/building-admin/buildings/${buildingId}/guests`, {
        residentId: +gResidentId,
        name: gName,
        validTo: new Date(gValidTo).toISOString(),
        phone: gPhone || undefined,
        email: gEmail || undefined,
        vehiclePlate: gPlate ? gPlate.trim().toUpperCase() : undefined,
      });
      setShowAdd(false);
      setGName(""); setGResidentId(""); setGValidTo(""); setGPhone(""); setGEmail(""); setGPlate("");
      await load();
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      setGError(e2.response?.data?.message ?? "Nie udało się dodać gościa");
    } finally {
      setGAdding(false);
    }
  };

  return (
    <>
      {/* ── Kafle kluczowych liczb ── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <StatCard
          icon={<UserCheck size={16} />}
          label="Aktywne zaproszenia"
          value={String(stats.active)}
          tone={stats.active > 0 ? "green" : "default"}
          hint={stats.withCar > 0 ? `w tym ${stats.withCar} z autem (wjazd LPR)` : "goście z PIN-em lub autem"}
        />
        <StatCard
          icon={<DoorOpen size={16} />}
          label="Wejścia gości dziś"
          value={String(stats.todayOpened)}
          tone={stats.todayOpened > 0 ? "green" : "default"}
          hint={stats.todayDenied > 0 ? `+ ${stats.todayDenied} nieudane próby` : "PIN, wjazd autem lub portal"}
        />
        <StatCard
          icon={<CalendarClock size={16} />}
          label="Wygasają w ciągu 24 godz."
          value={String(stats.expiringSoon)}
          tone={stats.expiringSoon > 0 ? "amber" : "default"}
          hint="zaproszenia, które niedługo stracą ważność"
        />
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.55fr) minmax(0, 1fr)",
          gap: 16,
          alignItems: "start",
        }}
      >
        {/* ── Lista gości ── */}
        <div className="ba-panel">
          <div className="ba-panel-head">
            <div className="ba-panel-title">
              <UserCheck size={16} />
              Goście
              <span className="pill">{guests.length}</span>
            </div>
            <div className="ba-panel-tools">
              <div className="ba-search" style={{ width: 240 }}>
                <Search size={14} />
                <input
                  placeholder="Szukaj gościa, gospodarza, tablicy…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              {!showAdd ? (
                <button type="button" className="ba-btn primary sm" onClick={() => setShowAdd(true)}>
                  <Plus size={13} /> Dodaj gościa
                </button>
              ) : null}
            </div>
          </div>

          {showAdd ? (
            <form
              onSubmit={onAddGuest}
              style={{ padding: 16, borderBottom: "1px solid var(--border)", display: "grid", gap: 10 }}
            >
              {gError ? (
                <div className="ba-pill red" style={{ display: "block", padding: "8px 12px" }}>
                  {gError}
                </div>
              ) : null}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={{ fontSize: 12, color: "var(--ink-2)", fontWeight: 600 }}>Imię / opis gościa</span>
                  <input required value={gName} onChange={(e) => setGName(e.target.value)} className="ba-input" placeholder="np. Pani Halinka" />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={{ fontSize: 12, color: "var(--ink-2)", fontWeight: 600 }}>Gospodarz (mieszkaniec)</span>
                  <select required value={gResidentId} onChange={(e) => setGResidentId(e.target.value)} className="ba-input">
                    <option value="">— Wybierz —</option>
                    {residents.map((r) => (
                      <option key={r.id} value={r.id}>{r.firstName} {r.lastName}</option>
                    ))}
                  </select>
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={{ fontSize: 12, color: "var(--ink-2)", fontWeight: 600 }}>Ważne do</span>
                  <input required type="datetime-local" value={gValidTo} onChange={(e) => setGValidTo(e.target.value)} className="ba-input" />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={{ fontSize: 12, color: "var(--ink-2)", fontWeight: 600 }}>Telefon (opcjonalnie)</span>
                  <input value={gPhone} onChange={(e) => setGPhone(e.target.value)} className="ba-input" />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={{ fontSize: 12, color: "var(--ink-2)", fontWeight: 600 }}>Email (wyśle zaproszenie)</span>
                  <input type="email" value={gEmail} onChange={(e) => setGEmail(e.target.value)} className="ba-input" />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={{ fontSize: 12, color: "var(--ink-2)", fontWeight: 600 }}>Tablica auta (opcjonalnie)</span>
                  <input value={gPlate} onChange={(e) => setGPlate(e.target.value)} className="ba-input" placeholder="np. WD1234X" />
                </label>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="submit" disabled={gAdding} className="ba-btn primary">
                  {gAdding ? "Dodawanie…" : "Dodaj gościa"}
                </button>
                <button type="button" className="ba-btn" onClick={() => setShowAdd(false)}>
                  Anuluj
                </button>
              </div>
            </form>
          ) : null}

          {/* Filtry status */}
          <div
            style={{
              display: "flex",
              gap: 6,
              padding: "10px 16px",
              borderBottom: "1px solid var(--border)",
              flexWrap: "wrap",
            }}
          >
            {FILTERS.map((f) => {
              const isActive = filter === f.key;
              const count = counts[f.key] ?? 0;
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilter(f.key)}
                  className="ba-btn sm"
                  style={
                    isActive
                      ? { background: "var(--ink)", color: "var(--surface)", borderColor: "var(--ink)" }
                      : undefined
                  }
                >
                  {f.label}
                  <span
                    style={{
                      fontSize: 11,
                      padding: "1px 6px",
                      borderRadius: 999,
                      background: isActive ? "rgba(255,255,255,0.2)" : "var(--bg-2)",
                      marginLeft: 2,
                    }}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          {loading ? (
            <div className="ba-empty">Ładowanie…</div>
          ) : filtered.length === 0 ? (
            <div className="ba-empty">
              <div className="ico">
                <UserCheck size={22} />
              </div>
              <h4>Brak gości</h4>
              <p>
                {guests.length === 0
                  ? "Goście dodawani przez mieszkańców lub admina pojawią się tutaj."
                  : "Brak wyników dla aktualnych filtrów."}
              </p>
            </div>
          ) : (
            <div>
              {filtered.map((g) => {
                const meta = STATUS_META[g.status];
                const last = lastActivity.get(g.id);
                const restrictions = formatRestrictions(g);
                const validity = g.status === "ACTIVE" ? validityHuman(g.validTo) : null;
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => openDrawer(g)}
                    className="ba-row"
                    style={{
                      width: "100%",
                      textAlign: "left",
                      background: "transparent",
                      border: 0,
                      borderBottom: "1px solid var(--border)",
                      gridTemplateColumns: "36px 1.7fr 1.2fr 1.1fr 0.9fr",
                      padding: "12px 16px",
                    }}
                  >
                    <div className="ba-av" style={{ width: 34, height: 34 }}>
                      <KeyRound size={14} />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", gap: 6 }}>
                        {g.name}
                        {restrictions && (
                          <span
                            className="ba-pill amber"
                            title={restrictions}
                            style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10.5 }}
                          >
                            <ShieldAlert size={10} />
                            Ograniczenia
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 1 }}>
                        gość: {g.resident ? `${g.resident.firstName} ${g.resident.lastName}` : "—"}
                        {g.vehiclePlate ? (
                          <>
                            {" · auto "}
                            <span className="ba-mono" style={{ textTransform: "uppercase" }}>{g.vehiclePlate}</span>
                          </>
                        ) : null}
                        {g.pin ? (
                          <>
                            {" · PIN "}
                            <span className="ba-mono">{g.pin}</span>
                          </>
                        ) : null}
                      </div>
                    </div>
                    <div style={{ fontSize: 12.5 }}>
                      {validity ? (
                        <span style={{ color: validity.soon ? "var(--amber)" : "var(--ink-2)", fontWeight: validity.soon ? 700 : 500 }}>
                          {validity.text}
                        </span>
                      ) : (
                        <span style={{ color: "var(--muted)" }}>
                          {fmtDate(g.validFrom)} → {fmtDate(g.validTo)}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--muted)" }}>
                      {last ? (
                        <span title={`${TYPE_LABEL[last.type]} · ${formatEventTs(last.ts)}`}>
                          {TYPE_ICON[last.type]} {timeAgo(last.ts)}
                        </span>
                      ) : g.usedAt ? (
                        fmtDate(g.usedAt)
                      ) : (
                        "jeszcze nie wszedł"
                      )}
                    </div>
                    <div>
                      <span className={`ba-pill ${meta.tone === "default" ? "" : meta.tone}`}>{meta.label}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Chronologiczna oś wejść gości ── */}
        <div className="ba-panel">
          <div className="ba-panel-head">
            <div className="ba-panel-title">
              <Clock size={16} />
              Wejścia gości
              <span className="pill">{feed.length}</span>
            </div>
          </div>
          {loading ? (
            <div className="ba-empty">Ładowanie…</div>
          ) : feedGroups.length === 0 ? (
            <div className="ba-empty">
              <div className="ico">
                <DoorOpen size={22} />
              </div>
              <h4>Brak wejść gości</h4>
              <p>Każde użycie PIN-u, wjazd autem (LPR) albo otwarcie przez portal pojawi się tutaj.</p>
            </div>
          ) : (
            <div style={{ maxHeight: 720, overflowY: "auto" }}>
              {feedGroups.map((grp) => (
                <div key={grp.header}>
                  <div
                    style={{
                      position: "sticky",
                      top: 0,
                      zIndex: 2,
                      padding: "8px 16px",
                      background: "var(--surface-2)",
                      borderBottom: "1px solid var(--border)",
                      fontSize: 11.5,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      color: "var(--muted)",
                    }}
                  >
                    {grp.header}
                  </div>
                  {grp.events.map((ev) => {
                    const gs = gateStatus(ev);
                    const guest = ev.guestId != null ? guestById.get(ev.guestId) : undefined;
                    const time = new Date(ev.ts).toLocaleTimeString("pl-PL", { timeZone: BUILDING_TZ, hour: "2-digit", minute: "2-digit" });
                    return (
                      <button
                        key={ev.id}
                        type="button"
                        onClick={() => guest && openDrawer(guest)}
                        title={guest ? "Pokaż szczegóły gościa" : undefined}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "44px 26px 1fr auto",
                          gap: 8,
                          alignItems: "center",
                          width: "100%",
                          textAlign: "left",
                          background: "transparent",
                          border: 0,
                          borderBottom: "1px solid var(--border)",
                          padding: "10px 16px",
                          cursor: guest ? "pointer" : "default",
                          font: "inherit",
                          color: "var(--ink)",
                        }}
                      >
                        <span className="ba-mono" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink-2)" }}>
                          {time}
                        </span>
                        <span style={{ fontSize: 15 }}>{TYPE_ICON[ev.type]}</span>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {ev.guestName ?? guest?.name ?? "Gość"}
                            {ev.plate ? (
                              <span className="ba-mono" style={{ marginLeft: 6, fontWeight: 500, fontSize: 12 }}>
                                {ev.plate}
                              </span>
                            ) : null}
                          </div>
                          <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                            {[TYPE_LABEL[ev.type], ev.accessPointLabel].filter(Boolean).join(" · ")}
                          </div>
                        </div>
                        <span
                          className={`ba-pill ${gs.tone === "ok" ? "green" : gs.tone === "bad" ? "red" : gs.tone === "warn" ? "amber" : ""}`}
                          title={gs.hint}
                          style={{ whiteSpace: "nowrap", flexShrink: 0 }}
                        >
                          {gs.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <ResidentDrawer
        open={drawerOpen}
        onClose={closeDrawer}
        title={sel ? `Gość: ${sel.name}` : "Gość"}
        footer={
          sel && sel.status === "ACTIVE" ? (
            <button type="button" className="ba-btn danger" onClick={() => onCancel(sel.id)}>
              <X size={13} /> Anuluj zaproszenie
            </button>
          ) : null
        }
      >
        {sel ? (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 16,
                  background: "var(--blue-50)",
                  color: "var(--blue-600)",
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <KeyRound size={26} />
              </div>
              <div>
                <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.01em" }}>{sel.name}</div>
                <div style={{ color: "var(--muted)", fontSize: 13 }}>
                  Zaproszony przez {sel.resident?.firstName} {sel.resident?.lastName ?? ""}
                </div>
                {sel.status === "ACTIVE" ? (
                  <div
                    style={{
                      fontSize: 12.5,
                      fontWeight: 700,
                      marginTop: 2,
                      color: validityHuman(sel.validTo).soon ? "var(--amber)" : "var(--green)",
                    }}
                  >
                    {validityHuman(sel.validTo).text}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="ba-kv-grid" style={{ marginTop: 16 }}>
              <div className="ba-kv">
                <div className="k">PIN</div>
                <div className="v ba-mono" style={{ fontSize: 16, letterSpacing: "0.06em" }}>
                  {sel.pin ?? "—"}
                </div>
              </div>
              <div className="ba-kv">
                <div className="k">Status</div>
                <div className="v">
                  <span className={`ba-pill ${STATUS_META[sel.status].tone === "default" ? "" : STATUS_META[sel.status].tone}`}>
                    {STATUS_META[sel.status].label}
                  </span>
                </div>
              </div>
              <div className="ba-kv">
                <div className="k">Telefon</div>
                <div className="v">{sel.phone ?? "—"}</div>
              </div>
              <div className="ba-kv">
                <div className="k">E-mail</div>
                <div className="v">{sel.email ?? "—"}</div>
              </div>
              <div className="ba-kv">
                <div className="k">Tablica gościa</div>
                <div className="v ba-mono" style={{ textTransform: "uppercase" }}>
                  {sel.vehiclePlate ?? "—"}
                </div>
              </div>
              <div className="ba-kv">
                <div className="k">Pierwsze użycie</div>
                <div className="v">{sel.usedAt ? fmtDate(sel.usedAt) : "jeszcze nie"}</div>
              </div>
              <div className="ba-kv" style={{ gridColumn: "span 2" }}>
                <div className="k">Ważność</div>
                <div className="v" style={{ fontSize: 13 }}>
                  {fmtDate(sel.validFrom)} → {fmtDate(sel.validTo)}
                </div>
              </div>
              {hasRestrictions(sel) && (
                <div className="ba-kv" style={{ gridColumn: "span 2" }}>
                  <div className="k">Ograniczenia dostępu</div>
                  <div className="v" style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
                    <ShieldAlert size={13} style={{ color: "var(--muted)" }} />
                    {formatRestrictions(sel)}
                  </div>
                </div>
              )}
            </div>

            {/* ── Edycja parametrów + wysyłka zaproszenia (tylko aktywne) ── */}
            {sel.status === "ACTIVE" ? (
              <>
                <GuestEditSection
                  key={`edit-${sel.id}`}
                  buildingId={buildingId}
                  guest={sel}
                  residents={residents}
                  onSaved={() => void refreshSel(sel.id)}
                />
                <GuestInviteSection
                  key={`invite-${sel.id}`}
                  buildingId={buildingId}
                  guest={sel}
                  onSent={() => void refreshSel(sel.id)}
                />
              </>
            ) : null}

            <div className="ba-section-label" style={{ marginTop: 18, marginBottom: 6 }}>
              <Clock size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
              Historia wejść tego gościa
              {guestEvents.length > 0 && <span className="pill" style={{ marginLeft: 6 }}>{guestEvents.length}</span>}
            </div>
            {eventsLoading ? (
              <p style={{ fontSize: 12.5, color: "var(--muted)", margin: 0 }}>Ładowanie…</p>
            ) : guestEvents.length === 0 ? (
              <p style={{ fontSize: 12.5, color: "var(--muted)", margin: 0 }}>
                Brak zarejestrowanych zdarzeń — pojawią się gdy gość użyje PIN-u,
                wjedzie autem (LPR) albo otworzy bramę przez portal.
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {guestEvents.map((ev) => {
                  const gs = gateStatus(ev);
                  return (
                    <div
                      key={ev.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "8px 10px",
                        borderRadius: 10,
                        border: "1px solid var(--border)",
                        background: "var(--surface-2)",
                      }}
                    >
                      <span style={{ fontSize: 16 }}>{TYPE_ICON[ev.type]}</span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                          {TYPE_LABEL[ev.type]}
                          {ev.plate && (
                            <span className="ba-mono" style={{ marginLeft: 6, fontWeight: 500 }}>
                              {ev.plate}
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                          {[ev.accessPointLabel, formatEventTs(ev.ts)].filter(Boolean).join(" · ")}
                        </div>
                      </div>
                      <span
                        className={`ba-pill ${gs.tone === "ok" ? "green" : gs.tone === "bad" ? "red" : gs.tone === "warn" ? "amber" : ""}`}
                        title={gs.hint}
                        style={{ whiteSpace: "nowrap" }}
                      >
                        {gs.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : null}
      </ResidentDrawer>
    </>
  );
}

// ── Edycja parametrów gościa (PATCH /guests/:id) ────────────────────────────
const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function GuestEditSection({
  buildingId,
  guest,
  residents,
  onSaved,
}: {
  buildingId: number;
  guest: Guest;
  residents: { id: number; firstName: string; lastName: string }[];
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [eName, setEName] = useState(guest.name);
  const [eResidentId, setEResidentId] = useState(String(guest.resident?.id ?? guest.residentId ?? ""));
  const [ePhone, setEPhone] = useState(guest.phone ?? "");
  const [ePlate, setEPlate] = useState(guest.vehiclePlate ?? "");
  const [eFrom, setEFrom] = useState(toLocalInput(guest.validFrom));
  const [eTo, setETo] = useState(toLocalInput(guest.validTo));

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await buildingAdminApi.patch(`/building-admin/buildings/${buildingId}/guests/${guest.id}`, {
        name: eName.trim(),
        residentId: eResidentId ? Number(eResidentId) : undefined,
        phone: ePhone.trim() || null,
        vehiclePlate: ePlate.trim() ? ePlate.trim().toUpperCase() : null,
        validFrom: new Date(eFrom).toISOString(),
        validTo: new Date(eTo).toISOString(),
      });
      setEditing(false);
      onSaved();
    } catch (error: unknown) {
      const e2 = error as { response?: { data?: { message?: string } } };
      setErr(e2.response?.data?.message ?? "Nie udało się zapisać zmian");
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <button type="button" className="ba-btn" style={{ marginTop: 14 }} onClick={() => setEditing(true)}>
        <Pencil size={14} /> Edytuj dane gościa
      </button>
    );
  }

  return (
    <form
      onSubmit={onSave}
      style={{ marginTop: 14, display: "grid", gap: 10, border: "1px solid var(--border)", borderRadius: 12, padding: 12 }}
    >
      {err ? (
        <div className="ba-pill red" style={{ display: "block", padding: "8px 12px" }}>{err}</div>
      ) : null}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="Imię / opis gościa">
          <input required className="ba-input" value={eName} onChange={(e) => setEName(e.target.value)} />
        </Field>
        <Field label="Gospodarz (mieszkaniec)">
          <select className="ba-input" value={eResidentId} onChange={(e) => setEResidentId(e.target.value)}>
            {residents.map((r) => (
              <option key={r.id} value={r.id}>{r.firstName} {r.lastName}</option>
            ))}
          </select>
        </Field>
        <Field label="Telefon">
          <input className="ba-input" value={ePhone} onChange={(e) => setEPhone(e.target.value)} />
        </Field>
        <Field label="Tablica auta">
          <input className="ba-input ba-mono" value={ePlate} onChange={(e) => setEPlate(e.target.value.toUpperCase())} placeholder="np. WD1234X" />
        </Field>
        <Field label="Ważne od">
          <input required type="datetime-local" className="ba-input" value={eFrom} onChange={(e) => setEFrom(e.target.value)} />
        </Field>
        <Field label="Ważne do">
          <input required type="datetime-local" className="ba-input" value={eTo} onChange={(e) => setETo(e.target.value)} />
        </Field>
      </div>
      <p style={{ fontSize: 11.5, color: "var(--muted)", margin: 0 }}>
        Zmiana tablicy lub okna ważności od razu aktualizuje dostęp gościa (PIN i wjazd autem).
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" className="ba-btn primary" disabled={busy}>
          {busy ? "Zapisywanie…" : "Zapisz zmiany"}
        </button>
        <button type="button" className="ba-btn" disabled={busy} onClick={() => setEditing(false)}>
          Anuluj
        </button>
      </div>
    </form>
  );
}

// ── Zaproszenie e-mail (POST /guests/:id/resend-email) ──────────────────────
// Podany adres NADPISUJE zapisany w bazie i od razu wysyła link do portalu
// zaproszenia (PIN + przyciski otwarcia) — działa też dla gościa dodanego
// bez e-maila.
function GuestInviteSection({
  buildingId,
  guest,
  onSent,
}: {
  buildingId: number;
  guest: Guest;
  onSent: () => void;
}) {
  const [email, setEmail] = useState(guest.email ?? "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const send = async () => {
    const target = email.trim();
    if (!target) return;
    setBusy(true);
    setResult(null);
    try {
      await buildingAdminApi.post(
        `/building-admin/buildings/${buildingId}/guests/${guest.id}/resend-email`,
        target !== (guest.email ?? "") ? { email: target } : {},
      );
      setResult({ ok: true, msg: `Zaproszenie wysłane na ${target}` });
      onSent();
    } catch (error: unknown) {
      const e2 = error as { response?: { data?: { message?: string } } };
      setResult({ ok: false, msg: e2.response?.data?.message ?? "Nie udało się wysłać zaproszenia" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 14 }}>
      <div className="ba-section-label" style={{ marginBottom: 6 }}>
        Zaproszenie dla gościa
      </div>
      {result ? (
        <div
          className={`ba-pill ${result.ok ? "green" : "red"}`}
          style={{ display: "block", padding: "8px 12px", marginBottom: 8 }}
        >
          {result.msg}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 8 }}>
        <input
          type="email"
          className="ba-input"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="adres e-mail gościa"
          style={{ flex: 1 }}
        />
        <button type="button" className="ba-btn" disabled={busy || !email.trim()} onClick={() => void send()}>
          <Mail size={14} /> {busy ? "Wysyłanie…" : guest.email ? "Wyślij ponownie" : "Wyślij zaproszenie"}
        </button>
      </div>
      <p style={{ fontSize: 11.5, color: "var(--muted)", margin: "6px 0 0" }}>
        Gość dostanie link do strony zaproszenia z PIN-em i przyciskiem otwarcia bramy.
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 12, color: "var(--ink-2)", fontWeight: 600 }}>{label}</span>
      {children}
    </label>
  );
}

function StatCard({
  icon,
  label,
  value,
  tone,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: "green" | "amber" | "default";
  hint?: string;
}) {
  const color = tone === "green" ? "var(--green)" : tone === "amber" ? "var(--amber)" : "var(--ink)";
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 14,
        padding: 16,
      }}
    >
      <div className="ba-section-label" style={{ marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
        {icon}
        {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color, letterSpacing: "-0.01em" }}>{value}</div>
      {hint ? <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>{hint}</div> : null}
    </div>
  );
}
