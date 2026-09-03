"use client";
// Notifications tab — redesign 2026-07-23 pod starszych administratorów:
//   • gotowe SZABLONY komunikatów (przerwa w wodzie/prądzie, zebranie,
//     prace konserwacyjne…) — klik wypełnia tytuł i treść, luki ___ do
//     uzupełnienia,
//   • odbiorcy jako DUŻE przyciski (Wszyscy / Jeden mieszkaniec), nie
//     ukryty dropdown,
//   • podgląd „jak zobaczy to mieszkaniec na telefonie" (rama telefonu),
//   • wysyłka do wszystkich wymaga POTWIERDZENIA (duże Tak/Anuluj —
//     ochrona przed przypadkowym masowym komunikatem),
//   • historia z ludzkimi datami (dziś/wczoraj), dużym drukiem i chipami
//     „do: Wszyscy (N)" / „do: Jan Kowalski".
// API bez zmian: POST /notifications {title, body, residentId?},
// GET /notifications {items,total,monthCount}.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  Bell,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Megaphone,
  Search,
  Send,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { buildingAdminApi } from "@/lib/building-admin-api";
import { BUILDING_TZ, buildingDayKey } from "@/lib/building-time";

interface Resident {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
}

interface NotificationItem {
  title: string;
  body: string;
  sentAt: string;
  senderBaId: number | null;
  senderName: string | null;
  recipients: number;
  targetResidentName: string | null;
}

interface ListResponse {
  items: NotificationItem[];
  total: number;
  monthCount: number;
  limit: number;
  offset: number;
}

const PAGE_SIZE = 20;

// ── Szablony komunikatów ────────────────────────────────────────────────────
// Luki ___ celowo — admin uzupełnia datę/godzinę. Teksty grzecznościowe,
// gotowe do wysłania po drobnej edycji.
const TEMPLATES: { icon: string; label: string; title: string; body: string }[] = [
  {
    icon: "💧",
    label: "Przerwa w dostawie wody",
    title: "Przerwa w dostawie wody",
    body: "Szanowni Państwo,\ninformujemy, że w dniu ___ w godzinach ___ nastąpi przerwa w dostawie wody z powodu prac na sieci wodociągowej.\nPrzepraszamy za utrudnienia.",
  },
  {
    icon: "⚡",
    label: "Przerwa w dostawie prądu",
    title: "Przerwa w dostawie prądu",
    body: "Szanowni Państwo,\ninformujemy, że w dniu ___ w godzinach ___ planowana jest przerwa w dostawie energii elektrycznej.\nPrzepraszamy za utrudnienia.",
  },
  {
    icon: "🔧",
    label: "Prace konserwacyjne",
    title: "Prace konserwacyjne na osiedlu",
    body: "Szanowni Państwo,\nw dniu ___ na terenie osiedla prowadzone będą prace konserwacyjne (___).\nProsimy o zachowanie ostrożności w pobliżu miejsca prac.",
  },
  {
    icon: "🏢",
    label: "Zebranie wspólnoty",
    title: "Zebranie wspólnoty mieszkaniowej",
    body: "Szanowni Państwo,\nzapraszamy na zebranie wspólnoty mieszkaniowej, które odbędzie się ___ o godzinie ___ w ___.\nObecność będzie mile widziana.",
  },
  {
    icon: "🚗",
    label: "Prośba o przeparkowanie",
    title: "Prośba o przeparkowanie pojazdów",
    body: "Szanowni Państwo,\nw dniu ___ prosimy o nieparkowanie pojazdów w rejonie ___ (powód: ___).\nDziękujemy za wyrozumiałość.",
  },
  {
    icon: "📢",
    label: "Własny komunikat",
    title: "",
    body: "",
  },
];

const fmtHuman = (iso: string) => {
  const d = new Date(iso);
  // „dziś/wczoraj" po dniach kalendarzowych OSIEDLA, nie przeglądarki widza.
  const key = buildingDayKey(d.getTime());
  const diffDays = key === buildingDayKey(Date.now()) ? 0
    : key === buildingDayKey(Date.now() - 86_400_000) ? 1 : 99;
  const time = d.toLocaleTimeString("pl-PL", { timeZone: BUILDING_TZ, hour: "2-digit", minute: "2-digit" });
  if (diffDays === 0) return `dziś o ${time}`;
  if (diffDays === 1) return `wczoraj o ${time}`;
  return `${d.toLocaleDateString("pl-PL", { timeZone: BUILDING_TZ, day: "numeric", month: "long", year: "numeric" })}, ${time}`;
};

