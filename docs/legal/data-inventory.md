# GateLynk — Inwentaryzacja danych osobowych (rejestr czynności przetwarzania)

> **Dokument wewnętrzny / fundament zgodności.** Powstał na podstawie **audytu
> faktycznego kodu** GateLynk (schemat bazy `apps/api/prisma/schema.prisma`,
> kod Edge/Cloud/iOS, konfiguracja Info.plist, projekt domofonu
> `docs/intercom-akuvox-call.md`). Służy jako podstawa do:
> 1. Polityki prywatności (`privacy-policy-pl.md`),
> 2. etykiet App Store / Data Safety (`app-store-privacy.md`),
> 3. rejestru czynności przetwarzania (art. 30 RODO) — do uzupełnienia przez IOD.
>
> **Stan na:** 2026-06-14. Każda zmiana modeli danych powinna pociągać aktualizację
> tego pliku. Pola oznaczone `[...]` wymagają decyzji właściciela/IOD (np. dokładna
> retencja, gdy nie wynika z kodu).

---

## 1. Architektura przetwarzania (gdzie fizycznie lądują dane)

Zrozumienie architektury jest kluczowe dla RODO, bo **większość danych wrażliwych
przetwarzana jest LOKALNIE** (on-premise / w sieci LAN nieruchomości), a nie w chmurze.

| Warstwa | Lokalizacja | Technologia | Co przetwarza |
|---|---|---|---|
| **Edge** | On-premise (Mac Mini w budynku, LAN) | NestJS + SQLite | LPR (rozpoznawanie tablic), PIN-y, sterowanie kamerami/domofonem, lokalna baza zdarzeń, terminacja SIP↔WebRTC (Janus) |
| **AI lokalne** | Lokalny MacBook w LAN nieruchomości | YOLOv8 (vision) + Ollama/Bielik (LLM) | Analiza obrazu z kamer, detekcja upadku (FALL), odpowiedzi asystenta AI — **bez wysyłania obrazu/zapytań do dostawców zewnętrznych** |
| **Cloud API** | **Fly.io, region Frankfurt (FRA), terytorium UE** | NestJS + PostgreSQL | Konta użytkowników, lokale, pojazdy, **metadane** zdarzeń dostępu, zgłoszenia, płatności (ewidencja), tokeny push, logi asystenta |
| **Aplikacja mobilna** | Urządzenie użytkownika (iOS; Android planowany) | Swift/SwiftUI (iOS), Expo/React Native (mobile scaffold) | Dane logowania, sesja, PIN mieszkańca, połączenie domofonowe (audio/wideo na żywo) |
| **Relay TURN** | Publiczny VPS, region Frankfurt (FRA) | coturn | Tylko gdy domofon dzwoni do mieszkańca poza siecią LAN — przekazuje zaszyfrowany strumień (SRTP/DTLS), nie deszyfruje |

**Zasada minimalizacji „chmurowej":** do Cloud trafiają wyłącznie **metadane**
zdarzeń (np. numer tablicy, data/godzina, typ zdarzenia, czy brama została
otwarta). **Obraz z kamer, klatki wideo i treść strumieni z domofonu NIE są
wysyłane do chmury** ani do zewnętrznych dostawców AI.

---

## 2. Tabela inwentaryzacji — kategoria danych → źródło → cel → podstawa → retencja

> Podstawy prawne wg art. 6 RODO: **(a)** zgoda, **(b)** wykonanie umowy,
> **(c)** obowiązek prawny, **(f)** prawnie uzasadniony interes.
>
> **Model ról (decyzja właściciela 2026-06):** dla danych przetwarzanych w ramach
> nieruchomości (mieszkańcy, goście, monitoring CCTV/LPR, zdarzenia dostępu,
> domofon, logi asystenta AI) administratorem jest **wspólnota / spółdzielnia /
> zarządca**, a GateLynk jest **podmiotem przetwarzającym (procesorem, art. 28
> RODO)** — przetwarza na udokumentowane polecenie administratora; podstawy prawne
> (a/b/c/f) leżą po stronie administratora-wspólnoty. Dla własnych relacji
> biznesowych GateLynk (konta B2B, kontakt przez stronę, marketing, rozliczenia)
> GateLynk jest **administratorem**. Szczegóły: `privacy-policy-pl.md` § 1.

### 2.1 Dane mieszkańców (model `Resident`, `UnitResident`, `Unit`)

