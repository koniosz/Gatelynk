/**
 * Spinner — używamy Lucide `Loader2` z `animate-spin`. Tokenizowany przez
 * Tailwind `text-brand`. Rozmiar przez prop `size`.
 */
import { Loader2 } from 'lucide-react'

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={`animate-spin text-brand ${className ?? ''}`} />
}
