# Gatelynk — Strona Zaproszenia Gościa
## Specyfikacja techniczna dla zespołu code

Dokument opisuje co musi wygenerować backend + frontend, aby strona zaproszenia (`Guest Invite.html`) działała w produkcji. Plik HTML w projekcie jest **wzorcem wizualnym** — finalna implementacja powinna mieć identyczny wygląd i zachowanie, ale dane wstrzykiwane dynamicznie.

---

## 1. Architektura wysokiego poziomu

1. Mieszkaniec w aplikacji Gatelynk tworzy zaproszenie → backend generuje **token** (JWT lub krótkie ID + signature).
2. Backend produkuje **podpisany URL**: `https://g8l.app/i/<token>` (krótki host, < 20 znaków łącznie z tokenem dla SMS).
3. URL jest wysyłany do gościa **SMS-em** (Twilio / link shortener) lub **e-mailem**.
4. Gość otwiera link → serwer waliduje token → render strony z danymi zaproszenia.
5. Każde naciśnięcie „Otwórz" → POST do API z tokenem → polecenie do Tedee / Nuki / kontrolera bram → zwrot stanu.

---

## 2. Model danych (payload renderowanej strony)

```ts
type Invite = {
  id: string;                          // "GTL-2A4F" — czytelne, ostatnie 4 znaki tokenu
  token: string;                       // pełny token zaproszenia (do API)
  host: {
    firstName: string;                 // "Anna"
    lastName: string;                  // "Szychta"
    initials: string;                  // "A"
    contactMasked?: string;            // "+48 ••• ••• 421" — pokazywane tylko po odsłonięciu
  };
  guest: {
    firstName: string;                 // "Marek" — opcjonalne, fallback "Witaj"
    locale: 'pl' | 'en' | 'uk' | 'de';
  };
  estate: {
    name: string;                      // "Osiedle Słoneczne"
    address: string;                   // "ul. Niewinna 1, Wilanów"
    apartment: string;                 // "Klatka A · 4 p. · m. 21"
    coords: { lat: number; lng: number };
    securityPhone: string;             // "+48 22 555 11 22"
  };
  window: {
    startsAt: string;                  // ISO 8601 z timezone
    endsAt: string;                    // ISO 8601 z timezone
    timezone: string;                  // "Europe/Warsaw"
  };
  access: AccessPoint[];               // patrz niżej — tylko te, które host udostępnił
  emergencyPin: {
    value: string;                     // "482309" (bez spacji) — szyfrowany at-rest, RAM-only po dekrypcji
    formatted: string;                 // "482 309" — do wyświetlenia
    pad: 'gate' | 'door' | 'both';     // gdzie wpisać
  };
  rules: string[];                     // krótkie zdania, max 3-4
  security: {
    invitedAt: string;                 // dla auditu
    e2eEncrypted: true;
    revoked: false;
  };
};

type AccessPoint = {
  id: string;                          // "entry" | "lobby" | "elevator" | "apt" | "fire" | string
  kind: 'gate' | 'door' | 'elevator' | 'fire';
  title: string;                       // "Brama wjazdowa"
  subtitle: string;                    // "Wjazd główny · szlaban"
  icon: 'gate' | 'door' | 'elevator' | 'home' | 'fire';
  cta: string;                         // "Otwórz" | "Wezwij" | "Awaryjnie"
  confirm: boolean;                    // true → bottom sheet "czy na pewno"
  destructive: boolean;                // styl czerwony
  meta?: {                             // dla wind: które piętro wezwać
    floor?: number;
    deviceVendor?: 'tedee' | 'nuki' | 'satel' | 'roger' | 'custom';
  };
};
```

---

## 3. Endpointy API

### `GET /api/invite/:token`
- Public, ale walidacja podpisu tokenu + wygaśnięcia.
- Zwraca **wyłącznie** dane potrzebne do renderu (model `Invite` powyżej). **Nie** zwraca PIN-u inline — patrz niżej.
- Cache: `no-store`, `Cache-Control: private`.
- Rate limit: **20 / godzinę / IP**.
- 410 Gone gdy zaproszenie wygasło / zostało odwołane.

