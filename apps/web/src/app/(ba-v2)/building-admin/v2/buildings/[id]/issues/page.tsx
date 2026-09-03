"use client";
// Issues (tickets) tab — redesign 2026-07-23 (czytelność + „co wymaga mojej
// reakcji" na pierwszy rzut oka):
//   • kafle: Czekają na odpowiedź / W toku / Załatwione w tym miesiącu,
//   • wiersz z czerwoną plakietką „CZEKA NA ODPOWIEDŹ" gdy ostatni głos
//     w wątku należy do mieszkańca (albo nikt jeszcze nie odpisał),
//   • sortowanie: wymagające reakcji na górze, zakończone na dole,
//   • ludzkie daty (dziś/wczoraj) + wiek otwartego zgłoszenia („otwarte od
//     X dni" — czerwone po tygodniu),
//   • drawer-rozmowa: wiadomość mieszkańca, wątek dymków, odpowiedź
//     (backend sam przestawia OPEN→W toku i wysyła push), a zmiana statusu
//     to DUŻE przyciski w stopce („Oznacz jako załatwione" itd.), nie select.
//
// Endpointy bez zmian: GET /tickets, PATCH /tickets/:id/status,
// POST /tickets/:id/replies (auto-IN_PROGRESS + push po stronie API).
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  MessageSquare,
  RotateCcw,
  Search,
  Send,
  Wrench,

  Paperclip,
  X,
} from "lucide-react";
import { buildingAdminApi } from "@/lib/building-admin-api";
import { ResidentDrawer } from "@/components/ba-v2/ResidentDrawer";
import { BUILDING_TZ, buildingDayKey } from "@/lib/building-time";

type TicketStatus = "OPEN" | "IN_PROGRESS" | "DONE";

interface TicketReply {
  id: number;
  body: string;
  authorType: "RESIDENT" | "ADMIN" | "CONCIERGE";
  authorId?: number | null;
  authorName?: string | null;
  createdAt: string;
  photo?: string | null;
}

interface Ticket {
  id: number;
  title: string;
  body: string;
  status: TicketStatus;
  category?: string | null;
  priority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT" | null;
  type?: "ADMIN" | "CONCIERGE" | null;
  photo?: string | null;
  createdAt: string;
  residentId: number;
  resident?: {
    id: number;
    firstName: string;
    lastName: string;
  } | null;
  replies?: TicketReply[];
}

type StatusFilter = "ALL" | TicketStatus;

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "ALL", label: "Wszystkie" },
  { key: "OPEN", label: "Otwarte" },
  { key: "IN_PROGRESS", label: "W toku" },
  { key: "DONE", label: "Zakończone" },
];

const STATUS_META: Record<TicketStatus, { label: string; tone: "amber" | "green" | "red" }> = {
  OPEN: { label: "Otwarte", tone: "red" },
  IN_PROGRESS: { label: "W toku", tone: "amber" },
  DONE: { label: "Zakończone", tone: "green" },
};

const CATEGORY_LABEL: Record<string, string> = {
  ISSUE: "Usterka",
  FEEDBACK: "Uwaga",
  QUESTION: "Pytanie",
  OTHER: "Inne",
};

const PRIORITY_META: Record<string, { label: string; tone: "red" | "amber" } | undefined> = {
  URGENT: { label: "PILNE", tone: "red" },
  HIGH: { label: "Ważne", tone: "amber" },
};

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString("pl-PL", { timeZone: BUILDING_TZ,
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

const fmtHuman = (iso: string) => {
  const d = new Date(iso);
  // „dziś/wczoraj" po dniach kalendarzowych OSIEDLA, nie przeglądarki widza.
  const key = buildingDayKey(d.getTime());
  const time = d.toLocaleTimeString("pl-PL", { timeZone: BUILDING_TZ, hour: "2-digit", minute: "2-digit" });
  if (key === buildingDayKey(Date.now())) return `dziś o ${time}`;
  if (key === buildingDayKey(Date.now() - 86_400_000)) return `wczoraj o ${time}`;
  return `${d.toLocaleDateString("pl-PL", { timeZone: BUILDING_TZ, day: "numeric", month: "long" })}, ${time}`;
};

const ageDays = (iso: string) =>
  Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);

/** Zgłoszenie czeka na reakcję administracji: nie jest zakończone, a ostatni
 *  wpis w wątku (albo samo zgłoszenie) pochodzi od mieszkańca. */
const needsReply = (t: Ticket): boolean => {
  if (t.status === "DONE") return false;
  const replies = t.replies ?? [];
  if (replies.length === 0) return true;
  const last = [...replies].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )[replies.length - 1];
  return last.authorType === "RESIDENT";
};

