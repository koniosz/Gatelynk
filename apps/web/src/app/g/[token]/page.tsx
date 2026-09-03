import { permanentRedirect } from 'next/navigation'

/**
 * Drop-in replace (decyzja A z 2026-05-11): stara ścieżka `/g/<token>` zostaje
 * jako 308 permanent redirect na nowy `/i/<token>` — wszystkie istniejące
 * linki SMS-y / email z poprzedniej wersji portalu dalej działają.
 *
 * Backend dalej trzyma `urlToken` w `Guest` tabeli (decyzja 3B — opaque
 * tokeny), więc samo przekierowanie URL wystarcza — nie trzeba migracji
 * danych. Strona docelowa `/i/[token]` używa tego samego tokenu i tej samej
 * walidacji po stronie API.
 */
export default async function GuestPortalLegacy({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  permanentRedirect(`/i/${token}`)
}