### `POST /api/invite/:token/pin`
- Zwraca PIN dopiero po explicite żądaniu (kliknięcie „pokaż"). Loguje zdarzenie.
- Body: `{ reason: 'reveal' | 'copy' }`.

### `POST /api/invite/:token/open`
- Body: `{ accessId: 'entry' | 'fire' | ..., clientTs: number, confirmedAt?: number }` — `confirmedAt` wymagane dla destructive.
- Server-side:
  1. Walidacja podpisu + window (`now ∈ [startsAt, endsAt]`).
  2. Wysłanie polecenia do urządzenia (Tedee / Nuki / kontroler bram) z timeoutem 4 s.
  3. **Notyfikacja host-a w czasie rzeczywistym** (WebSocket / push do aplikacji).
  4. Audyt do bazy (kto / co / kiedy / wynik / geo IP).
- Response: `{ status: 'opened' | 'failed' | 'timeout', message?: string }`.
- Rate limit: **6 prób / minutę / token**.

### `POST /api/invite/:token/report`
- Zgłoszenie nadużycia → zatrzymanie zaproszenia + alert do hosta i admina osiedla.

---

## 4. Walidacje / bezpieczeństwo

- Token: JWT (ES256) **lub** opaque token + sprawdzanie w bazie. Format JWT preferowany, claims: `inv_id`, `host_id`, `iat`, `exp`, `scopes` (lista accessId).
- Każde wywołanie API wymaga `Origin` + `Referer` z domeny `g8l.app`.
- CSP strict: `default-src 'self'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://api.g8l.app`.
- `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`.
- Logowanie wszystkich akcji do **audit log** (mieszkaniec widzi je w aplikacji).
- Host może z aplikacji w każdej chwili **„Odwołaj zaproszenie"** → revoked=true, 410 Gone na każdym kolejnym żądaniu.

---

## 5. Wzorzec wizualny

Plik `Guest Invite.html` w tym projekcie jest **referencją wizualną** — wszystkie kolory, radiusy, animacje, struktura komponentów są tam dokładnie zdefiniowane. Implementacja produkcyjna powinna:

- **Skopiować tokeny** z `:root` w pliku HTML (paleta, radiusy, cienie).
- **Skopiować strukturę DOM** sekcji: `.brand`, `.hero`, `.access-list`, `.pin-card`, `.loc-card`, `.rules`, `.footer`.
- Zachować animacje: `pulse` (status active), `ripple` (mapa), `spin` (spinner CTA).
- Font: **Geist** (Google Fonts) — fallback systemowy.

---

## 6. Komponenty (jeśli React/Next/Astro)

Sugerowany podział:

```
<InvitePage invite={invite}>
  <Brand />
  <Hero
    host={invite.host}
    guest={invite.guest}
    estate={invite.estate}
    window={invite.window}
  />
  <AccessList
    items={invite.access}
    onOpen={(id) => openAccess(token, id)}
  />
  <EmergencyPin token={token} />          {/* sam fetchuje na żądanie */}
  <Location coords={invite.estate.coords} />
  <Rules items={invite.rules} />
  <Footer inviteId={invite.id} />
</InvitePage>
```

Stany `AccessRow`:
- `idle` → CTA fioletowe „Otwórz"
- `opening` → spinner + „Otwieram", disabled
- `done` (3.5s) → zielone „✓ Otwarte", potem powrót do `idle`
- `failed` → czerwone „Spróbuj ponownie", toast z błędem
- `destructive` → CTA czerwone, klik otwiera `<ConfirmSheet>` przed wywołaniem API

---

## 7. Stany krawędziowe

| Sytuacja | Zachowanie |
|---|---|
| Zaproszenie poza oknem czasowym | Render strony z pełnym wyciszeniem CTA + komunikat „Dostęp aktywny od X" lub „Dostęp wygasł" |
| Zaproszenie odwołane | Strona-zaślepka: logo + „Zaproszenie zostało anulowane. Skontaktuj się z gospodarzem." |
| Brak internetu po wejściu | Service worker cache'uje render + pokaż PIN z `localStorage` (zaszyfrowane sessionKey) |
| Urządzenie nie odpowiada (Tedee offline) | Toast + sugestia użycia PIN-u awaryjnego |
| Token podejrzany (geolokacja) | Wymóg dodatkowego potwierdzenia (SMS OTP do hosta) |

---

## 8. SMS / E-mail — szablon

**SMS** (max 160 znaków):
```
Anna zaprasza Cię na Osiedle Słoneczne, dziś 18-23.
Otwórz: g8l.app/i/2A4F8x
```

**E-mail** — temat: „Anna Szychta zaprosiła Cię — Osiedle Słoneczne". Body: krótki preview + duży CTA „Otwórz zaproszenie" + adres + okno czasowe.

---

## 9. PWA

- Strona jako PWA: `manifest.json`, `start_url`, ikony.
- Service worker: cache shellu strony + PIN dla offline (zaszyfrowany lokalnie kluczem z tokenu).
- Add to home screen umożliwia szybki dostęp przy kolejnej wizycie.

---

## 10. i18n

Wszystkie ciągi przez słownik `pl | en | uk | de` — wybór na podstawie `guest.locale` lub `Accept-Language`. Strona renderowana SSR z gotowymi tłumaczeniami (żeby ładowanie było natychmiastowe).

---

## 11. Telemetria (audytable events)

| Event | Properties |
|---|---|
| `invite.viewed` | invite_id, ts, ua, ip_country |
| `invite.access.opened` | invite_id, access_id, ts, result |
| `invite.pin.revealed` | invite_id, ts |
| `invite.pin.copied` | invite_id, ts |
| `invite.expired_visit` | invite_id, ts |
| `invite.reported` | invite_id, ts, reason |

Wszystkie eventy widoczne dla hosta w sekcji „Historia zaproszenia" w aplikacji.
