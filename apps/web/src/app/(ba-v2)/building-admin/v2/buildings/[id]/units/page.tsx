"use client";
// Units tab — 2026-07-21 (decyzja Konrada): pełne zarządzanie lokalem.
//   • Lista lokali: search + filtr klatki + dodanie lokalu
//   • Drawer szczegółów:
//       – edycja i usunięcie lokalu,
//       – SALDO lokalu (ledger płatności) + ostatnie operacje,
//       – mieszkańcy: przypisz istniejącego / dodaj nowego (auto-przypisanie) /
//         odepnij,
//       – pojazdy mieszkańców lokalu: dodaj / usuń,
//       – goście mieszkańców lokalu: dodaj / usuń.
// Wszystko na istniejących endpointach BA (units CRUD, unit_residents,
// residents, vehicles, guests, payments/:unitId).
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Car,
  CreditCard,
  Home,
  Pencil,
  Plus,
  Search,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { buildingAdminApi } from "@/lib/building-admin-api";
import { ResidentDrawer } from "@/components/ba-v2/ResidentDrawer";
import { BUILDING_TZ } from "@/lib/building-time";

interface UnitType {
  id: number;
  name: string;
  icon: string;
  isCommonArea?: boolean;
}
interface Stairwell {
  id: number;
  name: string;
}
interface ResidentLite {
  id: number;
  firstName: string;
  lastName: string;
  email?: string;
}
interface UnitResidentEntry {
  id: number;
  role?: string | null;
  sinceDate?: string | null;
  untilDate?: string | null;
  resident?: ResidentLite | null;
}
interface Unit {
  id: number;
  number: string;
  floor?: number | null;
  areaSqm?: number | string | null;
  unitTypeId?: number;
  unitType?: UnitType | null;
  stairwellId?: number | null;
  stairwell?: Stairwell | null;
  unitResidents?: UnitResidentEntry[];
}
interface VehicleRow {
  id: number;
  residentId?: number | null;
  licensePlate: string;
  make?: string | null;
  model?: string | null;
  color?: string | null;
  status?: string | null;
  kind?: string | null;
  resident?: { id: number; firstName: string; lastName: string } | null;
}
interface GuestRow {
  id: number;
  residentId?: number | null;
  name: string;
  pin?: string | null;
  status?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
}
interface UnitPayments {
  balance: number;
  entries: { id?: number; amount: number; type?: string; date: string; description?: string | null }[];
}

const plnFmt = new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" });
const todayIso = () => new Date().toISOString().slice(0, 10);

const VEHICLE_STATUS_PL: Record<string, string> = {
  PENDING: "Oczekuje",
  APPROVED: "Zatwierdzony",
  REJECTED: "Odrzucony",
  BLOCKED: "Zablokowany",
  EXPIRED: "Wygasł",
};

