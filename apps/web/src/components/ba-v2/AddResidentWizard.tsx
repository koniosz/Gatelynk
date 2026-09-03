"use client";
// 3-krokowy wizard dodawania mieszkańca (BA v2).
//   Krok 1 — dane podstawowe (firstName/lastName/email/phone)
//   Krok 2 — lokal + rola (opcjonalny) + data od
//   Krok 3 — dostęp (hasło startowe ALBO „mieszkaniec ustawi sam")
//
// Submit sekwencyjny:
//   1) POST /residents → residentId
//   2) (jeśli lokal) POST /units/:unitId/residents
//   3) (jeśli hasło)  POST /residents/:rId/set-password
//
// Brak react-hook-form/zod (CLAUDE-PROMPT §G) — walidacja własna na useState.
// Renderowany w generycznym ResidentDrawer (open/close/title/footer).
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Check, KeyRound, MapPin, User } from "lucide-react";
import { buildingAdminApi } from "@/lib/building-admin-api";

interface UnitOption {
  id: number;
  number: string;
  unitType?: { name?: string | null; isCommonArea?: boolean } | null;
}

interface CreatedResident {
  id: number;
  firstName: string;
  lastName: string;
}

interface Props {
  buildingId: number;
  /** Wywoływane po pełnym sukcesie — page robi reload listy + toast + zamknięcie. */
  onDone: (created: CreatedResident) => void;
  /** Anuluj / zamknij bez zapisu. */
  onCancel: () => void;
}

type Role = "OWNER" | "TENANT";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontWeight: 700,
  color: "var(--muted)",
};

