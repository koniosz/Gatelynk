# Gatelynk — Strona Zaproszenia Gościa

Paczka dla zespołu dev / AI coding assistanta.

## Pliki

- **`Guest Invite.html`** — pixel-perfect referencja wizualna. Otwórz w przeglądarce, klikaj wszystkie wejścia, sprawdź animacje, copy PIN, bottom sheet bramy pożarowej. Implementacja produkcyjna musi wyglądać i zachowywać się **identycznie**.
- **`Guest Invite — Spec.md`** — specyfikacja techniczna: model danych, endpointy API, JWT, rate limity, edge case'y, szablon SMS/email, PWA, i18n, audit log.

## Prompt do wklejenia w Claude Code / Cursor / Lovable

> Zbuduj stronę zaproszenia gościa dla aplikacji Gatelynk.
>
> Wzorzec wizualny: **`Guest Invite.html`** — skopiuj tokeny `:root`, strukturę DOM, animacje (`pulse`, `ripple`, `spin`), font Geist.
>
> Pełna specyfikacja: **`Guest Invite — Spec.md`** — model `Invite` + `AccessPoint`, endpointy `GET /api/invite/:token`, `POST /open`, `POST /pin`, `POST /report`, JWT ES256, CSP, rate limity, stany komponentów, edge cases.
>
> Stack: Next.js 14 (App Router) + TypeScript + Tailwind. SSR pod `/i/[token]`. Backend: Next API routes. Urządzenia: Tedee SDK na start, reszta mockowana.
>
> Priorytet: (1) SSR + walidacja tokenu, (2) `POST /open` + Tedee, (3) bottom sheet potwierdzenia destructive, (4) reveal/copy PIN, (5) audit log + revoke, (6) service worker + PWA.
>
> Trzymaj się dokładnie designu — nie wymyślaj nowego layoutu.

## Struktura sugerowana

```
src/
├─ app/
│  └─ i/[token]/
│     ├─ page.tsx              # SSR strony
│     └─ not-found.tsx
├─ app/api/invite/[token]/
│  ├─ route.ts                 # GET — payload Invite
│  ├─ open/route.ts            # POST — otwarcie
│  ├─ pin/route.ts             # POST — reveal PIN
│  └─ report/route.ts          # POST — nadużycie
├─ components/invite/
│  ├─ Brand.tsx
│  ├─ Hero.tsx
│  ├─ AccessList.tsx
│  ├─ AccessRow.tsx            # stany: idle | opening | done | failed
│  ├─ EmergencyPin.tsx
│  ├─ Location.tsx
│  ├─ Rules.tsx
│  ├─ ConfirmSheet.tsx         # bottom sheet dla destructive
│  └─ Toast.tsx
├─ lib/
│  ├─ jwt.ts                   # walidacja tokenu ES256
│  ├─ tedee.ts                 # integracja
│  ├─ audit.ts                 # event log
│  └─ rate-limit.ts
└─ styles/
   ├─ globals.css              # tokeny z :root
   └─ animations.css
```

## Definition of Done

- [ ] Render strony pixel-perfect zgodnie z `Guest Invite.html` (porównanie screenshotów).
- [ ] Wszystkie stany CTA (idle/opening/done/failed) działają.
- [ ] Bottom sheet potwierdzenia dla bramy pożarowej.
- [ ] PIN ukryty domyślnie, lazy-fetch z `POST /pin`, copy to clipboard.
- [ ] Walidacja okna czasowego — strona-zaślepka poza oknem.
- [ ] Revoke przez hosta w aplikacji → 410 Gone.
- [ ] Audit log każdej akcji.
- [ ] Service worker + offline PIN.
- [ ] i18n: pl/en/uk/de.
- [ ] Rate limit 20/h/IP na GET, 6/min/token na open.
- [ ] Telemetria wszystkich eventów z spec.
