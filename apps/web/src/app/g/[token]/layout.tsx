import type { Metadata, Viewport } from 'next'

/**
 * Metadane dla mikroportalu gościa. Mobile-first: viewport-fit=cover żeby
 * gradient sięgał krawędzi iPhone-a (notch + home-bar), maximumScale:1
 * blokuje zoom (gość nie powinien przypadkowo powiększyć przycisku otwarcia).
 *
 * `themeColor` dopasowany do gradientu z page.tsx (Safari topbar przejmie
 * ten kolor na iOS Standalone PWA).
 */
export const metadata: Metadata = {
  title: 'GateLynk — Zaproszenie',
  description: 'Bezkontaktowy dostęp do osiedla',
  // Bez OG/Twitter — link jest prywatny (capability URL), nie chcemy żeby
  // pojawiał się w społecznościowkach z preview-em.
  robots: { index: false, follow: false, nocache: true },
  // PWA: pozwól zainstalować portal jako appkę (gość kliknie „Add to Home").
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'GateLynk',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#7c3aed', // środek gradientu indigo→purple→fuchsia
}

export default function GuestPortalLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