export default function NotificationsPage() {
  const params = useParams();
  const idStr = Array.isArray(params?.id) ? params.id[0] : params?.id;
  const buildingId = Number(idStr);

  const [residents, setResidents] = useState<Resident[]>([]);

  const [history, setHistory] = useState<NotificationItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [monthCount, setMonthCount] = useState(0);
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  const loadResidents = useCallback(async () => {
    if (!Number.isFinite(buildingId)) return;
    try {
      const res = await buildingAdminApi.get<Resident[]>(
        `/building-admin/buildings/${buildingId}/residents`,
      );
      setResidents(res.data);
    } catch {
      /* fallback empty */
    }
  }, [buildingId]);

  const loadHistory = useCallback(async () => {
    if (!Number.isFinite(buildingId)) return;
    setHistoryLoading(true);
    try {
      const params: Record<string, string | number> = {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      };
      if (debouncedQuery) params.q = debouncedQuery;
      const res = await buildingAdminApi.get<ListResponse>(
        `/building-admin/buildings/${buildingId}/notifications`,
        { params },
      );
      setHistory(res.data.items);
      setTotal(res.data.total);
      setMonthCount(res.data.monthCount);
    } catch (e) {
      console.error("notifications history fetch error", e);
      setHistory([]);
      setTotal(0);
    } finally {
      setHistoryLoading(false);
    }
  }, [buildingId, page, debouncedQuery]);

  useEffect(() => {
    void loadResidents();
  }, [loadResidents]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    const id = setTimeout(() => {
      setPage(0);
      setDebouncedQuery(query.trim());
    }, 300);
    return () => clearTimeout(id);
  }, [query]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 520px) 1fr",
        gap: 16,
        alignItems: "start",
      }}
    >
      <ComposerCard
        buildingId={buildingId}
        residents={residents}
        onSent={() => {
          setPage(0);
          void loadHistory();
        }}
      />

      {/* ── Historia ── */}
      <div className="ba-panel">
        <div className="ba-panel-head">
          <div className="ba-panel-title">
            <Bell size={16} />
            Wysłane komunikaty
            <span className="pill">{total}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              className="ba-pill green"
              style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
              title="Liczba komunikatów w bieżącym miesiącu"
            >
              {monthCount} w tym miesiącu
            </span>
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "4px 10px",
                minWidth: 200,
              }}
            >
              <Search size={13} color="var(--muted)" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Szukaj w treści…"
                className="ba-input"
                style={{ border: 0, background: "transparent", outline: "none", fontSize: 13, width: "100%", padding: 0 }}
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  style={{ background: "transparent", border: 0, cursor: "pointer", color: "var(--muted)", display: "grid", placeItems: "center" }}
                  aria-label="Wyczyść"
                >
                  <X size={13} />
                </button>
              ) : null}
            </label>
          </div>
        </div>

        {historyLoading ? (
          <div className="ba-empty">Ładowanie…</div>
        ) : history.length === 0 ? (
          <div className="ba-empty">
            <div className="ico">
              <Bell size={22} />
            </div>
            <h4>{debouncedQuery ? "Brak komunikatów dla tej frazy" : "Nie wysłano jeszcze żadnego komunikatu"}</h4>
            <p>
              {debouncedQuery
                ? "Spróbuj innego słowa."
                : "Napisz pierwszy komunikat po lewej stronie — możesz zacząć od gotowego szablonu."}
            </p>
          </div>
        ) : (
          <>
            <div>
              {history.map((n, i) => (
                <div
                  key={`${n.sentAt}-${i}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "40px 1fr",
                    gap: 12,
                    padding: "14px 16px",
                    borderBottom: "1px solid var(--border)",
                    alignItems: "start",
                  }}
                >
                  <div
                    className="ba-av"
                    style={{ background: "var(--blue-50, #eff6ff)", color: "var(--blue-600)", width: 40, height: 40 }}
                  >
                    <Megaphone size={17} />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 700, fontSize: 14.5 }}>{n.title}</span>
                      <span style={{ fontSize: 12.5, color: "var(--muted)", fontWeight: 600 }}>
                        {fmtHuman(n.sentAt)}
                      </span>
                    </div>
                    <div style={{ fontSize: 13.5, color: "var(--ink-2)", marginTop: 3, whiteSpace: "pre-wrap" }}>
                      {n.body}
                    </div>
                    <div style={{ display: "flex", gap: 6, marginTop: 7, flexWrap: "wrap" }}>
                      <span className="ba-pill" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        {n.targetResidentName ? <UserRound size={11} /> : <Users size={11} />}
                        {n.targetResidentName
                          ? `do: ${n.targetResidentName}`
                          : `do: wszyscy (${n.recipients} os.)`}
                      </span>
                      {n.senderName ? <span className="ba-pill">wysłał(a): {n.senderName}</span> : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {totalPages > 1 && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 12,
                  padding: "12px 16px",
                  borderTop: "1px solid var(--border)",
                }}
              >
                <button
                  type="button"
                  className="ba-btn sm"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  <ChevronLeft size={13} /> Nowsze
                </button>
                <span style={{ fontSize: 12.5, color: "var(--muted)" }}>
                  Strona {page + 1} z {totalPages}
                </span>
                <button
                  type="button"
                  className="ba-btn sm"
                  disabled={page + 1 >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Starsze <ChevronRight size={13} />
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Kompozytor: szablony → treść → odbiorcy → podgląd → potwierdzenie ───────
function ComposerCard({
  buildingId,
  residents,
  onSent,
}: {
  buildingId: number;
  residents: Resident[];
  onSent: () => void;
}) {
  const [templateIdx, setTemplateIdx] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [target, setTarget] = useState<"ALL" | "ONE">("ALL");
  const [residentId, setResidentId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  const pickTemplate = (idx: number) => {
    setTemplateIdx(idx);
    setTitle(TEMPLATES[idx].title);
    setBody(TEMPLATES[idx].body);
    setResult(null);
    setConfirming(false);
  };

  const hasGaps = title.includes("___") || body.includes("___");
  const canSend =
    title.trim().length > 0 &&
    body.trim().length > 0 &&
    (target === "ALL" || residentId !== "");

  const selectedResident = residents.find((r) => r.id === Number(residentId));

  const doSend = async () => {
    setSending(true);
    setResult(null);
    try {
      const dto: Record<string, unknown> = { title: title.trim(), body: body.trim() };
      if (target === "ONE") dto.residentId = Number(residentId);
      const res = await buildingAdminApi.post<{ sent?: number }>(
        `/building-admin/buildings/${buildingId}/notifications`,
        dto,
      );
      const sent = res.data.sent ?? 1;
      setResult({
        kind: "ok",
        msg:
          target === "ONE" && selectedResident
            ? `Komunikat wysłany do: ${selectedResident.firstName} ${selectedResident.lastName}`
            : `Komunikat wysłany do ${sent} mieszkańców`,
      });
      setTitle("");
      setBody("");
      setResidentId("");
      setTemplateIdx(null);
      setConfirming(false);
      onSent();
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      setResult({ kind: "err", msg: e2.response?.data?.message ?? "Nie udało się wysłać komunikatu" });
      setConfirming(false);
    } finally {
      setSending(false);
    }
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSend) return;
    // Wysyłka do WSZYSTKICH = nieodwracalna i masowa → wyraźne potwierdzenie.
    if (target === "ALL" && !confirming) {
      setConfirming(true);
      return;
    }
    void doSend();
  };

  return (
    <div className="ba-panel">
      <div className="ba-panel-head">
        <div className="ba-panel-title">
          <Megaphone size={16} />
          Napisz komunikat
        </div>
      </div>
      <form onSubmit={onSubmit} style={{ padding: 16, display: "grid", gap: 14 }}>
        {result ? (
          <div
            className={`ba-pill ${result.kind === "ok" ? "green" : "red"}`}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 12px", fontSize: 13.5 }}
          >
            {result.kind === "ok" ? <CheckCircle2 size={15} /> : null}
            {result.msg}
          </div>
        ) : null}

        {/* Krok 1: szablon */}
        <div>
          <StepLabel n={1} text="Zacznij od szablonu albo napisz własny" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {TEMPLATES.map((t, idx) => (
              <button
                key={t.label}
                type="button"
                onClick={() => pickTemplate(idx)}
                aria-pressed={templateIdx === idx}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: templateIdx === idx ? "2px solid var(--blue)" : "1px solid var(--border)",
                  background: templateIdx === idx ? "color-mix(in oklab, var(--blue) 8%, var(--surface))" : "var(--surface)",
                  cursor: "pointer",
                  font: "inherit",
                  fontSize: 13,
                  fontWeight: 600,
                  textAlign: "left",
                  color: "var(--ink)",
                }}
              >
                <span style={{ fontSize: 17 }}>{t.icon}</span>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Krok 2: treść */}
        <div style={{ display: "grid", gap: 10 }}>
          <StepLabel n={2} text="Uzupełnij treść" />
          <input
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="ba-input"
            placeholder="Tytuł komunikatu (np. Przerwa w dostawie wody)"
            maxLength={120}
            style={{ fontSize: 14.5, height: 42 }}
          />
          <textarea
            required
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="ba-input"
            placeholder="Treść komunikatu…"
            rows={6}
            style={{ fontSize: 14.5, lineHeight: 1.5 }}
          />
          {hasGaps ? (
            <div className="ba-pill amber" style={{ display: "block", padding: "8px 12px", fontSize: 12.5 }}>
              Uzupełnij miejsca oznaczone „___" (data, godzina itp.) przed wysłaniem.
            </div>
          ) : null}
        </div>

        {/* Krok 3: odbiorcy */}
        <div style={{ display: "grid", gap: 8 }}>
          <StepLabel n={3} text="Do kogo wysłać?" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <TargetButton
              active={target === "ALL"}
              icon={<Users size={16} />}
              label={`Wszyscy mieszkańcy (${residents.length})`}
              onClick={() => {
                setTarget("ALL");
                setConfirming(false);
              }}
            />
            <TargetButton
              active={target === "ONE"}
              icon={<UserRound size={16} />}
              label="Jeden mieszkaniec"
              onClick={() => {
                setTarget("ONE");
                setConfirming(false);
              }}
            />
          </div>
          {target === "ONE" ? (
            <select
              required
              value={residentId}
              onChange={(e) => setResidentId(e.target.value)}
              className="ba-input"
              style={{ fontSize: 14, height: 42 }}
            >
              <option value="">— Wybierz mieszkańca —</option>
              {residents.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.firstName} {r.lastName}
                </option>
              ))}
            </select>
          ) : null}
        </div>

        {/* Podgląd telefonu */}
        {title.trim() || body.trim() ? (
          <div>
            <div className="ba-section-label" style={{ marginBottom: 6 }}>
              Tak zobaczy to mieszkaniec na telefonie
            </div>
            <div
              style={{
                background: "linear-gradient(180deg, #0B1020 0%, #16203A 100%)",
                borderRadius: 18,
                padding: "16px 14px",
                border: "1px solid var(--border)",
              }}
            >
              <div
                style={{
                  background: "rgba(255,255,255,0.92)",
                  borderRadius: 14,
                  padding: "10px 12px",
                  display: "grid",
                  gridTemplateColumns: "30px 1fr auto",
                  gap: 9,
                  alignItems: "start",
                }}
              >
                <div
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 8,
                    background: "#3B5BFF",
                    display: "grid",
                    placeItems: "center",
                    color: "#fff",
                  }}
                >
                  <Bell size={15} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: "#15171a" }}>
                    🔔 {title.trim() || "Tytuł komunikatu"}
                  </div>
                  <div
                    style={{
                      fontSize: 12.5,
                      color: "#3a3f47",
                      marginTop: 1,
                      whiteSpace: "pre-wrap",
                      display: "-webkit-box",
                      WebkitLineClamp: 4,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {body.trim() || "Treść komunikatu…"}
                  </div>
                </div>
                <span style={{ fontSize: 10.5, color: "#71798a" }}>teraz</span>
              </div>
            </div>
          </div>
        ) : null}

        {/* Wyślij + potwierdzenie dla „wszyscy" */}
        {confirming ? (
          <div
            style={{
              border: "2px solid var(--amber)",
              background: "var(--amber-50)",
              borderRadius: 12,
              padding: 14,
              display: "grid",
              gap: 10,
            }}
          >
            <div style={{ fontSize: 14.5, fontWeight: 700 }}>
              Czy na pewno wysłać do WSZYSTKICH {residents.length} mieszkańców?
            </div>
            <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
              Każdy mieszkaniec dostanie powiadomienie na telefon. Wysłanego komunikatu nie można cofnąć.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="submit" className="ba-btn primary" disabled={sending} style={{ flex: 1 }}>
                <Send size={14} /> {sending ? "Wysyłanie…" : "Tak, wyślij do wszystkich"}
              </button>
              <button type="button" className="ba-btn" disabled={sending} onClick={() => setConfirming(false)}>
                Anuluj
              </button>
            </div>
          </div>
        ) : (
          <button
            type="submit"
            className="ba-btn primary"
            disabled={sending || !canSend}
            style={{ height: 46, fontSize: 15 }}
          >
            <Send size={15} />
            {sending
              ? "Wysyłanie…"
              : target === "ONE"
                ? selectedResident
                  ? `Wyślij do: ${selectedResident.firstName} ${selectedResident.lastName}`
                  : "Wyślij"
                : "Wyślij do wszystkich mieszkańców"}
          </button>
        )}
      </form>
    </div>
  );
}

function StepLabel({ n, text }: { n: number; text: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: 999,
          background: "var(--blue)",
          color: "#fff",
          display: "grid",
          placeItems: "center",
          fontSize: 12,
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        {n}
      </span>
      <span style={{ fontSize: 13.5, fontWeight: 700 }}>{text}</span>
    </div>
  );
}

function TargetButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: "12px 10px",
        borderRadius: 10,
        border: active ? "2px solid var(--blue)" : "1px solid var(--border)",
        background: active ? "color-mix(in oklab, var(--blue) 10%, var(--surface))" : "var(--surface)",
        color: active ? "var(--blue)" : "var(--ink)",
        cursor: "pointer",
        font: "inherit",
        fontSize: 13.5,
        fontWeight: 700,
      }}
    >
      {icon}
      {label}
    </button>
  );
}
