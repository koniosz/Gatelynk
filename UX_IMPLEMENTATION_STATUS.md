# GateLynk — status wdrożenia poprawek UX (audyt 2026-09-21)

Źródło wymagań: `gatelynk-ux-audit-2026-09-21/gatelynk-claude-code/01-WYTYCZNE.md` + `02-AUDYT.md`.
Nagranie pokazuje aplikację **GateLynkGlass** (iOS, SwiftUI, target `GateLynkGlass`
w `apps/ios/GateLynk.xcodeproj`, bundle `com.gatelynk.app.glass`). Backend: `apps/api`
(NestJS), sterowanie urządzeniami przez Edge (`apps/edge`). Panel administratora
(web BA v2 i tryb admina w Glass) — poza zakresem, nietknięty.

Legenda: ✅ zrobione · 🟡 częściowo · ⛔ zablokowane (z przyczyną) · 📝 backlog

Commity: `8f027bb` (etap 1–2) · `d6c9344` (etap 3) · `46ae080` (etap 4) · `d1d021d` (etap 5) · `0bb3d95` (testy API + fix konsjerża).
Lokalny `main` jest przed `origin/main` — **nie wypchnięte** i **API nie wdrożone na Fly** (patrz §8).

## 1. Mapa: wymaganie → pliki → źródło danych → zmiana

