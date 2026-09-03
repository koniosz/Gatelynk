"use client";
// Treść drawera szczegółów mieszkańca (BA v2) — sekcje:
//   Profil · Lokale · Pojazdy · Aktywność · Płatności
// + mini-form „Ustaw hasło" (footer hostuje przyciski w page.tsx).
//
// Lazy-load: vehicles/access-events/payments dociągamy dopiero gdy ten komponent
// się montuje (czyli gdy drawer się otwiera dla konkretnego rezydenta), nie przy
// liście. Każda sekcja ma własny stan loading → skeleton.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bell,
  Car,
  CarFront,
  CreditCard,
  DoorOpen,
  Home,
  KeyRound,
  Phone,
  Plus,
  ShieldAlert,
  Smartphone,
  Trash2,
} from "lucide-react";
import { buildingAdminApi } from "@/lib/building-admin-api";
import { BUILDING_TZ } from "@/lib/building-time";

// ── Typy danych (odzwierciedlają shape z building-admin.service.ts) ──────────
interface UnitResident {
  id?: number;
  role?: string | null;
  sinceDate?: string | null;
  untilDate?: string | null;
  unit?: { id: number; number: string; unitType?: { name?: string | null } | null } | null;
}

export interface ResidentDetail {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string | null;
  createdAt?: string | null;
  status?: string | null;
  unitResidents?: UnitResident[];
}

interface VehicleRow {
  id: number;
  residentId: number | null;
  make: string;
  model: string | null;
  color?: string | null;
  licensePlate: string;
  status: string;
}

interface AccessEventRow {
  id: string;
  ts: string;
  type: string;
  plate: string | null;
  accessPointLabel: string | null;
  gateOpened: boolean;
}

interface PaymentUnitRow {
  unitId: number;
  number: string;
  balance: number;
  residents?: { firstName: string; lastName: string; email: string }[];
}

interface Props {
  buildingId: number;
  resident: ResidentDetail;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const sectionLabelStyle: React.CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontWeight: 700,
  color: "var(--muted)",
  display: "flex",
  alignItems: "center",
  gap: 6,
  marginBottom: 8,
};

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("pl-PL", { timeZone: BUILDING_TZ, day: "2-digit", month: "short", year: "numeric" });
}

function vehicleStatusClass(status: string): string {
  switch (status) {
    case "APPROVED":
      return "ba-pill green";
    case "PENDING":
      return "ba-pill amber";
    case "BLOCKED":
    case "REJECTED":
      return "ba-pill red";
    default:
      return "ba-pill";
  }
}

const VEHICLE_STATUS_PL: Record<string, string> = {
  APPROVED: "Zatwierdzony",
  PENDING: "Oczekuje",
  BLOCKED: "Zablokowany",
  REJECTED: "Odrzucony",
  EXPIRED: "Wygasł",
};

const ACCESS_TYPE_PL: Record<string, string> = {
  LPR_MATCH: "Tablica rozpoznana",
  LPR_NO_MATCH: "Tablica nieznana",
  PIN_USED: "Wejście PIN",
  REMOTE_OPEN: "Otwarcie zdalne",
  MANUAL_OPEN: "Otwarcie ręczne",
  INTERCOM_CALL: "Wezwanie domofonu",
};

// FAZA polish (d) — Activity timeline: kolor + ikona per typ eventu.
type EventTone = "success" | "fail" | "info";
function accessEventIcon(type: string): { Icon: typeof DoorOpen; tone: EventTone } {
  switch (type) {
    case "LPR_MATCH":
      return { Icon: CarFront, tone: "success" };
    case "LPR_NO_MATCH":
      return { Icon: ShieldAlert, tone: "fail" };
    case "PIN_USED":
      return { Icon: KeyRound, tone: "success" };
    case "REMOTE_OPEN":
      return { Icon: Smartphone, tone: "info" };
    case "MANUAL_OPEN":
      return { Icon: DoorOpen, tone: "info" };
    case "INTERCOM_CALL":
      return { Icon: Phone, tone: "info" };
    default:
      return { Icon: Bell, tone: "info" };
  }
}

