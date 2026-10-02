"use client";

/**
 * Przełącznik panelu administratora (role="switch"). Zmiana idzie od razu do
 * API — w trakcie zapisu kontrolka jest zablokowana. Wspólny dla przełącznika
 * automatycznego wjazdu (Pojazdy) i powiadomień automatycznych (Powiadomienia).
 */
export function BaSwitch({
  checked,
  ariaLabel,
  title,
  busy = false,
  disabled = false,
  onChange,
  children,
}: {
  checked: boolean;
  ariaLabel: string;
  title?: string;
  busy?: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
  /** Widoczny podpis obok przełącznika (opcjonalny). */
  children?: React.ReactNode;
}) {
  const off = disabled || busy;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      title={title}
      disabled={off}
      onClick={() => onChange(!checked)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        background: "transparent",
        border: 0,
        padding: 0,
        cursor: off ? "default" : "pointer",
        opacity: disabled ? 0.45 : 1,
        font: "inherit",
      }}
    >
      <span
        aria-hidden
        style={{
          position: "relative",
          width: 36,
          height: 20,
          borderRadius: 999,
          background: checked ? "var(--green, #16a34a)" : "var(--line-strong, #cbd5e1)",
          transition: "background .15s",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: checked ? 18 : 2,
            width: 16,
            height: 16,
            borderRadius: 999,
            background: "#fff",
            boxShadow: "0 1px 2px rgba(0,0,0,.25)",
            transition: "left .15s",
          }}
        />
      </span>
      {children}
    </button>
  );
}
