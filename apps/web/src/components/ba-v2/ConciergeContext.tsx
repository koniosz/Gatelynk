"use client";
// Globalny kontekst sterujący panelem AI Concierge. Overview ma przycisk
// „Zapytaj…" który delegował-by do otwarcia panelu — to zostawiamy tutaj,
// żeby ten sam state był współdzielony przez FAB w shellu i textarea
// w Overview.
import { createContext, useCallback, useContext, useMemo, useState } from "react";

interface Ctx {
  open: boolean;
  setOpen: (b: boolean) => void;
  toggle: () => void;
  /** Otwiera panel i wstrzykuje pytanie do wysłania od razu (z Overview). */
  askQuestion: (q: string) => void;
  /** Pytanie czekające na pickup przez ConciergePanel. */
  pendingPrompt: string | null;
  /** Wywoływane przez panel po skonsumowaniu promptu. */
  consumePending: () => void;
}

const C = createContext<Ctx | null>(null);

export function ConciergeProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);

  const toggle = useCallback(() => setOpen((o) => !o), []);
  const askQuestion = useCallback((q: string) => {
    setPendingPrompt(q);
    setOpen(true);
  }, []);
  const consumePending = useCallback(() => setPendingPrompt(null), []);

  const value = useMemo<Ctx>(
    () => ({ open, setOpen, toggle, askQuestion, pendingPrompt, consumePending }),
    [open, pendingPrompt, toggle, askQuestion, consumePending],
  );
  return <C.Provider value={value}>{children}</C.Provider>;
}

export function useConcierge(): Ctx {
  const c = useContext(C);
  if (!c) throw new Error("useConcierge outside <ConciergeProvider>");
  return c;
}
