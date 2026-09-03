# Runbook — dzień instalacji nowego obiektu (MVP, budynek #2)

> Wersja: 2026-07-05. Dla integratora/instalatora. Zakłada wdrożone PR-1…PR-6
> (aktywacja GLEX + throttle, PIN Edge UI, readiness, setup-hub, import CSV,
> zaproszenia). Wariant obiektu: **bez konsjerża, bez AI** (3× Akuvox R29,
> 4× LPR Hikvision). Panel Integratora: `https://gatelynk-web.fly.dev/integrator`.

## 0. Przed wyjazdem (Cloud, ~15 min)

1. Zaloguj się do panelu Integratora → **Dashboard → Dodaj obiekt** (lub istniejący).
2. Ustaw **typ obiektu** i features (karta „Typ obiektu i funkcje" na stronie obiektu):
   - `has_concierge = OFF` (check „Konsjerż" w readiness przejdzie na „nie dotyczy"),
   - AI: nie konfiguruj karty AI Engine / wyłącz `feat_ai_engine` w Permissions
     Matrix (check „AI Engine" = „nie dotyczy").
3. **Kod aktywacyjny Edge**: strona obiektu → Urządzenia → karta „Edge / kod
   aktywacyjny" → *Generuj kod* (typ `EDGE`). Zapisz kod (TTL 24 h) — zabierz na obiekt.
4. Otwórz **Setup-hub**: strona obiektu → karta „Uruchomienie obiektu (setup)"
   (`/integrator/buildings/<id>/setup`). Wszystko czerwone = stan wyjściowy, OK.
5. Poproś zarządcę o **listę mieszkańców CSV** (imię; nazwisko; email; telefon;
   lokal; ulica — separator średnik lub przecinek, polskie nagłówki OK).

## 1. Montaż i sieć (on-site, poza softwarem)

- Mac mini (Edge) + switch; kamery LPR i domofony w tym samym LAN/VLAN.
- Rezerwacje DHCP (lub statyczne IP) dla: Edge, 3× R29, 4× LPR.
- Warunek wyjścia: Edge ma internet, `ping` do każdego urządzenia odpowiada.

## 2. Aktywacja Edge (on-site, ~5 min)

1. Na laptopie w LAN otwórz `http://<ip-edge>:4000/ui` → **Ustawienia**.
2. Wpisz kod aktywacyjny z pkt 0.3 → *Aktywuj*. (Throttle: 5 prób/min/IP —
   przy literówkach odczekaj minutę.)
3. **Ustaw PIN Edge UI** (PR-2) — od tej chwili panel lokalny wymaga PIN-u.
   PIN zapisz w dokumentacji obiektu, NIE zostawiaj na kartce przy urządzeniu.
4. Weryfikacja: Edge UI pokazuje „Połączono z Cloud — budynek: <nazwa>";
   w setup-hubie check **Bramka Edge = ✓** (Odśwież).

## 3. Urządzenia na Edge (on-site, Edge UI)

Dla każdego z 3× R29 i 4× LPR: Edge UI → **Dodaj urządzenie** (wizard 5 kroków:
typ → driver + skan sieci → IP/hasła → **test połączenia** → nazwa robocza).

- **Domofony Akuvox R29** — checklista szczegółowa: patrz workstream **WS-A**
  (checklista intercom — *placeholder, dokument w przygotowaniu*). Minimum:
  ISAPI/API dostępne, konto API, Action URL → `http://<edge>:4000/akuvox/event`,
  test przekaźnika „Wyzwól".
- **Kamery LPR Hikvision** — probe/veryfikacja: patrz workstream **WS-B**
  (probe kamer — *placeholder, dokument w przygotowaniu*). Minimum: ANPR
  włączone, snapshot działa, czas NTP zsynchronizowany.
- Przekaźniki: Edge UI → **Access** — hold-time, polarity, test „Wyzwól".

Weryfikacja: setup-hub check **Urządzenia** pokazuje 7/7 dostępnych.

## 4. Punkty dostępu + LPR (Cloud, zdalnie lub on-site)

1. Panel → obiekt → **Urządzenia → Punkty dostępu**: utwórz AP (wjazd, wyjazd,
   furtki…), każdemu przypnij urządzenie + wyjście przekaźnika + czas (binding).
2. Każdy AP przetestuj przyciskiem **Test** (AP_TEST_FIRE — wpis liczy się do readiness).
3. **Kamery LPR**: karta „Powiązania LPR" — każdą kamerę połącz z AP + kierunek
   IN/OUT (4 kamery = 2 wjazdy × 2 kierunki).
4. Weryfikacja: checki **Punkty dostępu** i **Kamery LPR** ≥ żółte (zielone po
   testowym przejeździe — pkt 7).

## 5. Import mieszkańców (CSV)

1. Setup-hub → **Import mieszkańców (CSV)** → wybierz plik od zarządcy.
2. Przejrzyj **podgląd (dry-run)**: ilu utworzy / pominie (duplikaty) / błędy
   per wiersz. Popraw plik jeśli trzeba i wgraj ponownie — import jest
   idempotentny, nic się nie zdubluje.
3. Klik **„Importuj X mieszkańców"** — utworzą się lokale + mieszkańcy + przypisania.
   Hasła NIE są ustawiane.

## 6. Zaproszenia e-mail

1. Setup-hub → **Zaproszenia mieszkańców** → **„Wyślij zaproszenia (N)"**.
2. Statusy na liście: *aktywny / zaproszony / wygasłe / bez e-maila / niezaproszony*.
   Pojedyncze ponowienie: przycisk „wyślij ponownie" przy wierszu.
3. Mieszkaniec: klika link w mailu → ustawia hasło (strona
   `/accept-invitation`) → loguje się w aplikacji iOS GateLynk.
4. Mieszkańcy „bez e-maila": zarządca uzupełnia adres w panelu BA
   (Mieszkańcy → edycja) → wróć tu i „zaproś".

## 7. Readiness all-green + test end-to-end

1. **Testowy przejazd**: autem z tablicą dodaną do whitelisty (BA → Pojazdy,
   status APPROVED) przejedź przez wjazd — szlaban otwiera się, w access-events
   pojawia się `LPR_MATCH` → check **Kamery LPR = ✓**.
2. **Test mieszkańca**: świeżo aktywowanym kontem zaloguj się w iOS →
   „Otwórz" na AP → przekaźnik działa, wpis `REMOTE_OPEN` w historii.
3. **Domofon**: wywołanie z R29 + otwarcie PIN-em gościa (utwórz gościa
   testowego w iOS).
4. Setup-hub → **Odśwież**: wszystkie checki ✓ lub „nie dotyczy"
   (Konsjerż, AI Engine). Status nagłówka: **Gotowy**.
5. Posprzątaj dane testowe (gość testowy, ewentualne wpisy testowe).

## Znane pułapki

- Kod aktywacyjny jest jednorazowy i ma TTL 24 h — nowy generujesz w tej samej karcie.
- `POST /api/edge/activate` ma rate-limit — seria błędnych kodów = odczekaj 1 min.
- Akuvox/Hikvision zwykle NIE rozgłaszają mDNS — w wizardzie Edge podaj IP ręcznie
  (ARP sweep to PR-9, jeszcze nie ma).
- Konto BA tworzy się dziś w legacy panelu superadmina — jeśli check
  „Administrator budynku" czerwony, zgłoś do GateLynk.
- Bez `RESEND_API_KEY` na serwerze zaproszenia nie wychodzą mailem — panel
  pokazuje wtedy przy każdym mieszkańcu przycisk „link" do ręcznego skopiowania.