| Kategoria danych | Pola / źródło w kodzie | Cel | Podstawa | Retencja |
|---|---|---|---|---|
| Imię i nazwisko | `Resident.firstName/lastName` | Identyfikacja w aplikacji, panelu zarządcy, historii zdarzeń | (b) umowa | Czas trwania umowy + okres przedawnienia roszczeń |
| E-mail | `Resident.email` | Logowanie, powiadomienia, zaproszenia | (b) umowa | jw. |
| Telefon (opcjonalny) | `Resident.phone` | Kontakt zarządcy/konsjerża | (f) obsługa nieruchomości | jw. |
| Hasło (hash) | `Resident.passwordHash` (bcrypt) | Uwierzytelnianie | (b) umowa | jw. |
| Zdjęcie profilowe (opcjonalne) | `Resident.avatarBase64` | Personalizacja profilu | (a) zgoda (dobrowolne) | Do usunięcia przez użytkownika |
| Numer lokalu / adres / klatka | `Unit.number/street`, `Stairwell` | Przypisanie do nieruchomości, kontrola dostępu | (b) umowa | jw. |
| Rola w lokalu (właściciel/najemca) | `UnitResident.role`, `sinceDate/untilDate` | Uprawnienia, rozliczenia | (b) umowa | jw. |
| **PIN dostępu mieszkańca** | `Resident.intercomPin` (4–6 cyfr, plain) | Otwieranie bramy/domofonu na klawiaturze | (b) umowa | Do zmiany/usunięcia przez użytkownika; synchron. lokalnie do Edge |
| Zgoda na alerty o zagrożeniach | `Resident.notifyAnomalies` (domyślnie OFF) | Opt-in powiadomień o upadku osoby | (a) zgoda | Do wycofania |

### 2.2 Pojazdy i tablice rejestracyjne (model `Vehicle`, `LprRead`, `AccessEvent`)

| Kategoria danych | Pola / źródło | Cel | Podstawa | Retencja |
|---|---|---|---|---|
| **Numer tablicy rejestracyjnej** | `Vehicle.licensePlate`, `LprRead.plate`, `AccessEvent.plate` | Automatyczna kontrola wjazdu (LPR), białą lista | (f) bezpieczeństwo i kontrola dostępu | Whitelist: czas uprawnienia. Odczyty `lpr_reads`: **30 dni** (czyszczone nocnym cronem) |
| Marka/model/kolor pojazdu | `Vehicle.make/model/color` | Identyfikacja pojazdu w panelu | (f) | jw. |
| Tagi opisowe pojazdu | `Vehicle.tags`, `serviceName`, `notes` | Klasyfikacja (np. „kurier", „obsługa basenu") | (f) | jw. |
| Odczyt tablicy + czas + kierunek | `LprRead` (`plate`, `ts`, `direction`, `matched`, `gateOpened`, `confidence`) | Audyt wjazdów/wyjazdów | (f) bezpieczeństwo | **30 dni** (`lpr_reads`) |
| Zdarzenie dostępu (zunifikowane) | `AccessEvent` (typ, czas, kto otworzył, `gateOpened`, `reason`) | Pełny audyt dostępu | (f) bezpieczeństwo, (c) ew. dowodowy | **3 miesiące** (domyślnie; administrator może zmienić) |

> **Uwaga prywatności (zaimplementowana w produkcie):** odczyt LPR **NIE
> przechowuje zdjęcia tablicy** (`apps/edge/store.service.ts`, komentarz w
> `schema.prisma` modelu `LprRead`). Asystent AI na pytanie „do kogo należy
> pojazd?" **NIE ujawnia właściciela** — podaje wyłącznie przypisany lokal
> (intent `vehicle_owner_by_plate`, faza 8.h.23 — defense-in-depth: SQL nie
> selektuje `owner`/`tags`, brak smart-rewrite LLM). To celowa zasada minimalizacji.

### 2.3 Monitoring wizyjny / kamery / AI wizyjne (model `LprCamera`, `AnomalyEvent`, vision na Edge)

| Kategoria danych | Pola / źródło | Cel | Podstawa | Retencja |
|---|---|---|---|---|
| Obraz / wizerunek osób w kadrze | Strumień kamer (Edge/lokalne AI) | Monitoring bezpieczeństwa, detekcja zdarzeń | (f) bezpieczeństwo osób i mienia | **Przetwarzanie lokalne**; nagrania (jeśli rejestrowane) **do 3 miesięcy**, potem nadpisywane (domyślnie; administrator może zmienić) |
| Snapshoty/klatki z analizą | Edge `vision_detections` (lokalny SQLite), `~/gatelynk-edge/data/lpr-snapshots/` | Analiza AI (YOLO), debugowanie detekcji | (f) | **7–30 dni** lokalnie na Edge |
| Rozpoznane napisy/marki (OCR) | `vision_detections.text_raw`, `brand_detected` | Identyfikacja kurierów/dostawców (np. po napisie na vanie) | (f) | Lokalnie na Edge |
| **Detekcja upadku osoby (FALL)** | `AnomalyEvent` (`type`, `likelihood`, `indicators`, `imageFilename`) | Alarm o możliwym zagrożeniu zdrowia/życia | (f) ochrona żywotnych interesów / bezpieczeństwo; powiadomienie opt-in mieszkańca (a) | Metadane w Cloud (audyt: 3 mies.); klatka lokalnie na Edge **7–30 dni** |

