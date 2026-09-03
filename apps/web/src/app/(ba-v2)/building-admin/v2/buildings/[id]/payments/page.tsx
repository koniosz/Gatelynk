"use client";
// Payments tab — redesign 2026-07-22 (czytelność dla starszych administratorów):
//   • duże kafle statystyk (suma zaległości / lokale z zaległością / planowany
//     przychód),
//   • wykres kołowy (donut) składowych czynszu — dane z GET payments/config
//     (unitPreview[].components zsumowane po nazwie; realne miesięczne PLN),
//     paleta 6 slotów zwalidowana skryptem dataviz (CVD ΔE ≥ 8, legenda
//     z kwotami jako relief dla kontrastu),
//   • lista lokali z kolumną „Ostatnia wpłata" (backend: lastPaymentAt),
//   • drawer: saldo-hero, historia wpłat z datami, DWA kanały przypomnień —
//     aplikacja (push + panel powiadomień) i e-mail (Resend, branded HTML),
//   • akcje księgowe (wpłata/korekta/konfiguracja) bez zmian.
//
// Endpointy:
//   GET  /payments            — overview (+ lastPaymentAt, residents z email)
//   GET  /payments/config     — składowe (donut)
//   GET  /payments/:unitId    — historia
//   POST /payments/:unitId/remind {email?: bool} — przypomnienie
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { Bell, CheckCircle2, CreditCard, Mail, PieChart, Search } from "lucide-react";
import { buildingAdminApi } from "@/lib/building-admin-api";
import { ResidentDrawer } from "@/components/ba-v2/ResidentDrawer";
import { ConfigTab } from "@/components/ba-v2/payments/ConfigTab";
import { ReportTab } from "@/components/ba-v2/payments/ReportTab";
import { Mt940Tab } from "@/components/ba-v2/payments/Mt940Tab";
import { BUILDING_TZ } from "@/lib/building-time";

interface PaymentOverviewItem {
  unitId: number;
  number: string;
  balance: number;
  config?: {
    monthlyRent: number | string;
    dueDay: number;
    openingBalance?: number | string;
    openingDate?: string;
  } | null;
  residents: { id: number; firstName: string; lastName: string; email?: string | null }[];
  lastPaymentAt?: string | null;
  // Niedopłacone naliczenia z minioną wymagalnością (null = nic po terminie).
  overdue?: { amount: number; daysOverdue: number } | null;
}

interface PaymentEntry {
  id: number;
  type: "CHARGE" | "PAYMENT" | "CORRECTION";
  amount: number;
  description?: string | null;
  date: string;
  source?: string | null;
}
interface PaymentUnitDetail {
  config?: PaymentOverviewItem["config"];
  balance: number;
  entries: PaymentEntry[];
}

interface ComponentsConfig {
  settings: { dueDay: number };
  components: { id: number; name: string; amount: number }[];
  unitPreview: {
    unitId: number;
    monthlyTotal: number;
    components: { name: string; amount: number }[];
  }[];
}

const TYPE_LABEL: Record<PaymentEntry["type"], string> = {
  CHARGE: "Naliczenie",
  PAYMENT: "Wpłata",
  CORRECTION: "Korekta",
};

const plnFmt = new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" });
const fmtPln = (n: number) => plnFmt.format(n);
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("pl-PL", { timeZone: BUILDING_TZ });

type Section = "overview" | "report" | "config" | "mt940";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "overview", label: "Przegląd" },
  { id: "report", label: "Raport miesięczny" },
  { id: "config", label: "Składowe opłat" },
  { id: "mt940", label: "Import MT940" },
];

export default function PaymentsPage() {
  const params = useParams();
  const idStr = Array.isArray(params?.id) ? params.id[0] : params?.id;
  const buildingId = Number(idStr);
  const [section, setSection] = useState<Section>("overview");

  if (!Number.isFinite(buildingId)) return null;

  return (
    <>
      <div className="ba-tabs" style={{ marginBottom: 16 }}>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`ba-tab ${section === s.id ? "active" : ""}`}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>
      {section === "overview" ? <OverviewSection buildingId={buildingId} /> : null}
      {section === "report" ? <ReportTab buildingId={buildingId} /> : null}
      {section === "config" ? <ConfigTab buildingId={buildingId} /> : null}
      {section === "mt940" ? <Mt940Tab buildingId={buildingId} /> : null}
    </>
  );
}

