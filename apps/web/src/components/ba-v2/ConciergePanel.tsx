"use client";
// Floating AI Concierge panel — bottom-right FAB otwiera 420x600 panel.
// Wywołuje istniejący endpoint POST /api/building-admin/buildings/:id/assistant/ask
// (BuildingAdminAssistantController — proxy do Edge).
//
// Markdown rendering: react-markdown + remark-gfm (dodane w Setup A.3).
// Streaming: prawdziwego streamingu nie ma w API (proxy + JSON response),
// więc po stronie UI symulujemy „pisanie" — pokazujemy dots-loader podczas
// pending request, a po dotarciu odpowiedzi wstawiamy ją w bubble.
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Plus, Shield, Sparkles, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { buildingAdminApi } from "@/lib/building-admin-api";
import { useBaLang } from "./LangProvider";
import { useConcierge } from "./ConciergeContext";
import { CONCIERGE_ICONS, type ConciergeIconName } from "./icons";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

export function ConciergePanel({ buildingId, buildingName }: { buildingId: number; buildingName: string }) {
  const { t } = useBaLang();
  const { open, setOpen, toggle, pendingPrompt, consumePending } = useConcierge();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Scroll-down przy każdej nowej wiadomości / zmianie busy.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const send = useCallback(
    async (textOverride?: string) => {
      const text = (textOverride ?? input).trim();
      if (!text || busy) return;
      setError(null);
      setInput("");
      const newUser: Msg = { role: "user", content: text };
      setMessages((m) => [...m, newUser]);
      setBusy(true);
      try {
        const history = messages
          .slice(-10)
          .map((m) => ({ role: m.role, content: m.content }));
        const res = await buildingAdminApi.post<{ answer?: string }>(
          `/building-admin/buildings/${buildingId}/assistant/ask`,
          { question: text, smart: true, history },
        );
        const answer = res.data?.answer ?? "(brak odpowiedzi)";
        setMessages((m) => [...m, { role: "assistant", content: answer }]);
      } catch (err: unknown) {
        const e = err as { response?: { data?: { message?: string } }; message?: string };
        const message = e.response?.data?.message ?? e.message ?? "Nieznany błąd";
        setError(message);
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            content: `Przepraszam — nie udało się pobrać odpowiedzi. (${message})`,
          },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [buildingId, busy, input, messages],
  );

  // Pickup pendingPrompt z Overview-page (askQuestion("...")).
  useEffect(() => {
    if (pendingPrompt && open) {
      void send(pendingPrompt);
      consumePending();
    }
  }, [pendingPrompt, open, send, consumePending]);

  const reset = () => {
    setMessages([]);
    setError(null);
  };

  return (
    <>
      {/* FAB — chowamy gdy panel otwarty (klik X w panelu zamyka) */}
      {!open ? (
        <button type="button" className="ba-v2-chat-fab" onClick={toggle} aria-label="Open AI Concierge">
          <Sparkles size={18} />
          <span>{t.concierge.title}</span>
        </button>
      ) : null}

      <div className={"ba-v2-chat-overlay" + (open ? " show" : "")} onClick={() => setOpen(false)} />
      <aside className={"ba-v2-chat-panel" + (open ? " show" : "")} aria-hidden={!open}>
        <header
          style={{
            padding: "14px 16px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            borderBottom: "1px solid #e7e3d6",
          }}
        >
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: "linear-gradient(135deg,#2c6dff,#1f4fcf)",
              display: "grid",
              placeItems: "center",
              color: "#fff",
              flexShrink: 0,
            }}
          >
            <Sparkles size={14} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 13.5 }}>{t.concierge.title}</div>
            <div style={{ fontSize: 11, color: "#71798a" }}>
              {buildingName} · <span style={{ color: "#15915a" }}>● {t.concierge.online}</span>
            </div>
          </div>
          {messages.length > 0 ? (
            <button
              type="button"
              onClick={reset}
              title="Nowa rozmowa"
              style={{
                marginLeft: "auto",
                width: 28,
                height: 28,
                borderRadius: 7,
                border: "1px solid #e7e3d6",
                background: "#fff",
                color: "#3a3f47",
                display: "grid",
                placeItems: "center",
                cursor: "pointer",
              }}
            >
              <Plus size={14} />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            style={{
              marginLeft: messages.length > 0 ? 0 : "auto",
              width: 28,
              height: 28,
              borderRadius: 7,
              border: "1px solid #e7e3d6",
              background: "#fff",
              color: "#3a3f47",
              display: "grid",
              placeItems: "center",
              cursor: "pointer",
            }}
          >
            <X size={14} />
          </button>
        </header>

        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          {messages.length === 0 ? (
            <div>
              <div style={{ textAlign: "center", padding: "14px 8px 18px" }}>
                <div
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: 14,
                    margin: "0 auto 12px",
                    background:
                      "linear-gradient(135deg, color-mix(in oklab, #2563eb 14%, #fff), color-mix(in oklab, #2563eb 22%, #fff))",
                    display: "grid",
                    placeItems: "center",
                    color: "#2563eb",
                    border: "1px solid color-mix(in oklab, #2563eb 30%, transparent)",
                  }}
                >
                  <Sparkles size={20} />
                </div>
                <h3 style={{ margin: "0 0 6px", fontSize: 16, letterSpacing: "-0.01em" }}>
                  {t.concierge.hello}
                </h3>
                <p style={{ margin: 0, fontSize: 12.5, color: "#71798a", lineHeight: 1.5 }}>
                  {t.concierge.helloDesc}
                </p>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
                {t.concierge.suggestions.map((s, i) => {
                  const Icon = CONCIERGE_ICONS[s.icon as ConciergeIconName] ?? Sparkles;
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => void send(s.text)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        background: "#fbfaf6",
                        border: "1px solid #e7e3d6",
                        borderRadius: 10,
                        padding: "9px 12px",
                        fontSize: 12.5,
                        color: "#3a3f47",
                        fontWeight: 500,
                        textAlign: "left",
                        cursor: "pointer",
                      }}
                    >
                      <span
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: 6,
                          background: "#fff",
                          display: "grid",
                          placeItems: "center",
                          color: "#2563eb",
                          border: "1px solid #e7e3d6",
                          flexShrink: 0,
                        }}
                      >
                        <Icon size={13} />
                      </span>
                      <span>{s.text}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {messages.map((m, i) => (
                <Bubble key={i} role={m.role} content={m.content} />
              ))}
              {busy ? (
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <div
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 99,
                      background: "linear-gradient(135deg,#2c6dff,#1f4fcf)",
                      color: "#fff",
                      display: "grid",
                      placeItems: "center",
                      marginTop: 2,
                      flexShrink: 0,
                    }}
                  >
                    <Sparkles size={11} />
                  </div>
                  <div
                    style={{
                      background: "#fbfaf6",
                      border: "1px solid #e7e3d6",
                      borderRadius: 14,
                      padding: "9px 13px",
                      display: "inline-flex",
                      gap: 4,
                      alignItems: "center",
                    }}
                  >
                    <span className="ba-dot" />
                    <span className="ba-dot" />
                    <span className="ba-dot" />
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 12px",
            borderTop: "1px solid #e7e3d6",
            background: "#fff",
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t.concierge.placeholder}
            disabled={busy}
            style={{
              flex: 1,
              height: 38,
              padding: "0 12px",
              border: "1px solid #e7e3d6",
              borderRadius: 999,
              background: "#fbfaf6",
              fontSize: 13,
              outline: "none",
            }}
          />
          <button
            type="submit"
            disabled={!input.trim() || busy}
            aria-label="Wyślij"
            style={{
              width: 38,
              height: 38,
              borderRadius: 999,
              background: "#2563eb",
              color: "#fff",
              border: 0,
              display: "grid",
              placeItems: "center",
              opacity: !input.trim() || busy ? 0.4 : 1,
              cursor: !input.trim() || busy ? "not-allowed" : "pointer",
            }}
          >
            <ArrowUp size={14} strokeWidth={2.4} />
          </button>
        </form>
        <div
          style={{
            padding: "6px 14px 10px",
            fontSize: 10.5,
            color: "#71798a",
            display: "flex",
            alignItems: "center",
            gap: 5,
            justifyContent: "center",
          }}
        >
          <Shield size={10} />
          {error ? `Błąd: ${error}` : t.concierge.foot}
        </div>
      </aside>
    </>
  );
}

function Bubble({ role, content }: { role: "user" | "assistant"; content: string }) {
  if (role === "user") {
    return (
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <div
          style={{
            background: "#2563eb",
            border: "1px solid #1f56d6",
            color: "#fff",
            borderRadius: "14px 14px 4px 14px",
            padding: "9px 13px",
            fontSize: 13,
            lineHeight: 1.5,
            maxWidth: 320,
          }}
        >
          {content}
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      <div
        style={{
          width: 22,
          height: 22,
          borderRadius: 99,
          background: "linear-gradient(135deg,#2c6dff,#1f4fcf)",
          color: "#fff",
          display: "grid",
          placeItems: "center",
          marginTop: 2,
          flexShrink: 0,
        }}
      >
        <Sparkles size={11} />
      </div>
      <div
        className="ba-v2-md"
        style={{
          background: "#fbfaf6",
          border: "1px solid #e7e3d6",
          borderRadius: 14,
          padding: "9px 13px",
          fontSize: 13,
          lineHeight: 1.5,
          color: "#15171a",
          maxWidth: 320,
        }}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    </div>
  );
}