const fieldWrap: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function AddResidentWizard({ buildingId, onDone, onCancel }: Props) {
  const [step, setStep] = useState(0); // 0,1,2

  // Krok 1
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [emailErr, setEmailErr] = useState<string | null>(null);

  // Krok 2
  const [units, setUnits] = useState<UnitOption[]>([]);
  const [unitsLoading, setUnitsLoading] = useState(false);
  const [unitId, setUnitId] = useState<number | "">("");
  const [role, setRole] = useState<Role>("TENANT");
  const [sinceDate, setSinceDate] = useState<string>(todayIso());

  // Krok 3
  const [accessMode, setAccessMode] = useState<"self" | "password">("self");
  const [password, setPassword] = useState("");
  const [passwordRepeat, setPasswordRepeat] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  // Lokale dociągamy gdy wizard się montuje (krok 2 ich potrzebuje, ale
  // prefetch w tle nie szkodzi — dropdown gotowy zanim user dojdzie do kroku 2).
  useEffect(() => {
    if (!Number.isFinite(buildingId)) return;
    let cancelled = false;
    setUnitsLoading(true);
    (async () => {
      try {
        const r = await buildingAdminApi.get<UnitOption[]>(`/building-admin/buildings/${buildingId}/units`);
        if (cancelled) return;
        // Części wspólne nie mogą mieć przypisanego mieszkańca (backend rzuca 400).
        setUnits((r.data ?? []).filter((u) => !u.unitType?.isCommonArea));
      } catch {
        if (!cancelled) setUnits([]);
      } finally {
        if (!cancelled) setUnitsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [buildingId]);

  const step1Valid =
    firstName.trim().length > 0 &&
    lastName.trim().length > 0 &&
    EMAIL_RE.test(email.trim());

  const step3Valid =
    accessMode === "self" ||
    (password.length >= 6 && password === passwordRepeat);

  const goNext = useCallback(() => {
    setSubmitErr(null);
    if (step === 0) {
      setEmailErr(null);
      if (!step1Valid) {
        if (!EMAIL_RE.test(email.trim())) setEmailErr("Podaj poprawny adres e-mail");
        return;
      }
    }
    setStep((s) => Math.min(2, s + 1));
  }, [step, step1Valid, email]);

  const goBack = useCallback(() => {
    setSubmitErr(null);
    setStep((s) => Math.max(0, s - 1));
  }, []);

  const submit = useCallback(async () => {
    if (submitting) return;
    setSubmitErr(null);
    setEmailErr(null);
    setSubmitting(true);
    try {
      // 1) Utwórz mieszkańca.
      let created: CreatedResident;
      try {
        const res = await buildingAdminApi.post<CreatedResident>(
          `/building-admin/buildings/${buildingId}/residents`,
          {
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            email: email.trim(),
            phone: phone.trim() || undefined,
          },
        );
        created = res.data;
      } catch (err: unknown) {
        const e = err as { response?: { status?: number; data?: { message?: string } } };
        if (e.response?.status === 409) {
          // Email zajęty — wróć na krok 1 i pokaż inline error, nie przechodź dalej.
          setEmailErr(e.response?.data?.message ?? "Mieszkaniec z tym adresem e-mail już istnieje");
          setStep(0);
          setSubmitting(false);
          return;
        }
        throw err;
      }

      // 2) Przypisz do lokalu (opcjonalnie).
      if (unitId !== "") {
        await buildingAdminApi.post(`/building-admin/buildings/${buildingId}/units/${unitId}/residents`, {
          residentId: created.id,
          role,
          sinceDate: new Date(sinceDate).toISOString(),
        });
      }

      // 3) Ustaw hasło startowe (opcjonalnie).
      if (accessMode === "password") {
        await buildingAdminApi.post(`/building-admin/buildings/${buildingId}/residents/${created.id}/set-password`, {
          password,
        });
      }

      onDone(created);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } }; message?: string };
      setSubmitErr(e.response?.data?.message ?? e.message ?? "Nie udało się dodać mieszkańca");
    } finally {
      setSubmitting(false);
    }
  }, [submitting, buildingId, firstName, lastName, email, phone, unitId, role, sinceDate, accessMode, password, onDone]);

  const steps = [
    { label: "Dane", icon: User },
    { label: "Lokal", icon: MapPin },
    { label: "Dostęp", icon: KeyRound },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Progress bar — 3 segmenty. */}
      <div style={{ display: "flex", gap: 8 }}>
        {steps.map((s, i) => {
          const active = i === step;
          const done = i < step;
          const Icon = s.icon;
          return (
            <div key={s.label} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
              <div
                style={{
                  height: 4,
                  borderRadius: 999,
                  background: done || active ? "var(--blue)" : "var(--border-strong)",
                  transition: "background 0.18s",
                }}
              />
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: active ? "var(--blue-600)" : done ? "var(--ink-2)" : "var(--muted-2)",
                }}
              >
                {done ? <Check size={13} /> : <Icon size={13} />}
                {s.label}
              </div>
            </div>
          );
        })}
      </div>

      {submitErr ? (
        <div className="ba-pill red" style={{ display: "block", padding: "8px 12px" }}>
          {submitErr}
        </div>
      ) : null}

      {/* ── Krok 1: dane podstawowe ── */}
      {step === 0 ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label style={fieldWrap}>
            <span style={labelStyle}>Imię</span>
            <input
              className="ba-input"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              autoFocus
            />
          </label>
          <label style={fieldWrap}>
            <span style={labelStyle}>Nazwisko</span>
            <input className="ba-input" value={lastName} onChange={(e) => setLastName(e.target.value)} />
          </label>
          <label style={{ ...fieldWrap, gridColumn: "span 2" }}>
            <span style={labelStyle}>E-mail</span>
            <input
              className="ba-input"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (emailErr) setEmailErr(null);
              }}
              style={emailErr ? { borderColor: "var(--red)" } : undefined}
            />
            {emailErr ? <span style={{ fontSize: 11.5, color: "var(--red)" }}>{emailErr}</span> : null}
          </label>
          <label style={{ ...fieldWrap, gridColumn: "span 2" }}>
            <span style={labelStyle}>
              Telefon <span style={{ color: "var(--muted-2)", textTransform: "none", letterSpacing: 0 }}>(opcjonalnie)</span>
            </span>
            <input className="ba-input" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>
        </div>
      ) : null}

      {/* ── Krok 2: lokal + rola ── */}
      {step === 1 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <label style={fieldWrap}>
            <span style={labelStyle}>
              Lokal <span style={{ color: "var(--muted-2)", textTransform: "none", letterSpacing: 0 }}>(opcjonalnie)</span>
            </span>
            <select
              className="ba-input"
              value={unitId}
              onChange={(e) => setUnitId(e.target.value === "" ? "" : Number(e.target.value))}
              disabled={unitsLoading}
            >
              <option value="">{unitsLoading ? "Ładowanie lokali…" : "— Nie przypisuj teraz —"}</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.number}
                  {u.unitType?.name ? ` · ${u.unitType.name}` : ""}
                </option>
              ))}
            </select>
            <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
              Lokal można przypisać później z poziomu szczegółów mieszkańca.
            </span>
          </label>

          {unitId !== "" ? (
            <>
              <div style={fieldWrap}>
                <span style={labelStyle}>Rola w lokalu</span>
                <div className="ba-lang-toggle" role="group" aria-label="Rola" style={{ width: "fit-content" }}>
                  <button type="button" className={role === "OWNER" ? "on" : ""} onClick={() => setRole("OWNER")}>
                    Właściciel
                  </button>
                  <button type="button" className={role === "TENANT" ? "on" : ""} onClick={() => setRole("TENANT")}>
                    Najemca
                  </button>
                </div>
              </div>
              <label style={fieldWrap}>
                <span style={labelStyle}>Od kiedy</span>
                <input
                  className="ba-input"
                  type="date"
                  value={sinceDate}
                  onChange={(e) => setSinceDate(e.target.value)}
                  style={{ width: 200 }}
                />
              </label>
            </>
          ) : null}
        </div>
      ) : null}

      {/* ── Krok 3: dostęp ── */}
      {step === 2 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <span style={labelStyle}>Dostęp do aplikacji</span>

          <button
            type="button"
            onClick={() => setAccessMode("self")}
            style={{
              textAlign: "left",
              border: `1px solid ${accessMode === "self" ? "var(--blue)" : "var(--border)"}`,
              background: accessMode === "self" ? "var(--blue-50)" : "var(--surface)",
              borderRadius: "var(--r-2)",
              padding: "12px 14px",
              cursor: "pointer",
              display: "flex",
              gap: 12,
              alignItems: "flex-start",
            }}
          >
            <span
              style={{
                width: 18,
                height: 18,
                borderRadius: 999,
                border: `2px solid ${accessMode === "self" ? "var(--blue)" : "var(--border-strong)"}`,
                marginTop: 2,
                flexShrink: 0,
                display: "grid",
                placeItems: "center",
              }}
            >
              {accessMode === "self" ? (
                <span style={{ width: 8, height: 8, borderRadius: 999, background: "var(--blue)" }} />
              ) : null}
            </span>
            <span>
              <span style={{ fontWeight: 600, fontSize: 13.5 }}>Mieszkaniec ustawi hasło sam</span>
              <span style={{ display: "block", fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                Przy pierwszym logowaniu utworzy własne hasło.
              </span>
            </span>
          </button>

          <button
            type="button"
            onClick={() => setAccessMode("password")}
            style={{
              textAlign: "left",
              border: `1px solid ${accessMode === "password" ? "var(--blue)" : "var(--border)"}`,
              background: accessMode === "password" ? "var(--blue-50)" : "var(--surface)",
              borderRadius: "var(--r-2)",
              padding: "12px 14px",
              cursor: "pointer",
              display: "flex",
              gap: 12,
              alignItems: "flex-start",
            }}
          >
            <span
              style={{
                width: 18,
                height: 18,
                borderRadius: 999,
                border: `2px solid ${accessMode === "password" ? "var(--blue)" : "var(--border-strong)"}`,
                marginTop: 2,
                flexShrink: 0,
                display: "grid",
                placeItems: "center",
              }}
            >
              {accessMode === "password" ? (
                <span style={{ width: 8, height: 8, borderRadius: 999, background: "var(--blue)" }} />
              ) : null}
            </span>
            <span>
              <span style={{ fontWeight: 600, fontSize: 13.5 }}>Ustaw hasło startowe</span>
              <span style={{ display: "block", fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                Przekaż je mieszkańcowi bezpiecznym kanałem.
              </span>
            </span>
          </button>

          {accessMode === "password" ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 4 }}>
              <label style={fieldWrap}>
                <span style={labelStyle}>Hasło</span>
                <input
                  className="ba-input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
              <label style={fieldWrap}>
                <span style={labelStyle}>Powtórz hasło</span>
                <input
                  className="ba-input"
                  type="password"
                  value={passwordRepeat}
                  onChange={(e) => setPasswordRepeat(e.target.value)}
                  autoComplete="new-password"
                  style={
                    passwordRepeat.length > 0 && password !== passwordRepeat
                      ? { borderColor: "var(--red)" }
                      : undefined
                  }
                />
              </label>
              <span style={{ gridColumn: "span 2", fontSize: 11.5, color: "var(--muted)" }}>
                {password.length > 0 && password.length < 6
                  ? "Hasło musi mieć min. 6 znaków."
                  : passwordRepeat.length > 0 && password !== passwordRepeat
                    ? "Hasła nie są identyczne."
                    : "Min. 6 znaków."}
              </span>
            </div>
          ) : null}

          <p style={{ fontSize: 11.5, color: "var(--muted)", margin: "4px 0 0" }}>
            Zaproszenie e-mail z linkiem aktywacyjnym pojawi się w przyszłej wersji.
          </p>
        </div>
      ) : null}

      {/* Nawigacja */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", paddingTop: 4 }}>
        {step > 0 ? (
          <button type="button" className="ba-btn" onClick={goBack} disabled={submitting}>
            <ArrowLeft size={14} /> Wstecz
          </button>
        ) : (
          <button type="button" className="ba-btn" onClick={onCancel} disabled={submitting}>
            Anuluj
          </button>
        )}
        <div style={{ flex: 1 }} />
        {step < 2 ? (
          <button
            type="button"
            className="ba-btn primary"
            onClick={goNext}
            disabled={step === 0 && !step1Valid}
          >
            Dalej <ArrowRight size={14} />
          </button>
        ) : (
          <button type="button" className="ba-btn primary" onClick={submit} disabled={submitting || !step3Valid}>
            {submitting ? "Dodawanie…" : "Dodaj mieszkańca"}
          </button>
        )}
      </div>
    </div>
  );
}