function OverviewSection({ buildingId }: { buildingId: number }) {
  const [items, setItems] = useState<PaymentOverviewItem[]>([]);
  const [componentsCfg, setComponentsCfg] = useState<ComponentsConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  const [sel, setSel] = useState<PaymentOverviewItem | null>(null);
  const [detail, setDetail] = useState<PaymentUnitDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const load = useCallback(async () => {
    if (!Number.isFinite(buildingId)) return;
    setLoading(true);
    try {
      const [ovRes, cfgRes] = await Promise.all([
        buildingAdminApi.get<PaymentOverviewItem[]>(`/building-admin/buildings/${buildingId}/payments`),
        buildingAdminApi
          .get<ComponentsConfig>(`/building-admin/buildings/${buildingId}/payments/config`)
          .catch(() => ({ data: null as ComponentsConfig | null })),
      ]);
      setItems(ovRes.data);
      setComponentsCfg(cfgRes.data);
    } finally {
      setLoading(false);
    }
  }, [buildingId]);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => {
    let totalOverdue = 0;
    let overdueCount = 0;
    let totalPlanned = 0;
    let pastDueAmount = 0;
    let pastDueCount = 0;
    for (const u of items) {
      if (u.balance < 0) {
        totalOverdue += Math.abs(u.balance);
        overdueCount += 1;
      }
      if (u.overdue) {
        pastDueAmount += u.overdue.amount;
        pastDueCount += 1;
      }
      if (u.config) totalPlanned += Number(u.config.monthlyRent);
    }
    return { totalOverdue, overdueCount, totalPlanned, totalUnits: items.length, pastDueAmount, pastDueCount };
  }, [items]);

  // ── Składowe czynszu → dane do donuta ─────────────────────────────────────
  // Sumujemy realne miesięczne kwoty per nazwa składowej ze WSZYSTKICH lokali
  // (unitPreview uwzględnia PER_SQM × metraż). Top 5 + „Pozostałe".
  const pieData = useMemo(() => {
    if (!componentsCfg) return [];
    const byName = new Map<string, number>();
    for (const u of componentsCfg.unitPreview) {
      for (const c of u.components) {
        byName.set(c.name, (byName.get(c.name) ?? 0) + c.amount);
      }
    }
    const sorted = [...byName.entries()].sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, 5).map(([name, amount]) => ({ name, amount }));
    const restSum = sorted.slice(5).reduce((s, [, a]) => s + a, 0);
    if (restSum > 0.005) top.push({ name: "Pozostałe", amount: restSum });
    return top;
  }, [componentsCfg]);

  const filtered = useMemo(() => {
    return items
      .filter((u) => {
        if (!query.trim()) return true;
        const q = query.trim().toLowerCase();
        const txt = `${u.number} ${u.residents.map((r) => `${r.firstName} ${r.lastName}`).join(" ")}`.toLowerCase();
        return txt.includes(q);
      })
      .sort((a, b) => a.balance - b.balance);
  }, [items, query]);

  const openDrawer = async (u: PaymentOverviewItem) => {
    setSel(u);
    setDetail(null);
    setDrawerOpen(true);
    setDetailLoading(true);
    try {
      const res = await buildingAdminApi.get<PaymentUnitDetail>(
        `/building-admin/buildings/${buildingId}/payments/${u.unitId}`,
      );
      setDetail(res.data);
    } finally {
      setDetailLoading(false);
    }
  };
  const closeDrawer = () => {
    setDrawerOpen(false);
    setTimeout(() => {
      setSel(null);
      setDetail(null);
    }, 320);
  };

  return (
    <>
      {/* ── Kafle statystyk ── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <StatCard
          label="Suma zaległości"
          value={fmtPln(stats.totalOverdue)}
          tone={stats.totalOverdue > 0 ? "red" : "green"}
          hint={stats.totalOverdue > 0 ? "do odzyskania od mieszkańców" : "wszystkie lokale rozliczone"}
        />
        <StatCard
          label="Po terminie płatności"
          value={fmtPln(stats.pastDueAmount)}
          tone={stats.pastDueCount > 0 ? "red" : "green"}
          hint={
            stats.pastDueCount > 0
              ? `${stats.pastDueCount} ${stats.pastDueCount === 1 ? "lokal" : "lokale/-i"} z minioną wymagalnością`
              : "nikt nie przekroczył terminu"
          }
        />
        <StatCard
          label="Lokale z zaległością"
          value={`${stats.overdueCount} z ${stats.totalUnits}`}
          tone={stats.overdueCount > 0 ? "amber" : "green"}
          hint="kliknij lokal na liście, aby wysłać przypomnienie"
        />
        <StatCard
          label="Planowany przychód / mies."
          value={fmtPln(stats.totalPlanned)}
          tone="default"
          hint="suma czynszów wszystkich lokali"
        />
      </div>

      {/* ── Donut: z czego składa się czynsz ── */}
      {pieData.length > 0 ? (
        <div
          className="ba-panel"
          style={{ marginBottom: 16, padding: 18 }}
        >
          <div className="ba-panel-title" style={{ marginBottom: 12 }}>
            <PieChart size={16} />
            Z czego składa się czynsz (miesięcznie, całe osiedle)
          </div>
          <RentDonut data={pieData} />
        </div>
      ) : null}

      <div className="ba-panel">
        <div className="ba-panel-head">
          <div className="ba-panel-title">
            <CreditCard size={16} />
            Płatności lokali
            <span className="pill">{items.length}</span>
          </div>
          <div className="ba-panel-tools">
            <div className="ba-search" style={{ width: 280 }}>
              <Search size={14} />
              <input
                placeholder="Szukaj lokalu lub mieszkańca…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>
        </div>

        {loading ? (
          <div className="ba-empty">Ładowanie…</div>
        ) : filtered.length === 0 ? (
          <div className="ba-empty">
            <div className="ico">
              <CreditCard size={22} />
            </div>
            <h4>Brak lokali</h4>
            <p>Dodaj lokale w zakładce Lokale, aby tutaj śledzić płatności.</p>
          </div>
        ) : (
          <div>
            <div
              className="ba-row"
              style={{
                gridTemplateColumns: "0.9fr 1.5fr 1fr 1fr 1fr 0.9fr",
                background: "var(--surface-2)",
                fontSize: 11,
                color: "var(--muted)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                fontWeight: 600,
                cursor: "default",
              }}
            >
              <div>Lokal</div>
              <div>Mieszkańcy</div>
              <div>Czynsz / termin</div>
              <div>Ostatnia wpłata</div>
              <div>Saldo</div>
              <div>Status</div>
            </div>
            {filtered.map((u) => {
              const isOverdue = u.balance < 0;
              const rentLabel = u.config
                ? `${fmtPln(Number(u.config.monthlyRent))} · do ${u.config.dueDay}.`
                : "Brak konfiguracji";
              return (
                <button
                  key={u.unitId}
                  type="button"
                  onClick={() => openDrawer(u)}
                  className="ba-row"
                  style={{
                    width: "100%",
                    textAlign: "left",
                    background: "transparent",
                    border: 0,
                    borderBottom: "1px solid var(--border)",
                    gridTemplateColumns: "0.9fr 1.5fr 1fr 1fr 1fr 0.9fr",
                    padding: "13px 16px",
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{u.number}</div>
                  <div style={{ fontSize: 13, color: "var(--muted)" }}>
                    {u.residents.length > 0
                      ? u.residents.map((r) => `${r.firstName} ${r.lastName}`).join(", ")
                      : "—"}
                  </div>
                  <div style={{ fontSize: 12.5, color: u.config ? "var(--ink-2)" : "var(--amber)" }}>
                    {rentLabel}
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
                    {u.lastPaymentAt ? fmtDate(u.lastPaymentAt) : "—"}
                  </div>
                  <div
                    className="ba-mono"
                    style={{
                      fontSize: 14,
                      fontWeight: 700,
                      color: u.balance >= 0 ? "var(--green)" : "var(--red)",
                    }}
                  >
                    {fmtPln(u.balance)}
                  </div>
                  <div>
                    <span className={`ba-pill ${u.overdue || isOverdue ? "red" : "green"}`}>
                      {u.overdue
                        ? `Po terminie ${u.overdue.daysOverdue} dn.`
                        : isOverdue
                          ? "Zaległość"
                          : "Opłacone"}
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
        title={sel ? `Płatności — lokal ${sel.number}` : "Płatności"}
      >
        {sel ? (
          <div>
            {/* ── Saldo hero ── */}
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 16,
                  background: sel.balance < 0 ? "var(--red-50)" : "var(--green-50)",
                  color: sel.balance < 0 ? "var(--red)" : "var(--green)",
                  display: "grid",
                  placeItems: "center",
                  flexShrink: 0,
                }}
              >
                <CreditCard size={26} />
              </div>
              <div>
                <div
                  style={{
                    fontSize: 26,
                    fontWeight: 700,
                    letterSpacing: "-0.01em",
                    color: (detail?.balance ?? sel.balance) < 0 ? "var(--red)" : "var(--green)",
                  }}
                >
                  {fmtPln(detail?.balance ?? sel.balance)}
                </div>
                <div style={{ color: "var(--muted)", fontSize: 13 }}>
                  {(detail?.balance ?? sel.balance) < 0 ? "zaległość do zapłaty" : "saldo rozliczone"}
                  {sel.residents.length > 0
                    ? ` · ${sel.residents.map((r) => `${r.firstName} ${r.lastName}`).join(", ")}`
                    : ""}
                </div>
                {sel.overdue ? (
                  <div style={{ color: "var(--red)", fontSize: 13, fontWeight: 700, marginTop: 3 }}>
                    Po terminie od {sel.overdue.daysOverdue} dni · {fmtPln(sel.overdue.amount)} do zapłaty
                  </div>
                ) : null}
              </div>
            </div>

            <div className="ba-kv-grid" style={{ marginTop: 14 }}>
              <div className="ba-kv">
                <div className="k">Czynsz miesięczny</div>
                <div className="v">
                  {sel.config ? fmtPln(Number(sel.config.monthlyRent)) : "Brak konfiguracji"}
                </div>
              </div>
              <div className="ba-kv">
                <div className="k">Termin płatności</div>
                <div className="v">{sel.config ? `${sel.config.dueDay}. dzień miesiąca` : "—"}</div>
              </div>
            </div>

            {/* ── Przypomnienia: aplikacja + e-mail ── */}
            <ReminderSection buildingId={buildingId} unit={sel} />

            {/* ── Historia ── */}
            <div className="ba-section-label" style={{ marginTop: 18, marginBottom: 8 }}>
              Historia wpłat i naliczeń
            </div>
            {detailLoading ? (
              <p style={{ fontSize: 13, color: "var(--muted)", margin: 0 }}>Ładowanie…</p>
            ) : (detail?.entries ?? []).length === 0 ? (
              <p style={{ fontSize: 13, color: "var(--muted)", margin: 0 }}>Brak transakcji</p>
            ) : (
              <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                {(detail?.entries ?? []).map((e) => {
                  const tone = e.type === "PAYMENT" ? "green" : e.type === "CHARGE" ? "red" : "amber";
                  return (
                    <div
                      key={e.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "auto 1fr auto",
                        gap: 10,
                        alignItems: "center",
                        padding: "10px 12px",
                        borderBottom: "1px solid var(--border)",
                      }}
                    >
                      <span className={`ba-pill ${tone}`}>{TYPE_LABEL[e.type]}</span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: "var(--ink-2)" }}>
                          {e.description || "—"}
                          {e.source === "mt940" ? (
                            <span
                              style={{
                                marginLeft: 6,
                                fontSize: 10.5,
                                background: "var(--bg-2)",
                                padding: "1px 5px",
                                borderRadius: 4,
                              }}
                            >
                              przelew bankowy
                            </span>
                          ) : null}
                        </div>
                        <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>
                          {fmtDate(e.date)}
                        </div>
                      </div>
                      <div
                        className="ba-mono"
                        style={{
                          fontSize: 13.5,
                          fontWeight: 700,
                          color: e.amount >= 0 ? "var(--green)" : "var(--red)",
                        }}
                      >
                        {fmtPln(e.amount)}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <UnitPaymentActions
              buildingId={buildingId}
              unitId={sel.unitId}
              config={sel.config ?? null}
              onChanged={async () => {
                await load();
                const res = await buildingAdminApi.get<PaymentUnitDetail>(
                  `/building-admin/buildings/${buildingId}/payments/${sel.unitId}`,
                );
                setDetail(res.data);
              }}
            />
          </div>
        ) : null}
      </ResidentDrawer>
    </>
  );
}

// ── Donut składowych czynszu ────────────────────────────────────────────────
// Paleta: 6 slotów kategorycznych (walidacja dataviz: CVD ΔE 9.1, normal 19.6,
// pass na białej powierzchni). „Pozostałe" = neutralny szary z tokenów.
// Kontrast-WARN slotów 3-5 pokryty legendą z kwotami (relief rule).
const PIE_COLORS = ["#2a78d6", "#008300", "#e87ba4", "#eda100", "#1baf7a", "#eb6834"];
const PIE_OTHER = "#71798a";

function RentDonut({ data }: { data: { name: string; amount: number }[] }) {
  const [active, setActive] = useState<number | null>(null);
  const total = data.reduce((s, d) => s + d.amount, 0);
  if (total <= 0) return null;

  // Geometria: donut r=80, grubość 34, gap 2px między segmentami (stroke
  // w kolorze powierzchni — spacer rule z dataviz).
  const R = 80;
  const THICK = 34;
  const C = 100;
  let angle = -90; // start od góry

  const segs = data.map((d, i) => {
    const frac = d.amount / total;
    const sweep = frac * 360;
    const a0 = angle;
    const a1 = angle + sweep;
    angle = a1;
    const large = sweep > 180 ? 1 : 0;
    const rad = (a: number) => (a * Math.PI) / 180;
    const x0 = C + R * Math.cos(rad(a0));
    const y0 = C + R * Math.sin(rad(a0));
    const x1 = C + R * Math.cos(rad(a1));
    const y1 = C + R * Math.sin(rad(a1));
    const r2 = R - THICK;
    const x2 = C + r2 * Math.cos(rad(a1));
    const y2 = C + r2 * Math.sin(rad(a1));
    const x3 = C + r2 * Math.cos(rad(a0));
    const y3 = C + r2 * Math.sin(rad(a0));
    const path = `M ${x0} ${y0} A ${R} ${R} 0 ${large} 1 ${x1} ${y1} L ${x2} ${y2} A ${r2} ${r2} 0 ${large} 0 ${x3} ${y3} Z`;
    const color = d.name === "Pozostałe" ? PIE_OTHER : PIE_COLORS[i % PIE_COLORS.length];
    return { ...d, path, color, frac, idx: i };
  });

  return (
    <div style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap" }}>
      <svg
        viewBox="0 0 200 200"
        width={190}
        height={190}
        role="img"
        aria-label="Wykres kołowy składowych czynszu"
        style={{ flexShrink: 0 }}
      >
        {segs.map((s) => (
          <path
            key={s.name}
            d={s.path}
            fill={s.color}
            stroke="var(--surface, #fff)"
            strokeWidth={2}
            opacity={active === null || active === s.idx ? 1 : 0.35}
            onMouseEnter={() => setActive(s.idx)}
            onMouseLeave={() => setActive(null)}
            style={{ transition: "opacity 0.12s", cursor: "pointer" }}
          >
            <title>{`${s.name}: ${fmtPln(s.amount)} (${Math.round(s.frac * 100)}%)`}</title>
          </path>
        ))}
        {/* Hero number w środku — suma miesięczna */}
        <text
          x={C}
          y={C - 4}
          textAnchor="middle"
          style={{ fontSize: 17, fontWeight: 700, fill: "var(--ink, #15171a)" }}
        >
          {active !== null ? fmtPln(segs[active].amount) : fmtPln(total)}
        </text>
        <text
          x={C}
          y={C + 14}
          textAnchor="middle"
          style={{ fontSize: 10, fill: "var(--muted, #71798a)" }}
        >
          {active !== null ? segs[active].name.slice(0, 18) : "razem / mies."}
        </text>
      </svg>

      {/* Legenda — duże wiersze z kwotą i procentem (czytelność + relief) */}
      <div style={{ display: "grid", gap: 6, flex: 1, minWidth: 260 }}>
        {segs.map((s) => (
          <div
            key={s.name}
            onMouseEnter={() => setActive(s.idx)}
            onMouseLeave={() => setActive(null)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 12px",
              borderRadius: 10,
              background: active === s.idx ? "var(--bg-2)" : "transparent",
              transition: "background 0.12s",
              cursor: "default",
            }}
          >
            <span
              style={{
                width: 14,
                height: 14,
                borderRadius: 4,
                background: s.color,
                flexShrink: 0,
              }}
            />
            <span style={{ flex: 1, fontSize: 14.5, fontWeight: 600 }}>{s.name}</span>
            <span className="ba-mono" style={{ fontSize: 14, fontWeight: 700 }}>
              {fmtPln(s.amount)}
            </span>
            <span style={{ fontSize: 12.5, color: "var(--muted)", minWidth: 40, textAlign: "right" }}>
              {Math.round(s.frac * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Przypomnienia: aplikacja (push + panel) i e-mail ────────────────────────
function ReminderSection({ buildingId, unit }: { buildingId: number; unit: PaymentOverviewItem }) {
  const [busy, setBusy] = useState<"app" | "email" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const emails = unit.residents.map((r) => r.email).filter((e): e is string => !!e);

  const send = async (viaEmail: boolean) => {
    setBusy(viaEmail ? "email" : "app");
    setResult(null);
    try {
      const res = await buildingAdminApi.post<{ sent: number; emailsSent?: number }>(
        `/building-admin/buildings/${buildingId}/payments/${unit.unitId}/remind`,
        viaEmail ? { email: true } : {},
      );
      const parts = [`powiadomienie w aplikacji do ${res.data.sent} os.`];
      if (viaEmail) parts.push(`e-mail do ${res.data.emailsSent ?? 0} os.`);
      setResult({ ok: true, msg: `Wysłano: ${parts.join(" + ")}` });
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      setResult({ ok: false, msg: e2.response?.data?.message ?? "Nie udało się wysłać przypomnienia" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ marginTop: 18 }}>
      <div className="ba-section-label" style={{ marginBottom: 8 }}>
        Przypomnienie o płatności
      </div>
      {result ? (
        <div
          className={`ba-pill ${result.ok ? "green" : "red"}`}
          style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", marginBottom: 8 }}
        >
          {result.ok ? <CheckCircle2 size={14} /> : null}
          {result.msg}
        </div>
      ) : null}
      <div style={{ display: "grid", gap: 8 }}>
        <button
          type="button"
          className="ba-btn"
          disabled={busy !== null || unit.residents.length === 0}
          onClick={() => void send(false)}
        >
          <Bell size={15} />
          {busy === "app" ? "Wysyłanie…" : "Wyślij w aplikacji (push + powiadomienie)"}
        </button>
        <button
          type="button"
          className="ba-btn"
          disabled={busy !== null || emails.length === 0}
          title={emails.length === 0 ? "Żaden mieszkaniec tego lokalu nie ma adresu e-mail" : emails.join(", ")}
          onClick={() => void send(true)}
        >
          <Mail size={15} />
          {busy === "email" ? "Wysyłanie…" : "Wyślij e-mailem (+ aplikacja)"}
        </button>
      </div>
      <p style={{ fontSize: 12, color: "var(--muted)", margin: "6px 0 0" }}>
        {unit.residents.length === 0
          ? "Do tego lokalu nie jest przypisany żaden mieszkaniec."
          : emails.length > 0
            ? `E-mail trafi do: ${emails.join(", ")}`
            : "Mieszkańcy tego lokalu nie mają adresów e-mail — dostępny tylko kanał aplikacji."}
      </p>
    </div>
  );
}

// ── Akcje księgowe lokalu (drawer): wpłata / korekta / konfiguracja ─────────
function UnitPaymentActions({
  buildingId, unitId, config, onChanged,
}: {
  buildingId: number;
  unitId: number;
  config: PaymentOverviewItem["config"];
  onChanged: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"none" | "payment" | "correction" | "config">("none");
  const [amount, setAmount] = useState("");
  const [desc, setDesc] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [rent, setRent] = useState(config ? String(Number(config.monthlyRent)) : "");
  const [dueDay, setDueDay] = useState(config ? String(config.dueDay) : "10");
  const [opening, setOpening] = useState(
    config?.openingBalance != null ? String(Number(config.openingBalance)) : "0",
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>, successMsg: string) => {
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      await fn();
      await onChanged();
      setOk(successMsg);
      setMode("none");
      setAmount("");
      setDesc("");
    } catch (e: unknown) {
      const e2 = e as { response?: { data?: { message?: string } } };
      setErr(e2.response?.data?.message ?? "Operacja nie powiodła się");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 18 }}>
      <div className="ba-section-label" style={{ marginBottom: 8 }}>Akcje księgowe</div>
      {err ? (
        <div className="ba-pill red" style={{ display: "block", padding: "8px 12px", marginBottom: 8 }}>{err}</div>
      ) : null}
      {ok ? (
        <div className="ba-pill green" style={{ display: "block", padding: "8px 12px", marginBottom: 8 }}>{ok}</div>
      ) : null}

      {mode === "none" ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="ba-btn sm" onClick={() => setMode("payment")}>
            Zaksięguj wpłatę
          </button>
          <button type="button" className="ba-btn sm" onClick={() => setMode("correction")}>
            Korekta salda
          </button>
          <button type="button" className="ba-btn sm" onClick={() => setMode("config")}>
            {config ? "Zmień czynsz" : "Ustaw czynsz"}
          </button>
        </div>
      ) : mode === "config" ? (
        <div style={{ display: "grid", gap: 8, border: "1px solid var(--border)", borderRadius: 10, padding: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <label style={{ display: "grid", gap: 4, fontSize: 12, fontWeight: 600, color: "var(--ink-2)" }}>
              Czynsz miesięczny (PLN)
              <input className="ba-input" type="number" step="0.01" value={rent} onChange={(e) => setRent(e.target.value)} />
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 12, fontWeight: 600, color: "var(--ink-2)" }}>
              Termin (dzień miesiąca)
              <input className="ba-input" type="number" min={1} max={28} value={dueDay} onChange={(e) => setDueDay(e.target.value)} />
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 12, fontWeight: 600, color: "var(--ink-2)" }}>
              Bilans otwarcia (PLN)
              <input className="ba-input" type="number" step="0.01" value={opening} onChange={(e) => setOpening(e.target.value)} />
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 12, fontWeight: 600, color: "var(--ink-2)" }}>
              Data otwarcia
              <input className="ba-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="ba-btn primary sm"
              disabled={busy || !rent}
              onClick={() =>
                run(
                  () =>
                    buildingAdminApi.put(
                      `/building-admin/buildings/${buildingId}/payments/${unitId}/config`,
                      {
                        monthlyRent: +rent,
                        dueDay: +dueDay,
                        openingBalance: +opening,
                        openingDate: new Date(date).toISOString(),
                      },
                    ),
                  "Konfiguracja czynszu zapisana",
                )
              }
            >
              {busy ? "Zapisywanie…" : "Zapisz konfigurację"}
            </button>
            <button type="button" className="ba-btn sm" onClick={() => setMode("none")}>Anuluj</button>
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8, border: "1px solid var(--border)", borderRadius: 10, padding: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <label style={{ display: "grid", gap: 4, fontSize: 12, fontWeight: 600, color: "var(--ink-2)" }}>
              {mode === "payment" ? "Kwota wpłaty (PLN)" : "Kwota korekty (± PLN)"}
              <input
                className="ba-input"
                type="number"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={mode === "payment" ? "np. 850" : "np. -50 lub 120"}
              />
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 12, fontWeight: 600, color: "var(--ink-2)" }}>
              Data
              <input className="ba-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 12, fontWeight: 600, color: "var(--ink-2)", gridColumn: "span 2" }}>
              Opis
              <input
                className="ba-input"
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                placeholder={mode === "payment" ? "np. wpłata gotówką w biurze" : "np. korekta naliczenia za marzec"}
              />
            </label>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="ba-btn primary sm"
              disabled={busy || !amount || (mode === "correction" && !desc)}
              onClick={() =>
                mode === "payment"
                  ? run(
                      () =>
                        buildingAdminApi.post(
                          `/building-admin/buildings/${buildingId}/payments/${unitId}/manual`,
                          { amount: Math.abs(+amount), date: new Date(date).toISOString(), description: desc || undefined },
                        ),
                      "Wpłata zaksięgowana",
                    )
                  : run(
                      () =>
                        buildingAdminApi.post(
                          `/building-admin/buildings/${buildingId}/payments/${unitId}/correction`,
                          { amount: +amount, description: desc, date: new Date(date).toISOString() },
                        ),
                      "Korekta zaksięgowana",
                    )
              }
            >
              {busy ? "Księgowanie…" : mode === "payment" ? "Zaksięguj wpłatę" : "Zaksięguj korektę"}
            </button>
            <button type="button" className="ba-btn sm" onClick={() => setMode("none")}>Anuluj</button>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone: "red" | "amber" | "green" | "default";
  hint?: string;
}) {
  const color =
    tone === "red"
      ? "var(--red)"
      : tone === "amber"
        ? "var(--amber)"
        : tone === "green"
          ? "var(--green)"
          : "var(--ink)";
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 14,
        padding: 16,
      }}
    >
      <div className="ba-section-label" style={{ marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color, letterSpacing: "-0.01em" }}>{value}</div>
      {hint ? <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>{hint}</div> : null}
    </div>
  );
}
