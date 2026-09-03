"use client";
// Mini-i18n context dla BA v2.
// Po MVP można zastąpić next-intl, ale tu wystarczy useState w shellu — nie
// chcemy instalować next-intl (zakazane przez task brief).
import { createContext, useContext, useMemo, useState } from "react";
import { STRINGS, type BaStrings, type Lang } from "./strings";

interface Ctx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: BaStrings;
}

const LangCtx = createContext<Ctx | null>(null);

export function LangProvider({ children, initial = "pl" }: { children: React.ReactNode; initial?: Lang }) {
  const [lang, setLang] = useState<Lang>(initial);
  const value = useMemo<Ctx>(() => ({ lang, setLang, t: STRINGS[lang] }), [lang]);
  return <LangCtx.Provider value={value}>{children}</LangCtx.Provider>;
}

export function useBaLang(): Ctx {
  const c = useContext(LangCtx);
  if (!c) throw new Error("useBaLang outside <LangProvider>");
  return c;
}
