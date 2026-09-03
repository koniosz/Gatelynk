"use client";
// Side-sheet 480px po prawej stronie. Bez Radix-a (CLAUDE-PROMPT §G zakazuje
// instalacji) — own implementation z react-dom portal + CSS transitions
// z ba-tokens.css.
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

export function ResidentDrawer({ open, onClose, title, children, footer }: Props) {
  // Escape zamyka drawer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // SSR-safe: portal wymaga `document`. Renderujemy null po stronie serwera.
  if (typeof window === "undefined") return null;

  // Portal ląduje w document.body — POZA kontenerem .ba-v2 layoutu, więc
  // wrapper musi sam nieść klasę .ba-v2, inaczej style .ba-v2 .ba-btn /
  // .ba-kv-grid itd. nie obejmują zawartości drawera (przyciski wyglądały
  // jak zwykły tekst).
  return createPortal(
    <div className="ba-v2">
      <div className={"ba-v2-drawer-overlay" + (open ? " show" : "")} onClick={onClose} />
      <aside className={"ba-v2-drawer" + (open ? " show" : "")} aria-hidden={!open}>
        <header
          style={{
            padding: "16px 18px",
            borderBottom: "1px solid #e7e3d6",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 15, flex: 1, minWidth: 0 }}>{title}</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              border: "1px solid #e7e3d6",
              background: "#fff",
              display: "grid",
              placeItems: "center",
              cursor: "pointer",
              color: "#3a3f47",
            }}
          >
            <X size={14} />
          </button>
        </header>
        <div style={{ padding: 18, overflowY: "auto", flex: 1 }}>{children}</div>
        {footer ? (
          <footer
            style={{
              padding: "12px 18px",
              borderTop: "1px solid #e7e3d6",
              display: "flex",
              gap: 8,
            }}
          >
            {footer}
          </footer>
        ) : null}
      </aside>
    </div>,
    document.body,
  );
}