const TONE_BG: Record<EventTone, string> = {
  success: "var(--green-50)",
  fail: "var(--red-50, #fef2f2)",
  info: "#eff6ff",
};
const TONE_FG: Record<EventTone, string> = {
  success: "var(--green)",
  fail: "var(--red)",
  info: "#1f4cb8",
};

function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "?";
  // YYYY-MM-DD in local time
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayLabel(key: string): string {
  if (key === "?") return "Nieznana data";
  const today = dayKey(new Date().toISOString());
  const ts = new Date(`${key}T00:00:00`).getTime();
  if (key === today) return "Dziś";
  const yest = new Date();
  yest.setDate(yest.getDate() - 1);
  if (key === dayKey(yest.toISOString())) return "Wczoraj";
  return new Date(ts).toLocaleDateString("pl-PL", { timeZone: BUILDING_TZ,
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("pl-PL", { timeZone: BUILDING_TZ, hour: "2-digit", minute: "2-digit" });
}

function Skeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 36,
            borderRadius: 8,
            background: "linear-gradient(90deg, var(--bg-2) 25%, var(--surface-2) 50%, var(--bg-2) 75%)",
            backgroundSize: "200% 100%",
            animation: "ba-skel 1.2s ease-in-out infinite",
          }}
        />
      ))}
    </div>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <div style={{ fontSize: 12.5, color: "var(--muted)" }}>{text}</div>;
}

/** Etykieta + kontrolka — ten sam układ, co formularz pojazdu przy lokalu. */
function VehicleField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 12, color: "var(--ink-2)", fontWeight: 600 }}>{label}</span>
      {children}
    </label>
  );
}

