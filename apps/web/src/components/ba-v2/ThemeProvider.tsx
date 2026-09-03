"use client";
/**
 * BA v2 — Theme provider (FAZA polish g).
 *
 * Trzyma `theme` ('light' | 'dark') w stanie React + persistuje do localStorage
 * pod kluczem `ba-theme`. AppShell renderuje `data-theme={theme}` na root div-ie,
 * CSS w `ba-tokens.css` ma `.ba-v2[data-theme="dark"] { … }` override paletę.
 *
 * Listener na `storage` event łapie zmianę motywu w innej karcie (np. user
 * przełączył w drugim oknie BA) i synchronizuje.
 */
import { createContext, useCallback, useContext, useEffect, useState } from "react";

export type BaTheme = "light" | "dark";

const STORAGE_KEY = "ba-theme";

interface BaThemeContextValue {
  theme: BaTheme;
  setTheme: (t: BaTheme) => void;
  toggle: () => void;
}

const BaThemeContext = createContext<BaThemeContextValue>({
  theme: "light",
  setTheme: () => {},
  toggle: () => {},
});

function readInitialTheme(): BaTheme {
  if (typeof window === "undefined") return "light";
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === "dark" || v === "light") return v;
  } catch {
    /* ignore */
  }
  return "light";
}

export function BaThemeProvider({ children }: { children: React.ReactNode }) {
  // SSR safety — initial state to 'light', a po mount-cie ładujemy z localStorage.
  // Inaczej hydration mismatch przy themach.
  const [theme, setThemeState] = useState<BaTheme>("light");

  useEffect(() => {
    setThemeState(readInitialTheme());
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && (e.newValue === "dark" || e.newValue === "light")) {
        setThemeState(e.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setTheme = useCallback((t: BaTheme) => {
    setThemeState(t);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(STORAGE_KEY, t);
      } catch {
        /* quota / private mode */
      }
    }
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  return (
    <BaThemeContext.Provider value={{ theme, setTheme, toggle }}>
      {children}
    </BaThemeContext.Provider>
  );
}

export function useBaTheme(): BaThemeContextValue {
  return useContext(BaThemeContext);
}