> **Nagrania domofonu i kamer nie są przesyłane do chmury.** Analiza obrazu i AI
> odbywają się na lokalnym sprzęcie w sieci nieruchomości.

### 2.4 Domofon — połączenia audio/wideo (model `BuildingIntercom`, `IntercomCallSession`)

| Kategoria danych | Pola / źródło | Cel | Podstawa | Retencja |
|---|---|---|---|---|
| Strumień audio (2-way) + wideo (1-way, gość→mieszkaniec) | Janus SIP↔WebRTC na Edge; relay TURN gdy off-site | Rozmowa mieszkańca z gościem przy domofonie | (b) umowa / (f) bezpieczeństwo | **Strumień NA ŻYWO — NIE jest nagrywany.** Brak zapisu treści audio/wideo |
| Metadane połączenia | `IntercomCallSession` (`state`, `startedAt`, `answeredAt`, `endedAt`, `endReason`, `unitLabel`, `intercomName`) | Historia połączeń, audyt, statystyki | (f) | **90 dni** (domyślnie; administrator może zmienić) |
| Snapshot dzwoniącego (opcjonalny) | `IntercomCallSession.meta.snapshotUrl` | Podgląd kto dzwoni (CallKit) | (f) bezpieczeństwo | jw. (90 dni) |

> **Status:** funkcja połączeń domofonowych jest za flagą `INTERCOM_CALL_ENABLED`
> (domyślnie wyłączona). **Wideo jest jednokierunkowe** — iPhone mieszkańca NIE
> publikuje kamery (`recvOnly`); dlatego aplikacja prosi tylko o **mikrofon**, nie
> o kamerę. Treść połączenia nie jest nagrywana ani przechowywana.

### 2.5 Goście (model `Guest`, `GuestEvent`, `CourierVisit`)

| Kategoria danych | Pola / źródło | Cel | Podstawa | Retencja |
|---|---|---|---|---|
| Imię gościa (opcj.), telefon (opcj.) | `Guest.name`, `Guest.phone` | Identyfikacja zaproszonego (host przekazuje kod sam — patrz § 6 polityki) | (f) interes administratora-wspólnoty | Okno ważności + audyt 3 mies. |
| PIN gościa (6 cyfr) | `Guest.pin` (plain) | Jednorazowy/czasowy dostęp | (f) | Do `validTo`, potem EXPIRED |
| Tablica gościa (opcj.) | `Guest.vehiclePlate` | Wjazd pojazdem gościa (tylko przy LPR) | (f) | Do `validTo` |
| E-mail gościa (opcj.) | `Guest.email`, `urlToken` (portal `/g/<token>`) | Wysyłka linku do otwierania bram — TYLKO gdy host świadomie wybierze zaproszenie z systemu | (f) | jw. |
| Zdarzenia gościa | `GuestEvent` (`via`, `actorIp`, `ts`) | Audyt użycia (np. PORTAL_OPEN), anty-spam | (f) | Audyt **3 miesiące** |
| Wizyta kuriera (kod 4-cyfr) | `CourierVisit` (`code`, `courierBrand`, `status`) | Wpuszczenie kuriera „pod dom" (osiedla) | (f) | Do EXPIRED (≈30 min) + audyt 3 mies. |

### 2.6 Administratorzy, zarządcy, konsjerże, integratorzy

| Kategoria danych | Pola / źródło | Cel | Podstawa | Retencja |
|---|---|---|---|---|
| Konto administratora/integratora | `Admin`, `Integrator` (email, passwordHash, name, company) | Zarządzanie systemem/budynkami | (b) umowa | Czas trwania umowy + okres przedawnienia roszczeń |
| Konto zarządcy budynku | `BuildingAdmin` (email, passwordHash, name) | Zarządzanie nieruchomością | (b) | jw. |
| Konto konsjerża | `Concierge` (email, passwordHash, name) | Obsługa recepcji | (b) | jw. |
| Dane firmy/budynku | `Building` (`name`, `address`, `nip`, `regon`) | Identyfikacja klienta | (b)/(c) podatkowy | jw. |
| **Log operacji integratora** | `IntegratorAuditLog` (`action`, `meta` z IP, user-agent, `createdAt`) | Audyt, compliance, diagnostyka | (f)/(c) | Obecnie bez limitu; **planowany cleanup > 90 dni** |
| Zmiana e-mail (token) | `Integrator.pendingEmail/Token` (TTL 24h) | Weryfikacja zmiany adresu | (b) | 24h |