export default function UnitsPage() {
  const params = useParams();
  const router = useRouter();
  const idStr = Array.isArray(params?.id) ? params.id[0] : params?.id;
  const buildingId = Number(idStr);

  const [units, setUnits] = useState<Unit[]>([]);
  const [unitTypes, setUnitTypes] = useState<UnitType[]>([]);
  const [stairwells, setStairwells] = useState<Stairwell[]>([]);
  const [loading, setLoading] = useState(true);

  const [query, setQuery] = useState("");
  const [stairFilter, setStairFilter] = useState<number | "all">("all");

  // Add-form (lista)
  const [showAdd, setShowAdd] = useState(false);
  const [uTypeId, setUTypeId] = useState("");
  const [uNumber, setUNumber] = useState("");
  const [uFloor, setUFloor] = useState("");
  const [uArea, setUArea] = useState("");
  const [uStairwellId, setUStairwellId] = useState("");
  const [uAdding, setUAdding] = useState(false);
  const [uError, setUError] = useState<string | null>(null);

  // Drawer
  const [selUnit, setSelUnit] = useState<Unit | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [payments, setPayments] = useState<UnitPayments | null>(null);
  const [allResidents, setAllResidents] = useState<ResidentLite[]>([]);
  const [vehicles, setVehicles] = useState<VehicleRow[]>([]);
  const [guests, setGuests] = useState<GuestRow[]>([]);
  const [drawerError, setDrawerError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!Number.isFinite(buildingId)) return;
    setLoading(true);
    try {
      const [unitsRes, buildingRes, typesRes] = await Promise.all([
        buildingAdminApi.get<Unit[]>(`/building-admin/buildings/${buildingId}/units`),
        buildingAdminApi
          .get<{ stairwells?: Stairwell[] }>(`/building-admin/buildings/${buildingId}`)
          .catch(() => ({ data: {} as { stairwells?: Stairwell[] } })),
        buildingAdminApi
          .get<UnitType[]>(`/building-admin/buildings/${buildingId}/unit-types`)
          .catch(() => ({ data: [] as UnitType[] })),
      ]);
      setUnits(unitsRes.data);
      setStairwells(buildingRes.data?.stairwells ?? []);
      setUnitTypes(typesRes.data ?? []);
    } finally {
      setLoading(false);
    }
  }, [buildingId]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    return units.filter((u) => {
      if (stairFilter !== "all" && u.stairwellId !== stairFilter) return false;
      if (!query.trim()) return true;
      const q = query.trim().toLowerCase();
      return (
        u.number.toLowerCase().includes(q) ||
        (u.unitType?.name?.toLowerCase() ?? "").includes(q)
      );
    });
  }, [units, query, stairFilter]);

  // ── Drawer: ładowanie kompletu danych lokalu ──
  const refreshDrawer = useCallback(
    async (unitId: number) => {
      const [unitRes, payRes, residentsRes, vehiclesRes, guestsRes] = await Promise.allSettled([
        buildingAdminApi.get<Unit>(`/building-admin/buildings/${buildingId}/units/${unitId}`),
        buildingAdminApi.get<UnitPayments>(`/building-admin/buildings/${buildingId}/payments/${unitId}`),
        buildingAdminApi.get<ResidentLite[]>(`/building-admin/buildings/${buildingId}/residents`),
        buildingAdminApi.get<VehicleRow[]>(`/building-admin/buildings/${buildingId}/vehicles`),
        buildingAdminApi.get<GuestRow[]>(`/building-admin/buildings/${buildingId}/guests`),
      ]);
      if (unitRes.status === "fulfilled") setSelUnit(unitRes.value.data);
      setPayments(payRes.status === "fulfilled" ? payRes.value.data : null);
      setAllResidents(residentsRes.status === "fulfilled" ? residentsRes.value.data : []);
      setVehicles(vehiclesRes.status === "fulfilled" ? vehiclesRes.value.data : []);
      setGuests(guestsRes.status === "fulfilled" ? guestsRes.value.data : []);
    },
    [buildingId],
  );

  const openDrawer = async (u: Unit) => {
    setSelUnit(u);
    setPayments(null);
    setDrawerError(null);
    setDrawerOpen(true);
    await refreshDrawer(u.id);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setTimeout(() => setSelUnit(null), 320);
  };

  const onAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setUAdding(true);
    setUError(null);
    try {
      await buildingAdminApi.post(`/building-admin/buildings/${buildingId}/units`, {
        unitTypeId: +uTypeId,
        number: uNumber,
        floor: uFloor ? +uFloor : undefined,
        areaSqm: uArea ? +uArea : undefined,
        stairwellId: uStairwellId ? +uStairwellId : undefined,
      });
      setShowAdd(false);
      setUTypeId("");
      setUNumber("");
      setUFloor("");
      setUArea("");
      setUStairwellId("");
      await load();
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      setUError(e2.response?.data?.message ?? "Błąd dodawania lokalu");
    } finally {
      setUAdding(false);
    }
  };

  const onDelete = async (unitId: number) => {
    if (!window.confirm("Usunąć ten lokal? Operacja jest nieodwracalna.")) return;
    try {
      await buildingAdminApi.delete(`/building-admin/buildings/${buildingId}/units/${unitId}`);
      closeDrawer();
      await load();
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      alert(e2.response?.data?.message ?? "Nie udało się usunąć lokalu");
    }
  };

  const goPayments = () => router.push(`/building-admin/v2/buildings/${buildingId}/payments`);

  return (
    <>
      <div className="ba-panel">
        <div className="ba-panel-head">
          <div className="ba-panel-title">
            <Home size={16} />
            Lokale
            <span className="pill">{units.length}</span>
          </div>
          <div className="ba-panel-tools">
            <div className="ba-search" style={{ width: 240 }}>
              <Search size={14} />
              <input
                placeholder="Szukaj po numerze…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            {stairwells.length > 1 ? (
              <select
                className="ba-input"
                style={{ width: 160 }}
                value={stairFilter === "all" ? "all" : String(stairFilter)}
                onChange={(e) =>
                  setStairFilter(e.target.value === "all" ? "all" : Number(e.target.value))
                }
              >
                <option value="all">Wszystkie klatki</option>
                {stairwells.map((sw) => (
                  <option key={sw.id} value={sw.id}>
                    {sw.name}
                  </option>
                ))}
              </select>
            ) : null}
            {!showAdd ? (
              <button type="button" className="ba-btn primary sm" onClick={() => setShowAdd(true)}>
                <Plus size={13} /> Dodaj lokal
              </button>
            ) : null}
          </div>
        </div>

        {showAdd ? (
          <form
            onSubmit={onAdd}
            style={{ padding: 16, borderBottom: "1px solid var(--border)", display: "grid", gap: 10 }}
          >
            {uError ? (
              <div className="ba-pill red" style={{ display: "block", padding: "8px 12px" }}>
                {uError}
              </div>
            ) : null}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <FormField label="Typ lokalu">
                <select required value={uTypeId} onChange={(e) => setUTypeId(e.target.value)} className="ba-input">
                  <option value="">— Wybierz —</option>
                  {unitTypes.map((ut) => (
                    <option key={ut.id} value={ut.id}>
                      {ut.name}
                      {ut.isCommonArea ? " (część wspólna)" : ""}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Numer / nazwa">
                <input required value={uNumber} onChange={(e) => setUNumber(e.target.value)} className="ba-input" placeholder="np. 14" />
              </FormField>
              <FormField label="Piętro">
                <input type="number" value={uFloor} onChange={(e) => setUFloor(e.target.value)} className="ba-input" />
              </FormField>
              <FormField label="Powierzchnia (m²)">
                <input type="number" step="0.01" value={uArea} onChange={(e) => setUArea(e.target.value)} className="ba-input" />
              </FormField>
              {stairwells.length > 0 ? (
                <FormField label="Klatka schodowa">
                  <select value={uStairwellId} onChange={(e) => setUStairwellId(e.target.value)} className="ba-input">
                    <option value="">— Brak —</option>
                    {stairwells.map((sw) => (
                      <option key={sw.id} value={sw.id}>
                        {sw.name}
                      </option>
                    ))}
                  </select>
                </FormField>
              ) : null}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="submit" disabled={uAdding} className="ba-btn primary">
                {uAdding ? "Dodawanie…" : "Dodaj lokal"}
              </button>
              <button type="button" className="ba-btn" onClick={() => setShowAdd(false)}>
                Anuluj
              </button>
            </div>
          </form>
        ) : null}

        {loading ? (
          <div className="ba-empty">Ładowanie…</div>
        ) : filtered.length === 0 ? (
          <div className="ba-empty">
            <div className="ico">
              <Home size={22} />
            </div>
            <h4>Brak lokali</h4>
            <p>{units.length === 0 ? "Dodaj pierwszy lokal, aby zacząć." : "Brak wyników dla aktualnych filtrów."}</p>
          </div>
        ) : (
          <div>
            <div
              className="ba-row"
              style={{
                gridTemplateColumns: "1fr 1fr 0.8fr 0.8fr 0.8fr",
                background: "var(--surface-2)",
                fontSize: 11,
                color: "var(--muted)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                fontWeight: 600,
                cursor: "default",
              }}
            >
              <div>Numer</div>
              <div>Klatka / piętro</div>
              <div>Metraż</div>
              <div>Typ</div>
              <div style={{ textAlign: "right" }}>Mieszkańcy</div>
            </div>
            {filtered.map((u) => {
              const residentsCount = (u.unitResidents ?? []).length;
              const area = u.areaSqm != null ? `${Number(u.areaSqm).toFixed(1)} m²` : "—";
              return (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => void openDrawer(u)}
                  className="ba-row"
                  style={{
                    width: "100%",
                    textAlign: "left",
                    background: "transparent",
                    border: 0,
                    borderBottom: "1px solid var(--border)",
                    gridTemplateColumns: "1fr 1fr 0.8fr 0.8fr 0.8fr",
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{u.number}</div>
                  <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
                    {u.stairwell?.name ?? "—"}
                    {u.floor != null ? ` · p. ${u.floor}` : ""}
                  </div>
                  <div className="ba-mono" style={{ fontSize: 12.5 }}>{area}</div>
                  <div style={{ fontSize: 12.5, color: "var(--muted)" }}>{u.unitType?.name ?? "—"}</div>
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <span className={`ba-pill ${residentsCount > 0 ? "blue" : ""}`}>
                      <Users size={11} /> {residentsCount}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <ResidentDrawer
        open={drawerOpen}
        onClose={closeDrawer}
        title={selUnit ? `Lokal ${selUnit.number}` : "Lokal"}
        footer={
          selUnit ? (
            <button type="button" className="ba-btn danger" onClick={() => onDelete(selUnit.id)}>
              <Trash2 size={13} /> Usuń lokal
            </button>
          ) : null
        }
      >
        {selUnit ? (
          <UnitDetails
            key={selUnit.id}
            buildingId={buildingId}
            unit={selUnit}
            unitTypes={unitTypes}
            stairwells={stairwells}
            payments={payments}
            allResidents={allResidents}
            vehicles={vehicles}
            guests={guests}
            error={drawerError}
            setError={setDrawerError}
            onChanged={async () => {
              await refreshDrawer(selUnit.id);
              await load();
            }}
            onGoPayments={goPayments}
          />
        ) : null}
      </ResidentDrawer>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Szczegóły lokalu w drawerze
// ─────────────────────────────────────────────────────────────────────────────
function UnitDetails({
  buildingId, unit, unitTypes, stairwells, payments, allResidents, vehicles, guests,
  error, setError, onChanged, onGoPayments,
}: {
  buildingId: number;
  unit: Unit;
  unitTypes: UnitType[];
  stairwells: Stairwell[];
  payments: UnitPayments | null;
  allResidents: ResidentLite[];
  vehicles: VehicleRow[];
  guests: GuestRow[];
  error: string | null;
  setError: (e: string | null) => void;
  onChanged: () => Promise<void>;
  onGoPayments: () => void;
}) {
  const [editing, setEditing] = useState(false);

  const activeAssignments = (unit.unitResidents ?? []).filter(
    (ur) => ur.resident && (!ur.untilDate || new Date(ur.untilDate) > new Date()),
  );
  const unitResidentIds = new Set(activeAssignments.map((ur) => ur.resident!.id));
  const unitVehicles = vehicles.filter((v) => v.residentId != null && unitResidentIds.has(v.residentId));
  const unitGuests = guests.filter((g) => g.residentId != null && unitResidentIds.has(g.residentId));

  const wrap = async (fn: () => Promise<unknown>, fallbackMsg: string) => {
    setError(null);
    try {
      await fn();
      await onChanged();
      return true;
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      setError(e2.response?.data?.message ?? fallbackMsg);
      return false;
    }
  };

  return (
    <div>
      {error ? (
        <div className="ba-pill red" style={{ display: "block", padding: "8px 12px", marginBottom: 12 }}>
          {error}
        </div>
      ) : null}

      {/* ── Dane lokalu + edycja ── */}
      {editing ? (
        <UnitEditForm
          buildingId={buildingId}
          unit={unit}
          unitTypes={unitTypes}
          stairwells={stairwells}
          onCancel={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await onChanged();
          }}
        />
      ) : (
        <>
          <div className="ba-kv-grid">
            <div className="ba-kv"><div className="k">Numer</div><div className="v">{unit.number}</div></div>
            <div className="ba-kv"><div className="k">Typ</div><div className="v">{unit.unitType?.name ?? "—"}</div></div>
            <div className="ba-kv"><div className="k">Piętro</div><div className="v">{unit.floor ?? "—"}</div></div>
            <div className="ba-kv">
              <div className="k">Metraż</div>
              <div className="v">{unit.areaSqm != null ? `${Number(unit.areaSqm).toFixed(1)} m²` : "—"}</div>
            </div>
            <div className="ba-kv" style={{ gridColumn: "span 2" }}>
              <div className="k">Klatka schodowa</div>
              <div className="v">{unit.stairwell?.name ?? "—"}</div>
            </div>
          </div>
          <button type="button" className="ba-btn sm" style={{ marginTop: 10 }} onClick={() => setEditing(true)}>
            <Pencil size={12} /> Edytuj dane lokalu
          </button>
        </>
      )}

      {/* ── Saldo ── */}
      <div className="ba-section-label" style={{ marginTop: 20, marginBottom: 8 }}>
        <CreditCard size={12} style={{ verticalAlign: -2, marginRight: 5 }} />
        Saldo lokalu
      </div>
      {payments === null ? (
        <p style={{ fontSize: 12.5, color: "var(--muted)", margin: 0 }}>Ładowanie salda…</p>
      ) : (
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px" }}>
          <div
            style={{
              fontSize: 24,
              fontWeight: 700,
              color: payments.balance < 0 ? "var(--red, #dc2626)" : "var(--green, #059669)",
            }}
          >
            {plnFmt.format(payments.balance)}
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", marginLeft: 8 }}>
              {payments.balance < 0 ? "zaległość" : "na plusie / rozliczone"}
            </span>
          </div>
          {payments.entries.length > 0 ? (
            <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
              {payments.entries.slice(0, 5).map((e, i) => (
                <div
                  key={e.id ?? i}
                  style={{ display: "flex", gap: 8, fontSize: 12, padding: "3px 0", alignItems: "baseline" }}
                >
                  <span style={{ color: "var(--muted)", minWidth: 72 }}>
                    {new Date(e.date).toLocaleDateString("pl-PL", { timeZone: BUILDING_TZ })}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {e.description ?? e.type ?? "—"}
                  </span>
                  <span
                    className="ba-mono"
                    style={{ fontWeight: 700, color: e.amount < 0 ? "var(--red, #dc2626)" : "var(--green, #059669)" }}
                  >
                    {plnFmt.format(e.amount)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          <button type="button" className="ba-btn sm" style={{ marginTop: 10 }} onClick={onGoPayments}>
            Pełna historia płatności →
          </button>
        </div>
      )}

      {/* ── Mieszkańcy ── */}
      <SectionResidents
        buildingId={buildingId}
        unit={unit}
        activeAssignments={activeAssignments}
        allResidents={allResidents}
        wrap={wrap}
      />

      {/* ── Pojazdy ── */}
      <SectionVehicles
        buildingId={buildingId}
        unitVehicles={unitVehicles}
        unitResidents={activeAssignments.map((ur) => ur.resident!)}
        wrap={wrap}
      />

      {/* ── Goście ── */}
      <SectionGuests
        buildingId={buildingId}
        unitGuests={unitGuests}
        unitResidents={activeAssignments.map((ur) => ur.resident!)}
        wrap={wrap}
      />
    </div>
  );
}

function UnitEditForm({
  buildingId, unit, unitTypes, stairwells, onCancel, onSaved,
}: {
  buildingId: number;
  unit: Unit;
  unitTypes: UnitType[];
  stairwells: Stairwell[];
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [num, setNum] = useState(unit.number);
  const [typeId, setTypeId] = useState(String(unit.unitTypeId ?? unit.unitType?.id ?? ""));
  const [floor, setFloor] = useState(unit.floor != null ? String(unit.floor) : "");
  const [area, setArea] = useState(unit.areaSqm != null ? String(unit.areaSqm) : "");
  const [swId, setSwId] = useState(unit.stairwellId != null ? String(unit.stairwellId) : "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      await buildingAdminApi.patch(`/building-admin/buildings/${buildingId}/units/${unit.id}`, {
        number: num,
        unitTypeId: typeId ? +typeId : undefined,
        floor: floor === "" ? undefined : +floor,
        areaSqm: area === "" ? undefined : +area,
        stairwellId: swId === "" ? undefined : +swId,
      });
      await onSaved();
    } catch (error: unknown) {
      const e2 = error as { response?: { data?: { message?: string } } };
      setErr(e2.response?.data?.message ?? "Nie udało się zapisać zmian");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 10 }}>
      {err ? (
        <div className="ba-pill red" style={{ display: "block", padding: "8px 12px" }}>{err}</div>
      ) : null}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <FormField label="Numer / nazwa">
          <input required value={num} onChange={(e) => setNum(e.target.value)} className="ba-input" />
        </FormField>
        <FormField label="Typ lokalu">
          <select value={typeId} onChange={(e) => setTypeId(e.target.value)} className="ba-input">
            {unitTypes.map((ut) => (
              <option key={ut.id} value={ut.id}>{ut.name}</option>
            ))}
          </select>
        </FormField>
        <FormField label="Piętro">
          <input type="number" value={floor} onChange={(e) => setFloor(e.target.value)} className="ba-input" />
        </FormField>
        <FormField label="Powierzchnia (m²)">
          <input type="number" step="0.01" value={area} onChange={(e) => setArea(e.target.value)} className="ba-input" />
        </FormField>
        {stairwells.length > 0 ? (
          <FormField label="Klatka schodowa">
            <select value={swId} onChange={(e) => setSwId(e.target.value)} className="ba-input">
              <option value="">— Brak —</option>
              {stairwells.map((sw) => (
                <option key={sw.id} value={sw.id}>{sw.name}</option>
              ))}
            </select>
          </FormField>
        ) : null}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" disabled={saving} className="ba-btn primary sm">
          {saving ? "Zapisywanie…" : "Zapisz zmiany"}
        </button>
        <button type="button" className="ba-btn sm" onClick={onCancel}>Anuluj</button>
      </div>
    </form>
  );
}

// ── Sekcja: mieszkańcy lokalu ────────────────────────────────────────────────
function SectionResidents({
  buildingId, unit, activeAssignments, allResidents, wrap,
}: {
  buildingId: number;
  unit: Unit;
  activeAssignments: UnitResidentEntry[];
  allResidents: ResidentLite[];
  wrap: (fn: () => Promise<unknown>, msg: string) => Promise<boolean>;
}) {
  const [mode, setMode] = useState<"none" | "assign" | "create">("none");
  const [pickId, setPickId] = useState("");
  const [role, setRole] = useState<"OWNER" | "TENANT">("OWNER");
  const [nFirst, setNFirst] = useState("");
  const [nLast, setNLast] = useState("");
  const [nEmail, setNEmail] = useState("");
  const [nPhone, setNPhone] = useState("");
  const [busy, setBusy] = useState(false);

  const assignedIds = new Set(activeAssignments.map((ur) => ur.resident!.id));
  const candidates = allResidents.filter((r) => !assignedIds.has(r.id));

  const assign = async (residentId: number) => {
    setBusy(true);
    const ok = await wrap(
      () =>
        buildingAdminApi.post(`/building-admin/buildings/${buildingId}/units/${unit.id}/residents`, {
          residentId,
          role,
          sinceDate: todayIso(),
        }),
      "Nie udało się przypisać mieszkańca",
    );
    setBusy(false);
    if (ok) {
      setMode("none");
      setPickId("");
    }
  };

  const createAndAssign = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const ok = await wrap(async () => {
      const res = await buildingAdminApi.post<{ id: number }>(
        `/building-admin/buildings/${buildingId}/residents`,
        { firstName: nFirst, lastName: nLast, email: nEmail, phone: nPhone || undefined },
      );
      await buildingAdminApi.post(`/building-admin/buildings/${buildingId}/units/${unit.id}/residents`, {
        residentId: res.data.id,
        role,
        sinceDate: todayIso(),
      });
    }, "Nie udało się dodać mieszkańca");
    setBusy(false);
    if (ok) {
      setMode("none");
      setNFirst(""); setNLast(""); setNEmail(""); setNPhone("");
    }
  };

  const unassign = async (ur: UnitResidentEntry) => {
    const r = ur.resident!;
    if (!window.confirm(`Odpiąć mieszkańca ${r.firstName} ${r.lastName} od lokalu?`)) return;
    await wrap(
      () =>
        buildingAdminApi.delete(
          `/building-admin/buildings/${buildingId}/units/${unit.id}/residents/${ur.id}`,
        ),
      "Nie udało się odpiąć mieszkańca",
    );
  };

  return (
    <>
      <div className="ba-section-label" style={{ marginTop: 20, marginBottom: 8 }}>
        <Users size={12} style={{ verticalAlign: -2, marginRight: 5 }} />
        Mieszkańcy ({activeAssignments.length})
      </div>

      {activeAssignments.length === 0 ? (
        <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "0 0 8px" }}>Brak przypisanych mieszkańców.</p>
      ) : (
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", marginBottom: 8 }}>
          {activeAssignments.map((ur) => {
            const r = ur.resident!;
            const initials = `${r.firstName?.[0] ?? ""}${r.lastName?.[0] ?? ""}`.toUpperCase();
            return (
              <div
                key={ur.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "32px 1fr auto",
                  gap: 10,
                  alignItems: "center",
                  padding: "10px 12px",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <div className="ba-av">{initials || "??"}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{r.firstName} {r.lastName}</div>
                  <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                    {ur.role === "OWNER" ? "Właściciel" : ur.role === "TENANT" ? "Najemca" : ur.role ?? "—"}
                    {ur.sinceDate ? ` · od ${new Date(ur.sinceDate).toLocaleDateString("pl-PL", { timeZone: BUILDING_TZ })}` : ""}
                  </div>
                </div>
                <button
                  type="button"
                  className="ba-btn sm"
                  title="Odepnij od lokalu"
                  onClick={() => void unassign(ur)}
                >
                  <X size={12} /> Odepnij
                </button>
              </div>
            );
          })}
        </div>
      )}

      {mode === "none" ? (
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="ba-btn sm" onClick={() => setMode("assign")}>
            <UserPlus size={12} /> Przypisz istniejącego
          </button>
          <button type="button" className="ba-btn sm" onClick={() => setMode("create")}>
            <Plus size={12} /> Nowy mieszkaniec
          </button>
        </div>
      ) : mode === "assign" ? (
        <div style={{ display: "grid", gap: 8, border: "1px solid var(--border)", borderRadius: 10, padding: 12 }}>
          <FormField label="Mieszkaniec">
            <select value={pickId} onChange={(e) => setPickId(e.target.value)} className="ba-input">
              <option value="">— Wybierz —</option>
              {candidates.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.firstName} {r.lastName}{r.email ? ` (${r.email})` : ""}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Rola">
            <select value={role} onChange={(e) => setRole(e.target.value as "OWNER" | "TENANT")} className="ba-input">
              <option value="OWNER">Właściciel</option>
              <option value="TENANT">Najemca</option>
            </select>
          </FormField>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="ba-btn primary sm"
              disabled={!pickId || busy}
              onClick={() => void assign(+pickId)}
            >
              {busy ? "Przypisywanie…" : "Przypisz"}
            </button>
            <button type="button" className="ba-btn sm" onClick={() => setMode("none")}>Anuluj</button>
          </div>
        </div>
      ) : (
        <form onSubmit={createAndAssign} style={{ display: "grid", gap: 8, border: "1px solid var(--border)", borderRadius: 10, padding: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <FormField label="Imię">
              <input required value={nFirst} onChange={(e) => setNFirst(e.target.value)} className="ba-input" />
            </FormField>
            <FormField label="Nazwisko">
              <input required value={nLast} onChange={(e) => setNLast(e.target.value)} className="ba-input" />
            </FormField>
            <FormField label="Email">
              <input required type="email" value={nEmail} onChange={(e) => setNEmail(e.target.value)} className="ba-input" />
            </FormField>
            <FormField label="Telefon (opcjonalnie)">
              <input value={nPhone} onChange={(e) => setNPhone(e.target.value)} className="ba-input" />
            </FormField>
            <FormField label="Rola">
              <select value={role} onChange={(e) => setRole(e.target.value as "OWNER" | "TENANT")} className="ba-input">
                <option value="OWNER">Właściciel</option>
                <option value="TENANT">Najemca</option>
              </select>
            </FormField>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" className="ba-btn primary sm" disabled={busy}>
              {busy ? "Dodawanie…" : "Dodaj i przypisz"}
            </button>
            <button type="button" className="ba-btn sm" onClick={() => setMode("none")}>Anuluj</button>
          </div>
        </form>
      )}
    </>
  );
}

// ── Sekcja: pojazdy lokalu ───────────────────────────────────────────────────
function SectionVehicles({
  buildingId, unitVehicles, unitResidents, wrap,
}: {
  buildingId: number;
  unitVehicles: VehicleRow[];
  unitResidents: ResidentLite[];
  wrap: (fn: () => Promise<unknown>, msg: string) => Promise<boolean>;
}) {
  const [adding, setAdding] = useState(false);
  const [plate, setPlate] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [color, setColor] = useState("");
  const [residentId, setResidentId] = useState("");
  const [busy, setBusy] = useState(false);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const ok = await wrap(
      () =>
        buildingAdminApi.post(`/building-admin/buildings/${buildingId}/vehicles`, {
          kind: "RESIDENT",
          residentId: +residentId,
          licensePlate: plate.trim().toUpperCase(),
          make: make || "—",
          model: model || undefined,
          color: color || "—",
        }),
      "Nie udało się dodać pojazdu",
    );
    setBusy(false);
    if (ok) {
      setAdding(false);
      setPlate(""); setMake(""); setModel(""); setColor(""); setResidentId("");
    }
  };

  const remove = async (v: VehicleRow) => {
    if (!window.confirm(`Usunąć pojazd ${v.licensePlate}? Zniknie też z białej listy wjazdu.`)) return;
    await wrap(
      () => buildingAdminApi.delete(`/building-admin/buildings/${buildingId}/vehicles/${v.id}`),
      "Nie udało się usunąć pojazdu",
    );
  };

  return (
    <>
      <div className="ba-section-label" style={{ marginTop: 20, marginBottom: 8 }}>
        <Car size={12} style={{ verticalAlign: -2, marginRight: 5 }} />
        Pojazdy ({unitVehicles.length})
      </div>

      {unitVehicles.length === 0 ? (
        <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "0 0 8px" }}>Brak pojazdów mieszkańców tego lokalu.</p>
      ) : (
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", marginBottom: 8 }}>
          {unitVehicles.map((v) => (
            <div
              key={v.id}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto auto",
                gap: 10,
                alignItems: "center",
                padding: "10px 12px",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div className="ba-mono" style={{ fontWeight: 700, fontSize: 13 }}>{v.licensePlate}</div>
                <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                  {[v.make, v.model, v.color].filter((x) => x && x !== "—").join(" · ") || "—"}
                  {v.resident ? ` · ${v.resident.firstName} ${v.resident.lastName}` : ""}
                </div>
              </div>
              <span className={`ba-pill ${v.status === "APPROVED" ? "green" : v.status === "PENDING" ? "amber" : "red"}`}>
                {VEHICLE_STATUS_PL[v.status ?? ""] ?? v.status ?? "—"}
              </span>
              <button type="button" className="ba-btn sm" title="Usuń pojazd" onClick={() => void remove(v)}>
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {!adding ? (
        <button
          type="button"
          className="ba-btn sm"
          onClick={() => setAdding(true)}
          disabled={unitResidents.length === 0}
          title={unitResidents.length === 0 ? "Najpierw przypisz mieszkańca" : undefined}
        >
          <Plus size={12} /> Dodaj pojazd
        </button>
      ) : (
        <form onSubmit={add} style={{ display: "grid", gap: 8, border: "1px solid var(--border)", borderRadius: 10, padding: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <FormField label="Tablica rejestracyjna">
              <input required value={plate} onChange={(e) => setPlate(e.target.value)} className="ba-input" placeholder="np. WD5005P" />
            </FormField>
            <FormField label="Właściciel (mieszkaniec)">
              <select required value={residentId} onChange={(e) => setResidentId(e.target.value)} className="ba-input">
                <option value="">— Wybierz —</option>
                {unitResidents.map((r) => (
                  <option key={r.id} value={r.id}>{r.firstName} {r.lastName}</option>
                ))}
              </select>
            </FormField>
            <FormField label="Marka">
              <input value={make} onChange={(e) => setMake(e.target.value)} className="ba-input" placeholder="np. Toyota" />
            </FormField>
            <FormField label="Model">
              <input value={model} onChange={(e) => setModel(e.target.value)} className="ba-input" />
            </FormField>
            <FormField label="Kolor">
              <input value={color} onChange={(e) => setColor(e.target.value)} className="ba-input" placeholder="np. czarny" />
            </FormField>
          </div>
          <p style={{ fontSize: 11.5, color: "var(--muted)", margin: 0 }}>
            Pojazd dodany przez administratora jest od razu zatwierdzony i trafia na białą listę wjazdu.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" className="ba-btn primary sm" disabled={busy}>
              {busy ? "Dodawanie…" : "Dodaj pojazd"}
            </button>
            <button type="button" className="ba-btn sm" onClick={() => setAdding(false)}>Anuluj</button>
          </div>
        </form>
      )}
    </>
  );
}

// ── Sekcja: goście lokalu ────────────────────────────────────────────────────
function SectionGuests({
  buildingId, unitGuests, unitResidents, wrap,
}: {
  buildingId: number;
  unitGuests: GuestRow[];
  unitResidents: ResidentLite[];
  wrap: (fn: () => Promise<unknown>, msg: string) => Promise<boolean>;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [residentId, setResidentId] = useState("");
  const [validTo, setValidTo] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  const activeGuests = unitGuests.filter((g) => g.status === "ACTIVE");

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const ok = await wrap(
      () =>
        buildingAdminApi.post(`/building-admin/buildings/${buildingId}/guests`, {
          residentId: +residentId,
          name,
          validTo: new Date(validTo).toISOString(),
          phone: phone || undefined,
          email: email || undefined,
        }),
      "Nie udało się dodać gościa",
    );
    setBusy(false);
    if (ok) {
      setAdding(false);
      setName(""); setResidentId(""); setValidTo(""); setPhone(""); setEmail("");
    }
  };

  const remove = async (g: GuestRow) => {
    if (!window.confirm(`Usunąć zaproszenie dla „${g.name}"? PIN przestanie działać.`)) return;
    await wrap(
      () => buildingAdminApi.delete(`/building-admin/buildings/${buildingId}/guests/${g.id}`),
      "Nie udało się usunąć gościa",
    );
  };

  return (
    <>
      <div className="ba-section-label" style={{ marginTop: 20, marginBottom: 8 }}>
        <UserPlus size={12} style={{ verticalAlign: -2, marginRight: 5 }} />
        Goście ({activeGuests.length})
      </div>

      {activeGuests.length === 0 ? (
        <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "0 0 8px" }}>Brak aktywnych zaproszeń.</p>
      ) : (
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", marginBottom: 8 }}>
          {activeGuests.map((g) => (
            <div
              key={g.id}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto auto",
                gap: 10,
                alignItems: "center",
                padding: "10px 12px",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{g.name}</div>
                <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                  {g.pin ? `PIN ${g.pin}` : ""}
                  {g.validTo ? ` · do ${new Date(g.validTo).toLocaleString("pl-PL", { timeZone: BUILDING_TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}` : ""}
                </div>
              </div>
              <span className="ba-pill green">Aktywny</span>
              <button type="button" className="ba-btn sm" title="Usuń zaproszenie" onClick={() => void remove(g)}>
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {!adding ? (
        <button
          type="button"
          className="ba-btn sm"
          onClick={() => setAdding(true)}
          disabled={unitResidents.length === 0}
          title={unitResidents.length === 0 ? "Najpierw przypisz mieszkańca" : undefined}
        >
          <Plus size={12} /> Dodaj gościa
        </button>
      ) : (
        <form onSubmit={add} style={{ display: "grid", gap: 8, border: "1px solid var(--border)", borderRadius: 10, padding: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <FormField label="Imię / opis gościa">
              <input required value={name} onChange={(e) => setName(e.target.value)} className="ba-input" placeholder="np. Pani Halinka" />
            </FormField>
            <FormField label="Gospodarz (mieszkaniec)">
              <select required value={residentId} onChange={(e) => setResidentId(e.target.value)} className="ba-input">
                <option value="">— Wybierz —</option>
                {unitResidents.map((r) => (
                  <option key={r.id} value={r.id}>{r.firstName} {r.lastName}</option>
                ))}
              </select>
            </FormField>
            <FormField label="Ważne do">
              <input required type="datetime-local" value={validTo} onChange={(e) => setValidTo(e.target.value)} className="ba-input" />
            </FormField>
            <FormField label="Telefon (opcjonalnie)">
              <input value={phone} onChange={(e) => setPhone(e.target.value)} className="ba-input" />
            </FormField>
            <FormField label="Email (wyśle zaproszenie)">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="ba-input" />
            </FormField>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" className="ba-btn primary sm" disabled={busy}>
              {busy ? "Dodawanie…" : "Dodaj gościa"}
            </button>
            <button type="button" className="ba-btn sm" onClick={() => setAdding(false)}>Anuluj</button>
          </div>
        </form>
      )}
    </>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 12, color: "var(--ink-2)", fontWeight: 600 }}>{label}</span>
      {children}
    </label>
  );
}
