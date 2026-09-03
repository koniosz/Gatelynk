import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './invite.css'

// Geist pulled via next/font żeby było self-hosted + zero FOUT.
// Variable font (bez `weight`) — handoff używa pośrednich wag (650),
// statyczne instancje by je syntetyzowały. Fallback systemowy w CSS.
const geist = Geist({
  subsets: ['latin', 'latin-ext'],
  display: 'swap',
})
const geistMono = Geist_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-geist-mono',
})

export const metadata: Metadata = {
  title: 'Zaproszenie · Gatelynk',
  description: 'Otwórz wejścia na osiedle bez dzwonienia.',
  robots: { index: false, follow: false }, // tokenowane URL-e nie powinny być indeksowane
  formatDetection: { telephone: false, email: false, address: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  // Dark navy z handoffu — pasek statusu iOS/Android zlewa się z aurorą.
  themeColor: '#070a12',
}

export default function InviteLayout({ children }: { children: React.ReactNode }) {
  return <div className={`${geist.className} ${geistMono.variable}`}>{children}</div>
}