### 2.7 Powiadomienia, tokeny, asystent AI

| Kategoria danych | Pola / źródło | Cel | Podstawa | Retencja |
|---|---|---|---|---|
| **Token push (APNs)** | `PushToken.token`, `environment`, `kind` (`apns`/`voip`) | Powiadomienia push i VoIP (budzenie na połączenie) | (b)/(f) | Do wylogowania/usunięcia urządzenia; auto-czyszczenie przy BadDeviceToken |
| Treść powiadomień | `Notification` (`title`, `body`, `senderBaId`) | Komunikaty zarządcy/systemu | (b)/(f) | `[okres — ustala administrator]` |
| **Zapytania do asystenta AI + odpowiedzi** | `AssistantQueryLog` (`question`, `answer`, `role`, `userId`, `intent`, `model`) | Dostrajanie/ocena jakości LLM (panel integratora) | (f) ulepszanie usługi | **30 dni**, następnie usunięcie lub anonimizacja (minimalizacja: unikać przechowywania danych identyfikujących, pseudonimizacja) |
| Zaproszenia | `Invitation` (`tokenHash`, `status`, `expiresAt`) | Onboarding mieszkańca | (b) | Do akceptacji/wygaśnięcia |

> **Uwaga:** zapytania do asystenta AI są przetwarzane **lokalnie** (LLM Bielik/Ollama
> na sprzęcie w LAN — nie wysyłane do OpenAI/Anthropic/Google). Jednak **log par
> pytanie/odpowiedź jest zapisywany w Cloud** (`assistant_query_logs`) na potrzeby
> oceny jakości. Treść pytań może zawierać dane osobowe (np. numer tablicy, lokal) —
> **wymaga przeglądu IOD pod kątem retencji/anonimizacji.**

### 2.8 Zgłoszenia, paczki, rezerwacje, płatności

| Kategoria danych | Pola / źródło | Cel | Podstawa | Retencja |
|---|---|---|---|---|
| Zgłoszenia / wiadomości | `Ticket`, `TicketReply` (`title`, `body`, `photo`) | Obsługa zgłoszeń mieszkańców | (b)/(f) | `[okres — ustala administrator]` |
| Przesyłki/paczki | `Parcel` (`trackingNumber`, `courier`, `issuedPhotoUrl`) | Awizacja i wydanie paczek | (b)/(f) | `[okres — ustala administrator]` |
| Rezerwacje części wspólnych | `Reservation` (`startAt`, `endAt`, `pricePaid`) | Rezerwacja sauny/siłowni itp. | (b) | `[okres — ustala administrator]` |
| **Ewidencja opłat / saldo** | `PaymentConfig`, `PaymentEntry` (`amount`, `reference` z MT940) | Rozliczenia opłat za lokal | (b)/(c) obowiązek księgowy | Zgodnie z przepisami podatkowymi/rachunkowymi (np. 5 lat) |
| Dokumenty bazy wiedzy | `BuildingKnowledgeDoc` (`parsedText`, np. eksport czatu Messenger, uchwały, regulaminy, kontakty) | RAG dla asystenta AI | (f) | Do usunięcia przez zarządcę |

> **Brak realnego operatora płatności.** „BLIK"/„PayPo" w aplikacji iOS to obecnie
> wyłącznie oznaczenia graficzne (UI) — **żadne dane kart/transakcji nie są
> przetwarzane przez operatora płatniczego.** Płatności = wewnętrzna ewidencja sald.
> Po uruchomieniu realnego operatora dodać go jako podmiot przetwarzający.

---

## 3. Odbiorcy / podprocesorzy (realni, z kodu)

> Wszystkie poniższe to **podprocesorzy** (dalsze powierzenie) — GateLynk powierza
> im przetwarzanie jako procesor działający na zlecenie administratora-wspólnoty,
> za zgodą administratora i na podstawie umów podpowierzenia (art. 28 ust. 2 i 4 RODO).

