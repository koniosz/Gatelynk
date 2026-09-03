import type { Metadata } from "next";
import { Geist, Geist_Mono, IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// IBM Plex — używane w Panel Integratora (handoff §3). Nie nadpisuje Geist
// dla pozostałych paneli — `@theme inline` w globals.css ma fallback do
// var(--font-plex-sans, var(--font-geist-sans)). Komponenty integrator-a
// ustawiają `--font-plex-*` w swoim scope.
const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  weight: ["400", "500", "600", "700"],
  subsets: ["latin", "latin-ext"],   // latin-ext dla polskich znaków
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  weight: ["400", "500"],
  subsets: ["latin", "latin-ext"],
});

export const metadata: Metadata = {
  // `template` używamy w sekcjach panelu (dashboard/concierge/building-admin)
  // żeby tytuł karty przeglądarki miał kontekst, np. „Konsjerż — GateLynk".
  // Strony bez własnego tytułu fall-back-ują na `default`.
  title: {
    default: "GateLynk",
    template: "%s — GateLynk",
  },
  description: "GateLynk — kontrola dostępu, mieszkańcy, paczki, rezerwacje.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${plexSans.variable} ${plexMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
