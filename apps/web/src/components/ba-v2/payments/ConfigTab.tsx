"use client";
// ConfigTab — konfiguracja opłat: składowe czynszu (CRUD) + termin płatności
// (dueDay per budynek) + podgląd miesięcznej opłaty per lokal.
//
// Endpointy:
//   GET    /building-admin/buildings/:id/payments/config
//   PUT    /building-admin/buildings/:id/payments/config/settings   { dueDay }
//   POST   /building-admin/buildings/:id/payments/components        ComponentDto
//   PATCH  /building-admin/buildings/:id/payments/components/:cid
//   DELETE /building-admin/buildings/:id/payments/components/:cid
import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, Trash2, Wallet } from "lucide-react";
import { buildingAdminApi } from "@/lib/building-admin-api";

interface ComponentRow {
  id: number;
  unitId: number | null;
  unitNumber: string | null;
  unitStreet: string | null;
  name: string;
  amount: number;
  calcType: string; // FIXED | PER_SQM
  activeFrom: string;
  activeTo: string | null;
}

interface UnitPreviewRow {
  unitId: number;
  number: string;
  street: string | null;
  areaSqm: number | null;
  monthlyTotal: number;
  components: { name: string; amount: number; calcType: string }[];
}

interface ConfigResponse {
  settings: { dueDay: number };
  components: ComponentRow[];
  unitPreview: UnitPreviewRow[];
}

interface ComponentForm {
  id: number | null;
  name: string;
  amount: string;
  calcType: "FIXED" | "PER_SQM";
  unitId: string; // "" = budynek
  activeFrom: string;
  activeTo: string;
}

const emptyForm: ComponentForm = {
  id: null,
  name: "",
  amount: "",
  calcType: "FIXED",
  unitId: "",
  activeFrom: "",
  activeTo: "",
};

const fmtPln = (n: number) => `${n.toFixed(2)} PLN`;
const unitLabel = (number: string, street: string | null) => (street ? `${street} ${number}` : number);

