"use client";
// ReportTab — raport miesięczny płatności: kto zapłacił / kto nie.
//
// Endpointy:
//   GET  /building-admin/buildings/:id/payments/report?period=YYYY-MM
//   POST /building-admin/buildings/:id/payments/charges/generate  { period }
//   POST /building-admin/buildings/:id/payments/:unitId/manual    { amount, date, description, period }
//
// Eksport CSV generowany client-side (separator ';' + BOM — przyjazny Excelowi PL).
import { useCallback, useEffect, useState } from "react";
import { Download, FileText, PlusCircle, RefreshCcw } from "lucide-react";
import { buildingAdminApi } from "@/lib/building-admin-api";

type ChargeStatus = "PAID" | "PARTIAL" | "UNPAID" | "OVERDUE" | "NO_CHARGE";

interface ReportRow {
  unitId: number;
  number: string;
  street: string | null;
  residents: string[];
  chargeId: number | null;
  charged: number;
  paid: number;
  dueDate: string | null;
  components: { name: string; amount: number }[];
  status: ChargeStatus;
  daysOverdue: number;
}

interface ReportResponse {
  period: string;
  totals: {
    charged: number;
    paid: number;
    unitsTotal: number;
    unitsCharged: number;
    unitsPaid: number;
    unitsOverdue: number;
    paidPct: number;
  };
  rows: ReportRow[];
}

const STATUS_LABEL: Record<ChargeStatus, string> = {
  PAID: "Opłacone",
  PARTIAL: "Częściowo",
  UNPAID: "Do zapłaty",
  OVERDUE: "Zaległość",
  NO_CHARGE: "Brak naliczenia",
};
const STATUS_TONE: Record<ChargeStatus, string> = {
  PAID: "green",
  PARTIAL: "amber",
  UNPAID: "blue",
  OVERDUE: "red",
  NO_CHARGE: "",
};

const fmtPln = (n: number) => `${n.toFixed(2)} PLN`;
const unitLabel = (number: string, street: string | null) => (street ? `${street} ${number}` : number);

function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

interface ManualForm {
  unitId: number;
  unitNumber: string;
  amount: string;
  date: string;
  description: string;
}

