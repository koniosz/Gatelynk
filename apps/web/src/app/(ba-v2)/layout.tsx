"use client";
// Root layout dla nowej rewizji panelu Building Admin. Ten plik istnieje TYLKO
// po to, żeby:
//  1. dodać Plus Jakarta Sans + IBM Plex Mono (preload, latin-ext dla PL)
//     w scope-u ba-v2 (nie wpływa na istniejący panel dashboard / login)
//  2. zapiąć ba-tokens.css (scope-owane do `.ba-v2`, więc też niegroźne)
//  3. ustawić title karty
//
// Auth check robi `[id]/layout.tsx` (potrzebuje params.id do api callów).
import { Plus_Jakarta_Sans, IBM_Plex_Mono } from "next/font/google";
import { useEffect } from "react";
import "@/styles/ba-tokens.css";

const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  weight: ["400", "500", "600", "700"],
  subsets: ["latin", "latin-ext"],
});

const plexMonoV2 = IBM_Plex_Mono({
  variable: "--font-plex-mono-v2",
  weight: ["400", "500"],
  subsets: ["latin", "latin-ext"],
});

export default function BaV2RootLayout({ children }: { children: React.ReactNode }) {
  // Tytuł karty (RootLayout jest 'use client', `export const metadata` niedostępne).
  useEffect(() => {
    document.title = "Panel Administratora v2 — GateLynk";
  }, []);

  return (
    <div className={`${jakarta.variable} ${plexMonoV2.variable}`} style={{ minHeight: "100vh" }}>
      {children}
    </div>
  );
}