export default function IssuesPage() {
  const params = useParams();
  const idStr = Array.isArray(params?.id) ? params.id[0] : params?.id;
  const buildingId = Number(idStr);

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [query, setQuery] = useState("");

  const [sel, setSel] = useState<Ticket | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  // Zdjęcie w odpowiedzi (2026-08-13) — data-URI po pomniejszeniu w canvas
  // (max 1600 px, JPEG q0.82): pełne zdjęcia z telefonu mają 5-12 MB, a jako
  // base64 puchną o 1/3 — bez zmniejszenia łatwo przebić limit body API.
  const [replyPhoto, setReplyPhoto] = useState<string | null>(null);
  const [replySending, setReplySending] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);

  const load = useCallback(async () => {
    if (!Number.isFinite(buildingId)) return;
    try {
      const res = await buildingAdminApi.get<Ticket[]>(`/building-admin/buildings/${buildingId}/tickets`);
      const adminOnly = res.data.filter((t) => !t.type || t.type === "ADMIN");
      setTickets(adminOnly);
    } finally {
      setLoading(false);
    }
  }, [buildingId]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!sel) return;
    const fresh = tickets.find((t) => t.id === sel.id);
    if (fresh && fresh !== sel) setSel(fresh);
  }, [tickets, sel]);

  const counts = useMemo(() => {
    const c = { ALL: tickets.length, OPEN: 0, IN_PROGRESS: 0, DONE: 0 } as Record<StatusFilter, number>;
    for (const t of tickets) c[t.status] = (c[t.status] ?? 0) + 1;
    return c;
  }, [tickets]);

  const stats = useMemo(() => {
    const awaiting = tickets.filter(needsReply).length;
    const inProgress = counts.IN_PROGRESS;
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    // „Załatwione w tym miesiącu" — przybliżenie po dacie ostatniej
    // odpowiedzi/utworzenia (brak closedAt w schemie).
    const doneThisMonth = tickets.filter((t) => {
      if (t.status !== "DONE") return false;
      const lastTs = (t.replies ?? []).reduce(
        (max, r) => Math.max(max, new Date(r.createdAt).getTime()),
        new Date(t.createdAt).getTime(),
      );
      return lastTs >= monthStart.getTime();
    }).length;
    const oldestOpen = tickets
      .filter((t) => t.status !== "DONE")
      .reduce<number | null>((max, t) => {
        const d = ageDays(t.createdAt);
        return max === null || d > max ? d : max;
      }, null);
    return { awaiting, inProgress, doneThisMonth, oldestOpen };
  }, [tickets, counts.IN_PROGRESS]);

  const filtered = useMemo(() => {
    return tickets
      .filter((t) => (statusFilter === "ALL" ? true : t.status === statusFilter))
      .filter((t) => {
        if (!query.trim()) return true;
        const q = query.trim().toLowerCase();
        return (
          t.title.toLowerCase().includes(q) ||
          t.body.toLowerCase().includes(q) ||
          `${t.resident?.firstName ?? ""} ${t.resident?.lastName ?? ""}`.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        // Wymagające reakcji na górze, DONE na dole, w grupach najnowsze pierwsze.
        const ra = needsReply(a) ? 0 : a.status === "DONE" ? 2 : 1;
        const rb = needsReply(b) ? 0 : b.status === "DONE" ? 2 : 1;
        if (ra !== rb) return ra - rb;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
  }, [tickets, statusFilter, query]);

  const openDrawer = (t: Ticket) => {
    setSel(t);
    setReplyBody("");
    setDrawerOpen(true);
  };
  const closeDrawer = () => {
    setDrawerOpen(false);
    setTimeout(() => setSel(null), 320);
  };

  const onReply = async () => {
    if (!sel) return;
    const body = replyBody.trim();
    if (!body) return;
    setReplySending(true);
    try {
      await buildingAdminApi.post(`/building-admin/buildings/${buildingId}/tickets/${sel.id}/replies`, {
        body,
        ...(replyPhoto ? { photo: replyPhoto } : {}),
      });
      setReplyBody("");
      setReplyPhoto(null);
      await load();
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      alert(e2.response?.data?.message ?? "Nie udało się wysłać odpowiedzi");
    } finally {
      setReplySending(false);
    }
  };

  const onStatusChange = async (status: TicketStatus) => {
    if (!sel) return;
    setStatusSaving(true);
    try {
      await buildingAdminApi.patch(`/building-admin/buildings/${buildingId}/tickets/${sel.id}/status`, { status });
      await load();
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      alert(e2.response?.data?.message ?? "Nie udało się zmienić statusu");
    } finally {
      setStatusSaving(false);
    }
  };

  return (
    <>
      {/* ── Kafle ── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <StatCard
          icon={<MessageSquare size={16} />}
          label="Czekają na odpowiedź"
          value={String(stats.awaiting)}
          tone={stats.awaiting > 0 ? "red" : "green"}
          hint={
            stats.awaiting > 0
              ? "mieszkańcy czekają na Twoją reakcję"
              : "wszystkie zgłoszenia obsłużone — brawo!"
          }
        />
        <StatCard
          icon={<Wrench size={16} />}
          label="W toku"
          value={String(stats.inProgress)}
          tone={stats.inProgress > 0 ? "amber" : "default"}
          hint={
            stats.oldestOpen != null && stats.oldestOpen > 7
              ? `najstarsze otwarte od ${stats.oldestOpen} dni`
              : "sprawy w trakcie załatwiania"
          }
        />
        <StatCard
          icon={<CheckCircle2 size={16} />}
          label="Załatwione w tym miesiącu"
          value={String(stats.doneThisMonth)}
          tone={stats.doneThisMonth > 0 ? "green" : "default"}
          hint="zamknięte zgłoszenia"
        />
      </div>

      <div className="ba-panel">
        <div className="ba-panel-head">
          <div className="ba-panel-title">
            <AlertTriangle size={16} />
            Zgłoszenia
            <span className="pill">{tickets.length}</span>
          </div>
          <div className="ba-panel-tools">
            <div className="ba-search" style={{ width: 280 }}>
              <Search size={14} />
              <input
                placeholder="Szukaj tytułu lub mieszkańca…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>
        </div>

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
          {STATUS_FILTERS.map((f) => {
            const isActive = statusFilter === f.key;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setStatusFilter(f.key)}
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
                  {counts[f.key] ?? 0}
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
              <AlertTriangle size={22} />
            </div>
            <h4>Brak zgłoszeń</h4>
            <p>
              {tickets.length === 0
                ? "Zgłoszenia od mieszkańców pojawią się tutaj."
                : "Brak wyników dla aktualnych filtrów."}
            </p>
          </div>
        ) : (
          <div>
            {filtered.map((t) => {
              const meta = STATUS_META[t.status];
              const replyCount = t.replies?.length ?? 0;
              const awaiting = needsReply(t);
              const age = ageDays(t.createdAt);
              const prio = t.priority ? PRIORITY_META[t.priority] : undefined;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => openDrawer(t)}
                  className="ba-row"
                  style={{
                    width: "100%",
                    textAlign: "left",
                    background: awaiting ? "color-mix(in oklab, var(--red) 4%, transparent)" : "transparent",
                    border: 0,
                    borderBottom: "1px solid var(--border)",
                    gridTemplateColumns: "36px 1fr auto",
                    padding: "13px 16px",
                  }}
                >
                  <div
                    className="ba-av"
                    style={{
                      width: 34,
                      height: 34,
                      background: awaiting ? "var(--red-50)" : "var(--amber-50)",
                      color: awaiting ? "var(--red)" : "var(--amber)",
                    }}
                  >
                    <AlertTriangle size={14} />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <span>{t.title}</span>
                      {prio ? <span className={`ba-pill ${prio.tone}`}>{prio.label}</span> : null}
                      {awaiting ? (
                        <span className="ba-pill red" style={{ fontSize: 10.5 }}>
                          CZEKA NA ODPOWIEDŹ
                        </span>
                      ) : null}
                    </div>
                    <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 2 }}>
                      {t.resident?.firstName} {t.resident?.lastName}
                      {t.category ? ` · ${CATEGORY_LABEL[t.category] ?? t.category}` : ""}
                      {" · "}
                      {fmtHuman(t.createdAt)}
                      {replyCount > 0 ? (
                        <>
                          {" · "}
                          <MessageSquare size={11} style={{ display: "inline", verticalAlign: "middle" }} />{" "}
                          {replyCount} {replyCount === 1 ? "odpowiedź" : "odpowiedzi"}
                        </>
                      ) : null}
                      {t.status !== "DONE" && age > 7 ? (
                        <span style={{ color: "var(--red)", fontWeight: 700 }}>
                          {" "}
                          · otwarte od {age} dni
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <span className={`ba-pill ${meta.tone}`} style={{ alignSelf: "center" }}>
                    {meta.label}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <ResidentDrawer
        open={drawerOpen}
        onClose={closeDrawer}
        title={sel ? sel.title : "Zgłoszenie"}
        footer={
          sel ? (
            <div style={{ display: "flex", gap: 8, width: "100%" }}>
              {sel.status === "OPEN" ? (
                <>
                  <button
                    type="button"
                    className="ba-btn"
                    disabled={statusSaving}
                    onClick={() => void onStatusChange("IN_PROGRESS")}
                  >
                    <Wrench size={14} /> Rozpocznij pracę
                  </button>
                  <button
                    type="button"
                    className="ba-btn"
                    style={{ background: "var(--green-50)", color: "var(--green)", borderColor: "var(--green)" }}
                    disabled={statusSaving}
                    onClick={() => void onStatusChange("DONE")}
                  >
                    <CheckCircle2 size={14} /> Oznacz jako załatwione
                  </button>
                </>
              ) : sel.status === "IN_PROGRESS" ? (
                <button
                  type="button"
                  className="ba-btn"
                  style={{ background: "var(--green-50)", color: "var(--green)", borderColor: "var(--green)" }}
                  disabled={statusSaving}
                  onClick={() => void onStatusChange("DONE")}
                >
                  <CheckCircle2 size={14} /> Oznacz jako załatwione
                </button>
              ) : (
                <button
                  type="button"
                  className="ba-btn"
                  disabled={statusSaving}
                  onClick={() => void onStatusChange("OPEN")}
                >
                  <RotateCcw size={14} /> Otwórz ponownie
                </button>
              )}
            </div>
          ) : null
        }
      >
        {sel ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {/* Nagłówek: kto, kiedy, status */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span className={`ba-pill ${STATUS_META[sel.status].tone}`}>
                {STATUS_META[sel.status].label}
              </span>
              {needsReply(sel) ? (
                <span className="ba-pill red" style={{ fontSize: 10.5 }}>
                  CZEKA NA ODPOWIEDŹ
                </span>
              ) : null}
              <span style={{ fontSize: 12.5, color: "var(--muted)" }}>
                {sel.resident?.firstName} {sel.resident?.lastName} · {fmtHuman(sel.createdAt)}
              </span>
            </div>

            {/* Wątek jak iMessage (zgłoszenie 2026-08-13): JEDNA rozmowa —
                pierwotne zgłoszenie mieszkańca to pierwszy bąbel po lewej,
                odpowiedzi administracji/konsjerża po prawej („my" po prawej,
                jak we własnym telefonie), mieszkaniec zawsze po lewej.
                Wcześniejsze osobne sekcje + pełna szerokość + blade tła
                zlewały się w ścianę tekstu. */}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <ChatBubble
                side="left"
                tone="resident"
                author={
                  `${sel.resident?.firstName ?? ""} ${sel.resident?.lastName ?? ""}`.trim() ||
                  "Mieszkaniec"
                }
                ts={fmtHuman(sel.createdAt)}
                body={sel.body}
                photo={sel.photo}
              />
              {(sel.replies ?? []).map((r) => {
                const isAdmin = r.authorType === "ADMIN";
                const isConcierge = r.authorType === "CONCIERGE";
                return (
                  <ChatBubble
                    key={r.id}
                    side={isAdmin || isConcierge ? "right" : "left"}
                    tone={isAdmin ? "admin" : isConcierge ? "concierge" : "resident"}
                    author={
                      isAdmin
                        ? r.authorName ?? "Administrator"
                        : isConcierge
                        ? r.authorName ?? "Konsjerż"
                        : `${sel.resident?.firstName ?? ""} ${sel.resident?.lastName ?? ""}`.trim() ||
                          "Mieszkaniec"
                    }
                    ts={fmtHuman(r.createdAt)}
                    body={r.body}
                    photo={r.photo}
                  />
                );
              })}
            </div>

            {/* Odpowiedź */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="ba-section-label">Odpowiedz mieszkańcowi</div>
              <textarea
                className="ba-input"
                rows={3}
                placeholder="Napisz odpowiedź…"
                value={replyBody}
                onChange={(e) => setReplyBody(e.target.value)}
                style={{ fontSize: 14, lineHeight: 1.5 }}
              />
              {replyPhoto ? (
                <div style={{ position: "relative", alignSelf: "flex-start" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={replyPhoto}
                    alt="Załączone zdjęcie"
                    style={{ maxHeight: 120, borderRadius: 10, border: "1px solid var(--border)" }}
                  />
                  <button
                    type="button"
                    aria-label="Usuń zdjęcie"
                    onClick={() => setReplyPhoto(null)}
                    style={{
                      position: "absolute", top: -8, right: -8, width: 24, height: 24,
                      borderRadius: 999, background: "var(--ink)", color: "var(--surface)",
                      border: "2px solid var(--surface)", display: "grid", placeItems: "center",
                      cursor: "pointer",
                    }}
                  >
                    <X size={13} />
                  </button>
                </div>
              ) : null}
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <label className="ba-btn sm" style={{ cursor: "pointer", margin: 0 }}>
                  <Paperclip size={13} /> Dodaj zdjęcie
                  <input
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (!file) return;
                      try {
                        setReplyPhoto(await downscaleImage(file));
                      } catch {
                        alert("Nie udało się wczytać zdjęcia");
                      }
                    }}
                  />
                </label>
                <span style={{ fontSize: 11.5, color: "var(--muted)", flex: 1 }}>
                  Mieszkaniec dostanie powiadomienie na telefon.
                  {sel.status === "OPEN" ? " Zgłoszenie przejdzie w status „W toku”." : ""}
                </span>
                <button
                  type="button"
                  className="ba-btn primary"
                  disabled={replySending || !replyBody.trim()}
                  onClick={onReply}
                >
                  <Send size={13} /> {replySending ? "Wysyłanie…" : "Wyślij odpowiedź"}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </ResidentDrawer>
    </>
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
      <div className="ba-section-label" style={{ marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
        {icon}
        {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color, letterSpacing: "-0.01em" }}>{value}</div>
      {hint ? <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>{hint}</div> : null}
    </div>
  );
}

// ── Bąbel rozmowy (styl iMessage) ────────────────────────────────────────────
//
// Perspektywa panelu: administracja/konsjerż po prawej (pełny kolor, biały
// tekst), mieszkaniec po lewej (jasny bąbel). Podpis nadawcy + godzina małą
// czcionką NAD bąblem, po stronie bąbla. Max ~78% szerokości — dymki nie
// rozlewają się na całą szerokość (główny grzech starego widoku).
function ChatBubble({
  side,
  tone,
  author,
  ts,
  body,
  photo,
}: {
  side: "left" | "right";
  tone: "resident" | "admin" | "concierge";
  author: string;
  ts: string;
  body: string;
  photo?: string | null;
}) {
  const tones: Record<string, { bg: string; color: string; border: string }> = {
    resident: { bg: "var(--surface-2)", color: "var(--ink)", border: "1px solid var(--border)" },
    admin: { bg: "linear-gradient(135deg,#2c6dff,#1f4fcf)", color: "#fff", border: "none" },
    concierge: { bg: "linear-gradient(135deg,#0ea472,#087f57)", color: "#fff", border: "none" },
  };
  const t = tones[tone];
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: side === "right" ? "flex-end" : "flex-start",
      }}
    >
      <div style={{ fontSize: 11, color: "var(--muted)", margin: "0 6px 3px", fontWeight: 600 }}>
        {author} · {ts}
      </div>
      <div
        style={{
          maxWidth: "78%",
          background: t.bg,
          color: t.color,
          border: t.border,
          borderRadius: 18,
          borderBottomLeftRadius: side === "left" ? 6 : 18,
          borderBottomRightRadius: side === "right" ? 6 : 18,
          padding: "9px 13px",
          fontSize: 14,
          lineHeight: 1.45,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          boxShadow: "0 1px 2px rgba(0,0,0,.06)",
        }}
      >
        {body}
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photo}
            alt="Zdjęcie do zgłoszenia"
            style={{
              display: "block",
              marginTop: 8,
              maxHeight: 260,
              maxWidth: "100%",
              borderRadius: 12,
              objectFit: "contain",
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Pomniejszenie zdjęcia w przeglądarce do data-URI JPEG (max 1600 px,
 * q 0.82). Zdjęcia z telefonów mają 5-12 MB — bez tego base64 przebiłby
 * limit body API, a mieszkaniec i tak ogląda je na ekranie telefonu.
 */
function downscaleImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const MAX = 1600;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("canvas"));
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("img"));
    };
    img.src = url;
  });
}