export function ReportTab({ buildingId }: { buildingId: number }) {
  const [period, setPeriod] = useState(currentPeriod());
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [manual, setManual] = useState<ManualForm | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);
  const [savingManual, setSavingManual] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await buildingAdminApi.get<ReportResponse>(
        `/building-admin/buildings/${buildingId}/payments/report`,
        { params: { period } },
      );
      setReport(res.data);
    } finally {
      setLoading(false);
    }
  }, [buildingId, period]);

  useEffect(() => {
    void load();
  }, [load]);

  const generate = async () => {
    setGenerating(true);
    setMessage(null);
    try {
      const res = await buildingAdminApi.post<{
        created: number;
        skippedExisting: number;
        skippedNoConfig: number;
      }>(`/building-admin/buildings/${buildingId}/payments/charges/generate`, { period });
      const { created, skippedExisting, skippedNoConfig } = res.data;
      setMessage(
        `Wygenerowano ${created} naliczeń (pominięto: ${skippedExisting} już istniejących, ${skippedNoConfig} bez konfiguracji).`,
      );
      await load();
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      setMessage(e2.response?.data?.message ?? "Błąd generowania naliczeń");
    } finally {
      setGenerating(false);
    }
  };

  const exportCsv = () => {
    if (!report) return;
    const head = ["Lokal", "Mieszkańcy", "Naliczono (PLN)", "Wpłacono (PLN)", "Termin", "Status", "Dni po terminie"];
    const lines = report.rows.map((r) =>
      [
        unitLabel(r.number, r.street),
        r.residents.join(", "),
        r.charged.toFixed(2),
        r.paid.toFixed(2),
        r.dueDate ? r.dueDate.slice(0, 10) : "",
        STATUS_LABEL[r.status],
        r.status === "OVERDUE" ? String(r.daysOverdue) : "",
      ]
        .map((cell) => `"${cell.replace(/"/g, '""')}"`)
        .join(";"),
    );
    const csv = "\uFEFF" + [head.join(";"), ...lines].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `raport-platnosci-${report.period}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const openManual = (r: ReportRow) => {
    setManualError(null);
    setManual({
      unitId: r.unitId,
      unitNumber: unitLabel(r.number, r.street),
      amount: r.charged > r.paid ? (r.charged - r.paid).toFixed(2) : "",
      date: new Date().toISOString().slice(0, 10),
      description: "",
    });
  };

  const submitManual = async () => {
    if (!manual) return;
    const amount = Number(manual.amount.replace(",", "."));
    if (!Number.isFinite(amount) || amount <= 0) {
      setManualError("Podaj dodatnią kwotę");
      return;
    }
    setSavingManual(true);
    try {
      await buildingAdminApi.post(
        `/building-admin/buildings/${buildingId}/payments/${manual.unitId}/manual`,
        {
          amount,
          date: manual.date,
          description: manual.description || undefined,
          period,
        },
      );
      setManual(null);
      await load();
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      setManualError(e2.response?.data?.message ?? "Błąd zapisu wpłaty");
    } finally {
      setSavingManual(false);
    }
  };

  const totals = report?.totals;

  return (
    <>
      {/* Pasek narzędzi */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <input
          className="ba-input"
          type="month"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          style={{ width: 160 }}
        />
        <button type="button" className="ba-btn" onClick={() => void load()}>
          <RefreshCcw size={13} /> Odśwież
        </button>
        <button type="button" className="ba-btn primary" onClick={generate} disabled={generating}>
          <PlusCircle size={13} /> {generating ? "Generowanie…" : "Generuj naliczenia"}
        </button>
        <button type="button" className="ba-btn" onClick={exportCsv} disabled={!report?.rows.length}>
          <Download size={13} /> Eksport CSV
        </button>
      </div>

      {message ? (
        <div
          className="ba-pill blue"
          style={{ display: "block", padding: "8px 12px", marginBottom: 12 }}
        >
          {message}
        </div>
      ) : null}

      {/* Stat cards */}
      {totals ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 12,
            marginBottom: 16,
          }}
        >
          <Stat label="Suma naliczeń" value={fmtPln(totals.charged)} />
          <Stat label="Suma wpłat" value={fmtPln(totals.paid)} color="var(--green)" />
          <Stat
            label="Opłaconych lokali"
            value={`${totals.unitsPaid} / ${totals.unitsCharged} (${totals.paidPct}%)`}
          />
          <Stat
            label="Zaległych"
            value={String(totals.unitsOverdue)}
            color={totals.unitsOverdue > 0 ? "var(--red)" : undefined}
          />
        </div>
      ) : null}

      <div className="ba-panel">
        <div className="ba-panel-head">
          <div className="ba-panel-title">
            <FileText size={16} />
            Raport {period}
            <span className="pill">{report?.rows.length ?? 0}</span>
          </div>
        </div>

        {loading ? (
          <div className="ba-empty">Ładowanie…</div>
        ) : !report || report.rows.length === 0 ? (
          <div className="ba-empty">
            <h4>Brak danych</h4>
            <p>Dodaj lokale i wygeneruj naliczenia za wybrany miesiąc.</p>
          </div>
        ) : (
          <div>
            <div
              className="ba-row"
              style={{
                gridTemplateColumns: "0.9fr 1.5fr 0.9fr 0.9fr 0.9fr 1.1fr auto",
                background: "var(--surface-2)",
                fontSize: 11,
                color: "var(--muted)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                fontWeight: 600,
              }}
            >
              <div>Lokal</div>
              <div>Mieszkańcy</div>
              <div>Naliczono</div>
              <div>Wpłacono</div>
              <div>Termin</div>
              <div>Status</div>
              <div />
            </div>
            {report.rows.map((r) => (
              <div
                key={r.unitId}
                className="ba-row"
                style={{
                  gridTemplateColumns: "0.9fr 1.5fr 0.9fr 0.9fr 0.9fr 1.1fr auto",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{unitLabel(r.number, r.street)}</div>
                <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
                  {r.residents.length ? r.residents.join(", ") : "—"}
                </div>
                <div className="ba-mono" style={{ fontSize: 13 }}>
                  {r.status === "NO_CHARGE" ? "—" : fmtPln(r.charged)}
                </div>
                <div
                  className="ba-mono"
                  style={{ fontSize: 13, color: r.paid > 0 ? "var(--green)" : undefined }}
                >
                  {r.paid > 0 ? fmtPln(r.paid) : "—"}
                </div>
                <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
                  {r.dueDate ? r.dueDate.slice(0, 10) : "—"}
                </div>
                <div>
                  <span className={`ba-pill ${STATUS_TONE[r.status]}`}>
                    {STATUS_LABEL[r.status]}
                    {r.status === "OVERDUE" && r.daysOverdue > 0 ? ` (${r.daysOverdue} dni)` : ""}
                  </span>
                </div>
                <div>
                  <button type="button" className="ba-btn sm" onClick={() => openManual(r)}>
                    + Wpłata
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Modal ręcznej wpłaty */}
      {manual ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            zIndex: 60,
            display: "grid",
            placeItems: "center",
            padding: 16,
          }}
          onClick={() => setManual(null)}
        >
          <div
            className="ba-panel"
            style={{ width: 400, maxWidth: "100%", padding: 18 }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>Zarejestruj wpłatę</h3>
            <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "var(--muted)" }}>
              Lokal {manual.unitNumber} · okres {period}
            </p>
            <div style={{ display: "grid", gap: 10 }}>
              <label style={{ display: "grid", gap: 4, fontSize: 12.5, color: "var(--muted)" }}>
                Kwota (PLN)
                <input
                  className="ba-input"
                  inputMode="decimal"
                  value={manual.amount}
                  onChange={(e) => setManual({ ...manual, amount: e.target.value })}
                />
              </label>
              <label style={{ display: "grid", gap: 4, fontSize: 12.5, color: "var(--muted)" }}>
                Data wpłaty
                <input
                  className="ba-input"
                  type="date"
                  value={manual.date}
                  onChange={(e) => setManual({ ...manual, date: e.target.value })}
                />
              </label>
              <label style={{ display: "grid", gap: 4, fontSize: 12.5, color: "var(--muted)" }}>
                Opis (opcjonalny)
                <input
                  className="ba-input"
                  value={manual.description}
                  placeholder="np. wpłata gotówkowa"
                  onChange={(e) => setManual({ ...manual, description: e.target.value })}
                />
              </label>
              {manualError ? (
                <div className="ba-pill red" style={{ padding: "6px 10px" }}>
                  {manualError}
                </div>
              ) : null}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
                <button type="button" className="ba-btn" onClick={() => setManual(null)}>
                  Anuluj
                </button>
                <button type="button" className="ba-btn primary" onClick={submitManual} disabled={savingManual}>
                  {savingManual ? "Zapisywanie…" : "Zapisz wpłatę"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 14,
        padding: 14,
      }}
    >
      <div className="ba-section-label" style={{ marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color: color ?? "var(--ink)", letterSpacing: "-0.01em" }}>
        {value}
      </div>
    </div>
  );
}