export function ResidentDetails({ buildingId, resident }: Props) {
  const fullName = `${resident.firstName} ${resident.lastName}`.trim();

  const [vehicles, setVehicles] = useState<VehicleRow[] | null>(null);
  const [events, setEvents] = useState<AccessEventRow[] | null>(null);
  const [payments, setPayments] = useState<PaymentUnitRow[] | null>(null);
  const [vLoading, setVLoading] = useState(true);
  const [eLoading, setELoading] = useState(true);
  const [pLoading, setPLoading] = useState(true);

  // Dodawanie pojazdu wprost z karty mieszkańca (2026-08-09). Wcześniej dało
  // się to zrobić tylko z karty lokalu — a administrator, który właśnie
  // wprowadził mieszkańca, siedzi w JEGO karcie. Właściciela nie wybieramy:
  // jest nim ten mieszkaniec, więc formularz ma o jedno pole mniej niż przy
  // lokalu (tam wybór jest konieczny, bo lokal ma kilku mieszkańców).
  const [vAdding, setVAdding] = useState(false);
  const [vPlate, setVPlate] = useState("");
  const [vMake, setVMake] = useState("");
  const [vModel, setVModel] = useState("");
  const [vColor, setVColor] = useState("");
  const [vBusy, setVBusy] = useState(false);
  const [vError, setVError] = useState<string | null>(null);

  // Pojazdy — filtr client-side po residentId. Osobny callback (a nie część
  // `load`), bo po dodaniu/usunięciu pojazdu odświeżamy TYLKO tę sekcję —
  // przeładowywanie aktywności i płatności byłoby zbędnym ruchem.
  const loadVehicles = useCallback(async () => {
    setVLoading(true);
    try {
      const r = await buildingAdminApi.get<VehicleRow[]>(
        `/building-admin/buildings/${buildingId}/vehicles`,
      );
      setVehicles((r.data ?? []).filter((v) => v.residentId === resident.id));
    } catch {
      setVehicles([]);
    } finally {
      setVLoading(false);
    }
  }, [buildingId, resident.id]);

  const load = useCallback(async () => {
    let cancelled = false;
    void loadVehicles();

    // Aktywność — backend `q` szuka m.in. po residentName.
    setELoading(true);
    buildingAdminApi
      .get<{ events: AccessEventRow[] }>(
        `/building-admin/buildings/${buildingId}/access-events`,
        { params: { q: fullName, limit: 20 } },
      )
      .then((r) => {
        if (cancelled) return;
        setEvents(r.data?.events ?? []);
      })
      .catch(() => !cancelled && setEvents([]))
      .finally(() => !cancelled && setELoading(false));

    // Płatności — znajdź wpisy dla lokali tego rezydenta po email match.
    setPLoading(true);
    buildingAdminApi
      .get<PaymentUnitRow[]>(`/building-admin/buildings/${buildingId}/payments`)
      .then((r) => {
        if (cancelled) return;
        const mine = (r.data ?? []).filter((p) =>
          (p.residents ?? []).some((res) => res.email === resident.email),
        );
        setPayments(mine);
      })
      .catch(() => !cancelled && setPayments([]))
      .finally(() => !cancelled && setPLoading(false));

    return () => {
      cancelled = true;
    };
  }, [buildingId, resident.email, fullName, loadVehicles]);

  useEffect(() => {
    const cleanup = load();
    return () => {
      void cleanup.then((fn) => fn?.());
    };
  }, [load]);

  const cancelAddVehicle = () => {
    setVAdding(false);
    setVError(null);
    setVPlate(""); setVMake(""); setVModel(""); setVColor("");
  };

  const addVehicle = async (e: React.FormEvent) => {
    e.preventDefault();
    const plate = vPlate.trim().toUpperCase();
    if (!plate) return;
    setVBusy(true);
    setVError(null);
    try {
      await buildingAdminApi.post(`/building-admin/buildings/${buildingId}/vehicles`, {
        kind: "RESIDENT",
        residentId: resident.id,
        licensePlate: plate,
        // Backend wymaga make/color jako string — „—" to ta sama konwencja,
        // co w formularzu przy lokalu (pola opisowe są opcjonalne dla admina).
        make: vMake.trim() || "—",
        model: vModel.trim() || undefined,
        color: vColor.trim() || "—",
      });
      cancelAddVehicle();
      await loadVehicles();
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string | string[] } } };
      const msg = e2.response?.data?.message;
      setVError(Array.isArray(msg) ? msg.join(", ") : (msg ?? "Nie udało się dodać pojazdu"));
    } finally {
      setVBusy(false);
    }
  };

  const removeVehicle = async (v: VehicleRow) => {
    if (!window.confirm(`Usunąć pojazd ${v.licensePlate}? Zniknie też z białej listy wjazdu.`)) return;
    setVBusy(true);
    setVError(null);
    try {
      await buildingAdminApi.delete(`/building-admin/buildings/${buildingId}/vehicles/${v.id}`);
      await loadVehicles();
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      setVError(e2.response?.data?.message ?? "Nie udało się usunąć pojazdu");
    } finally {
      setVBusy(false);
    }
  };

  const initials = `${resident.firstName?.[0] ?? ""}${resident.lastName?.[0] ?? ""}`.toUpperCase();
  const activeUnits = (resident.unitResidents ?? []).filter((ur) => !ur.untilDate);

  // FAZA polish (d) — group events by day (events come time-desc from backend)
  const groupedEvents = useMemo(() => {
    if (!events) return [] as Array<{ key: string; label: string; events: AccessEventRow[] }>;
    const groups = new Map<string, AccessEventRow[]>();
    for (const ev of events) {
      const k = dayKey(ev.ts);
      const list = groups.get(k);
      if (list) list.push(ev);
      else groups.set(k, [ev]);
    }
    return Array.from(groups.entries()).map(([key, evs]) => ({
      key,
      label: dayLabel(key),
      events: evs,
    }));
  }, [events]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      {/* keyframes skeleton — inline, scoped do tego drawera */}
      <style>{`@keyframes ba-skel { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>

      {/* Header */}
      <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: 999,
            background: "#dbe7ff",
            color: "#1f4cb8",
            display: "grid",
            placeItems: "center",
            fontSize: 22,
            fontWeight: 700,
          }}
        >
          {initials || "??"}
        </div>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.01em" }}>{fullName}</div>
          <div style={{ color: "var(--muted)", fontSize: 13 }}>{resident.email}</div>
        </div>
      </div>

      {/* ── Profil ── */}
      <section>
        <div style={sectionLabelStyle}>
          <KeyRound size={12} /> Profil
        </div>
        <div className="ba-kv-grid">
          <div className="ba-kv">
            <div className="k">E-mail</div>
            <div className="v">{resident.email}</div>
          </div>
          <div className="ba-kv">
            <div className="k">Telefon</div>
            <div className="v">{resident.phone || "—"}</div>
          </div>
          <div className="ba-kv">
            <div className="k">Status</div>
            <div className="v">{resident.status ? resident.status : "Aktywny"}</div>
          </div>
          <div className="ba-kv">
            <div className="k">Dołączył</div>
            <div className="v">{fmtDate(resident.createdAt)}</div>
          </div>
        </div>
      </section>

      {/* ── Lokale ── */}
      <section>
        <div style={sectionLabelStyle}>
          <Home size={12} /> Lokale
        </div>
        {activeUnits.length === 0 ? (
          <EmptyLine text="Brak przypisanych lokali" />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {activeUnits.map((ur, i) => (
              <div
                key={ur.id ?? i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 12px",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--r-2)",
                  background: "var(--surface-2)",
                }}
              >
                <div style={{ fontWeight: 700, fontSize: 14 }}>{ur.unit?.number ?? "—"}</div>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>{ur.unit?.unitType?.name ?? ""}</div>
                <div style={{ flex: 1 }} />
                <span className={ur.role === "OWNER" ? "ba-pill blue" : "ba-pill"}>
                  {ur.role === "OWNER" ? "Właściciel" : ur.role === "TENANT" ? "Najemca" : ur.role ?? "—"}
                </span>
                <span style={{ fontSize: 11.5, color: "var(--muted)" }}>od {fmtDate(ur.sinceDate)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Pojazdy ── */}
      <section>
        <div style={sectionLabelStyle}>
          <Car size={12} /> Pojazdy{vehicles ? ` (${vehicles.length})` : ""}
        </div>
        {vLoading ? (
          <Skeleton rows={2} />
        ) : !vehicles || vehicles.length === 0 ? (
          <EmptyLine text="Brak pojazdów" />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {vehicles.map((v) => (
              <div
                key={v.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 12px",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--r-2)",
                  background: "var(--surface-2)",
                }}
              >
                <span
                  className="ba-mono"
                  style={{
                    fontSize: 12.5,
                    fontWeight: 700,
                    padding: "3px 8px",
                    border: "1px solid var(--border-strong)",
                    borderRadius: 6,
                    background: "var(--surface)",
                  }}
                >
                  {v.licensePlate}
                </span>
                <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
                  {[v.make, v.model].filter(Boolean).join(" ") || "—"}
                </div>
                <div style={{ flex: 1 }} />
                <span className={vehicleStatusClass(v.status)}>{VEHICLE_STATUS_PL[v.status] ?? v.status}</span>
                <button
                  type="button"
                  className="ba-btn sm"
                  title="Usuń pojazd"
                  onClick={() => void removeVehicle(v)}
                  disabled={vBusy}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        {vError ? (
          <div className="ba-pill red" style={{ display: "block", padding: "8px 12px", marginTop: 8 }}>
            {vError}
          </div>
        ) : null}

        {!vAdding ? (
          <button type="button" className="ba-btn sm" style={{ marginTop: 10 }} onClick={() => setVAdding(true)}>
            <Plus size={12} /> Dodaj pojazd
          </button>
        ) : (
          <form
            onSubmit={addVehicle}
            style={{
              display: "grid",
              gap: 8,
              border: "1px solid var(--border)",
              borderRadius: "var(--r-2)",
              padding: 12,
              marginTop: 10,
            }}
          >
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <VehicleField label="Tablica rejestracyjna">
                <input
                  required
                  autoFocus
                  value={vPlate}
                  onChange={(e) => setVPlate(e.target.value)}
                  className="ba-input"
                  placeholder="np. WD5005P"
                />
              </VehicleField>
              <VehicleField label="Marka">
                <input value={vMake} onChange={(e) => setVMake(e.target.value)} className="ba-input" placeholder="np. Toyota" />
              </VehicleField>
              <VehicleField label="Model">
                <input value={vModel} onChange={(e) => setVModel(e.target.value)} className="ba-input" />
              </VehicleField>
              <VehicleField label="Kolor">
                <input value={vColor} onChange={(e) => setVColor(e.target.value)} className="ba-input" placeholder="np. czarny" />
              </VehicleField>
            </div>
            <p style={{ fontSize: 11.5, color: "var(--muted)", margin: 0 }}>
              Właściciel: <strong>{fullName}</strong>. Pojazd dodany przez administratora jest od razu
              zatwierdzony i trafia na białą listę wjazdu.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="submit" className="ba-btn primary sm" disabled={vBusy}>
                {vBusy ? "Dodawanie…" : "Dodaj pojazd"}
              </button>
              <button type="button" className="ba-btn sm" onClick={cancelAddVehicle} disabled={vBusy}>
                Anuluj
              </button>
            </div>
          </form>
        )}
      </section>

      {/* ── Aktywność (timeline grouped by day) ── */}
      <section>
        <div style={sectionLabelStyle}>
          <Activity size={12} /> Aktywność
        </div>
        {eLoading ? (
          <Skeleton rows={3} />
        ) : !events || events.length === 0 ? (
          <EmptyLine text="Brak ostatniej aktywności" />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {groupedEvents.map((group) => (
              <div key={group.key}>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    color: "var(--muted)",
                    marginBottom: 6,
                    paddingLeft: 4,
                  }}
                >
                  {group.label}
                </div>
                <div
                  style={{
                    position: "relative",
                    paddingLeft: 14,
                  }}
                >
                  {/* Vertical line łącząca eventy w grupie */}
                  <div
                    style={{
                      position: "absolute",
                      left: 13,
                      top: 12,
                      bottom: 12,
                      width: 1,
                      background: "var(--border)",
                    }}
                  />
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {group.events.map((ev) => {
                      const { Icon, tone } = accessEventIcon(ev.type);
                      const gateLabel = ev.gateOpened ? null : !ev.gateOpened && ev.type !== "INTERCOM_CALL" ? "nie otwarto" : null;
                      return (
                        <div
                          key={ev.id}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            position: "relative",
                          }}
                        >
                          {/* Ikona / dot */}
                          <div
                            style={{
                              width: 26,
                              height: 26,
                              borderRadius: 999,
                              background: TONE_BG[tone],
                              color: TONE_FG[tone],
                              display: "grid",
                              placeItems: "center",
                              border: "1px solid var(--border)",
                              flexShrink: 0,
                              marginLeft: -13,
                              zIndex: 1,
                            }}
                          >
                            <Icon size={13} />
                          </div>
                          <div
                            style={{
                              flex: 1,
                              minWidth: 0,
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              padding: "6px 10px",
                              border: "1px solid var(--border)",
                              borderRadius: "var(--r-2)",
                              fontSize: 12.5,
                              background: "var(--surface)",
                            }}
                          >
                            <span style={{ fontWeight: 600 }}>{ACCESS_TYPE_PL[ev.type] ?? ev.type}</span>
                            {ev.plate ? (
                              <span className="ba-mono" style={{ fontSize: 11.5, color: "var(--muted)" }}>
                                {ev.plate}
                              </span>
                            ) : null}
                            {ev.accessPointLabel ? (
                              <span style={{ fontSize: 11.5, color: "var(--muted)" }}>· {ev.accessPointLabel}</span>
                            ) : null}
                            {gateLabel ? (
                              <span style={{ fontSize: 11.5, color: "var(--red)" }}>· {gateLabel}</span>
                            ) : null}
                            <div style={{ flex: 1 }} />
                            <span style={{ fontSize: 11.5, color: "var(--muted-2)", whiteSpace: "nowrap" }}>
                              {fmtTime(ev.ts)}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Płatności ── */}
      <section>
        <div style={sectionLabelStyle}>
          <CreditCard size={12} /> Płatności
        </div>
        {pLoading ? (
          <Skeleton rows={1} />
        ) : !payments || payments.length === 0 ? (
          <EmptyLine text="Brak danych o płatnościach" />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {payments.map((p) => {
              const negative = p.balance < 0;
              return (
                <div
                  key={p.unitId}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 12px",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--r-2)",
                    background: "var(--surface-2)",
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: 13.5 }}>Lokal {p.number}</div>
                  <div style={{ flex: 1 }} />
                  <div
                    style={{
                      fontWeight: 700,
                      fontSize: 13.5,
                      color: negative ? "var(--red)" : "var(--green)",
                    }}
                  >
                    {p.balance.toLocaleString("pl-PL", { style: "currency", currency: "PLN" })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
