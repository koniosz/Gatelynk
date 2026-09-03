# Akuvox Directory Sync v2 — analiza przebudowy integracji kontaktów (firmware 29.30.10.x)

Data: 2026-07-30 · Autor: Claude (na zlecenie właściciela) · Status: **Etapy 1 i 2 zaimplementowane**
(Etap 1 wdrożony na produkcję przez właściciela; Etap 2 za zgodą właściciela z 2026-07-30),
Etap 3 opisany (wymaga osobnej zgody + potwierdzenia endpointów API Akuvox).

Cel: GateLynk → **Akuvox Contact Sync Service** → adapter konkretnego firmware → import
użytkowników/kontaktów do Akuvox R29. GateLynk pozostaje systemem nadrzędnym (źródłem prawdy);
Akuvox jest lokalną, synchronizowaną kopią katalogu. Docelowy firmware: **29.30.10.465 LTS**
(model danych „Directory → User → Contact Details").

---

## 1. Obecny model kontaktów (stan repo, 2026-07-30)

### 1.1 Dane źródłowe w bazie

Hierarchia GateLynk: `Building → Stairwell → Unit → Resident` (pivot `unit_residents`
z `sinceDate`/`untilDate` — mieszkaniec „aktywny" = `untilDate IS NULL OR untilDate > NOW()`).

- `units` — `number` (bywa nie-SIP-owalne, np. „Niewinna 4/2"), `street`, `floor Int?`,
  `stairwellId?`, **`contactGroupId?`** (od 2026-07-30).
- `residents` — `firstName`, `lastName`, `email`, `phone?`, `intercomPin?` (PIN-y syncowane
  osobno do Edge — poza zakresem directory sync).
- `contact_groups` (migracja `20260730100000_add_contact_groups`) — `buildingId`, `name`,
  `sortOrder`; CRUD w `building-admin.service/controller`, strona
  `apps/web/src/app/(ba-v2)/building-admin/v2/buildings/[id]/contact-groups/page.tsx`.
  **Spec-owe `contactGroup` mapujemy NA TO** — nie tworzymy drugiego bytu grup.
- Urządzenia domofonowe: `building_intercoms` (BuildingIntercom — SIP/bridge config,
  `edgeDeviceId` → Edge mirror) i `stairwell_intercoms` (StairwellIntercom — driver + config).
  **Nie ma dziś rejestru „urządzenie Akuvox jako cel synchronizacji katalogu"** — integracja
  kontaktów jest per-budynek, nie per-urządzenie.

### 1.2 Kanał A (legacy): Remote Phonebook XML

`apps/api/src/resident/intercom-phonebook.controller.ts` —
`GET /api/intercom/phonebook?b=<buildingId>&t=<token>&host=<edge-ip>`:

- endpoint **publiczny**, token = HMAC(JWT_SECRET, `phonebook:<buildingId>`) — `tokenFor()`;
- 1 wpis `<Contact>` per lokal z ≥1 aktywnym mieszkańcem;
- `Name` = od 2026-07-30 z prefiksem grupy kontaktowej („Budynek 1 · Niewinna 4/2 — Kowalscy");
- `Office` = `<unit.id>@<host>` — **dialedExtension = unit.id** (routing punktowy; NIE unit.number);
- format płaski `<Directory><Contact/></Directory>` — Remote Phonebook Akuvoxa nie ma grup.

### 1.3 Kanał B (legacy, najbliższy „template-driven"): eksport UserData.tgz

`apps/api/src/resident/intercom-akuvox-export.service.ts` — `buildUserDataTgz(buildingId)`:

- ręcznie pisany tar (ustar) + gzip, **format odtworzony 1:1 z realnego eksportu E18C
  (2026-06-22)**: `userdata.xml` (`<UserData><Data …><Pin Code=""/></Data></UserData>`)
  + `DoorSchedule.xml` (Always/Never 1001/1002);
- atrybuty `<Data>`: `ID`, `UserID`, `Name`, `WebRelay`, `Floor`, `Phone` (=unit.id),
  `Group` (grupa kontaktowa > ulica > „Mieszkańcy"), `PriorityOfCall`, `DialAccount`,
  `Schedule-Relay="1001-1;"`, `Schedule-SRelay`;
- pobierany w 2 panelach: Integrator (`GET /api/integrator/buildings/:id/akuvox-userdata.tgz`)
  i BA (`building-admin.controller.ts`, ta sama usługa) — UI: `AkuvoxStationCard.tsx`.

**Ocena względem spec (pkt 7):** ten serwis JEST embrionem podejścia template-driven — format
został zdjęty z urządzenia, nie wymyślony. Różnica: template jest **zahardkodowany w kodzie**
(1 model, 1 firmware), a spec wymaga template'ów wgrywanych per (model, firmware) i parsera.
Decyzja: serwis **staje się bazą `AkuvoxLegacyContactsAdapter`** — jego statyczne helpery
(`buildUserDataXml`, `makeTar`) są reużyte przez adapter legacy i przez fabrykę fixture
w testach (syntetyczny UserData.tgz w formacie E18C). Sam serwis zostaje bez zmian zachowania,
oznaczony `@deprecated` (endpointy legacy działają dalej).

### 1.4 Routing dzwonienia (NIE ruszamy)

`dialedExtension = unit.id` → Edge → Cloud routuje do mieszkańców lokalu. Wszystko w
sip-proxy / JanusMediaBridge / intercom-call.* — **poza zakresem** tej przebudowy (twarda granica).

### 1.5 Urządzenia produkcyjne

- R29C @ 192.168.1.109, firmware **29.30.10.128** — wg spec „starsze", wymaga migracji do LTS.
- E18C @ 192.168.1.100 — źródło odtworzonego formatu UserData.tgz.
- **Zero żądań do fizycznych urządzeń w tej pracy** — capabilities detection czysto
  funkcyjne (model+firmware string), testowane na mockach.

## 2. Wszystkie miejsca zależne od Remote Phonebook URL

| # | Miejsce | Zależność |
|---|---------|-----------|
| 1 | `apps/api/src/resident/intercom-phonebook.controller.ts` | sam endpoint `GET /api/intercom/phonebook` + `tokenFor()` (HMAC) |
| 2 | `apps/api/src/resident/resident.module.ts:16,26` | rejestracja kontrolera |
| 3 | `apps/api/src/building-admin/building-admin.service.ts:32,1603-1604` | `GET /building-admin/buildings/:id/intercom-phonebook-info` — buduje `{ token: tokenFor(id), path: '/intercom/phonebook', edgeLanIp }` dla panelu BA |
| 4 | `apps/api/src/building-admin/building-admin.controller.ts:622` | routing endpointu z pkt 3 |
| 5 | `apps/web/src/app/(ba-v2)/building-admin/v2/buildings/[id]/contact-groups/page.tsx` (SyncSection, ~l.658-780) | wyświetla pełny URL phonebooka (z tokenem i `host=`) + przycisk kopiuj — instrukcja wklejenia w R29 (Phone → Remote Phonebook) |
| 6 | Konfiguracja na fizycznym R29C (poza repo) | URL wpisany w web UI urządzenia — **jedyny „konsument" produkcyjny**; przy migracji do Directory v2 URL zostaje aż do świadomego wyłączenia przez instalatora |
| 7 | `JWT_SECRET` (env) | zmiana sekretu unieważnia tokeny phonebooka na wszystkich urządzeniach |

Wniosek: zależności są wąskie (2 endpointy + 1 sekcja UI + konfiguracja urządzenia).
Nic z tego nie jest usuwane w Etapie 1 — tylko adnotacje `@deprecated` + odesłanie do v2.

## 3. Proponowane zmiany bazy danych

Zasada: **nowe tabele obok istniejących, zero zmian w istniejących tabelach.**
Spec-owe pojęcia mapujemy na istniejący schemat zamiast przebudowy:

| Pojęcie spec | Mapowanie GateLynk | Uzasadnienie |
|---|---|---|
| `Property` | ≈ `Building` (`propertyId` = `String(buildingId)`) | Nie ma encji Property; „portfel budynków" to relacja Admin→Buildings — wystarczająca. Pole w modelu domenowym zostaje (interfejs spec), wypełniane buildingId. |
| `floor` | `Unit.floor Int?` już istnieje | Opcjonalne pole, bez migracji. |
| `staircase` | `Stairwell.name` | już istnieje |
| `buildingNumber` | `Unit.street` + konfig szablonu | osiedla domków mają adres w Unit |
| `contactGroup` | `ContactGroup` (2026-07-30) | JEDEN byt grup — twardy wymóg właściciela |
| `DirectoryPerson` | **projekcja runtime** z `residents` + `unit_residents` + `units` (NIE tabela) | GateLynk jest źródłem prawdy — materializacja tabeli = drugie źródło + syncowanie samego siebie. Checksum + snapshot wystarczą do idempotencji. |
| `AccessIdentity / AccessCredential / AccessPermission / Vehicle / IntercomCallTarget` (pkt 3) | istnieją częściowo: `Vehicle`, `Resident.intercomPin`, `guests.pin`, `guest_access_restrictions` | **Nie tworzymy nowych encji** — rozdział „mieszkaniec vs kontrola dostępu" jest już de facto w schemacie (PIN-y, pojazdy, goście osobno). Dla directory sync potrzebny jest tylko kanał kontaktowy; `IntercomCallTarget` = derywowany CallTarget (unit.id). Nowe encje dopiero gdy pojawi się realny wymóg (np. wiele numerów SIP per osoba — Etap 2+). |

### 3.1 Nowe tabele (migracja `20260730120000_add_akuvox_directory_v2`, SQL ręczny)

**`akuvox_devices`** — rejestr urządzeń Akuvox jako celów synchronizacji katalogu
(świadomie OSOBNY od `building_intercoms` — tamto jest configiem SIP/bridge; tu jest
konfiguracja integracji katalogu; opcjonalny link przez `intercomId`):

- `id SERIAL PK`, `buildingId INT FK→buildings ON DELETE CASCADE`
- `intercomId INT? FK→building_intercoms ON DELETE SET NULL` (link do istniejącego rekordu SIP)
- `name TEXT` (np. „Brama główna R29"), `model TEXT?` (np. „R29C"), `ipAddress TEXT?`, `macAddress TEXT?`
- `firmwareVersion TEXT?`, `hardwareVersion TEXT?`
- `syncMode TEXT DEFAULT 'MANUAL_EXPORT'` (MANUAL_EXPORT | MANUAL_IMPORT | PROVISIONING | DEVICE_API)
- `contactAuthority TEXT DEFAULT 'GATELYNK'` (GATELYNK | SMARTPLUS | MERGED | MANUAL)
- `adapter TEXT DEFAULT 'directory-user'` (`legacy-contacts` | `directory-user`)
- `mapping JSONB DEFAULT '{}'` — `AkuvoxDirectoryMapping` (pkt 12)
- `capabilitiesOverride JSONB?` — ręczne nadpisania wykrytych capabilities
- `credentialUser TEXT?`, `credentialEnc TEXT?` — poświadczenia web UI urządzenia,
  hasło **AES-256-GCM** kluczem z env `AKUVOX_CRED_KEY` (pkt 18; NIE ruszamy istniejących
  plain-text sekretów w `building_intercoms`/`stairwell_intercoms` — Faza 7.7 odroczona)
- `lastDeviceSnapshot JSONB?` — sparsowany ostatni eksport wgrany z urządzenia (baza diffów)
- `lastSyncAt TIMESTAMP?`, `lastSyncChecksum TEXT?`
- `enabled BOOLEAN DEFAULT true`, `createdAt`, `updatedAt`

**`akuvox_import_templates`** — template'y formatu importu per (model, firmware, format):

- `id SERIAL PK`, `buildingId INT FK` (template wgrywany w kontekście budynku, ale
  wyszukiwany po model+firmware — reużywalny między urządzeniami tego samego budynku)
- `model TEXT`, `firmwareVersion TEXT`, `format TEXT` (`tgz` | `xml` | `csv`)
- `originalFilename TEXT`, `rawFile BYTEA` (oryginał — audyt + re-parse po ulepszeniu parsera)
- `parsedSpec JSONB` — wynik parsera: lista/kolejność atrybutów, pliki w archiwum,
  separator/kodowanie CSV, wartości stałe, przykładowy rekord
- `uploadedBy TEXT?`, `createdAt`
- `UNIQUE (model, firmwareVersion, format)` — jeden template per kombinacja
  (świeży upload nadpisuje przez upsert)

**`akuvox_sync_runs`** — historia operacji (widok F + audyt, pkt 18):

- `id SERIAL PK`, `deviceId INT FK→akuvox_devices ON DELETE CASCADE`
- `kind TEXT` (`PREVIEW` | `EXPORT` | `APPLY` | `TEMPLATE_UPLOAD` | `DEVICE_EXPORT_UPLOAD`)
- `status TEXT` (`OK` | `WARNING` | `ERROR`)
- `operator TEXT?` (login/id integratora), `summary JSONB?` ({create,update,disable,delete,unchanged,conflicts}),
  `warnings JSONB?`, `errors JSONB?`, `directoryChecksum TEXT?`, `fileName TEXT?`, `createdAt`
- indeks `(deviceId, createdAt DESC)`

### 3.2 Dlaczego snapshot w JSONB, a nie tabela `akuvox_directory_entries`

Idempotencję (pkt 10) realizują: stabilne `externalId` (`gl-u<unitId>` / `gl-p<residentId>`),
checksum rekordu (SHA256 znormalizowanych pól), checksum katalogu i snapshot ostatniego stanu
urządzenia. Katalog jednego urządzenia to setki, nie miliony wpisów — JSONB per device jest
prostszy, atomowy i wystarczający. Tabela per-wpis miałaby sens dopiero przy DEVICE_API
z częściowymi aktualizacjami (Etap 3).

## 4. Plan migracji

### 4.1 Migracja bazy (Etap 1 — wykonana)

1. SQL pisany **ręcznie** (nie `prisma migrate dev` — lokalna baza ma zastany drift;
   autogenerowany diff jest destrukcyjny, m.in. `DROP COLUMN lpr_reads.vehicleBrand`;
   precedens: `20260730100000_add_contact_groups`).
2. Modele dopisane do `schema.prisma` (AkuvoxDevice, AkuvoxImportTemplate, AkuvoxSyncRun).
3. `npx prisma migrate deploy` lokalnie (baza = bezpieczna kopia produkcji) + `npx prisma generate`.
4. Migracja czysto addytywna → rollback = DROP 3 tabel, bez wpływu na resztę.

### 4.2 Migracja legacy → v2 (pkt 20 spec) — **projekt; implementacja = Etap 2**

`LegacyRemotePhonebookConfig` nie istnieje jako tabela — legacy config to: (a) URL phonebooka
wklejony w urządzenie, (b) grupy kontaktowe, (c) konwencje nazw z kodu. Migracja per urządzenie:

1. Integrator rejestruje urządzenie w Directory Sync (model, firmware, IP, MAC).
2. Kreator „Przejmij z Remote Phonebook": tworzy `AkuvoxDirectoryMapping` odtwarzające
   DZISIEJSZE zachowanie 1:1 → `displayMode='unit'`, `groupBy='none'` (grupa z ContactGroup),
   `displayNameTemplate='{{unitNumber}} — {{lastNames}}'`, `roomNumberTemplate='{{unitId}}'`,
   `hideLastName=false`, `anonymizeDirectory=false`. Kolejność sortowania jak dziś
   (sortOrder grupy → nazwa grupy → numer lokalu).
3. Podgląd porównawczy: wpisy legacy XML vs wpisy v2 — muszą być identyczne co do nazwy,
   numeru wybierania (unit.id), grupy i kolejności. Raport migracji zapisany w `akuvox_sync_runs`.
4. Aktywacja v2 (import pliku na urządzeniu) — **stara konfiguracja NIE jest usuwana**:
   phonebook URL działa dalej; rollback = ponowne włączenie Remote Phonebook na urządzeniu.
5. Deprecation legacy dopiero po potwierdzonym okresie równoległym (decyzja właściciela).

**Dwie znane różnice parytetu z Etapu 1 — ROZSTRZYGNIĘTE w Etapie 2 (2026-07-30):**
- Fallback grup: decyzja właściciela `ContactGroup → ulica → „Pozostali"`, zaimplementowana
  przez właściciela w `toDirectoryPersons` (projekcja domenowa). Kreator migracji raportuje
  różnicę legacy „Mieszkańcy"→„Pozostali" jako OCZEKIWANĄ.
- Fałszywe „update" przy pierwszym porównaniu: rozwiązane checksumem świadomym formatu
  (`comparableFieldsFromSpec` — diff porównuje tylko pola przenoszone przez template).

Uzasadnienie przesunięcia do Etapu 2: mechanizm wymaga widoku D (pełne różnice) i realnego
template'a 29.30.10.465 z urządzenia — obu rzeczy z definicji nie ma w Etapie 1.

## 5. Lista plików

### 5.1 Nowe — API (`apps/api/src/akuvox-directory/`)

| Plik | Rola |
|---|---|
| `akuvox-directory.module.ts` | moduł NestJS (import w `app.module.ts`) |
| `akuvox-directory.controller.ts` | routing `/api/integrations/akuvox/**` (guard Integrator JWT + flaga `AKUVOX_DIRECTORY_V2`) |
| `akuvox-directory.service.ts` | orkiestracja: urządzenia, template'y, preview/eksport/apply, historia |
| `akuvox-directory-config.service.ts` | feature flags z env (pkt 21) — defaulty ze spec, ConfigService |
| `akuvox-crypto.service.ts` | AES-256-GCM (`AKUVOX_CRED_KEY`) dla poświadczeń urządzeń |
| `domain/directory.types.ts` | kanoniczny model (pkt 2, 4, 5, 6, 9, 12, 16) — wszystkie interfejsy |
| `domain/directory-projection.service.ts` | Contact Domain → Contact Projection: DB → DirectoryPerson[] → AkuvoxDirectoryUser[] (szablony `{{…}}`, prywatność pkt 13, walidacja pkt 15, checksumy pkt 10) |
| `domain/directory-diff.service.ts` | sync różnicowy (pkt 9) + reguły SmartPlus/managedBy (pkt 11) |
| `adapters/akuvox-adapter.types.ts` | interfejs `AkuvoxAdapter` + typy wyników |
| `adapters/akuvox-capabilities.ts` | `detectCapabilitiesFromInfo(model, firmware)` — czysta funkcja, bez sieci |
| `adapters/akuvox-legacy-contacts.adapter.ts` | starsze firmware — generuje UserData.tgz w formacie E18C (reużywa statyki `IntercomAkuvoxExportService`) |
| `adapters/akuvox-directory-user.adapter.ts` | nowe firmware — **template-driven**; bez template'a (model, firmware) ODMAWIA generacji |
| `template/akuvox-template.parser.ts` | parser wgranego eksportu (tgz/xml/csv) → `TemplateSpec`; gunzip + tar reader + analiza atrybutów/kolumn |
| `*.spec.ts` (5 plików) | testy jednostkowe pkt 19 (bez bazy) |

### 5.2 Nowe — Web

- `apps/web/src/app/(integrator-dashboard)/integrator/buildings/[id]/akuvox-directory/page.tsx`
  — sekcja „Integracje → Akuvox → Directory Sync"; zakładki A/B/C/E (+ D/F placeholder).

### 5.3 Nowe — docs

- `docs/akuvox-directory-v2-analysis.md` (ten dokument)
- `docs/akuvox-directory-v2-installer.md` (procedura 12-krokowa, pkt 22)

### 5.4 Modyfikowane (minimalnie)

- `apps/api/prisma/schema.prisma` — 3 nowe modele + back-relations (Building, BuildingIntercom)
- `apps/api/prisma/migrations/20260730120000_add_akuvox_directory_v2/migration.sql`
- `apps/api/src/app.module.ts` — rejestracja `AkuvoxDirectoryModule` + env schema (AKUVOX_*)
- `apps/api/src/resident/intercom-phonebook.controller.ts` — nagłówek `@deprecated` (bez zmiany zachowania)
- `apps/api/src/resident/intercom-akuvox-export.service.ts` — nagłówek `@deprecated` + notka o reużyciu statyk (bez zmiany zachowania)
- `apps/web/src/app/(integrator-dashboard)/integrator/buildings/[id]/devices/page.tsx` — link do nowej sekcji

### 5.5 NIE dotykane (twarde granice)

`apps/edge/**`, `apps/ios/**`, routing połączeń (`intercom-call.*`, sip-proxy, JanusMediaBridge),
istniejące sekrety urządzeń, endpointy legacy (phonebook XML, akuvox-userdata.tgz).

## 6. Gdzie żyje panel „Integracje → Akuvox → Directory Sync" — decyzja

**Rekomendacja i decyzja: panel Integratora** (`/integrator/buildings/[id]/akuvox-directory`).

Uzasadnienie:
1. To warstwa **techniczna urządzeń** (firmware, template'y, checksumy, tryby sync, poświadczenia
   web UI urządzenia) — dokładnie profil panelu Integratora; panel BA jest projektowany dla
   starszych administratorów (duże fonty, proste operacje — patrz ba-v2).
2. RBAC ze spec (pkt 18): „tylko admin/instalator" — w GateLynk instalator = Integrator
   (`jwt` / `IntegratorJwtAuthGuard`). BA dostaje co najwyżej read-only podgląd w Etapie 2+.
3. Precedens: cały wiring techniczny (AP binding, LPR linkage, AI engine, kamery) został już
   w 2026-06-02 przeniesiony z BA do Integratora.
4. BA zachowuje swoje istniejące narzędzia: grupy kontaktowe (treść katalogu) zostają w BA —
   podział „BA zarządza LUDŹMI i grupami, Integrator zarządza URZĄDZENIAMI i formatem".

## 7. Kluczowe decyzje projektowe (konflikty spec ↔ stan repo)

1. **`propertyId`** — w interfejsach spec zostaje, wypełniany `String(buildingId)`
   (brak encji Property; portfel = Admin→Buildings). Zero przebudowy schematu.
2. **`DirectoryPerson` jako projekcja, nie tabela** — patrz §3.2. `sourceUpdatedAt` =
   max(`createdAt` powiązanych rekordów) — schemat nie ma `updatedAt` na residents/units;
   dokładniejszy tracking to kandydat na Etap 2 (kolumny updatedAt lub triggery).
3. **CallTarget dzisiaj = 1 target** typu `extension` o wartości `unit.id` (routing punktowy —
   NIE ruszamy). Model wspiera 1–3 targety/priorytety/dialAccount od razu (interfejs pełny,
   dane z czasem); testy pokrywają multi-target.
4. **Pkt 3 (rozdział encji)** — realizowany „logicznie": directory sync czyta wyłącznie kanał
   kontaktowy; PIN-y/pojazdy/goście mają już osobne modele i osobne kanały sync. Nowych encji
   nie tworzymy (nadmiarowe dla MVP) — patrz tabela w §3.
5. **`contactGroup`** = `ContactGroup` (BA). `groupBy` w mappingu pozwala alternatywnie grupować
   po building/staircase/floor — wtedy `groupName` pochodzi z tych pól, a ContactGroup jest
   defaultem (`groupBy='none'`).
6. **Capabilities (pkt 6)**: `detectCapabilities()` w Etapie 1 NIE dotyka sieci — czysta funkcja
   z (model, firmwareVersion) + `capabilitiesOverride` z bazy. `supportsHttpApi` nie implikuje
   zarządzania kontaktami — osobna flaga `supportsDirectoryWriteApi`, **domyślnie false wszędzie**
   (żaden endpoint API Akuvox nie jest potwierdzony oficjalną dokumentacją/testem). Wersje:
   `29.30.10.128` → starsze (legacy phonebook + tgz), `29.30.10.465+` → Directory User model
   (flagi ustawiane zachowawczo; realny template z urządzenia weryfikuje formaty).
7. **Generator bez template'a ODMAWIA** (pkt 7 — „nie twórz CSV na oko"). Wyjątek świadomy:
   format **E18C UserData.tgz jest potwierdzony sprzętowo** (odtworzony 1:1 w repo) — adapter
   legacy ma go jako wbudowany template `builtin:e18c-userdata-tgz`. Adapter `directory-user`
   dla 29.30.10.465 wymaga wgranego template'a — pierwszy realny template musi wgrać
   **instalator z urządzenia** (patrz dokumentacja instalatora).
8. **`apply` w MVP** = potwierdzenie ręcznego importu (zapis w historii + snapshot), NIE żądanie
   do urządzenia. `syncMode=DEVICE_API` zablokowany flagą `AKUVOX_DIRECTORY_WRITE_API=false`.
9. **Feature flags** (pkt 21) — env przez ConfigService (`AKUVOX_DIRECTORY_V2=true`,
   `AKUVOX_MANUAL_IMPORT=true`, `AKUVOX_PROVISIONING_SYNC=false`,
   `AKUVOX_DIRECTORY_WRITE_API=false`). Celowo NIE w `Building.featurePermissions`
   (to matrix uprawnień ról per budynek, nie przełączniki platformowe).
10. **Szyfrowanie poświadczeń** — tylko NOWE poświadczenia (akuvox_devices) AES-256-GCM
    z `AKUVOX_CRED_KEY` (32 bajty hex/base64). Brak klucza → zapis poświadczeń odrzucany
    z czytelnym błędem (nigdy plain-text fallback). Hasła nie wracają do frontendu
    (tylko `credentialIsSet: true/false`) i nie są logowane. Istniejące plain-text sekrety
    innych tabel — bez zmian (Faza 7.7).
11. **Matching rekordów przy diffie**: primary key = `externalId` gdy format go przenosi;
    format E18C/UserData nie ma pola externalId → fallback matching po `Phone` (= unit.id,
    stabilny) + heurystyka nazwy. Rekordy bez dopasowania i bez `gl-` pochodzenia →
    `managedBy: 'local'|'unknown'` → **domyślnie zachowywane, nigdy nie usuwane automatycznie**.

## 8. Ryzyka

| Ryzyko | Waga | Mitygacja |
|---|---|---|
| Format importu 29.30.10.465 odgadnięty źle | wysoka | generator template-driven ODMAWIA bez realnego template'a; syntetyczny template tylko w testach |
| Import na urządzeniu nadpisuje/kasuje lokalne kontakty (SmartPlus/manual) | wysoka | tryb MERGED: obce rekordy do pliku bez zmian; diff nigdy nie usuwa `managedBy≠gatelynk`; przed pierwszym importem obowiązkowy upload eksportu z urządzenia (widok E) |
| Diff bez `externalId` w formacie pliku → błędne dopasowania | średnia | matching po Phone=unit.id (stabilny int); konflikty raportowane, nie auto-rozstrzygane |
| `AKUVOX_CRED_KEY` zgubiony → poświadczenia nieodczytywalne | średnia | poświadczenia są wygodą (link do web UI), nie krytyczne; UI pokazuje „ustawione/nie" i pozwala nadpisać |
| Drift Prisma przy migracji | średnia | SQL ręczny + `migrate deploy` (wzorzec 20260730100000); migracja czysto addytywna |
| Regres w legacy phonebook/tgz | niska | zero zmian zachowania; tylko komentarze `@deprecated`; testy nie dotykają tych ścieżek |
| Pomylenie paneli (BA vs Integrator) przy grupach | niska | grupy zostają w BA; Directory Sync w Integratorze czyta je read-only |
| Duplikaty plików iCloud psują build | pewne 😉 | standardowy cleanup `find … -name "* 2.*" -delete` przed tsc/build (CLAUDE.md #12) |
| Równoległa synchronizacja (pkt 18) | niska (MVP ręczny) | blokada in-memory per deviceId w service (mutex); przy multi-instancji Cloud → advisory lock w Etapie 2 |

## 9. Plan wdrożenia etapami

### Etap 1 — fundament + MVP ręczny (TEN etap — zaimplementowany)

- Modele domenowe (pkt 2, 4, 5, 6, 9, 12), projekcja + szablony + prywatność (pkt 12–13),
  walidacja (pkt 15), checksumy/idempotencja (pkt 10), diff engine + SmartPlus (pkt 9, 11).
- Migracja DB (3 tabele), rejestr urządzeń, szyfrowanie poświadczeń (pkt 18 częściowo).
- Adaptery: `AkuvoxLegacyContactsAdapter` (E18C tgz, builtin template) i
  `AkuvoxDirectoryUserAdapter` (template-driven, odmawia bez template'a).
- Template upload + parser (tgz/xml/csv) (pkt 7).
- Endpointy (pkt 16–17): capabilities, directory, template, sync/preview (dry-run),
  sync/export, sync/apply (potwierdzenie ręczne), sync/history, sync/:syncId.
- Feature flags (pkt 21). Panel Integratora: widoki A/B/C + E-częściowo; D/F placeholdery (pkt 14).
- Testy jednostkowe + integracyjne na fixture (pkt 19). Dokument instalatora (pkt 22).
- Legacy oznaczone `@deprecated`, działa bez zmian.

### Etap 2 — migracja legacy, pełny diff, provisioning ✅ ZAIMPLEMENTOWANE (2026-07-30, za zgodą właściciela)

Decyzje właściciela przed Etapem 2: fallback grup `ContactGroup → ulica → „Pozostali"`
(zaimplementowany przez właściciela w projekcji domenowej), `AKUVOX_CRED_KEY` ustawiony
(Fly + lokalnie), checksum świadomy formatu zaakceptowany, realny template 465 wgra instalator później.

- ✅ **Kreator migracji legacy→v2** (pkt 20): `domain/legacy-migration.ts` (czysta logika —
  odtworzenie wpisów legacy tgz/phonebook z tych samych wierszy źródłowych + porównanie
  z projekcją v2 pod mapowaniem parytetowym `LEGACY_PARITY_MAPPING`) + endpointy
  `POST devices/:id/migration/preview` i `.../migration/adopt` + karta w widoku A.
  Raport per lokal (nazwa/numer/grupa/kolejność) z klasyfikacją różnic OCZEKIWANYCH
  (fallback „Mieszkańcy"→„Pozostali", kolejność nazwisk — porównywany zbiór, prefiks grupy
  phonebooka zbędny przy grupach natywnych) vs WYMAGAJĄCYCH UWAGI (m.in. twardy strażnik:
  różny numer wybierania blokuje adopt w UI). Adopt zapisuje mapowanie parytetowe + raport
  do `akuvox_sync_runs` (kind=MIGRATION); starej konfiguracji NIE usuwa — rollback możliwy.
- ✅ **Widoki D i F** (pkt 14): D = pełny diff z drill-down per pole (before/after),
  konflikty z `managedBy`, licznik zachowanych obcych rekordów; F = pełna historia
  (data, operator, operacja, wynik, liczba zmian, checksum, plik, błędy/ostrzeżenia,
  filtr po typie operacji).
- ✅ **Checksum świadomy formatu**: `comparableFieldsFromSpec(TemplateSpec)` → diff porównuje
  wyłącznie pola przenoszone przez template (E18C: name/group/phones/dialAccount, BEZ
  roomNumber) — pierwsze porównanie z eksportem urządzenia nie daje fałszywych „update".
  Przejście na `enabled=false` wykrywane przed checksumem (flaga nieprzenoszona przez formaty).
- ✅ **Cykl E2E z ochroną SmartPlus**: testy pełnego cyklu generator→parser→diff w MERGED
  (obce rekordy nietknięte, konflikty raportowane, zero automatycznych usunięć).
- ✅ **PROVISIONING za flagą** (`AKUVOX_PROVISIONING_SYNC=false`, default OFF): publiczny
  endpoint `GET /api/integrations/akuvox/provisioning/:deviceId/directory?t=<token HMAC>`
  (wzorzec legacy `tokenFor()`; przy wyłączonej fladze 404) + `GET devices/:id/provisioning-info`
  dla integratora + karta w widoku A. **UWAGA: oficjalna dokumentacja Akuvox NIE potwierdza
  dystrybucji katalogu użytkowników przez autoprovisioning dla R29 na 29.30.10.x** — mechanizm
  jest przygotowany wyłącznie po stronie GateLynk (urządzenie samo pobiera plik), flaga
  pozostaje wyłączona do czasu potwierdzenia dokumentacją lub testem instalatora na sprzęcie.

Przesunięte z pierwotnego zakresu Etapu 2 → Etap 2.5/3: realny template z R29 na 29.30.10.465
(czeka na instalatora), read-only podgląd w panelu BA, tracking `sourceUpdatedAt`,
advisory lock odporny na multi-instancję (dziś lock in-memory per proces).

### Etap 3 — DEVICE_API (WYMAGA ZGODY WŁAŚCICIELA + potwierdzenia endpointów)

- WYŁĄCZNIE po potwierdzeniu oficjalnych endpointów API Akuvox (dokumentacja producenta
  lub test na urządzeniu) — `supportsDirectoryWriteApi=true` per (model, firmware).
- `applyDirectory()` przez HTTP API urządzenia: timeouty, retry z exponential backoff,
  weryfikacja po zapisie (`verifyDirectory()`), pełny audyt.
- Ewentualna tabela `akuvox_directory_entries` (stan per-wpis) dla częściowych aktualizacji.
- Automatyczny trigger sync po zmianie mieszkańców (debounce) — nadal z dry-run gate.

## 10. Testowanie (pkt 19 — mapowanie na pliki)

Jednostkowe (`apps/api/src/akuvox-directory/**/*.spec.ts`, bez bazy — dane wejściowe jako
struktury in-memory):

- projekcja: mieszkaniec→user, priorytety 1/2/3→Primary/Secondary/Tertiary, grupy, normalizacja
  numeru lokalu, ukryty kontakt, usunięty mieszkaniec (deletedAt), kilku mieszkańców w lokalu,
  SIP i IP, polskie znaki, puste pola, bardzo długie nazwy, szablony `{{…}}`, anonimizacja;
- idempotencja/checksum: stabilność, niezależność od kolejności targetów, zmiana pola → zmiana checksumu;
- diff: create/update/disable/delete/unchanged/conflicts, konflikt SmartPlus, ochrona obcych rekordów;
- parser template: realny format E18C (fixture generowany statykami legacy serwisu),
  syntetyczny template 29.30.10.465 (do czasu realnego), CSV z separatorem/kodowaniem,
  uszkodzony plik, nieobsługiwany firmware;
- adapter: odmowa generacji bez template'a; generacja zgodna z template (kolejność atrybutów);
- crypto: roundtrip, zły klucz, brak klucza;
- capabilities: 29.30.10.128 vs 29.30.10.465 vs nieznany.

Ręczny test na R29C — patrz `docs/akuvox-directory-v2-installer.md` + raport końcowy
(bez żądań automatycznych do 192.168.1.109; wszystko przez człowieka).
