// PR-5 (2026-07-05) — import mieszkańców z CSV.
//
// Schemat wymaga `Resident.email NOT NULL` + unique (buildingId, email),
// a realne listy od zarządców miewają mieszkańców BEZ adresu e-mail.
// Zamiast migracji na nullable email (dotyka logins/joins w całym API),
// import generuje unikalny placeholder w kontrolowanej domenie.
//
// Konsumenci konwencji:
//   • ResidentsImportService — generuje placeholder przy braku e-maila,
//   • InvitationsService — pomija placeholdery przy bulk-send (status
//     „bez e-maila" w UI zaproszeń),
//   • IntegratorReadinessService — mieszkańcy-placeholder nie blokują
//     checka „Zaproszenia mieszkańców".
export const NO_EMAIL_DOMAIN = 'brak-email.gatelynk.invalid'

export function isPlaceholderEmail(email: string | null | undefined): boolean {
  return typeof email === 'string' && email.toLowerCase().endsWith(`@${NO_EMAIL_DOMAIN}`)
}

/** Placeholder unikalny per (lokal, wiersz) — deterministyczny w ramach pliku,
 *  ale idempotencję re-uploadu zapewnia dedup po (imię+nazwisko+lokal), nie
 *  po samym adresie. */
export function buildPlaceholderEmail(unitNumber: string, rowIndex: number): string {
  const slug = unitNumber
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'lokal'
  return `mieszkaniec-${slug}-w${rowIndex}@${NO_EMAIL_DOMAIN}`
}