| Wymaganie | Pliki / komponenty | Źródło danych | Status |
|---|---|---|---|
| §3.1 polecenie ≠ stan fizyczny | `GateLynk/AccessOpenControl.swift` (`AccessOpenOutcome`, `AccessOpenPhase`, `AccessHoldButton`), `GlassAccessDeck`, `GlassGateSheet`, `GlassCameraSheet`, `GlassHomeView.openAccessPoint` | `POST /resident/access-points/:id/open` → `{success,label}` = Edge przyjął komendę przekaźnika; Nuki: `GET /resident/smart-lock` (realny stan) | ✅ |
| §3.2 brama pożarowa | `GlassGateSheet` (sekcja „Awaryjne", potwierdzenie), `GlassAccessDeck` („Otwórz awaryjnie…") | ten sam endpoint open; backend zapisuje audyt `REMOTE_OPEN` | ✅ UI · 🟡 decyzja produktowa (§7) |
| §3.3 cofnięcie dostępu gościa | `GlassGuestsSheet` (`revokeOrDelete`, `resultMessage`), API `resident.service.ts › cancelGuest` | `DELETE /resident/guests/:id` → `revocation.edgeOnline` | ✅ kod · ⛔ API niewdrożone (§8) |
| §4 wspólny CTA, kamera, domofon | `AccessHoldButton`, `GlassCameraSheet` (`isLive`, `feedBadge`), `GateLynk/IntercomCallView.swift`, `CallManager.openDoorAwaiting` | MJPEG/snapshot z czasem klatki; WebRTC; `POST /resident/intercom/calls/:id/open` | ✅ |
| §5 goście i przepustki | `GlassGuestsSheet`, `Logic/GlassAccessLogic.swift` (`GuestPassPhase`), `Guest.passPhase` | `/resident/guests`, `/resident/access-events?guestsOnly=true` | ✅ |
| §6 pojazdy | `GlassVehiclesSheet` (`anprStatusCard`, `lastActivityCard`, `historyEntry`), `LprEventReading` | `/resident/vehicles`, `/resident/vehicles/:id/history` (`reason`) | ✅ |
| §7 nawigacja | `GlassHomeView` (zakładki), `GlassHubViews.swift` (`GlassTopBar`, `GlassTabBar`, `GlassHubRow`…), `GlassMoreSheet` (tylko konto), `GlassSheetKind.household` | te same sheety i tablice co dotąd (`activeSheet`) | ✅ |
| §8 dashboard | `GlassAttentionSection`, `AttentionVerdict`, `AttentionRules`, `DashboardSourceState`, `GlassShortcutTile`, `GlassAssistantCard`, `GlassBackground(calm:)` | `/resident/parcels`, `/payments`, `/guests`, `/tickets`, `/me` — stan per źródło | ✅ |
| §9 formularze | `GlassGuestsSheet` (kreator), `GlassVehiclesSheet`, `GlassTicketsSheet`, `GlassErrorText` | kontrakty API bez zmian | ✅ (tylko potwierdzone problemy) |
| §10 porządki P2 | `GlassParcelsSheet`, `GlassAnnouncementsSheet`, `GlassPaymentsSheet`, `GlassMoreSheet` („W przygotowaniu") | — | ✅ |
| Linki z powiadomień | `GlassHomeView` (`ticketReplyPushTapped`, `guestEventPushTapped`, `announcementPushTapped`, `contentPushTapped`, pending routes z `AppDelegate`) | payload pusha | ✅ zachowane bez zmian w kodzie routingu |

## 2. Kandydaci P0 — wynik weryfikacji

Weryfikacja: czytanie kodu klienta, API i Edge + testy. **Nie** testowano na sprzęcie.

### Potwierdzony problem
1. **UI ogłaszało stan fizyczny bez telemetrii.** „Zamknięta / Otwarte / Podniesiony / Brama otwarta ✓" wynikało wyłącznie z `success` odpowiedzi API. Bramy i szlabany nie raportują stanu (Akuvox potwierdza komendę nawet dla niepodłączonego przekaźnika).
2. **Domofon ogłaszał „Brama otwarta" PRZED odpowiedzią serwera** — po samym geście (~1,1 s), także gdy żądanie kończyło się błędem.
3. **Brama pożarowa: fałszywa obietnica.** Potwierdzenie mówiło „zgłoszone do administracji / Powiadomiono administrację", a backend zapisuje tylko audyt `REMOTE_OPEN` — żadnego powiadomienia nie ma.
4. **Lista wejść otwierała jednym dotknięciem**, podczas gdy karta Domu wymagała przytrzymania 2 s.
5. **Kamera: plakietka zawsze „NA ŻYWO"**, a znacznik czasu pokazywał zegar telefonu, nie czas klatki.
6. **Goście: jeden kosz robił dwie różne rzeczy** (cofnięcie dostępu albo usunięcie wpisu) bez nazwania; „Aktywne teraz" liczone z samego statusu (przyszłe i wyczerpane przepustki jako aktywne).
7. **Formularz gościa: wyłączone „Wszystkie wejścia" bez wyboru tworzyło przepustkę na WSZYSTKIE wejścia** (`draftAllowedAccessPoints` → `nil`).
8. (poza Glass, wykryte testem) **Lista zgłoszeń konsjerża zwracała 500** — zapytanie czytało nieistniejącą kolumnę `r.avatar`.

### Naprawione
1. Jeden model wyniku: „Polecenie otwarcia przyjęte" / „Wynik nieznany" (timeout, zerwane połączenie, 502/504) / błąd z powodem. Słowo „otwarte" tylko dla zamków Nuki z realnej telemetrii. Bez automatycznych powtórek; spóźniona odpowiedź po zmianie celu jest odrzucana (`commitToken`, `.id(ap.id)`).
2. Domofon używa wspólnego `AccessHoldButton` i `openDoorAwaiting()` — komunikat dopiero po odpowiedzi.
3. Tekst potwierdzenia: „Otwarcie zostanie zapisane w historii zdarzeń osiedla, którą widzi administracja" (zgodne z backendem). Logika urządzenia awaryjnego **bez zmian**.
4. Wszędzie przytrzymanie 2 s (postęp w przycisku), przerwanie przed końcem nie wysyła komendy; dla VoiceOver nazwana akcja z potwierdzeniem.
5. „NA ŻYWO" tylko przy klatce młodszej niż 5 s, inaczej „Ostatni obraz — brak transmisji" + czas klatki.
6. Zakładki Aktywne / Zaplanowane / Historia z `GuestPassPhase`; osobne, nazwane akcje „Cofnij dostęp" i „Usuń wpis z historii"; komunikat po cofnięciu zależy od `edgeOnline`.
7. Błąd przy polu „Wybierz co najmniej jedno wejście…".
8. `r."avatarBase64"`.

### Niezweryfikowane
- Zachowanie na realnym sprzęcie (Akuvox, Hikvision, Nuki) — brak testów sprzętowych; mocków nie traktuję jako dowodu.
- Brama pożarowa VN (Akuvox 192.168.1.89): „Open Relay via HTTP" wyłączone w urządzeniu (`retcode -3`) — do włączenia na miejscu.
- Przy **rozłączonym Edge** PIN cofniętej przepustki może działać na klawiaturze do ponownego połączenia (walidacja offline-first, kasowanie przez trwały outbox). UI mówi to wprost, ale samego okna nie zamyka.
- **Cała kontrola wizualna** — patrz §6.

## 3. Etap 2 — wspólny stan/CTA dostępu i domofon ✅
`AccessHoldButton` (dawna robocza nazwa `HoldToOpenButton` kolidowała z przyciskiem głównej apki i psuła build targetu `GateLynk` — naprawione w `46ae080`). Domofon: plakietka „NA ŻYWO"/„ŁĄCZENIE", „Tożsamość niepotwierdzona" tylko dla połączeń przychodzących, nazwane przyciski Mikrofon / Rozłącz / Głośnik, bez sztywnego „Brama główna".

## 4. Etap 3 — goście i pojazdy ✅
Goście: kto → ważność → zakres → stan; menu wiersza (Udostępnij, Przedłuż, Szczegóły i edycja, Cofnij dostęp / Zaproś ponownie); przedłużanie +2 h / do końca dnia / +1 dzień / +7 dni. Pojazdy: „Automatyczny wjazd jest włączony", ostatnie zdarzenie z tonem i zastrzeżeniem „Odczyt kamery nie potwierdza przejazdu", widoczna „Historia przejazdów", nieznany kod powodu pokazywany wprost.

## 5. Etap 4 — nawigacja i dashboard ✅
- Zakładki **Dom / Dostęp / Sprawy / Osiedle**, konto przez avatar, AI jako skrót w górnym pasku i wiersz w Osiedlu (funkcja bez zmian). Paski w `safeAreaInset` — treść nie wchodzi pod Dynamic Island ani pod nawigację. Usunięty demonstracyjny przełącznik pory dnia.
- Przeniesione z „Konta": historia zdarzeń, domownicy, zamki → Dostęp; kalendarz → Osiedle. Rezerwacji, dokumentów i kontaktu **nie dodano** — Glass nie ma tych modułów (brak pustych ekranów).
- Moduły wyłączone dla osiedla (`featurePermissions` / 403 `FEATURE_DISABLED`) są ukrywane.
- „Wymaga uwagi": płatność po terminie **albo** zbliżający się termin (≤5 dni), nowa odpowiedź obsługi w otwartym zgłoszeniu, paczki `RECEIVED`, przepustka aktywna wygasająca w 24 h. Każda pozycja otwiera właściwy obiekt (wątek, szczegóły przepustki). „Brak spraw wymagających działania" tylko gdy wszystkie źródła odpowiedziały; inaczej „Nie udało się sprawdzić wszystkich spraw" + Odśwież.
- „Przeczytane" odpowiedzi w zgłoszeniach pamiętane **lokalnie** (`GlassTicketSeenStore`) — API nie ma takiego znacznika.
- Karta asystenta: bez zbiorczego „Ruch przy bramie" (filtr po stronie karty; generator `ai-prototype/response_builder.py` zasila też inne widoki), pusty brief ≠ „niedostępny".

## 6. Etap 6 — testy i kontrola

| Sprawdzenie | Wynik |
|---|---|
| Build `GateLynkGlass`, `GateLynk`, `GateLynkGamma` (symulator iPhone 17, Debug) | ✅ 3× BUILD SUCCEEDED |
| `apps/ios/LogicTests` (swiftc, czysta logika): fazy przepustek, odczyt zdarzeń LPR, werdykt „Wymaga uwagi", reguły pozycji | ✅ ALL PASSED (37 asercji) |
| API `tsc --noEmit` | ✅ |
| API e2e, nowy `guest-revoke.e2e-spec.ts` (cofnięcie jednej nie rusza drugiej, `revocation.edgeOnline`, ponowny DELETE = usunięcie wpisu, cudza przepustka → 404) | ✅ 3/3 |
| API e2e, całość (2 przebiegi) | 🟡 56/57 — czerwony `vehicle-approval-flow › outbox PLATE_UPSERT` istniał wcześniej (fixture bez aktywowanego EdgeDevice; osobne zadanie) |
| Jednorazowo w pierwszym pełnym przebiegu padł `vehicle-unit-assignment › lokal innego budynku → 404`; w izolacji i w 2 kolejnych pełnych przebiegach zielony | 🟡 zaobserwowana niestabilność, przyczyna nieustalona |

**Kontrola wizualna: NIE wykonana.** Nie mam zgody na użycie symulatora (prośba o dostęp odrzucona lub bez odpowiedzi) i nie obchodziłem tego przez `simctl`. Nie loguję się też do aplikacji — nie tworzę kont i nie wpisuję haseł. Niezweryfikowane zostają więc: mały ekran, wycięcie/Dynamic Island, większy tekst, klawiatura w formularzach, kolejność fokusu VoiceOver, realne pola dotyku. Statycznie sprawdzone w kodzie: `safeAreaInset` dla obu pasków, pola 44 pt (zamknięcie sheetu, Odśwież, pasek górny, zakładki min. 50 pt), style Dynamic Type w nowych komponentach, etykiety dostępności.
**Warunek rozwiązania:** udziel dostępu do symulatora („Let Claude use it") i zaloguj się w nim sam — wtedy wykonam zrzuty i inspekcję wszystkich zakładek i sheetów.

## 7. Pozostałe ograniczenia

| Ograniczenie | Przyczyna | Warunek rozwiązania |
|---|---|---|
| Brak stanu fizycznego bram/szlabanów | urządzenia nie mają telemetrii | czujnik krańcowy / wejście cyfrowe + kontrakt API ze stanem |
| Otwarcie bramy pożarowej nie powiadamia administracji | backend zapisuje tylko audyt | decyzja produktowa: czy i kogo powiadamiać → endpoint/push |
| Cofnięcie przy Edge offline działa z opóźnieniem | walidacja PIN/tablic offline-first | akceptowalne z komunikatem; ewentualnie krótszy TTL lokalnej kopii |
| „Przeczytane" odpowiedzi per urządzenie | brak pola w API | `lastReadAt` w wątku zgłoszenia |
| Starsze sheety mają sztywne rozmiary czcionek | zakres: nie przebudowywać działających ekranów | osobna iteracja typografii |
| Filtr „Ruch przy bramie" po stronie klienta | wspólny generator briefu | parametr odbiorcy w `day-summary` |
| Główna apka `GateLynk` ma własny przycisk z przytrzymaniem 1,6 s i starymi statusami | audyt dotyczył Glass | decyzja, czy ujednolicać |

## 8. Do wykonania przez właściciela
- `git push` (lokalny `main` przed `origin/main`).
- Deploy API na Fly — bez niego Glass nie dostaje `revocation.edgeOnline` (klient obsługuje brak pola: komunikat neutralny) i lista zgłoszeń konsjerża nadal zwraca 500.
- Xcode: Clean Build Folder + Run na urządzeniu; test przytrzymania, domofonu i cofnięcia przepustki na sprzęcie.
- Akuvox .89: włączyć „Open Relay via HTTP".

## 9. Backlog (bez wdrażania w tej iteracji) 📝
OC / badania techniczne pojazdów · OCR dokumentów · integracje EV · dalsze rozszerzenia AI · płatności BLIK, kod do paczkomatu, geofencing (w aplikacji: Konto › „W przygotowaniu").