export function ConfigTab({ buildingId }: { buildingId: number }) {
  const [data, setData] = useState<ConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [dueDay, setDueDay] = useState("10");
  const [savingDueDay, setSavingDueDay] = useState(false);
  const [form, setForm] = useState<ComponentForm | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [expandedUnit, setExpandedUnit] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await buildingAdminApi.get<ConfigResponse>(
        `/building-admin/buildings/${buildingId}/payments/config`,
      );
      setData(res.data);
      setDueDay(String(res.data.settings.dueDay));
    } finally {
      setLoading(false);
    }
  }, [buildingId]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveDueDay = async () => {
    setSavingDueDay(true);
    try {
      await buildingAdminApi.put(
        `/building-admin/buildings/${buildingId}/payments/config/settings`,
        { dueDay: Number(dueDay) },
      );
      await load();
    } finally {
      setSavingDueDay(false);
    }
  };

  const openCreate = () => {
    setFormError(null);
    setForm({ ...emptyForm });
  };
  const openEdit = (c: ComponentRow) => {
    setFormError(null);
    setForm({
      id: c.id,
      name: c.name,
      amount: String(c.amount),
      calcType: c.calcType === "PER_SQM" ? "PER_SQM" : "FIXED",
      unitId: c.unitId ? String(c.unitId) : "",
      activeFrom: c.activeFrom ? c.activeFrom.slice(0, 10) : "",
      activeTo: c.activeTo ? c.activeTo.slice(0, 10) : "",
    });
  };

  const submitForm = async () => {
    if (!form) return;
    setFormError(null);
    const amount = Number(form.amount.replace(",", "."));
    if (!form.name.trim()) {
      setFormError("Podaj nazwę składowej");
      return;
    }
    if (!Number.isFinite(amount) || amount < 0) {
      setFormError("Podaj prawidłową kwotę");
      return;
    }
    const body = {
      name: form.name.trim(),
      amount,
      calcType: form.calcType,
      unitId: form.unitId ? Number(form.unitId) : null,
      activeFrom: form.activeFrom || null,
      activeTo: form.activeTo || null,
    };
    setSaving(true);
    try {
      if (form.id) {
        await buildingAdminApi.patch(
          `/building-admin/buildings/${buildingId}/payments/components/${form.id}`,
          body,
        );
      } else {
        await buildingAdminApi.post(
          `/building-admin/buildings/${buildingId}/payments/components`,
          body,
        );
      }
      setForm(null);
      await load();
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      setFormError(e2.response?.data?.message ?? "Błąd zapisu składowej");
    } finally {
      setSaving(false);
    }
  };

  const deleteComponent = async (c: ComponentRow) => {
    if (!window.confirm(`Usunąć składową „${c.name}"?`)) return;
    await buildingAdminApi.delete(
      `/building-admin/buildings/${buildingId}/payments/components/${c.id}`,
    );
    await load();
  };

  if (loading && !data) return <div className="ba-empty">Ładowanie…</div>;

  return (
    <>
      {/* Termin płatności */}
      <div className="ba-panel" style={{ marginBottom: 16 }}>
        <div className="ba-panel-head">
          <div className="ba-panel-title">Termin płatności</div>
        </div>
        <div style={{ padding: 14, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: "var(--muted)" }}>Opłata wymagalna do</span>
          <input
            className="ba-input"
            type="number"
            min={1}
            max={28}
            value={dueDay}
            onChange={(e) => setDueDay(e.target.value)}
            style={{ width: 72 }}
          />
          <span style={{ fontSize: 13, color: "var(--muted)" }}>dnia każdego miesiąca</span>
          <button type="button" className="ba-btn primary sm" onClick={saveDueDay} disabled={savingDueDay}>
            {savingDueDay ? "Zapisywanie…" : "Zapisz"}
          </button>
        </div>
      </div>

      {/* Składowe */}
      <div className="ba-panel" style={{ marginBottom: 16 }}>
        <div className="ba-panel-head">
          <div className="ba-panel-title">
            <Wallet size={16} />
            Składowe opłaty miesięcznej
            <span className="pill">{data?.components.length ?? 0}</span>
          </div>
          <div className="ba-panel-tools">
            <button type="button" className="ba-btn primary sm" onClick={openCreate}>
              <Plus size={13} /> Dodaj składową
            </button>
          </div>
        </div>

        {(data?.components.length ?? 0) === 0 ? (
          <div className="ba-empty">
            <h4>Brak składowych</h4>
            <p>
              Dodaj składowe (np. „Czynsz podstawowy", „Fundusz remontowy", „Woda"), z których
              system wygeneruje miesięczne naliczenia dla lokali.
            </p>
          </div>
        ) : (
          <div>
            <div
              className="ba-row"
              style={{
                gridTemplateColumns: "1.6fr 1fr 1fr 1fr 1fr auto",
                background: "var(--surface-2)",
                fontSize: 11,
                color: "var(--muted)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                fontWeight: 600,
              }}
            >
              <div>Nazwa</div>
              <div>Zakres</div>
              <div>Kwota</div>
              <div>Naliczanie</div>
              <div>Obowiązuje</div>
              <div />
            </div>
            {data?.components.map((c) => (
              <div
                key={c.id}
                className="ba-row"
                style={{
                  gridTemplateColumns: "1.6fr 1fr 1fr 1fr 1fr auto",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{c.name}</div>
                <div>
                  {c.unitId ? (
                    <span className="ba-pill blue">Lokal {unitLabel(c.unitNumber ?? "?", c.unitStreet)}</span>
                  ) : (
                    <span className="ba-pill green">Cały budynek</span>
                  )}
                </div>
                <div className="ba-mono" style={{ fontSize: 13 }}>
                  {fmtPln(c.amount)}
                  {c.calcType === "PER_SQM" ? <span style={{ color: "var(--muted)" }}> /m²</span> : null}
                </div>
                <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
                  {c.calcType === "PER_SQM" ? "Za m²" : "Stała"}
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>
                  {c.activeFrom.slice(0, 10)} → {c.activeTo ? c.activeTo.slice(0, 10) : "∞"}
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button type="button" className="ba-btn sm" onClick={() => openEdit(c)}>
                    <Pencil size={12} />
                  </button>
                  <button type="button" className="ba-btn sm danger" onClick={() => deleteComponent(c)}>
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Podgląd per lokal */}
      <div className="ba-panel">
        <div className="ba-panel-head">
          <div className="ba-panel-title">
            Miesięczna opłata lokalu (podgląd)
            <span className="pill">{data?.unitPreview.length ?? 0}</span>
          </div>
        </div>
        <div>
          {data?.unitPreview.map((u) => (
            <div key={u.unitId} style={{ borderBottom: "1px solid var(--border)" }}>
              <button
                type="button"
                onClick={() => setExpandedUnit(expandedUnit === u.unitId ? null : u.unitId)}
                className="ba-row"
                style={{
                  width: "100%",
                  textAlign: "left",
                  background: "transparent",
                  border: 0,
                  gridTemplateColumns: "1fr 1fr 1fr",
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{unitLabel(u.number, u.street)}</div>
                <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
                  {u.areaSqm ? `${u.areaSqm} m²` : "—"}
                </div>
                <div className="ba-mono" style={{ fontWeight: 700, fontSize: 13.5 }}>
                  {u.monthlyTotal > 0 ? fmtPln(u.monthlyTotal) : <span style={{ color: "var(--amber)" }}>Brak składowych</span>}
                </div>
              </button>
              {expandedUnit === u.unitId && u.components.length > 0 ? (
                <div style={{ padding: "4px 16px 12px" }}>
                  {u.components.map((c, i) => (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: 12.5,
                        color: "var(--ink-2)",
                        padding: "3px 0",
                      }}
                    >
                      <span>{c.name}{c.calcType === "PER_SQM" ? " (za m²)" : ""}</span>
                      <span className="ba-mono">{fmtPln(c.amount)}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      {/* Modal add/edit */}
      {form ? (
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
          onClick={() => setForm(null)}
        >
          <div
            className="ba-panel"
            style={{ width: 440, maxWidth: "100%", padding: 18 }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: "0 0 14px", fontSize: 16 }}>
              {form.id ? "Edytuj składową" : "Nowa składowa opłaty"}
            </h3>
            <div style={{ display: "grid", gap: 10 }}>
              <label style={{ display: "grid", gap: 4, fontSize: 12.5, color: "var(--muted)" }}>
                Nazwa
                <input
                  className="ba-input"
                  value={form.name}
                  placeholder="np. Fundusz remontowy"
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <label style={{ display: "grid", gap: 4, fontSize: 12.5, color: "var(--muted)" }}>
                  Kwota (PLN)
                  <input
                    className="ba-input"
                    inputMode="decimal"
                    value={form.amount}
                    placeholder="0.00"
                    onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  />
                </label>
                <label style={{ display: "grid", gap: 4, fontSize: 12.5, color: "var(--muted)" }}>
                  Naliczanie
                  <select
                    className="ba-input"
                    value={form.calcType}
                    onChange={(e) => setForm({ ...form, calcType: e.target.value as "FIXED" | "PER_SQM" })}
                  >
                    <option value="FIXED">Kwota stała</option>
                    <option value="PER_SQM">Za m² (wymaga metrażu)</option>
                  </select>
                </label>
              </div>
              <label style={{ display: "grid", gap: 4, fontSize: 12.5, color: "var(--muted)" }}>
                Zakres
                <select
                  className="ba-input"
                  value={form.unitId}
                  onChange={(e) => setForm({ ...form, unitId: e.target.value })}
                >
                  <option value="">Cały budynek (wszystkie lokale)</option>
                  {data?.unitPreview.map((u) => (
                    <option key={u.unitId} value={u.unitId}>
                      Lokal {unitLabel(u.number, u.street)}
                    </option>
                  ))}
                </select>
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <label style={{ display: "grid", gap: 4, fontSize: 12.5, color: "var(--muted)" }}>
                  Aktywna od
                  <input
                    className="ba-input"
                    type="date"
                    value={form.activeFrom}
                    onChange={(e) => setForm({ ...form, activeFrom: e.target.value })}
                  />
                </label>
                <label style={{ display: "grid", gap: 4, fontSize: 12.5, color: "var(--muted)" }}>
                  Aktywna do (puste = bezterminowo)
                  <input
                    className="ba-input"
                    type="date"
                    value={form.activeTo}
                    onChange={(e) => setForm({ ...form, activeTo: e.target.value })}
                  />
                </label>
              </div>
              {formError ? (
                <div className="ba-pill red" style={{ padding: "6px 10px" }}>
                  {formError}
                </div>
              ) : null}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
                <button type="button" className="ba-btn" onClick={() => setForm(null)}>
                  Anuluj
                </button>
                <button type="button" className="ba-btn primary" onClick={submitForm} disabled={saving}>
                  {saving ? "Zapisywanie…" : form.id ? "Zapisz zmiany" : "Dodaj składową"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