| Podmiot | Rola | Lokalizacja | Co przetwarza | Źródło w kodzie |
|---|---|---|---|---|
| **Fly.io, Inc.** | Hosting Cloud + baza | Serwery w **UE (Frankfurt)**; spółka USA | Wszystkie dane Cloud (Postgres) | `fly.api.toml`, region FRA |
| **Resend, Inc.** | Wysyłka e-mail transakcyjnych | USA | E-mail, imię/nazwisko, treść wiadomości | `apps/api/src/mail/mail.service.ts` |
| **Apple Inc.** | Powiadomienia push/VoIP (APNs) | USA | Token urządzenia, treść powiadomienia | `apps/api/src/push/push.service.ts` |
| **Tailscale Inc.** | Szyfrowany tunel sieciowy Cloud↔Edge | Kanada/USA | Pośredniczy w połączeniu; **brak dostępu do treści** (E2E) | architektura tunelu |
| **Operator VPS / coturn (TURN)** | Relay strumienia domofonu (off-site) | **Frankfurt (FRA)** | Zaszyfrowany strumień SRTP/DTLS — nie deszyfruje | `infra/intercom/coturn/`, `docs/intercom-akuvox-call.md` |

**Nie używane (potwierdzone):**
- Brak Google FCM (aplikacja produkcyjna to iOS; Android = scaffold Expo, do wdrożenia).
- Brak Google Analytics / Meta Pixel / PostHog / Mixpanel / Hotjar w panelu web
  (zweryfikowano `apps/web/package.json` i `src/`). Jedyne cookie: `js-cookie` —
  techniczne (sesja/uwierzytelnianie), brak trackerów marketingowych.
- Brak chmury producentów urządzeń (Hik-Connect / Akuvox SmartPlus cloud) —
  urządzenia działają lokalnie w LAN.
- Brak zewnętrznych dostawców AI (LLM/vision działają lokalnie na sprzęcie w LAN).

---

## 4. Przekazywanie poza EOG

- **Dane w spoczynku (Cloud):** serwery w UE (Frankfurt) — bez transferu poza EOG.
- **Transfer poza EOG** zachodzi przy korzystaniu z usług podprocesorów z siedzibą
  w USA/Kanadzie (Fly.io, Resend, Apple/APNs, Tailscale). Przekazania objęte
  odpowiednimi zabezpieczeniami: **EU-U.S. Data Privacy Framework** (art. 45 RODO)
  i/lub **standardowe klauzule umowne (SCC, art. 46 RODO)**. Status DPF/SCC każdego
  podprocesora potwierdza się przy zawieraniu umowy podpowierzenia.
- **APNs (Apple):** przekazywany wyłącznie token urządzenia + treść powiadomienia
  (minimum). Przekazanie do USA objęte DPF i/lub SCC; treść powiadomień jest
  minimalizowana (bez nadmiaru danych osobowych).

---

## 5. Punkty wymagające decyzji właściciela / IOD

**Rozstrzygnięte (decyzja właściciela 2026-06) — domyślne wartości w tabeli powyżej
i w `privacy-policy-pl.md`:**

- ✅ **Rola** — GateLynk jest **procesorem** dla danych w nieruchomości
  (administrator = wspólnota / zarządca) i **administratorem** dla własnych relacji
  B2B. Wdrożone w polityce § 1.
- ✅ **Retencja (domyślne, administrator może zmienić):** zdarzenia dostępu /
  `access_events` — **3 mies.**; nagrania CCTV — **do 3 mies.**; metadane domofonu /
  `intercom_call_sessions` — **90 dni**; snapshoty Edge — **7–30 dni**;
  `assistant_query_logs` — **30 dni** + usunięcie/anonimizacja (pseudonimizacja);
  `lpr_reads` — 30 dni (z kodu); konta/lokal — czas umowy + przedawnienie;
  opłaty — wg przepisów podatkowych (np. 5 lat).

**Nadal do ustalenia / weryfikacji z IOD:**

1. **Retencja `integrator_audit_logs`** — obecnie bez limitu; planowany cleanup
   > 90 dni (do potwierdzenia).
2. **Retencja `Notification` / `Ticket` / `Parcel` / `Reservation`** — ustala
   administrator (oznaczone w tabeli jako placeholder).
3. **Treść i podpis umowy powierzenia (DPA, art. 28)** z każdą wspólnotą/zarządcą —
   w tym lista podprocesorów i tryb zgody na ich zmianę.
4. **Status DPF/SCC** poszczególnych podprocesorów (Fly.io, Resend, Apple,
   Tailscale, operator TURN) — potwierdzić przy zawieraniu umów podpowierzenia.
5. **Dane administratora-wspólnoty w klauzulach informacyjnych** — udostępnia sam
   administrator (nazwa, adres, kontakt, ewentualny IOD).
6. **Operator płatności** — gdy zostanie wdrożony, dodać do rejestru i polityki.
