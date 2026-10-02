# GateLynk — projekt

Platforma zarządzania nieruchomościami: kontrola dostępu, mieszkańcy, paczki, zgłoszenia, rezerwacje.

## Struktura monorepo (pnpm workspaces)

```
apps/
  api/        NestJS — Cloud API (port 3000)
  web/        Next.js — panel webowy (port 3002)
  ios/        iOS Swift/SwiftUI — aplikacja mobilna
  edge/       Node.js — Edge app na Mac Mini (port 4000, lokalny LAN)
```

## Uruchamianie

```bash
# API (po każdej zmianie)
cd apps/api
npm run build
node dist/src/main    # NIE: dist/main — pliki są w dist/src/

# Web
cd apps/web
npm run dev           # port 3002

# Edge (na Mac Mini)
# zarządzany osobno, dostęp przez SSH
# IP (Tailscale): 100.90.244.90
# IP (LAN):       192.168.1.127
# User SSH:       shc_development     ← NIE konradsz
# Przykład:       ssh shc_development@100.90.244.90
```

## Baza danych

- PostgreSQL: `postgresql://konradsz@localhost:5432/gatelynk`
- psql: `/opt/homebrew/Cellar/postgresql@16/16.13/bin/psql`
- Prisma migrations: `cd apps/api && npx prisma migrate dev --name <nazwa>`

### Prisma — 5.22 unified (✅ Faza 7.1, 2026-05-08)

Wcześniej w monorepo był konflikt wersji 5.22 (root + Client) vs 7.5
(`@prisma/adapter-pg`), przez który `prisma generate` failował z „Cannot
convert undefined or null to object", a kod musiał używać raw SQL dla nowych
pól. **Naprawione przez usunięcie `@prisma/adapter-pg` z dependencies** —
production API i seed-y używają standardowego `PrismaClient` bez adapter-a
(Rust query engine + `DATABASE_URL` z env). Connection pooling przyjdzie
z PgBouncer / Prisma Accelerate na produkcji.

Po naprawie:
- `prisma generate` przechodzi czysto, typed Prisma Client zna wszystkie
  modele wraz z nowymi polami (Faza 4 `Ticket.type`, `TicketReply.authorId`).
- `tsc --noEmit` clean dla całego API + seed-y.
- Dockerfile workaround `rm -rf @prisma/client` z poprzednich wersji
  usunięty (lockfile nie ściąga już duplikatu 7.x).

**Stan raw SQL (~143 wystąpień):** te które już są — zostają. Działają OK
i są pokryte schematem. Nowy kod od dziś **może i powinien** używać typed
Prisma Client. Refactor istniejących raw SQL → typed Client to osobny task
(estymowany w Fazie 7.4 e2e testach — tam i tak musimy wszystko ruszać).

## Architektura

### Przepływ Edge ↔ Cloud
- Edge (Mac Mini LAN) łączy się z Cloud API przez WebSocket (`/edge` endpoint)
- `EdgeGateway` trzyma live połączenia; `EdgeService.syncAccessPoints()` synchronizuje przekaźniki
- Sync uruchamiany: co 5 min (`@Interval(300_000)`) + przy każdym `GET /resident/access-points`
- Fallback: jeśli Edge nie jest połączony przez WS, używamy `edge.ipAddress` z bazy

### Role użytkowników
| Rola | Endpoint prefix | JWT type |
|------|----------------|----------|
| Mieszkaniec | `/resident/*` | `jwt-resident` |
| Portier | `/concierge/*` | `jwt-concierge` |
| Admin budynku | `/building-admin/*` | `jwt-building-admin` |
| Integrator | `/buildings/*` | `jwt` |

### Wielobudynkowy login
Jeden email może mieć konta w wielu budynkach. Login zwraca `requiresBuildingSelection: true` → klient pokazuje picker → `POST /resident/auth/select-building`.

## iOS (SwiftUI)

- **Wzorzec:** `@Observable` + `@Environment` (nie `@StateObject`/`@ObservedObject`)
- **Ustawienia trwałe:** `@AppStorage` (UserDefaults) — klucze: `appTheme`, `homeShowAccessPoints`, `homeShowQuickActions`, `homeShowActivity`
- **Motyw:** `appTheme = "dark" | "light"` — ustawiany w `ResidentTabView.preferredColorScheme`
- **AuthManager:** `role: UserRole?` — enum `.resident(ResidentUser)` / `.concierge` / `.buildingAdmin`
- **Zdjęcia base64:** DB przechowuje `data:image/jpeg;base64,...` — iOS dekoduje przez `HomeView.decodeBase64Image()` (stripuje prefix)
- **Rebuild po zmianach:** `⇧⌘K` (Clean) → `⌘R` (Run) w Xcode

### Pliki iOS kluczowe
```
Views/Resident/HomeView.swift       — ekran główny (glassmorphism, motyw)
Views/Resident/ProfileView.swift    — SettingsView (ustawienia + motyw toggle)
Views/MainTabView.swift             — ResidentTabView, schemat kolorów
Auth/AuthManager.swift              — login, logout, updateAvatar
Models/Models.swift                 — wszystkie modele Decodable
```

### Drugi target: GateLynkGlass ("GateLynk β", 2026-06-10 → PRODUKCJA 2026-07-07)

Apka resident-only w designie **Glass Depth Premium**
(`docs/design/glass-depth-2026-06-10/handoff_glass_depth/`). Decyzja
właściciela 2026-07-07: **osobna apka produkcyjna w App Store** (bundle
`com.gatelynk.app.glass`) obok głównej — NIE tylko porównanie UX.

- Źródła: `apps/ios/GateLynkGlass/` (GlassApp + Theme/ + Views/ + Views/Sheets/),
  własny Info.plist (`CFBundleDisplayName=GateLynk` — docelowa nazwa App Store
  od 2026-07-16, wcześniej „GateLynk β”; mic + photo-add usage,
  `UIBackgroundModes=voip,audio`) i Assets.xcassets (AppIcon = ta sama ikona
  co główna, `BuildingPhoto` = zdjęcie hero z handoffu).
- Współdzielone z targetem GateLynk (te same FileReference, drugi PBXBuildFile):
  `APIClient`, `KeychainHelper`, `Models`, `AuthManager`, `EdgeAssistantClient`,
  `AppDelegate` + od 2026-07-07 także `VoIPManager`, `CallManager`,
  `IntercomCallView` (rozmowy domofonowe). UI w 100% osobne — prefiks `Glass*`.
- **WebRTC**: target Glass linkuje pakiet SPM `stasel/WebRTC` (drugi
  XCSwiftPackageProductDependency `AA…DD10` + BuildFile `FF18` w Frameworks).
  `canImport(WebRTC)` jest więc prawdziwe w OBU targetach — `AppDelegate.setupVoIP`
  działa też w β. Gamma (γ) dalej bez WebRTC/VoIP.
- **Push WŁĄCZONY w β** (2026-07-07): `GateLynkGlass/GateLynkGlass.entitlements`
  z `aps-environment=development`, `CODE_SIGN_ENTITLEMENTS` w obu configach.
  Wymaga App ID `com.gatelynk.app.glass` z Push Notifications w Apple Developer
  portal (klucz APNs .p8 jest per-team — ten sam co główna apka).
- **UUID w pbxproj:** target Glass używa serii `AA000000000000000000DD<XX>`
  (infra: target/fazy/grupy/configi/SPM, ostatni zajęty `DD10`), `EE<XX>`
  (FileReference, ostatni zajęty `EE17`) i `FF<XX>` (BuildFile, zajęte
  `FF01–FF18` + `FF20–FF25` shared). Stare serie `BB/CC` należą do targetu
  GateLynk — nowy plik w Glass target to `EE18`/`FF19` (potem `FF26`)+,
  nowy w starym targecie dalej `BB24`/`CC24`+.
- Atrapy z prototypu HTML (panel zamka Tedee, „Zapłać BLIK", kod skrytki
  paczkomatu, Dynamic Island geofencing, dodawanie pojazdu) — widoczne jako
  **zapowiedzi z plakietką WKRÓTCE** (decyzja właściciela); jeden reużywalny
  komponent `GlassComingSoon.swift` (enum `GlassUpcomingFeature` + sheet).
- Wymogi App Store w β: link do polityki prywatności
  (`https://gatelynk.pl/polityka-prywatnosci`) i **usuwanie konta**
  (`DELETE /api/resident/me` — anonimizacja, patrz `ResidentService.deleteMyAccount`)
  w sheecie „Więcej".

## Panel webowy (Next.js)

- **Admin (Integrator):** `/dashboard/buildings/[id]/page.tsx`
- **Admin budynku:** `/building-admin/buildings/[id]/page.tsx`
- **Portier:** `/concierge/building/*`
- Autentykacja przez `buildingAdminApi` / `api` axios instances z tokenem w localStorage

## Konwencje kodu

- TypeScript strict — brak `any` gdzie można uniknąć (wyjątek: response z Prisma raw)
- NestJS serwisy: logika biznesowa tylko w `*.service.ts`, kontrolery tylko routing
- SwiftUI: małe `private var` properties zamiast dużych inline bloków
- Nazwy polskie w UI (labels, placeholders), kod angielski
- Migracje: zawsze `--name` opisowy po polsku lub angielsku (`add_resident_avatar`, `add_vehicle_model`)

## Częste pułapki

1. **Build output:** `nest build` produkuje `dist/main.js` (flat). Wcześniej
   było `dist/src/main` przez stary tsconfig — po naprawie Fazy 7.1 (Prisma
   drift, reinstall pnpm) struktura `dist/` jest płaska. `start:prod` i
   `entrypoint-api.sh` używają `node dist/main`.
2. **Prisma generate fail** → użyj raw SQL (patrz sekcja wyżej)
3. **Avatar nie pokazuje się po uploadzie** → `AuthManager.updateAvatar()` musi być wywołane po PATCH, żeby odświeżyć `role` in-memory
4. **Edge sync nie działa** → sprawdź czy `edgeDevice.isActivated = true` i czy IP jest aktualne w bazie
5. **Nowy plik Swift w Xcode** → musi być dodany ręcznie przez File → Add Files (nie wystarczy stworzyć w VS Code)
6. **„Edit or create" modal pułapka** — modale typu LPR „Identyfikuj/Zmień klasyfikację"
   muszą rozróżniać POST od PATCH na podstawie czy obiekt już istnieje
   (`read.vehicleId` w LprViewer). Inaczej edycja literówki w nazwie marki
   stworzy drugi wpis pojazdu z tą samą tablicą zamiast aktualizacji
   istniejącego. Defense-in-depth na 3 warstwach: UI (PATCH gdy id), backend
   (`createVehicle` z duplicate-guard po `(buildingId, licensePlate)`),
   ewentualnie DB (unique partial index — wymaga uprzednio cleanup-u istniejących
   duplikatów). Patrz `LprViewer.handleSave` + `BuildingAdminService.createVehicle`
   + `ConciergeService.createVehicle`.
7. **Hikvision `<vehicleLogoRecog>` = marka fabryczna, NIE operator kuriera.**
   `apps/edge/src/devices/cameras/hikvision-vehicle-brands.ts` mapuje numeryczne
   ID z DeepinView ANPR na human-readable nazwę. **Pułapka:** kuszące jest
   wpisać `1044: 'DPD'` po obserwacji jednego vana DPD z tym ID — ale ID 1044
   to po prostu marka pojazdu (np. VW Crafter / MB Sprinter, czyli model
   używany przez wielu kurierów ORAZ zwykłych ludzi). Konsekwencja: 4
   prywatne auta (HN1440G, WZ3286J, WD5405V, BSE12FM) zostały błędnie
   sklasyfikowane jako "DPD" w AI summary (2026-05-24).
   - **Reguła:** identyfikacja kuriera (DPD/DHL/InPost/Bolt) wyłącznie przez
     **OCR napisu na boku vana** (EasyOCR pipeline w `apps/yolo-vision`),
     NIGDY przez LPR brand ID. Brand ID jest dodatkowo niestabilny per-detekcja
     (ta sama tablica WD5405V w `lpr_reads` ma 40+ różnych brand IDs w ciągu
     tygodnia — to noisy signal).
   - **Walidacja mapowania:** nowe `NNNN → 'Marka'` wymaga obserwacji na
     ≥3 niezależnych pojazdach z tego samego brand ID + OSD overlay
     w snapshocie (`~/gatelynk-edge/data/lpr-snapshots/<ts>_<plate>.jpg`).
   - **Cleanup gdy złe mapowanie zostało wdrożone:** SQL na Edge:
     `UPDATE lpr_reads SET vehicle_brand='#NNNN' WHERE vehicle_brand='WrongLabel'`
     (Cloud `LprRead` nie syncuje `vehicleBrand`, więc cleanup tylko Edge SQLite
     `data/store.db`).
8. **NestJS `DevicesModule` exports** — dodając nowy moduł który injectuje
   service z `DevicesModule` (np. `IntercomService` dla nowego
   `OutputDriverRegistry`), MUSI on być w `exports[]`, nie tylko `providers[]`.
   Symptom: `UnknownDependenciesException: Nest can't resolve dependencies of
   the XxxService (?, ...). Please make sure that the argument YyyService at
   index [0] is available in the AbcModule module.` Naprawa:
   `apps/edge/src/devices/devices.module.ts:exports` musi listować service.
   2026-06-01 zapomniano dodać `IntercomService` przy access-points refactor —
   Edge nie startował, manual `node dist/main.js` pokazywał dokładny error
   dependency injection.
9. **Edge deploy — NIE rsync monorepo `package.json`.** `apps/edge/package.json`
   ma `@gatelynk/device-drivers: workspace:*` — protokół pnpm-only.
   Skopiowanie go na Edge (Mac Mini ma `npm` z nvm, nie pnpm) crashuje
   `npm install` z `EUNSUPPORTEDPROTOCOL`. Symptom: `Unsupported URL Type
   "workspace:": workspace:*`. Procedura deployu Edge:
   - `rsync apps/edge/dist/` na Edge — TAK
   - rsync `package.json` — NIE (zostaw stary na Edge bez workspace deps),
     LUB scrub workspace deps przed rsync:
     `node -e "const p=JSON.parse(fs.readFileSync('package.json'));delete p.dependencies['@gatelynk/device-drivers'];fs.writeFileSync(...)"`
   - `@gatelynk/device-drivers` ręcznie rsync z `packages/device-drivers/dist`
     na Edge do `~/gatelynk-edge/node_modules/@gatelynk/device-drivers/`
     (Edge dist linkuje przez `require('@gatelynk/device-drivers')`).
   - Nowe deps (np. `cron-parser`): dodać do Edge `package.json` ręcznie po
     scrub workspace, potem `npm install` na Edge.
10. **Edge SSH non-interactive shell nie ma `node`/`npm` w PATH.**
    `PATH=/usr/bin:/bin:/usr/sbin:/sbin` (bez `~/.nvm/...`). Przed
    `npm install` w SSH command: `export PATH=$HOME/.nvm/versions/node/v22.22.2/bin:$PATH`.
    Symptom: `zsh: command not found: npm` / `node not found`.
11. **`launchctl kickstart -k` user-agent** czasem nie restartuje procesu
    (silently fails na launchd user agent z `gui/501/...`). Procedura
    pewnego restartu Edge:
    ```bash
    ssh shc_development@100.90.244.90 "
      PID=\$(pgrep -f 'dist/main' | head -1)
      kill -TERM \$PID
      sleep 3
      launchctl kickstart gui/501/com.gatelynk.edge    # bez -k
    "
    sleep 10
    ssh ... "ps -axo pid,etime,command | grep 'dist/main' | grep -v grep"
    ```
    Po launchctl kickstart proces dostaje wrapper `caffeinate -i` (zapobiega
    sleep), widoczny jako oddzielny PID obok node-a. Weryfikacja: `etime`
    nowego PID < 1min + boot log pokazuje `InstanceLoader` dla nowych
    modułów.
12. **iCloud Drive duplikuje pliki w `node_modules` i `.next/types`** —
    katalogi typu `@alloc` + `@alloc 2`, pliki `routes.d.ts` + `routes.d 2.ts`.
    Blokuje `tsc --noEmit` (duplicate identifier errors) i czasem
    `pnpm install` (broken symlinks). Standardowy cleanup PRZED każdym tsc/build:
    ```bash
    find apps/<workspace>/.next apps/<workspace>/src -name "* 2.*" -type f -delete
    ```
    Bardziej radykalny: `rm -rf node_modules && pnpm install` (rebuild od zera,
    1662 paczki ~20s) — używaj gdy `.pnpm/lock.yaml` ma tylko siebie bez
    realnych pakietów.

    **DODATEK 2026-06-08:** iCloud robi duplikaty NIE tylko plików, ale
    też **całych katalogów**: `apps/edge/dist 2/`, `dist/devices 2/`,
    `dist/tunnel 2/`. Wtedy `nest build` wsadza skompilowane pliki do
    `devices 2/` zamiast `devices/`, a runtime crashuje
    `Cannot find module '../devices/device-registry.service'`.
    Cleanup `find -name "* 2.*" -type f` ŁAPIE tylko pliki. Pełen cleanup:
    ```bash
    find apps/edge -type d -name "* 2" -exec rm -rf {} +
    find apps/edge -name "* 2.*" -type f -delete
    rm -rf apps/edge/dist
    pnpm --filter @gatelynk/edge build
    ```

    **iOS Xcode bonus (2026-06-09):** gdy iCloud zrobi duplikat Swift
    pliku (`PaymentsView 2.swift`), Xcode pickup-uje go i dodaje do
    `project.pbxproj` jako PBXBuildFile/PBXFileReference + dwie linie w
    grupie i sources. Skasowanie samego pliku NIE wystarcza — build dalej
    failuje z `Build input file cannot be found: '...PaymentsView 2.swift'`.
    Trzeba też wyczyścić pbxproj:
    ```bash
    sed -i '' '/PaymentsView 2.swift/d' apps/ios/GateLynk.xcodeproj/project.pbxproj
    # albo szerzej, dla dowolnych duplikatów:
    sed -i '' '/[A-Za-z][A-Za-z0-9]* 2\.swift/d' apps/ios/GateLynk.xcodeproj/project.pbxproj
    ```
    Backup `cp pbxproj /tmp/pbxproj.backup` przed sed-em — pbxproj to
    serialized plist, korupcja = projekt nie otwiera się w Xcode.

    **PUŁAPKA TRZECIA 2026-06-09:** Jeśli odtwarzasz zaginiony plik
    Swift od zera, NAJPIERW sprawdź `Models/Models.swift` (i pokrewne)
    czy typy response API już są zdefiniowane. Wiele Views korzysta ze
    wspólnych typów `XxxSummary` / `XxxConfig` / `XxxEntry` w Models.swift.
    Redeklarowanie ich w View powoduje 3 błędy: redeclaration, ambiguous
    lookup, „does not conform to Decodable". Sprawdź:
    ```bash
    grep -nE "struct (Payment|Reservation|Notification|Vehicle)[A-Z]" \
      apps/ios/GateLynk/Models/Models.swift
    ```

    **PUŁAPKA WTÓRNA 2026-06-09:** Po usunięciu phantom `* 2.swift`
    musisz SPRAWDZIĆ czy prawidłowa wersja pliku (bez " 2") jest też
    w pbxproj. Bywa scenariusz: plik fizycznie istnieje, iCloud zrobił
    duplikat, ale Xcode dodał do projektu TYLKO phantom — prawidłowy
    nigdy nie był wpisany. Po sed-cleanup dostajesz
    `Cannot find 'XxxView' in scope` — bo phantom był jedyną referencją.
    Procedura ratunkowa:
    ```bash
    # 1. czy plik na dysku?
    ls apps/ios/GateLynk/Views/Resident/PaymentsView.swift
    # 2. czy w pbxproj?
    grep -c "PaymentsView" apps/ios/GateLynk.xcodeproj/project.pbxproj
    # 0 = nigdy nie był; dodaj 4 wpisy ręcznie z UUID `AA000000000000000000BB<XX>`
    # i `CC<XX>` gdzie XX = następny wolny hex (sprawdź najwyższy zajęty
    # w pbxproj) — analogicznie do innych Views w tej samej grupie.
    plutil -lint apps/ios/GateLynk.xcodeproj/project.pbxproj  # sanity check
    ```
13. **`next build` przez `pnpm --filter` + pipe `2>&1 | tail` zawiesza się.**
    Process żyje ale stdout pusty, ekran terminala blokuje. Workaround:
    `pnpm --filter @gatelynk/web build` (skrypt z `package.json`) zamiast
    `pnpm --filter @gatelynk/web exec next build`. Korelacja z Node 24 +
    Next 16 + Turbopack stderr buffering.
14. **Bastion SSH przez Edge — gdy LAN do MacBooka AI nieosiągalny.**
    `ai_mac@192.168.1.109` (MacBook M1 z yolo-vision) bywa unreachable
    z laptopa konsultanta (różne sieci, NAT), choć Edge (Mac Mini)
    pinguje go w 1ms przez wspólny LAN. Bastion SSH:
    ```bash
    # Rsync przez Edge jako proxy jump:
    rsync -avz --exclude='.venv' --exclude='__pycache__' \
      -e "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
          -J shc_development@100.90.244.90" \
      ./ ai_mac@192.168.1.109:/Users/ai_mac/yolo-vision/

    # SSH przez Edge:
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -J shc_development@100.90.244.90 ai_mac@192.168.1.109 "<cmd>"
    ```
    Tailscale dla MacBooka NIE skonfigurowane, więc Edge → LAN jest jedynym
    sposobem. Dla deployu yolo-vision: rsync + `launchctl unload/load`
    `~/Library/LaunchAgents/com.gatelynk.yolo.plist`.
15. **`flyctl ssh console` ma ograniczony shell.** Komendy:
    - `cd && cmd` nie działa — `cd` nie jest executable w eksec mode.
      Workaround: `sh -c 'cd /app && node script.js'`
    - `psql` NIE jest w PATH — Postgres client nie zainstalowany. Użyj
      Prisma raw query w node-script:
      ```bash
      flyctl ssh console -a gatelynk-api -C "sh -c 'cd /app && node script.js'"
      ```
    - Upload pliku przez `flyctl ssh sftp shell` (`put /tmp/local.js /tmp/remote.js`).
    - Backslash escaping dla quoting jest fragile — preferuj plik + upload
      zamiast inline-string z 4× backslash.
    - Cytaty w SQL: Postgres używa `"` dla identifier, `'` dla string. W
      jednoliniowej komendzie shell traktuje `"` jako quoting, więc trzeba
      `\"` lub przejść na single-quoted SQL i double-quote identifierów.
17. **SwiftUI `@ViewBuilder` body: NIE assignments na istniejących obiektach.**
    Kompilator interpretuje każdy statement w ViewBuilder body jako expression
    i próbuje conform jego typ do `View`. Assignment (`df.locale = ...`)
    zwraca `()` → error `Type '()' cannot conform to 'View'`. Wzorzec
    typowo z `DateFormatter`/`NumberFormatter` mutation w view body.
    ```swift
    // ZŁY:
    @ViewBuilder func dayCard(_ date: Date) -> some View {
        let df = DateFormatter()
        df.locale = Locale(identifier: "pl_PL")   // ← () = Void
        df.dateFormat = "EEEE, d MMMM"            // ← () = Void
        let label = df.string(from: date)
        VStack { Text(label) }
    }
    // DOBRY: extract side-effects do helper function (non-ViewBuilder)
    private static func dayLabel(for date: Date) -> String {
        let df = DateFormatter()
        df.locale = Locale(identifier: "pl_PL")
        df.dateFormat = "EEEE, d MMMM"
        return df.string(from: date).capitalized
    }
    @ViewBuilder func dayCard(_ date: Date) -> some View {
        let label = Self.dayLabel(for: date)   // ← let bindings OK
        VStack { Text(label) }
    }
    ```
    `let` bindings są OK (declaration, nie expression), tylko property
    assignments fail. Wystąpiło 2026-06-10 w `CalendarView.swift` po
    agent-generated sprint.
18. **NIE wołaj `StoreService.<table>Get()` w konstruktorze Edge-owego
    serwisu.** `StoreService.db` jest inicjalizowany dopiero w
    `onModuleInit()` (better-sqlite3 `new Database(path)`). Wcześniejsze
    użycie rzuca `TypeError: Cannot read properties of undefined (reading
    'prepare')` — i przy launchd retry robi crash-loop bez visible PID-a.
    Symptom: `pgrep -f 'dist/main'` zwraca pusto, ale `edge.err.log` co 10s
    pokazuje ten sam stack trace (każda próba launchctl restartu).
    Naprawa: serwis implementuje `OnModuleInit`, bootstrap idzie do
    `onModuleInit()`. Nest gwarantuje że dependency (StoreService) jest
    fully initialized zanim ten hook leci. Wystąpiło 2026-06-03 w
    `VisionDetectService.bootstrapAiEngineConfig()` (Faza 8.g).
19. **Domofon: głuche rozmowy wychodzące = kaskada 4 błędów (debug 2026-07-29).**
    Objaw: rozmowa apka→stacja „odbiera się", ale cisza w obie strony; wszystkie
    rozmowy od ~15.07 trwały 1–13 s i kończyły się ANSWERED_HANGUP. Znalezione
    i naprawione TEGO SAMEGO wieczoru (każdy błąd osobno wystarczał na ciszę):
    1. **`decline` zamiast `hangup` dla wychodzących** — `JanusMediaBridge.hangup`
       wysyłał `decline` gdy `st.accepted=false`, ale `accepted` jest ustawiane
       tylko dla PRZYCHODZĄCYCH. Plugin SIP w stanie incall odrzuca decline
       („Wrong state: not invited"), BYE nie wychodzi, **uchwyt zostaje w incall
       NA ZAWSZE** i każda kolejna rozmowa odbija się od „already in a call".
       Fix: `st.accepted || st.outboundUri → 'hangup'`.
    2. **Answer gubiony przy 183 Session Progress** — jsep answer może przyjść
       w evencie `progress` (nie tylko `accepted`); brak case = zgubiony answer.
    3. **Wyścig offera w tunelu** — CMD INTERCOM_SIGNAL(offer) potrafi wyprzedzić
       CMD INTERCOM_CALL_STATION; handleSdp bez outboundUri po cichu NIC nie
       robił (zero loga!). Fix: `pendingOffers` bufor konsumowany po
       startOutbound.
    4. **ROOT CAUSE ciszy: kierunki mediów w answerze (RFC 3264)** — apka
       oferuje video `recvonly`, Akuvox odpowiada SIP-owo `sendrecv`, a plugin
       Janusa przepisywał to żywcem do answera WebRTC. libWebRTC (iOS) odrzuca
       CAŁY answer („Incompatible send direction") → setRemoteDescription pada
       → ICE nigdy nie startuje. Fix: `fixAnswerDirections` w JanusMediaBridge
       (video sendrecv→sendonly gdy oferta recvonly; audio bez zmian).
    **Procedury z tego debugu:**
    - Po KAŻDYM restarcie Edge sprawdź w logu `SIP registered: edge`. Jeśli
      zamiast tego jest `Two seconds passed and still no NUA` (error 499) —
      wątek Sofia-SIP w Janusie nie wstał dla nowego uchwytu: **restart Janusa,
      POTEM Edge** (kolejność obowiązkowa). Objaw martwego NUA: `handleSdp →
      SIP call` w logu Edge, ale w logu Janusa brak „edge is calling"/INVITE.
    - Sygnalizację E2E widać w logach Edge: `CMD signal od apki kind=…` (app→),
      `SIP accepted/progress: jsep=…`, `EVT INTERCOM_SIGNAL → Cloud kind=…` (→app).
    - Diagnostyka Janusa bez restartu: admin API `127.0.0.1:8089/admin`
      (set_log_level, handle_info z parami ICE). Logi: /tmp/janus.out.log.
    - Bufor sygnałów Cloud (signalBuffer) jest in-memory na 1 instancję API —
      SSE drenuje destrukcyjnie; pusty bufor po rozmowie = apka ODEBRAŁA sygnały.
    - Decydujący dowód dał iOS: uruchomienie Glass z Xcode i linie `[Call] …`
      (setRemoteDescription error był widoczny TYLKO tam). Przy „cisza mimo że
      sygnalizacja działa" — od razu proś o logi z Xcode, zamiast zgadywać.
    - **„Działa na WiFi, cisza na LTE" = sprawdź `turn_*` w janus.jcfg.** Na
      komórce apka używa WYŁĄCZNIE relay (polityka .relay — carrier CGNAT), a
      para relay↔relay wymaga alokacji TURN po OBU stronach. TURN Janusa
      (coturn 91.99.212.240:3478 udp, długożyciowy cred HMAC `2097208599:janus`)
      był zakomentowany w janus.jcfg od 19.06 — po każdej edycji tego pliku
      zweryfikuj `grep turn_ janus.jcfg` i boot-log Janusa: `TURN server to
      use: 91.99.212.240:3478 (udp)`. Cred weryfikuje się przeciw sekretowi:
      `HMAC-SHA1(TURN_STATIC_SECRET, user)` base64 (secret w Fly secrets).
      Naprawione + potwierdzone na LTE 2026-07-29.
20. **„Internal server error" przy otwieraniu przekaźnika = najpierw sprawdź
    TLS, nie hasło (debug 2026-08-05, VN).** Dwie nowe kasety R29C dawały
    podgląd, ale przekaźnik zwracał 500. W `edge.err.log` dwa RÓŻNE objawy,
    mylnie sugerujące dwa różne problemy:
    `write EPROTO … ssl_choose_client_version:unsupported protocol` oraz
    `timeout of 8000ms exceeded`. Przyczyna wspólna: firmware tych kaset
    negocjuje **wyłącznie TLSv1.0 + DHE-RSA-AES256-SHA**, a Node 22 /
    OpenSSL 3 odrzuca to na trzech niezależnych poziomach (minVersion
    TLSv1.2, SECLEVEL=1 wycinający SHA1/DH, wymóg RFC 5746 secure
    renegotiation). Do HTTP nigdy nie dochodziło.
    - **PUŁAPKA DIAGNOSTYCZNA:** `curl` z tego samego Maca dostaje 200, bo
      macOS linkuje LibreSSL (pobłażliwy). „Z terminala działa, z Edge nie"
      = to prawie na pewno różnica OpenSSL 3 vs LibreSSL, NIE sieć i NIE
      hasło. Rozstrzyga `tls.connect` z Node, nie curl.
    - Fix: wspólny `apps/edge/src/devices/lan-https-agent.ts`
      (`minVersion:'TLSv1'`, `ciphers:'ALL:@SECLEVEL=0'`,
      `SSL_OP_LEGACY_SERVER_CONNECT | SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION`,
      `keepAlive`). Samo `@SECLEVEL=0` NIE wystarcza — bez `ALL` domyślna
      lista szyfrów i tak nie zawiera DHE-RSA-AES256-SHA. Agent jest
      wstecznie zgodny (nowe kamery dalej negocjują TLS 1.3) i używają go
      wszystkie serwisy urządzeń — intercom, kamery, LPR, vision, snapshoty.
    - Handshake DHE na słabym CPU kasety trwa 1–2 s i bywa zmienny, a
      `requestWithDigest` robi dwa żądania → timeout 8 s podniesiony na 12 s.
      Pojedynczy timeout NIE musi znaczyć awarii: te kasety potrafią się
      chwilowo zatkać po nieudanych handshake'ach i wracają same.
    - **Testuj bez otwierania bramy:** `DoorNum=99` na
      `/fcgi/OpenDoor?action=OpenDoor` przechodzi tę samą ścieżkę transportu
      i autoryzacji, ale zwraca błąd zamiast wyzwalać przekaźnik.
    - Kody odpowiedzi mapowane teraz na komunikaty (`AKUVOX_RETCODE_HINTS`):
      `-2 Error Param` = zły numer wyjścia, `-3 Not Enable` = **ten konkretny
      przekaźnik** nie jest włączony (NIE całe API — patrz niżej), `-4` =
      High Security Mode / hasło API.
    - **DRUGA PRZYCZYNA W TYM SAMYM ZGŁOSZENIU: zły przekaźnik, a kaseta i tak
      mówi OK.** Po naprawie TLS Wjazd zwracał `retcode=0 "OK"` i… brama się
      nie ruszała. R29 ma dwa niezależne przekaźniki i **potwierdza wykonanie
      także dla tego, do którego nic nie jest podłączone**. `DoorNum` liczymy
      jako `relayIndex + 1`, więc `index: 1` w configu = przekaźnik B.
      W VN napęd wisi na A → poprawny `index: 0`. W Villi Natura na B
      (`index: 1`) i dlatego tam działało — **numeracja jest cechą okablowania
      konkretnej instalacji, nie modelu**. Przy nowej kasecie NIE zakładaj
      wartości z działającego obiektu; zapytaj instalatora o zaciski.
      Diagnostyka: `retcode=0` bez reakcji bramy = prawie na pewno zły
      `DoorNum`; strzał w drugi przekaźnik rozstrzyga w 5 sekund.
    - Zapis configu przez `PATCH /devices/:id` na Edge jest chroniony PIN-em
      (401 bez auth) — zmianę przekaźnika robi się w Edge UI, nie curl-em.
21. **`orderBy: { number: 'asc' }` dla lokali sortuje TEKSTOWO.** Postgres
    porównuje `number` znak po znaku, więc „10/1" wypada przed „2/1", a na
    osiedlu domów (VN: `Niewinna 1/1` … `Niewinna 21/2`, ulica wpisana
    w sam numer, kolumna `street` pusta) lista wygląda na losową. Nie widać
    tego przy 9 lokalach — wychodzi dopiero od numeru 10.
    - Sortujemy w aplikacji: `sortUnits()` / `compareNatural()` z
      `apps/api/src/common/natural-sort.ts` (dzieli ciąg na fragmenty
      cyfrowe i tekstowe, klucz: ulica → klatka → numer). Listy lokali mają
      dziesiątki wierszy, więc koszt jest żaden.
    - `orderBy` w zapytaniu ZOSTAJE jako stabilna baza — dzięki temu
      kolejność jest deterministyczna, gdy dwa oznaczenia porównają się
      jako równe.
    - Kopia dla panelu: `apps/web/src/lib/natural-sort.ts` (dla list, które
      front składa sam z kilku źródeł — np. picker w grupach kontaktowych).
      **Zmieniasz jedną — zmień drugą.**
    - 2026-08-09 poprawione w 12 miejscach naraz (BA, konsjerż, płatności,
      units, integrator, katalog Akuvox). Szukając kolejnych:
      `grep -rn "number: 'asc'" apps/api/src`. Kolejność z
      `akuvox-directory` trafia wprost na wyświetlacz domofonu — tam zła
      kolejność to nie kosmetyka, tylko gość, który nie znajduje lokalu.

22. **`EDGE_HTTP_HOST_OVERRIDE` NIGDY na produkcji + podgląd kamer domofonów
    (incydent 2026-08-11).** Sekret `EDGE_HTTP_HOST_OVERRIDE=100.90.244.90`
    (relikt z czasów jednego budynku) przypisywał KAŻDEMU łączącemu się Edge
    adres Villa Natury: podgląd kamer VN zwracał pusty obraz (Cloud pytał
    ZŁY Edge o urządzenia VN), `touch()` nadpisywał `edge_devices.ipAddress`
    w bazie (ręczna naprawa IP nie przetrwała reconnectu), a `syncAccessPoints`
    stworzył w b11 duchowe access-pointy wskazujące urządzenia b9 — przycisk
    „Wjazd" w VN otwierał bramę w Villa Naturze. Sekret usunięty; gateway
    przyjmuje teraz z WS wyłącznie adres tailnetowy (100.64/10), w innym razie
    bierze ostatni dobry adres z bazy (`EdgeService.getStoredIp`).
    - Objaw „podgląd nie działa w apce" debuguj OD KOŃCA: najpierw
      `curl http://localhost:4000/devices/<uuid>/snapshot?live=1` na Edge
      (działa? → problem w Cloud→Edge), potem realny endpoint
      `/resident/access-points/:id/snapshot` z podpisanym JWT na Fly.
      404/obcy obraz = ZŁY Edge (IP), timeout = martwy adres.
    - Snapshot Akuvox (`akuvoxHttpSnapshot`): port 8080 bywa HTTP albo HTTPS
      zależnie od firmware; nowsze firmware serwuje tam web UI (Angular),
      które odpowiada 200+HTML na KAŻDĄ ścieżkę — bez kontroli Content-Type/
      magic-bytes podgląd dostaje strone HTML „jako jpeg". Sondy http/https
      idą RÓWNOLEGLE (Promise.any) — sekwencyjnie nieudana pierwsza sonda
      zjadała 5-sekundowy budżet proxy Clouda (E18 ma handshake legacy-TLS
      1–2 s). Fallback RTSP wymaga WŁĄCZONEGO RTSP na stacji — „Wjazd"
      w Villa Naturze (R29C .109) ma RTSP wyłączone i nowe firmware bez
      picture.jpg → podgląd niemożliwy do czasu włączenia RTSP na kasecie.

23. **Dwa Xcode na maszynie — CLI builds muszą używać 26.5 z ~/Downloads.**
    `/Applications/Xcode.app` to STARY 16.4 (SDK iOS 18.5), a projekt używa
    API z SDK 26 (`.task(name:)` itd.) i buduje się w GUI Xcode 26.5, który
    leży w `~/Downloads/Xcode.app`. `xcodebuild` bez override bierze 16.4 →
    obłędne błędy LINKERA (undefined `SwiftUI._TaskModifier2`,
    `_swift_coroFrameAlloc`, `_TagTraitWritingModifier`) w plikach, których
    nikt nie ruszał; incremental cache potrafi to maskować dniami i wybucha
    dopiero po wyczyszczeniu `./build`. Przed xcodebuild ZAWSZE:
    ```bash
    export DEVELOPER_DIR="/Users/konradsz/Downloads/Xcode.app/Contents/Developer"
    ```
    Docelowo warto przenieść Xcode 26.5 do /Applications i `xcode-select` —
    decyzja usera.

## Plan iteracyjny — 6 faz, każda samodzielnie deploy-owalna

Każda faza kończy się commit-em + deploy + testem manualnym, bez ryzyka regresji
w pozostałych modułach. Status faz aktualizujemy w trakcie pracy (✅/🟡/⏳).

### Faza 1 — Vehicles approval flow ✅ DONE

- ✅ Schema: `VehicleStatus` enum (PENDING/APPROVED/REJECTED/BLOCKED/EXPIRED),
  `validFrom`/`validTo`, `approvedById`/`approvedByType`/`approvedAt`,
  `rejectionReason`. Plik: `apps/api/prisma/schema.prisma:648-704`
- ✅ Resident `POST /resident/vehicles` jawnie wstawia `status='PENDING'::VehicleStatus`
  (`apps/api/src/resident/resident.service.ts:410-427`). Default schemy to APPROVED
  dla integratorów/adminów; PENDING tylko ścieżka rezydenta.
- ✅ Admin `PATCH /buildings/:id/vehicles/:vehicleId/status` (approve/reject/block)
  z hookiem `syncPlateToEdge` — UPSERT na APPROVED, DELETE na BLOCKED/REJECTED/EXPIRED
- ✅ iOS lista pojazdów: jako sekcja `vehiclesSection` w `ProfileView.swift:104+`
  (NIE oddzielny `VehiclesView.swift` jak w pierwotnym planie). `vehicleStatusBadge()` +
  pokazywanie `rejectionReason` przy REJECTED.
- ✅ Web admin: tab Pojazdy w `/building-admin/buildings/[id]/page.tsx` z modalem
  approve/reject (filtrowanie po statusie w tabie; sidebarowy licznik PENDING — nie ma,
  uznane za nice-to-have).

### Faza 2 — Akuvox PIN driver + Guests ✅ DONE

**Architektura PIN-ów**: zamiast plan-owych capabilities `createPinCode/revokePinCode/validateCode`
przez HTTP do R29, wybraliśmy **pull-based offline-first**:
- Cloud syncuje aktywne PIN-y do Edge przez tunnel (`PIN_UPSERT/PIN_DELETE/PIN_SYNC_ALL`)
- Akuvox skonfigurowany z Action URL → `http://<edge>:4000/akuvox/event`
- `AkuvoxEventController` → `IntercomPinService` waliduje lokalnie + woła `OpenDoor`
- Działa offline („zatrzymanie internetu nie blokuje gościa"); audyt usedAt + push
  asynchronicznie do Cloud przez WS

Pliki:
- Edge: `apps/edge/src/devices/intercom/akuvox-event.controller.ts`,
  `intercom-pin.service.ts`, `intercom.service.ts`
- Cloud: `apps/api/src/guests/guests-validation.service.ts` (PIN flow gdy WS jest),
  `guests-edge.controller.ts` (`POST /api/edge/validate-pin`),
  `guests-expiry.service.ts` (`@Interval(5*60_000)` — cron co 5 min, nie 1 min jak w planie)

Reszta:
- ✅ Schema: `Guest` model + `GuestStatus` enum + `GuestEvent`
  (`schema.prisma:719-779`)
- ✅ Resident `GET/POST/PATCH/DELETE /resident/guests`
  (`resident.controller.ts:124-173`)
- ✅ iOS `Views/Resident/GuestsView.swift` z `ShareLink` na PIN
- ✅ Web concierge `/concierge/building/guests` + `guests/history`
- ✅ Web admin `/building-admin/buildings/[id]/guests/history`

### Faza 3 — Unified AccessEvent + historia w iOS ✅ DONE (deploy 2026-05-03)

- ✅ Migracja `20260502130000_add_access_events`: enum `AccessEventType` +
  tabela `access_events` z indeksami. Schema.prisma model `AccessEvent`
  + back-relations w Building/AccessPoint/Resident/Vehicle/Guest/LprRead.
- ✅ Backfill `20260502140000_backfill_access_events_from_lpr` —
  idempotentny (`WHERE NOT EXISTS`). Po deployu zaimportowane **1025 eventów**
  z `lpr_reads` (61 LPR_MATCH + 964 LPR_NO_MATCH).
- ✅ `AccessEventsService` (`apps/api/src/access-events/access-events.service.ts`)
  — wszystko **raw SQL** (Prisma 7.5↔5.22 drift, patrz „Znany problem z Prismą").
  Metody: `record()`, `listForBuilding()`, `listForResident()`. Joiny:
  - rezydent → unit przez LATERAL na `unit_residents` (Resident NIE ma `unitId`)
  - openedBy: `residents.firstName/lastName`, `building_admins.name`,
    `concierges.name` (Concierge i BuildingAdmin mają tylko `name`, NIE
    `firstName/lastName` — błąd przy pierwszej iteracji)
  - LEFT JOIN po `openedByType` żeby polymorph działało jednym query
- ✅ Hook LPR: `lpr-reads.service.ts` → `recordLprAccessEvent()` —
  fire-and-forget, podpina `lprReadId` lookup po `(buildingId, cameraDeviceId, edgeReadId)`,
  rozwiązuje vehicle/resident po `licensePlate`. `WHERE NOT EXISTS (lprReadId, type)`
  dedup.
- ✅ Hook PIN: `guests-validation.service.ts` audytuje **wszystkie** ścieżki
  (BAD_FORMAT/PIN_NOT_FOUND/CANCELLED/EXPIRED/NOT_YET_VALID/INACTIVE + success).
  `openedByType='EDGE'`.
- ✅ Hook remote-open:
  - Resident: `resident.service.openAccessPoint(apId, buildingId, residentId)` —
    audyt na success i `BadGatewayException`. `openedByType='RESIDENT'`.
  - Guest portal: `guest-portal.service` → `REMOTE_OPEN` +
    `meta={ source: 'guest-portal', actorIp }`. `openedByType='SYSTEM'`.
- ✅ Endpointy (z `/api` prefix):
  - `GET /api/resident/access-events?limit=20` (jwt-resident)
  - `GET /api/concierge/access-events?limit=200&type=...&plate=...` (jwt-concierge)
  - `GET /api/building-admin/buildings/:id/access-events?limit=500`
    (jwt-building-admin + permission check po `buildingIds`)
- ✅ iOS: `Models/Models.swift` ma `AccessEvent` (id jako `String` —
  BigInt z API). HomeView ma sekcję „Ostatnie wejścia" (top 5/20),
  toggle `homeShowAccessEvents` w `ProfileView` (SettingsView).
  Tytuł: tablica → guestName → typeLabel; kolory zgodne z statusem.
  Fail-silent przy starszym backendzie.
- ✅ Web concierge: `/concierge/building/access-events` — pełen feed
  z 3 stat-cards (LPR/PIN/odrzucone dziś), filtrami chip-row (6 typów + ALL),
  search po plate/resident/guest/openedBy/accessPoint/unit/reason.
  Helpery w `apps/web/src/lib/access-events.ts`. Nav item: 🚪 „Wejścia (audit)".

**Pułapki napotkane:**
1. Przy pierwszym smoke-teście użyłem `https://gatelynk-api.fly.dev/concierge/...`
   bez `/api` prefiksu → 404. Globalny prefix to `/api` (`main.ts: app.setGlobalPrefix('api')`).
2. `Concierge` i `BuildingAdmin` mają tylko `name` (jeden field), nie
   `firstName/lastName` jak `Resident`. Trzeba to uwzględnić w joinach
   `resolveOpenedByName()`.
3. `Resident` NIE ma kolumny `unitId` — relacja przez `unit_residents` pivot.
   LATERAL subquery z `untilDate IS NULL OR untilDate > NOW()`.
4. Self-reference: `const plate = opts.plate ? plate.toUpperCase() : null` —
   musi być `opts.plate.toUpperCase()`. Bug pierwszej iteracji.

#### Architektura schematu `access_events` (decyzja z 2026-05-02, wdrożone 2026-05-03)

```sql
CREATE TYPE "AccessEventType" AS ENUM (
  'LPR_MATCH',       -- tablica rozpoznana, brama otwarta
  'LPR_NO_MATCH',    -- tablica nieznana (audyt, brama nieotwarta)
  'PIN_USED',        -- gość wpisał poprawny PIN na Akuvox
  'REMOTE_OPEN',     -- mieszkaniec/admin/concierge wcisnął „otwórz" w app
  'MANUAL_OPEN',     -- przycisk przy szlabanie / domofon głośnik
  'INTERCOM_CALL'    -- wezwanie domofonowe (bez otwarcia)
);

CREATE TABLE "access_events" (
  id              BIGSERIAL PRIMARY KEY,
  "buildingId"    INT NOT NULL REFERENCES "buildings"(id) ON DELETE CASCADE,
  "accessPointId" INT REFERENCES "access_points"(id) ON DELETE SET NULL,
  ts              TIMESTAMP(3) NOT NULL DEFAULT now(),
  type            "AccessEventType" NOT NULL,
  direction       TEXT,                  -- 'IN'/'OUT' tylko LPR
  "gateOpened"    BOOLEAN NOT NULL DEFAULT false,
  reason          TEXT,                  -- np. 'plate not in allowlist', 'PIN expired'
  "residentId"    INT REFERENCES "residents"(id) ON DELETE SET NULL,
  "vehicleId"     INT REFERENCES "vehicles"(id)  ON DELETE SET NULL,
  "guestId"       INT REFERENCES "guests"(id)    ON DELETE SET NULL,
  "lprReadId"     INT REFERENCES "lpr_reads"(id) ON DELETE SET NULL,
  plate           TEXT,                  -- snapshot — żeby filtr po tablicy działał
                                          --           nawet po DELETE LprRead (30 dni TTL)
  "openedById"    INT,                   -- residentId/adminId/conciergeId — kto wcisnął
  "openedByType"  TEXT,                  -- 'RESIDENT'/'ADMIN'/'CONCIERGE'
  meta            JSONB,                 -- ad-hoc: confidence OCR, edgeReadId, deviceId
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX ON "access_events" ("buildingId", ts DESC);
CREATE INDEX ON "access_events" ("buildingId", type, ts DESC);
CREATE INDEX ON "access_events" ("residentId", ts DESC);
CREATE INDEX ON "access_events" (plate) WHERE plate IS NOT NULL;
```

**Decyzje:**
- Indeksy DESC bo zapytania zawsze są „ostatnie N" — Postgres robi reverse-scan tańszy.
- `plate` jako snapshot kolumna mimo FK do `lpr_reads` — bo `LprRead` ma 30-day TTL,
  a AccessEvent ma żyć dłużej (audyt). Po cleanupie LprReada zostaje plate-text.
- `openedById/openedByType` zamiast osobnych FK — bo otwierać może RESIDENT/ADMIN/CONCIERGE,
  każdy ma inną tabelę. Polymorphic association w stylu RoR.
- `meta` JSONB dla rzadkich pól (confidence, deviceId, edgeReadId) — żeby nie dodawać
  20 nullable kolumn dla edge case'ów.
- Brak unique constraint — dane append-only, deduplikujemy po stronie aplikacji
  (Edge przesyła z `edgeReadId`, Cloud sprawdza czy event z tym edgeReadId+type już jest).

**Endpoints:**
- `GET /resident/access-events?limit=20` — lista wpisów dla budynku rezydenta
- `GET /concierge/access-events?limit=200&type=...` — feed (concierge widzi wszystko)
- `GET /building-admin/buildings/:id/access-events?limit=500` — admin (paginacja TBD)

### Faza 4 — Concierge ticket replies + drobne fixe ✅ DONE (deploy 2026-05-07)

- ✅ Migracja `20260506120000_add_ticket_target_role`:
  `tickets.type` (TEXT default 'ADMIN') + `ticket_replies.authorId` (INTEGER nullable)
  + index `tickets_buildingId_type_idx`. Backwards-compat — istniejące ticket-y
  dostają `type='ADMIN'`.
- ✅ Resident `POST /resident/tickets` akceptuje opcjonalny `type` ('ADMIN' | 'CONCIERGE'),
  default 'ADMIN'. Raw SQL bo Prisma generate broken (drift 5.22/7.5).
- ✅ Concierge endpointy (`/api/concierge/building/tickets[/...]`):
  - `GET tickets[?status=]` — tylko `type='CONCIERGE'` w jego budynku, joinuje
    resident + replies (z `authorName` z BuildingAdmin/Concierge tabel).
  - `GET tickets/:id` — szczegół jednego.
  - `POST tickets/:id/replies` — dodaje reply (authorType='CONCIERGE',
    authorId=req.user.sub), auto-IN_PROGRESS gdy OPEN, push do mieszkańca.
  - `PATCH tickets/:id/status` — OPEN/IN_PROGRESS/DONE.
  - Wszystkie blokują dostęp do ticket-ów z `type='ADMIN'` (BadRequest).
- ✅ BA `addTicketReply` zapisuje teraz `authorId` (id buildingAdmin) — wcześniej
  było NULL. Dzięki temu iOS pokaże imię admina w bubble-u rozmowy.
- ✅ Web concierge: `/concierge/building/tickets` z 30s polling, status filter,
  expanded card, reply form, status select. Nav item „🎫 Zgłoszenia".
  3 warianty bubble (RESIDENT white right, ADMIN blue ml-8, CONCIERGE emerald ml-8)
  pokazują kto co odpowiedział w wątku.
- ✅ iOS `TicketsView`:
  - `TicketReply` model rozszerzony o `authorId: Int?` + `authorName: String?`.
  - `staffBubble()` zastąpił `adminBubble()` — przyjmuje role/icon/bg, więc
    obsługuje zarówno admin (szare, budynek) jak i concierge (zielone, dzwonek).
  - `NewTicketView` ma segmented picker „Administracja / Konsjerż" + opisowy
    helper text. `CreateTicketBody` wysyła `type` do API.
- ✅ Bug fix iOS: tab „Płatności" wskazywał `ReservationsView()` — przesterowany
  na `PaymentsView()` z ikoną creditcard. Plik `PaymentsView 2.swift` (identyczny
  duplikat) usunięty.

**Pułapki napotkane:**
1. `prisma generate` broken (drift 5.22/7.5) → wszystkie nowe pola czytane raw SQL.
   `tickets.type` nie da się pokazać przez `prisma.ticket.findMany()`, bo Client
   ma stale typing — INSERT i SELECT przez `$queryRaw`/`$executeRaw`.
2. JWT `req.user.sub` to id konsjerża/admina (potwierdzone w `building-admin.service.ts:157`).
   Concierge JWT też ma `sub` = concierge.id (`concierge.service.ts:96`).
3. BA `addTicketReply` musiał zmienić signature (dodanie `baId`) — controller
   przekazuje `req.user.sub`. Inaczej `authorId` byłby NULL i iOS pokazywałby
   tylko rolę bez imienia.

### Faza 5 — Admin UI: Access Points + Devices ✅ DONE (deploy 2026-05-07)

- ✅ **Backend** (`building-admin.service.ts` + controller):
  - `GET    /buildings/:id/access-points` — lista posortowana sortOrder ASC.
  - `PATCH  /buildings/:id/access-points/reorder` — bulk update sortOrder
    z drag-dropa (`{ ids: number[] }`).
  - `PATCH  /buildings/:id/access-points/:apId` — partial update label/icon/sortOrder/isActive.
  - `GET    /buildings/:id/devices` — lista edges + intercoms + cameras
    z `online` z `EdgeGateway.isOnline()`. Intercom/camera „online" = jego
    Edge online (LAN reachable). Raw SQL dla intercoms/cameras bo Prisma Client
    nie zna `edgeDeviceId` (drift 5.22/7.5).
  - `POST   /buildings/:id/devices/:edgeDeviceId/ping` — sync isOnline check
    + zwrot lastSeenAt/IP. Bez czekania na pong (Edge tego dziś nie obsługuje).
  - `POST   /buildings/:id/devices/:edgeDeviceId/restart` — wysyła CMD `RESTART`
    przez WS. **Edge musi zaimplementować handler** w `apps/edge/src` (TODO).
- ✅ **Modyfikacja** `EdgeService.syncAccessPoints` — przy `update` NIE
  nadpisuje już `label`/`icon`. Override-y admina są trwałe; sync co 5 min
  tylko refresh-uje `edgeDeviceId` (gdyby Edge został wymieniony).
- ✅ **Web BA** — dwie nowe strony:
  - `/building-admin/buildings/[id]/access-points` — lista z drag-drop sort
    (natywne HTML5, bez @dnd-kit), modal edit (label/icon/isActive),
    helper `apps/web/src/lib/access-point-icons.ts` z 5 emoji.
  - `/building-admin/buildings/[id]/devices` — 3 sekcje (Edge / Domofony /
    Kamery), status badges (animated pulse dla online), akcje Ping/Restart
    (toast feedback), polling co 15s, "X min temu" lastSeenAt.
  - Linki na `[id]/page.tsx` headerze (3 quick-action buttons obok
    „Odczyty tablic").
- ✅ DTO walidacja `BaUpdateAccessPointDto` (icon whitelist `ACCESS_POINT_ICONS`),
  `BaReorderAccessPointsDto` (cross-tenant ids guard — sprawdzamy że
  wszystkie id-y należą do budynku przed bulk update).

**Pułapki napotkane:**
1. `Prisma generate` broken → `BuildingIntercom.edgeDeviceId` i
   `LprCamera.edgeDeviceId` nie były znane Prisma Client (drift 5.22/7.5).
   Przeszedłem na `$queryRaw` dla obu modeli w `listDevices`.
2. TypeScript: `React.DragEvent<HTMLDivElement>` vs `<HTMLLIElement>` —
   `<li>` ma własne typowanie i nie zaakceptuje generic z `<div>`. Zmiana na
   `React.DragEvent<HTMLElement>` (parent type) rozwiązuje.
3. Bez `@dnd-kit` — natywny HTML5 drag-drop wystarcza dla ≤ 10 pozycji
   AccessPoint. `setDraggingId` + `setHoverId` + bordery; `persistOrder`
   po drop. Cofniecie przy 5xx (re-load z serwera).
4. ~~`RESTART` na Edge — handler nie istnieje~~ ✅ **Zaadresowane 2026-05-08**:
   - Edge ma już handler dla `REBOOT` (`tunnel.service.ts:215`) — Cloud
     poprzednio wysyłał `RESTART` (literówka), zmienione na `REBOOT`.
   - `process.exit(0)` po 3-sec delay — wymaga service managera. Dodany
     `apps/edge/install/com.gatelynk.edge.plist` (LaunchDaemon dla macOS) +
     README.md z instrukcją instalacji.
   - Po naprawie: BA klika „Restart" → Cloud sendCommand REBOOT → Edge ACK +
     exit → launchd restartuje po 10s → tunel reconnect → online.

### Faza 6 — Demo seed Villa Natura + e2e scenariusz ✅ DONE (2026-05-08)

- ✅ `apps/api/prisma/seed-villa-natura.ts` — idempotentny seed (upsert
  + skip-if-exists). Tworzy:
  - Admin (`admin@villanatura.demo`)
  - BuildingAdmin (`ba@villanatura.demo`, Anna Zielińska)
  - Concierge (`concierge@villanatura.demo`, Marek Nowicki)
  - Building „Villa Natura" (Sopot, Bałtycka 12)
  - 1 stairwell + 3 lokale (15A/B/C)
  - 5 rezydentów (anna/marek/kasia/piotr/zofia) z UnitResident pivot
  - 5 pojazdów (3 APPROVED + 2 PENDING) z tagami
  - 3 gości (active z PIN-em, future jutro, expired wczoraj)
  - 2 EdgeDevice (1 aktywowany, 1 z activationCode), 2 Akuvox intercom-y,
    2 LPR Hikvision
  - 5 access pointów (Wjazd LPR, Wyjazd LPR, Wejście pieszo, Furtka, Brama poż.)
  - 10 access events (24h history, mix LPR_MATCH/LPR_NO_MATCH/PIN_USED/REMOTE_OPEN/MANUAL_OPEN/INTERCOM_CALL)
  - 3 ticket-y (1 ADMIN open + 1 ADMIN in-progress z reply admina + 1 CONCIERGE)
  - PaymentConfig + 5 PaymentEntry per lokal (3-mies. historia)
  - **Hasło wszystkich kont demo: `villa2024`**
- ✅ `apps/api/prisma/demo-scenario.ts` — 11-step e2e runner. Loguje OK/FAIL
  per step + sumę. Sprawdza Faza 1-5 end-to-end:
  1. Resident login (anna)
  2. Resident POST vehicle → PENDING
  3. BA login
  4. BA approve vehicle → APPROVED
  5. Resident widzi APPROVED
  6. Resident POST guest → 6-cyfrowy PIN
  7. Resident POST ticket type=CONCIERGE
  8. Concierge login
  9. Concierge widzi nowy ticket
  10. Concierge POST reply
  11. Resident widzi reply (authorType=CONCIERGE)
- ✅ Scripts w `apps/api/package.json`:
  - `pnpm --filter @gatelynk/api db:seed:demo`
  - `pnpm --filter @gatelynk/api demo:scenario` (env: API_URL, PASSWORD)
- ✅ `apps/api/tsconfig.build.json` — `prisma` dodane do `exclude`. Pliki seed-y
  używają Prisma Client + raw SQL hybrid (raw SQL dla modeli których Client
  nie zna przez drift 5.22/7.5: Guest, Vehicle, Ticket, AccessEvent,
  PaymentConfig, PaymentEntry, Intercom, LprCamera).

**Pułapki napotkane:**
1. `nest build` próbował kompilować `prisma/*.ts` razem z głównym src/.
   Prisma Client (broken generate) = 6 typów errors w seed mimo że runtime
   działa. Rozwiązanie: dodać `"prisma"` do `tsconfig.build.json:exclude`.
   Główny build chodzi clean, seed-y typecheckują przez `tsc --noEmit`.
2. Pusta tablica TypeScript inferuje `never[]` — `const units = []` push-uje
   na `never`. Trzeba explicit `const units: { id: number; number: string }[] = []`.
3. Idempotency dla `Guest`/`PaymentEntry` które nie mają `@@unique` — sprawdzamy
   manualnie przez `$queryRaw` SELECT, skip jeśli istnieje.
4. NIE uruchamiamy seed-a na produkcji bez konsultacji — domena
   `@villanatura.demo` nie koliduje z produkcyjnymi userami, ale i tak warto
   zapytać. Seed dostępny do reproducowania demo środowiska (lokalnie /
   staging).

**Use case:** klient prosi o demo → spin-up świeża baza (Postgres na Fly
gatelynk-db-demo) → `pnpm db:seed && pnpm db:seed:demo` → `pnpm demo:scenario`
weryfikuje że całość działa → klient klika w panel BA / iOS → wszystko gotowe.

## Faza 7 — Dług techniczny / hardening przed klientem produkcyjnym

Zebrane 2026-05-06 po analizie ryzyk operacyjnych. Każdy punkt można zrealizować
osobno i osobno deploy-ować. Kolejność wynika z **wpływu na produkcję** (od
najbardziej palących do nice-to-have). Estymacja w godzinach robocze.

### 7.1 — Ujednolicenie wersji Prismy w monorepo ✅ DONE (2026-05-08)

Drift był: `apps/api` miał `@prisma/adapter-pg@^7.5.0` (peer-resolves
`@prisma/client@7.5.0`), root miał `5.22.0`. Hoisted client conflict + broken
`prisma generate` → raw SQL wszędzie.

**Naprawa:**
- Usunięty `@prisma/adapter-pg` z `apps/api/package.json` (NestJS app i
  seed-y używają standardowego `PrismaClient` bez adapter-a — Rust query
  engine + DATABASE_URL z env). Adapter był używany tylko w seed-ach,
  i to z syntaxem 7.x niekompatybilnym z 5.22.
- `pnpm install` po cleanup-ie node_modules — teraz w monorepo jest
  dokładnie 1 wersja Prismy: 5.22.0.
- `prisma generate` ✓ — przechodzi czysto.
- Workaround `rm -rf apps/api/node_modules/@prisma/client` z `Dockerfile.api`
  (prod + dev) usunięty — lockfile nie ma już duplikatu.
- 143 raw SQL wystąpienia zostawione jako są (działają). Refactor → typed
  Prisma Client zaplanowany razem z 7.4 (e2e tests).

### 7.2 — Staging environment na Fly (2-3h, P0) ⏳

**Problem:** `flyctl deploy` idzie prosto na produkcję. Bug SQL `v.brand`
w access-events trafił od razu do `gatelynk-api` — odkryliśmy go dopiero
przez probe + raport usera „nadal nic nie pokazuje".

**Naprawa:**
- `flyctl apps create gatelynk-api-staging`, `gatelynk-web-staging` — w tym
  samym regionie FRA, ten sam Dockerfile.
- `flyctl postgres create gatelynk-db-staging` (mały tier, attach do API).
- `flyctl secrets import` z produkcji → staging (z mockowanym Resend API key
  na safe-mode, mockowymi push-tokenami).
- Cloudflare DNS: `staging.gatelynk.com` + `api-staging.gatelynk.com`.
- Nowy CLI script `pnpm deploy:staging` w root `package.json` →
  `flyctl deploy --config fly.api.staging.toml --remote-only`.
- Workflow: każdy deploy najpierw na staging, smoke test (curl + opcjonalny
  iOS build pointed at staging), potem prod.

### 7.3 — Sentry + healthcheck monitoring (2h, P0) ⏳

**Problem:** Po deployu sprawdzamy ręcznie probe-em. 500-tki w produkcji nikt
nie zauważy aż user napisze. Brak metryki „WS Edge online/offline" — Edge może
być rozłączony godzinami i nie wiemy.

**Naprawa:**
- Sentry SDK do `apps/api` (NestJS interceptor + filter), `apps/web`
  (Next.js auto-instrumentation), `apps/ios` (Swift SDK). Free tier do 5k
  errors/miesiąc na start.
- Better Stack / Healthcheck.io: ping co 1 min na `https://api.gatelynk.com/api/health`.
  Slack/email alert gdy 2 ping-i pod rząd fail.
- W API dodać `GET /api/health` z prawdziwym health-check-iem: Postgres ping,
  liczba aktywnych Edge WS, ostatnie LPR od każdego budynku (degraded gdy >5min).
- Alert „Edge offline >15min" dla każdego budynku z `isActivated=true` —
  scheduled task co 5 min porównuje `edgeDevice.lastSeen` z NOW.

### 7.4 — Critical-path testy e2e ✅ DONE (2026-05-08)

**Infrastruktura:**
- `apps/api/test/utils/db-setup.ts` — `resetDatabase()` apply migrations +
  TRUNCATE wszystkich user-tabel + minimal seed (license + apartment unit type).
  Defensive guard: TRUNCATE wymaga `_test` lub `localhost` w URL.
- `apps/api/test/utils/fixtures.ts` — factory functions: `seedAdmin`,
  `seedBuilding`, `seedBuildingAdmin`, `seedConcierge`, `seedResident`,
  `seedUnit`, `seedFullBuilding`. Bcrypt rounds=4 dla speed.
- `test:e2e` script ma `--runInBand` (testy sekwencyjne, jedna DB).

**Test suites (4 pliki):**
- `app.e2e-spec.ts` — smoke test, `GET /api/health → 200`.
- `vehicle-duplicate-guard.e2e-spec.ts` (3 testy):
  - POST same plate 2× → drugi 400 (backend duplicate-guard z Fazy 4)
  - PATCH zmiana literówki nie tworzy duplikatu (LprViewer regression)
  - DB-level unique constraint (Faza 7.5) odrzuca raw INSERT
- `multi-tenant-isolation.e2e-spec.ts` (5 testów):
  - Concierge A: GET vehicles nie widzi B
  - Concierge A: PATCH cudzego vehicle (B) → 404
  - Concierge A: DELETE cudzego vehicle (B) → 404
  - BA A: GET vehicles z B → 403 (guardBuilding)
  - Concierge A: GET tickets nie widzi tickets z B
- `vehicle-approval-flow.e2e-spec.ts` (5 testów):
  - Resident POST → status PENDING (body status='APPROVED' ignorowany)
  - Admin PATCH approve → APPROVED + outbox PLATE_UPSERT (Faza 7.6 hook)
  - Admin PATCH reject bez `reason` → 400
  - Admin PATCH reject z `reason` → REJECTED + rejectionReason
  - Resident GET widzi APPROVED po cyklu

**CI** (`.github/workflows/api-e2e.yml`):
- Postgres 16 jako service container
- `pnpm install --frozen-lockfile` + `prisma migrate deploy` + `prisma generate`
- `pnpm --filter @gatelynk/api run test:e2e`
- Trigger: push do main + PR do main

**Lokalne uruchomienie:**
```bash
# Wymaga lokalnego Postgres na :5432
createdb gatelynk_test
cd apps/api && NODE_OPTIONS=--experimental-vm-modules \
  DATABASE_URL="postgresql://konradsz@localhost:5432/gatelynk_test" \
  DATABASE_URL_TEST="postgresql://konradsz@localhost:5432/gatelynk_test" \
  npx jest --config ./test/jest-e2e.json --runInBand --forceExit
```
Dwie pułapki (2026-09-07): (1) `AppModule` czyta `DATABASE_URL` z `apps/api/.env`
(baza dev), a seed/reset używa `DATABASE_URL_TEST` — bez nadpisania OBU
zmiennych logowanie w testach zwraca 401, bo konta są w innej bazie;
(2) `BuildingAdminService.login` robi `await import('bcrypt')` — pod Jestem
bez `--experimental-vm-modules` to 500 „dynamic import callback".
Znany dług: `vehicle-approval-flow` asercja outbox PLATE_UPSERT pada, bo
`seedFullBuilding` nie tworzy aktywowanego `EdgeDevice` (outbox pisze
1 wiersz per Edge → 0 wierszy).

**Pułapki:**
1. `globalPrefix='/api'` musi być ustawione w `app.init()` w testach (jak
   w `main.ts`), inaczej route-y nie pasują.
2. `bcrypt.hash(pwd, 10)` w produkcji = ~100ms per call. W testach `rounds=4`
   skraca to do <10ms. Razem 50 hash-ów per test suite = 5s zaoszczędzone.
3. Faza 7.6 outbox jest auto-test-owany — `vehicle-approval-flow` sprawdza
   czy PLATE_UPSERT row pojawił się przy approve.

### 7.5 — DB-level constraints + cleanup duplikatów ✅ DONE (2026-05-08)

Migracja `20260508120000_vehicles_unique_plate_per_building`:
- Cleanup w jednym SQL DELETE (self-join, zachowuje max(id) z każdej grupy):
  ```sql
  DELETE FROM "vehicles" v
   WHERE EXISTS (SELECT 1 FROM "vehicles" v2
     WHERE v2."buildingId"=v."buildingId" AND v2."licensePlate"=v."licensePlate"
       AND v2.id > v.id)
  ```
  Zachowane: najnowszy wpis każdej grupy (`id DESC`). Audit-log
  (`access_events`) ocalał — `vehicleId` ma `onDelete: SetNull`.
- `CREATE UNIQUE INDEX vehicles_buildingId_licensePlate_key ON vehicles (buildingId, licensePlate)`.
- Bonus: partial unique na PIN-y aktywnych gości:
  `CREATE UNIQUE INDEX guests_buildingId_pin_active_key ON guests (buildingId, pin) WHERE status = 'ACTIVE'`.
- Schema.prisma zsynchronizowany: `Vehicle @@unique([buildingId, licensePlate])`.

Verify (2026-05-08): `REMAINING DUPES: []`, oba indexy obecne, vehicles
b9: 26 (było ~30 z dupes).

`units(buildingId, number)` już ma @@unique od dawna; access_points też
ma `(buildingId, deviceId, relayIndex)` unique. Nic więcej do dodania.

### 7.6 — Persistent Edge sync queue ✅ DONE (2026-05-08)

**Migracja `20260508130000_add_edge_sync_outbox`:**
- Tabela `edge_sync_outbox` (id TEXT PK, buildingId, edgeDeviceId nullable,
  action, payload JSONB, attempts, lastAttemptAt, lastError, deliveredAt,
  failedAt, createdAt) + 3 indexy (pending per device, pending per building,
  delivered cleanup).
- Schema.prisma: `EdgeSyncOutboxEntry` model + relacje Building/EdgeDevice.

**`EdgeOutboxService` (apps/api/src/edge/edge-outbox.service.ts):**
- `enqueueForDevice(buildingId, deviceId, action, payload)` → row z 8-znak
  random id (używanym też jako WS message-id).
- `enqueueForBuilding(buildingId, action, payload)` → 1 row PER znany Edge
  w budynku (online + offline). Offline dostają WS przy reconnect.
- `markDelivered(id)` po ACK (cicho ignoruje jeśli row nie istnieje —
  legacy ACK bez outbox-row).
- `markAttempted(id, error?)` inkrementuje attempts; po 10 → `failedAt`
  (deadletter + ERROR log).
- `pendingForDevice(deviceId, limit=200)` chronologicznie — używane przy
  reconnect replay.
- `pendingForRetry({olderThanMs}, limit=100)` dla cron-retry.
- `statsForBuilding(buildingId)` zwraca Map deviceId → {pending, failed}.

**EdgeGateway changes:**
- `sendCommand(deviceId, buildingId, action, payload)` — sygnatura zmieniła
  signature (dodany `buildingId`, async + void return). Caller w BA service
  zaktualizowany.
- `sendToBuilding(buildingId, action, payload)` — najpierw outbox (1 row per
  każdy znany Edge), potem WS dla online. Fallback do legacy WS.send gdy
  outbox failed (DB down).
- `handleConnection` po reconnect: `replayPendingForDevice` wysyła wszystkie
  pending do Edge po kolei.
- `handleMessage('ACK', id)` → `markDelivered` lub `markAttempted` jeśli
  `success=false`.
- Nowy `@Interval(60_000) retryOutboxPending()` — resend dla online Edge
  z lost ACK-iem (lastAttemptAt < NOW-60s).

**BA UI:**
- `listDevices` zwraca `outbox: { pending, failed }` per Edge.
- `/building-admin/buildings/[id]/devices` pokazuje badge ⏳ X (pending) i
  ⚠ X (failed) obok status pill.

**Verify (2026-05-08 09:35):** migracja applied, 11 kolumn + 4 indexy,
API żyje, web zdeployowany.

**Use case scenariusz:**
1. Resident dodaje gościa → Concierge service emit `PIN_UPSERT` przez
   `sendToBuilding`.
2. Edge offline → 1 row w outbox z `attempts=0`, `deliveredAt=NULL`.
3. BA widzi badge ⏳ 1 obok Edge — wie że coś czeka.
4. Edge reconnect → `handleConnection` woła `replayPendingForDevice` →
   PIN_UPSERT ląduje w Edge → Edge ACK → `markDelivered`.
5. Badge znika.

**Cleanup cron** ✅ DONE 2026-05-09: `EdgeOutboxService.cleanupOldDelivered()`
z `@Interval(24h)` kasuje delivered entries > 30 dni. Failed (deadletter)
zostają jako audit-log. Plus dedykowane testy e2e (`edge-outbox.e2e-spec.ts`):
8 testów pokrywających enqueue, markDelivered, markAttempted/deadletter,
replay chronology, statsForBuilding, cleanup retention.

### 7.7 — Sekrety + rotacja (1h, P2) ⏳

**Problem:** Akuvox/Hikvision device passwords leżą plain-text w
`flyctl secrets`. Brak audytu kto czytał, brak rotacji. Niski priorytet bo
nie mamy compliance, ale przy klientach enterprise to red flag.

**Naprawa:**
- Migracja kolumn `EdgeDevice.devicePassword` na encrypted-at-rest
  (libsodium-wrappers + master key w Fly secrets).
- CLI script `pnpm rotate:device-secrets <buildingId>` — nadaje nowe,
  pushuje do urządzeń przez Edge, updateuje w DB.
- Audit log: kto i kiedy widział dane urządzenia (dziś każdy admin może
  zobaczyć, brak tracingu).

### Sumarycznie

| # | Temat | Estymacja | Priorytet | Status |
|---|-------|-----------|-----------|--------|
| 7.1 | Prisma drift | 1–2h | P0 | ✅ DONE 2026-05-08 |
| 7.2 | Staging env | 2–3h | P0 | 🅿️ ODROCZONE (decyzja usera 2026-05-08) |
| 7.3 | Sentry+healthcheck | 2h | P0 | 🅿️ ODROCZONE (decyzja usera 2026-05-08) |
| 7.4 | E2E testy | 4–6h | P1 | ✅ DONE 2026-05-08 |
| 7.5 | DB constraints | 1–2h | P1 | ✅ DONE 2026-05-08 |
| 7.6 | Edge sync queue | 3–4h | P1 | ✅ DONE 2026-05-08 |
| 7.7 | Sekrety/rotacja | 1h | P2 | 🅿️ ODROCZONE (decyzja usera 2026-05-08) |

**⚠️ DLA PRZYSZŁYCH SESJI:** 7.2/7.3/7.7 są **ODROCZONE** decyzją usera (Konrad,
2026-05-08). NIE zaczynać autonomicznie — czekać aż user explicit poprosi.
Triggers:
- 7.2 staging — gdy Villa Natura zostanie płatnym klientem albo dojdzie 2-gi
- 7.3 Sentry — gdy user założy konto na sentry.io / betterstack.com (potrzebne DSN-y)
- 7.7 sekrety/rotacja — przed pierwszym enterprise/SLA contractem

Pozostały tech-debt do autonomicznego zrobienia: brak. Faza 7 zamknięta z punktu
widzenia tego co można zrobić bez external decisions.

## Faza 8 — Universal architecture (2026-06-02)

Decyzja strategiczna: GateLynk musi obsługiwać **trzy typy obiektów** jednolicie —
blok mieszkalny (Konsjerż + central mailbox), osiedle domów (kurier-pod-dom, brak
konsjerża) i mixed-use. Villa Natura to **osiedle 55 domów**, NIE blok — pierwsza
implementacja produkcyjna.

### Architektura ról — model 2-warstwowy

Decyzja architektoniczna 2026-06-02 (Konrad): **NIE rezygnujemy z Cloud Integrator
panel** mimo że Edge UI dubluje część features. Powody:
1. Multi-budynkowy widok (integrator-firma obsługuje N klientów)
2. Audyt centralny (integrator_audit_logs)
3. Status monitoring (Cloud widzi które Edge online)
4. Permissions matrix (faza e — kto co widzi)
5. BA/Concierge/Resident są w Cloud — spójność dla integratora-jako-użytkownika

**Podział odpowiedzialności:**

```
EDGE UI (http://<edge>:4000/ui — on-site, LAN)
- Pierwsze podłączenie urządzenia (wizard)
- IP / hasła / model / manufacturer
- Fizyczne przekaźniki: label, hold-time, polarity
- "Wyzwól" — test relay
- Diagnostyka / snapshot test / ISAPI check
- Eksport configu do USB (backup offline)

CLOUD INTEGRATOR (gatelynk-web.fly.dev/integrator — off-site)
- Multi-budynkowy dashboard (faza f, do zrobienia)
- Status Edge per budynek (online/offline + uptime + queue)
- AccessPoint binding (device→output→durationMs)
- LPR camera ↔ AccessPoint linking (multi-link z direction IN/OUT)
- Object type + features (BUILDING/HOUSING_ESTATE/etc.)
- Schedules cron
- Permissions matrix (faza e — co BA/Concierge/Resident widzi)
- Audit log wszystkich zmian integratora
- (NIE) Deeplinks do Edge UI — user odrzucił, integrator korzysta
  z Tailscale/SSH własnym kanałem
```

### 8.a — RESIDENT_PIN ✅ DONE (deploy 2026-06-02)

Stały PIN mieszkańca (4-6 cyfr) do klawiatury Akuvox. Działa offline-first przez
lokalny cache Edge w `resident_pins`. Mieszkaniec ustawia w iOS Profile, walidacja
Cloud-side (unique per building, brak kolizji z aktywnym Guest.pin, blacklist
trivial 1234/0000/etc).

- Schema: `Resident.intercomPin String? @db.VarChar(6)` + unique partial index
- Tunnel: `RESIDENT_PIN_UPSERT/DELETE/SYNC_ALL`
- Edge: tabela `resident_pins` + AkuvoxEventController sprawdza guest→resident
- iOS: sekcja "Mój PIN do bramy" w ProfileView (SecureField + reveal toggle)
- Audit: `access_events.openedByType=RESIDENT`

### 8.b — Universal object types ✅ DONE (deploy 2026-06-02)

`Building.objectType` enum (5 wartości) + `Building.features` JSON. Concierge
panel pokazuje fullscreen blokadę gdy `has_concierge=false`.

- Migration: `20260602180000_building_object_types`
- Konstanty: `apps/api/src/buildings/buildings.constants.ts`
- Backfill: Villa Natura (id=9) → `HOUSING_ESTATE` + features `delivery_to_door=true`
- Web: `BuildingFeaturesContext` w BA v2, `IntegratorObjectTypeCard` w Integrator
- Edge: tunnel `BUILDING_CONFIG_UPDATE` zapisuje payload (na razie brak konsumera)
- **Pułapka napotkana**: legacy budynki miały `objectType='ESTATE'` (sprzed enum),
  migration UPDATE warunkowała `WHERE objectType='BUILDING'` → nie złapała. Fix
  ręczny przez node-script + Prisma raw SQL.

### 8.c — AccessPoint.category + multi-LPR per AP ✅ DONE (deploy 2026-06-02)

AP dostaje semantyczną kategorię (5 typów). 1 LPR camera może mieć N AP-links z
direction (IN/OUT) — Villa Natura docelowo 2 wjazdy × 2 kamery = 4 kamery łącznie.

- Migration: `20260602190000_access_point_category_and_multi_lpr`
- Schema: `AccessPoint.category String @default('MAIN_ENTRY')` + `LprCameraAccessPointLink` model
- Konstanty: `apps/api/src/access-points/access-points.constants.ts` (5 kategorii)
- Edge: tabela `lpr_camera_ap_links` + tunnel `LPR_AP_LINK_UPSERT/DELETE/SYNC_ALL`
- Edge `HikvisionLprService` przy LPR match iteruje linki dla danej kamery i
  multi-fire-uje wszystkie AP. Fallback do legacy `linkedAccessPointId`.
- Web Integrator: `IntegratorLprLinkageCard` rozszerzony do N linków per kamera
  (przycisk "+ dodaj powiązanie", per-link IN/OUT select + usuń)

### 8.d — Estate features ✅ DONE (deploy 2026-06-02)

`Unit.street` + `Unit.houseType` (APARTMENT/HOUSE/OFFICE/SHOP/STORAGE/PARKING_SPOT).
`CourierVisit` model z flow PENDING/ACCEPTED/REJECTED/EXPIRED.

- Migration: `20260602200000_estate_features`
- Cloud `CourierVisitService` — recordNewVisit (broadcast push), accept (fire AP),
  reject, cron expire >30min
- Edge `IntercomPinService.handleKeypadEvent` — gdy 4-cyfrowy kod nie matchuje
  guest_pins ani resident_pins, emit `COURIER_VISIT_NEW` tunnel event
- Cloud `EdgeGateway` reaguje na `COURIER_VISIT_NEW` → broadcast push do
  wszystkich mieszkańców z actionable category COURIER_VISIT
- BA: `/courier-visits` strona z stats cards + tabela wizyt
- **TODO iOS**: Swift action handlers dla push category COURIER_VISIT (Wpuść/Nie znam) —
  wymaga edit AppDelegate + nowych view-ów, osobna sesja Xcode

### 8.e — Permissions Matrix ✅ DONE (deploy 2026-06-02)

Integrator decyduje co BA/Konsjerż/Mieszkaniec widzą per budynek. `Building.featurePermissions`
JSON z kluczami `feat_<system_feature>` i `ap_<id>`. Backend filtruje API zwroty
i 403-uje endpointy z `FEATURE_DISABLED` code. iOS i BA panel conditional rendering.

15 system features: vision_ai, fall_detection, lpr_audit, guest_portal, resident_pin,
courier_visits, schedules, parcels, tickets, payments, reservations, vehicles,
guests, notifications, building_branding.

Visual matrix w Integrator panel: 3 role × N features + N AP-y per budynek.
Default per objectType (5 wariantów defaultów w `feature-permissions.constants.ts`).

### 8.f — Multi-budynkowy dashboard ✅ DONE (deploy 2026-06-02)

Dashboard `/integrator/dashboard` z listą wszystkich budynków klienta + status
Edge per budynek + alerty. Klik → `/integrator/buildings/:id`. Polling co 30s.

- Backend: `GET /api/integrator/dashboard` — agregowany JSON, single endpoint,
  Edge status z `lastStatus` cache w EdgeGateway. Tenant filter po `Building.adminId`.
- Frontend: `IntegratorDashboardStats` (4 cards: Total/Online/Offline/Z alertami/
  Anomalia 24h), `IntegratorDashboardFilters` (Wszystkie/Online/Offline/Z alertami,
  sort: status/nazwa/anomalie), `IntegratorBuildingCard` (badge status ok/warning/
  critical, Edge details + stats per budynek).
- Auto-redirect: `/integrator/login` → `/integrator/dashboard` (zamiast `/buildings`).

### 8.g — AI Engine first-class device ✅ DONE (deploy 2026-06-03)

AI Engine (YOLO/Vision service na MacBooku M1) jako pełnowartościowe urządzenie
edytowalne z panelu Integratora w Cloud. Dotąd `process.env.YOLO_URL` na Edge —
zmiana wymagała SSH. Teraz: integrator klika, wpisuje URL/model, "Testuj" →
1 budynek = 1 AI Engine (`@@unique buildingId`).

- Migration `20260603000000_add_ai_engine_config` — tabela `ai_engines` z `url`,
  `healthPath`, `model`, `enabled`, `lastTestAt/Ok/Ms/Err/Code`.
- `feature-permissions.constants.ts`: 4 nowe features (`ai_engine`,
  `vision_dashboard`, `brand_detection`, `plate_ocr`) + `AI_ENGINE_DEPENDENT_FEATURES`
  set. `hasPermission` KASKADA: gdy `feat_ai_engine=false`, wszystkie zależne ML
  features (fall_detection / vision_dashboard / brand_detection / plate_ocr)
  automatycznie zwracają false — defense-in-depth backend + frontend mirror.
- Edge: `ai_engines` table w sqlite, `VisionDetectService` czyta URL z store
  (env fallback do grace period), auto-migration z `YOLO_URL` env przy starcie
  (loguje `[ai-engine] auto-migrated from YOLO_URL env`).
- Tunnel: `AI_ENGINE_CONFIG_UPDATE` (Cloud→Edge) + `AI_ENGINE_TEST` (Cloud→Edge)
  + EVT `AI_ENGINE_TEST_RESULT` (Edge→Cloud z `{ok, ms, statusCode, error}`).
- Endpoint: `GET/PATCH /api/integrator/buildings/:id/ai-engine` +
  `POST /api/integrator/buildings/:id/ai-engine/test` (asynchroniczny — Edge
  zapisuje wynik do `ai_engines.lastTest*`, frontend polluje 30s).
- UI: `IntegratorAiEngineCard` w `/integrator/buildings/[id]/devices` —
  URL/healthPath/model/enabled + "Testuj połączenie" + "Ostatni test: 47ms OK"
  badge. Permissions matrix cascade UI: badge "MASTER" dla `feat_ai_engine`,
  badge "wymaga AI Engine" dla zależnych, wyszarzanie checkboxów + banner
  ostrzeżenia gdy AI Engine off.
- Pułapka napotkana (zaadresowana, patrz pułapka #16): VisionDetectService
  konstruktor wołał `store.aiEngineGet()` zanim `StoreService.onModuleInit`
  zainicjalizował `db` → infinite crash-loop pod launchd. Naprawione przez
  `implements OnModuleInit` + bootstrap w `onModuleInit()`.

**TODO follow-up:**
- iOS cascade dla `vision_dashboard`/`fall_detection` (osobna sesja Xcode)
- Multi-engine per budynek (na razie 1:1 hard-coded; rozszerzenie wymaga
  `vision_detections.ai_engine_id` FK)
- DB-level CHECK constraint na URL regex (opcjonalne, backend już waliduje)
- `prisma generate` w produkcji (raw SQL fallback działa — opcjonalne)

### 8.h — Camera role (STANDARD/LPR) + per-camera AI toggle ✅ DONE (deploy 2026-06-04)

Bug w panelu Integratora: zwykła kamera (typ `CAMERA` z Edge) lądowała w
sekcji "Kamery LPR" przez błąd w `DeviceTreeSection.categoriesForGroup` —
mapowanie `CAMERA || LPR_CAMERA → ['LPR_CAMERA']`. Dodatkowo brak per-camera
flagi "Analizuj AI": VisionDetectService brał wszystkie kamery hurtem.

- Migration `20260603120000_camera_role_and_ai_toggle`:
  `LprCamera.role TEXT DEFAULT 'LPR'` + `LprCamera.aiAnalysisEnabled BOOLEAN DEFAULT true`
  + CHECK `role IN ('STANDARD', 'LPR')`. Backfill wszystkich istniejących → 'LPR'.
- Konstanta: `apps/api/src/cameras/cameras.constants.ts` — `CAMERA_ROLES`,
  `CAMERA_ROLE_LABELS`, `isCameraRole(x)`.
- Cloud endpoint `PATCH /api/integrator/buildings/:id/cameras/:cameraId`
  z body `{role?, aiAnalysisEnabled?}` — raw SQL update, emit
  `CAMERA_CONFIG_UPDATE` przez tunnel + outbox.
- Edge sqlite: kolumny `role TEXT DEFAULT 'LPR'` + `ai_analysis_enabled INTEGER DEFAULT 1`
  w `device_config`, helpery `setCameraRole/setCameraAiAnalysisEnabled`.
- Edge `VisionDetectService.listCameras()` filter `c.aiAnalysisEnabled !== false`.
- Tunnel: `CAMERA_CONFIG_UPDATE` (Cloud→Edge partial update).
- UI Integrator:
  - `DeviceTreeSection.categoriesForGroup` fix — zwykła kamera (`CAMERA`)
    nie ma już opcji bindowania do LPR.
  - Nowy komponent `IntegratorCameraSettingsCard.tsx` w panelu devices —
    2 sekcje ("Kamery wizyjne" / "Kamery LPR"), per-row dropdown role +
    checkbox "Analizuj AI", auto-PATCH onChange.

**TODO follow-up:**
- iOS Models nie miały LprCamera (kamery są integratorskie, nie residentskie) — skip
- BA panel devices — można dodać read-only widok role+aiAnalysisEnabled w przyszłości

### 8.h.1+ — Backfill role z Edge mirror + UI improvements ✅ DONE (2026-06-05)

Faza 8.h migracja backfill ustawiła wszystkim kamerom `role='LPR'` — ale
część kamer (np. Kamera HikV w Villa Natura, Hikvision ColorVu bez ANPR) to
faktycznie zwykłe wizyjne. Edge raportuje je jako `type='CAMERA'`.

- Migracja `20260605130000_camera_role_backfill_fix_join` — drugi backfill,
  JOIN po prawidłowym kluczu `edge_device_mirror.deviceUuid = lpr_cameras.edgeDeviceId`
  (poprzednia migracja `20260604140000` miała błędny JOIN po `edgeDeviceId =
  edgeDeviceId` — `EdgeDeviceMirror.edgeDeviceId` to cuid serwera Edge, NIE
  UUID urządzenia). Idempotentna: tylko mismatch (mirror='CAMERA' + role='LPR').
- `getLprCameras` — JOIN z mirror, COALESCE dla IP (mirror.config jako
  fallback), zwraca `edgeMirrorType` do detekcji mismatch.
- `IntegratorCameraSettingsCard` — amber-banner "Edge widzi tę kamerę jako
  wizyjną — zmień rolę na STANDARD" gdy `mirror.type='CAMERA'` ale `role='LPR'`.
- Vision page brand filter (BA): `filterBrand` state, sticky banner z licznikiem
  "X z Y detekcji", toggle on/off przez kliknięcie tej samej marki.

**Pułapka napotkana:** `EdgeDeviceMirror` ma DWA pola wyglądające na klucz:
`edgeDeviceId` (cuid Edge serwera) vs `deviceUuid` (UUID konkretnego urządzenia
w Edge sqlite). `LprCamera.edgeDeviceId` semantycznie odpowiada DRUGIEMU
(`deviceUuid` w mirror, nie `edgeDeviceId`). Nieudokumentowane — łatwo zrobić
błąd przy JOIN.

### 8.h.2 — CAMERA_SYNC_ALL przy reconnect Edge ✅ DONE (2026-06-05)

Backfill SQL na Cloud nie przechodzi przez tunel — Edge może mieć stale
`role='LPR'` mimo że Cloud zaktualizował 'STANDARD'. Analogicznie do
`AP_SYNC_ALL` / `LPR_AP_LINK_SYNC_ALL`, dodany pełen replace-all per kamera
przy każdym reconnect.

- Tunnel action `CAMERA_SYNC_ALL` (Cloud → Edge, payload `{items: [{cameraDeviceId, role, aiAnalysisEnabled}]}`)
- `EdgeGateway.pushAccessPointSync` dorzuca CAMERA_SYNC_ALL razem z innymi sync-ami
- Edge handler iteruje items, setCameraRole + setCameraAiAnalysisEnabled
- Log: `CAMERA_SYNC_ALL: replaced config for N camera(s)`

**Weryfikacja na produkcji:** Po restarcie Edge log:
`CAMERA_SYNC_ALL: replaced config for 2 camera(s)` — Villa Natura (Kamera HikV
+ Wjazd).

### 8.h.3 — Polish retail brand patterns w EasyOCR ✅ DONE (2026-06-05)

Zgłoszenie: Media Expert van GM8149M przejechał Villa Natura o 20:17 (2026-06-05),
LPR złapał plate ale "Media Expert" nie zostało rozpoznane jako brand. Diagnoza:
`BRAND_PATTERNS` w `apps/yolo-vision/brand_matcher.py` zawierało tylko kurierów
(DHL/DPD/InPost/FedEx/GLS/UPS) + meal-box (NTFY/Maczfit/Lightbox itd.) — brak
polskich sieci retail.

Dodane 18 nowych brandów:
- **AGD/RTV**: MEDIA_EXPERT, MEDIA_MARKT, RTV_EURO_AGD, X_KOM, KOMPUTRONIK,
  NEONET, AVANS
- **DIY/dom**: IKEA, OBI, LEROY_MERLIN, CASTORAMA, JYSK
- **Spożywka**: FRISCO, BARBORA, BIEDRONKA, LIDL, AUCHAN, CARREFOUR
- **Apteki**: DOZ, GEMINI

Weryfikacja na żywym snapshocie 1780683420802_GM8149M.jpg (504KB):
```
brand_detected: MEDIA_EXPERT
brand_conf: 0.843
text_raw: ['ML', 'MM', 'HLACZUHY', 'mediaexpert', 'medhaexpertp]']
ocr_ms: 1579
```

Retroaktywny update `UPDATE vision_detections SET brand_detected='MEDIA_EXPERT' WHERE id=12969`
na Edge sqlite (Cloud nie ma vision_detections — sync nie potrzebny).

**Deploy:** `apps/yolo-vision/brand_matcher.py` zsync z prod (`scp -J Edge`),
restart `launchctl unload/load com.gatelynk.yolo.plist`.

**TODO follow-up:**
- Cleanup script retroactive: sweep ostatnich N dni `vision_detections` z
  brand_detected=NULL, re-run /detect dla snapshotów które istnieją, update DB.
  Opcjonalne — koszt ~5 min per 1000 frames. Korzyść: nowe brandy backfill.
- Brand detection pipeline tylko dla "notable" frames (skip-non-notable) —
  potencjalnie pomijamy klatki z autem bez `person`/`dog`/`brand-trigger`.
  Sprawdzić czy van retail z napisem ale bez osoby też wpada w notable check
  (`{"car":N}` → non-notable). Może trzeba dodać tę logikę.

### 8.h.4 — Surowe OCR tokens w UI + text search ✅ DONE (2026-06-05)

Zgłoszenie usera: "Czy można rozpoznawać KAŻDY napis w kadrze i zapisywać?".
Odpowiedź: storage już istniał (`vision_detections.text_raw` JSON array od
fazy brand-detection 2026-05-19), ale Edge controller go nie zwracał, UI nie
pokazywał. Rozwiązanie surface-only.

- `StoreService.visionListRecent` SELECT-uje `text_raw AS textRaw`
- Edge `vision-detect.controller.ts`:
  - `parseTextRaw()` helper — filtruje noise: tokeny >=3 znaki, musi mieć
    literę lub >=3 cyfry, odrzuca OSD overlay (data ISO, czas HH:MM,
    "Canera 0X" / "Camera 0X")
  - Response zawiera `textRaw: string[]` per detection
- Web BA Vision page (`vision/page.tsx`):
  - `filterText` state, search input w sidebarze "🔎 Szukaj napisu"
  - `visibleDetections` filter — pokazuje detekcje gdzie `textRaw.some(t.includes(query))`
  - DetectionCard: chips "🔡 Napisy" z monospace tokens (max 12, "+N więcej")
- Pełen flow: van Media Expert → EasyOCR (OCR_CLASSES truck/bus/car/person) →
  text_raw zachowany → UI pokazuje chips. Brand_matcher dalej działa jako
  bonus (gdy pattern matchuje → kanoniczna nazwa w `brandDetected`), ale BA
  może teraz zobaczyć każdy napis nawet bez pattern.

**Weryfikacja:** Detection 12969 (Media Expert van GM8149M, 20:17) zwraca:
```
brandDetected: MEDIA_EXPERT
textRaw: ['(nsleopsdo] (', 'Jrayy', 'mediaexpert', '784', "'Mlespslol |", 'JLIE', "'epalol |", 'Canera Q1', 'Jqyy']
```

User może wpisać w search "media", "784", "mediaexpert" — wszystko trafia.

**TODO follow-up:**
- Auto-discovery: cron tygodniowy sumuje top tokens >5 wystąpień z `text_raw`
  które NIE matchują żadnego brand pattern. Sugeruje patterns do dodania.
- Concierge / Mieszkaniec też potencjalnie czytają — feature permissions
  `text_search` (default off, integrator włącza). Trzeba dodać do
  SYSTEM_FEATURES jeśli się zdecydujemy.

### 8.h.27 — LPR reads: redesign ba-v2 + lazy thumbnails fix ✅ DONE (2026-06-12)

Delegowane agentowi (#38), wdrożone wspólnym deployem z 8.h.26.

**Problem miniaturek (NIE stary bug TS_HTTP_PROXY — ten env nadal jest):**
strona ładowała eager 50 × pełnowymiarowy snapshot (~780 KB każdy)
naraz + `proxySnapshot` miał `AbortSignal.timeout(5000)` → masowe 504.
Backend działał poprawnie (zwracał 200/782KB pojedynczo).

**Fix:**
- `apps/web/src/components/LazyLprThumbnail.tsx` — IntersectionObserver
  (ładuje tylko w viewport) + semafor max 4 równoległe fetche + retry 1×
  po 2 s. Użyty w legacy i v2.
- `apps/api/src/lpr-reads/lpr-reads.controller.ts` — proxySnapshot
  timeout 5 s → 15 s.
- Nowa strona `apps/web/src/app/(ba-v2)/building-admin/v2/buildings/[id]/lpr-reads/page.tsx`
  (stat cards, search, chips, paginacja, LprViewer) + tab "Odczyty tablic"
  w `TabBar.tsx`/`strings.ts` (feature `lpr_audit`).

Weryfikacja w DevTools Network: max 4 równoległe requesty obrazków,
tylko widoczne wiersze fetchują.

### 8.h.26 — Logi pytań GateLynk AI + ocena (panel Integratora) ✅ DONE (2026-06-12)

Zgłoszenie (Konrad): tymczasowy panel w Integratorze zapisujący prompty
userów/adminów do GateLynk AI — pytanie + odpowiedź + checkbox OK/NIE OK,
żeby zebrać dataset do dostrojenia LLM.

**Backend (Cloud):**
- Tabela `assistant_query_logs` (migracja `20260612160000`): buildingId FK
  CASCADE, role RESIDENT|BUILDING_ADMIN, userId, question, answer, intent,
  totalMs, model, smart, **ratingOk BOOLEAN (NULL=nieocenione)**, ratedAt.
  Index (buildingId, createdAt DESC) + partial index WHERE ratingOk IS NULL.
- Fire-and-forget INSERT w `resident-assistant.controller.ts` (OBA return
  paths: local-first → model='cloud-local', Edge forward → data.modelUsed)
  i `building-admin-assistant.controller.ts`. Błąd zapisu NIE blokuje
  odpowiedzi (void + .catch → logger.warn).
- Integrator endpoints: `GET /integrator/buildings/:id/assistant-logs`
  (limit/offset/rating=unrated|ok|bad, zwraca items+total+unrated) i
  `PATCH .../assistant-logs/:logId` `{ratingOk: true|false|null}` (null
  cofa ocenę, ratedAt auto). Tenant guard przez `getBuilding()`.

**Frontend:** `/integrator/buildings/[id]/assistant-logs` — filtr chips
(Wszystkie/Nieocenione[badge]/OK/Złe), lista z expandable odpowiedzią,
toggle ✓/✗ (optimistic update + rollback, drugi klik cofa ocenę),
paginacja po 50. Link-karta na stronie obiektu (badge "tymczasowe").

**Gotcha buildy web:** `apps/web` NIE ma własnego node_modules — next
hoistowany do roota monorepo. `pnpm build` w apps/web → "next: command
not found". Działa: `node ../../node_modules/next/dist/bin/next build`.

### 8.h.25 — PLATE_SYNC_ALL przy reconnect Edge ✅ DONE (2026-06-12)

Domyka TODO z 8.h.24: zgubiony outbox-delivery (PLATE_UPSERT) = wieczny
drift `lpr_plates` (Edge sqlite) vs `vehicles` (Cloud Postgres) aż do
ręcznego resync-to-edge. Wzorzec 8.h.2 (CAMERA_SYNC_ALL).

- Cloud `EdgeGateway.pushAccessPointSync` → nowy helper
  `collectPlateSyncItems(prisma, buildingId)`:
  - APPROVED vehicles z unitLabel w JEDNYM query (LATERAL JOIN
    `unit_residents` → `units` → `stairwells`, najnowszy aktywny pivot —
    semantyka jak `computeUnitLabel` w BA service). Tags rozszerzone
    o serviceName/make/model/color (jak `buildPlateSyncPayload`), owner
    bez PII (serviceName albo '').
  - Aktywni goście z `vehiclePlate` (status ACTIVE, okno nie minęło),
    owner `Gość {name} ({inviter})` — konwencja delta-syncu.
  - Dedup po znormalizowanej tablicy, vehicle wygrywa nad gościem
    (case WE387YT) — Edge `lprReplaceAll` robi czysty INSERT, duplikat
    plate wywaliłby transakcję na UNIQUE (camera_device_id, plate).
  - Wire: CMD `PLATE_SYNC_ALL { items: [...] }`, item = `PlateEntry`
    (`validUntil`, nie `validTo`!).
- Edge `tunnel.service.ts` — dedykowany case `PLATE_SYNC_ALL` (wyjęty
  z grupy PLATE_UPSERT/DELETE → executeOnDevice): iteruje po WSZYSTKICH
  kamerach LPR (`lpr.getDeviceIds()`), per kamera `lpr.syncAll` →
  `store.lprReplaceAll` (transakcja DELETE+INSERT). Stary dispatch
  brał tylko jedną kamerę (`payload.cameraDeviceId ?? pierwsza`).
  Akceptuje `items` i legacy alias `plates`.

**Pułapka napotkana:** routing `PLATE_SYNC_ALL` na Edge ISTNIAŁ od
początku (`hikvision-lpr.execute` → `syncAll`), ale (a) Cloud nigdy go
nie wysyłał, (b) obsługiwał jedną kamerę, (c) czytał `payload.plates ??
[]` — gdyby Cloud wysłał `items` do STAREGO Edge, replace-all z pustą
listą WYCZYŚCIŁBY whitelistę. Dlatego deploy w kolejności Edge → Cloud.

**Weryfikacja na produkcji (2026-06-12):** po `flyctl deploy` Edge
reconnect → Cloud log `AP/SCHEDULE/LPR_LINK/CAMERA/PLATE_SYNC_ALL pushed
(… 66 plates)`, Edge log `PLATE_SYNC_ALL: replaced 66 plate(s) on
1 camera(s)`. COUNT lpr_plates = 66 = Cloud APPROVED (17 RESIDENT +
31 SERVICE + 17 DELIVERY + 1 EMERGENCY, 0 aktywnych gości z tablicą).
WD5005P i WE387YT oba z `unit_label = Niewinna 4/2`.

### 8.h.24 — Edge whitelist desync + manual resync ✅ DONE (2026-06-12)

Zgłoszenie: asystent twierdził że WD5005P nie jest na liście a WE387YT
bez lokalu — a oba pojazdy są APPROVED w Cloud z lokalem Niewinna 4/2.

**Diagnoza:** Edge `lpr_plates` rozjechany z Cloud `vehicles`:
- WD5005P — w ogóle nieobecny na Edge (zgubiony sync)
- WE387YT — obecny tylko jako wpis GOŚCIA ("Gość Doktor Jeckyl"), bez
  unit_label; wpis pojazdu mieszkańca nigdy nie dotarł

**Fix:** istniejący endpoint `POST /buildings/:id/vehicles/resync-to-edge`
(Faza C1+R1) — pełen resync APPROVED vehicles przez outbox. Wywołany
node-scriptem NA maszynie prod (signed BA JWT z JWT_SECRET env +
fetch localhost:3000). Wynik: 56 pojazdów → Edge, oba problematyczne
teraz z unit_label.

**Procedura resync (gdy Edge whitelist się rozjedzie):**
```bash
# /tmp/resync_vehicles2.js na prod — sign BA JWT + POST resync-to-edge
flyctl ssh console -a gatelynk-api -C "sh -c 'cd /app && node resync_vehicles2.js'"
```
UWAGA flyctl sftp: `put` NIE nadpisuje istniejącego pliku ("file exists
on VM") — wgraj pod nową nazwą.

**~~TODO~~ (luka systemowa):** brak PLATE_SYNC_ALL przy reconnect Edge
— ✅ zamknięte w 8.h.25 (2026-06-12).

### 8.h.23 — Intent vehicle_owner_by_plate (privacy: tylko lokal) ✅ DONE (2026-06-12)

Zgłoszenie: "Do kogo należy pojazd?" (follow-up po pytaniu o tablicę) →
unknown. Decyzja prywatności (Konrad): NIE ujawniamy właściciela —
odpowiedź podaje TYLKO przypisany lokal ("Nie mogę podać danych
właściciela, ale pojazd przypisany jest do lokalu Niewinna 4/2").

Pierwszy nowy intent dodany PRZEZ schemat 8.h.21 (wpis w registry +
template + builder + 5 testów w katalogu → eval 145/145).

**Defense-in-depth prywatności (3 warstwy, każda samodzielna):**
1. SQL template NIE selectuje `owner` ANI `vehicle_tags` — tagi zawierają
   nazwę właściciela! (live test: WL9397W tags=["Taxi Uber","Toyota",...]
   i Bielik wygadał "należy do Uber, czarny kombi Toyota")
2. `NO_SMART_INTENTS` w app.py — intent pomija smart naturalization,
   template answer (precyzyjny prawnie) idzie bez przeróbek Bielika
3. Deterministic plate-injection w conversation.py — "Do kogo należy
   pojazd?" + tablica w historii → doklej tablicę BEZ LLM (Bielik w
   rewrite zwracał pytanie bez zmian mimo przykładu w prompcie;
   lekcja 8.h.16: deterministyka > LLM)

**PUŁAPKA dla przyszłych intentów z prywatnością:** nie wystarczy nie
selectować wrażliwej kolumny — sprawdź też kolumny pochodne (tags/meta/
opisy) i wyłącz smart rewrap (NO_SMART_INTENTS), bo LLM dopowiada
wszystko co dostanie w rows.

**Verified live:** spoza listy → "nie figuruje na białej liście";
whitelist bez lokalu → "typ: SERVICE, danych właściciela nie mogę podać"
(leak-check: brak Uber/Toyota/Taxi w odpowiedzi); multi-turn →
rewritten deterministycznie "Do kogo należy pojazd WD5005P?".

### 8.h.22 — Staged progress w czacie asystenta (iOS) ✅ DONE (2026-06-12)

Decyzja UX (Konrad): user czekający na odpowiedź LLM nie ma patrzeć w
statyczne "Myślę…" — komunikaty postępu zmieniają się w trakcie i są
dobrane pod TREŚĆ pytania:

| Pytanie zawiera | Etapy |
|---|---|
| brand/kurier (dhl/uber/frisco...) | "Sprawdzam detekcje kamer…" → "Przeglądam rozpoznane napisy…" |
| harmonogram/odbiór/śmieci | "Przeglądam harmonogramy…" → "Sprawdzam ogłoszenia osiedla…" |
| tablica rejestracyjna | "Szukam w rejestrze wjazdów…" |
| ile/wjechało/aut | "Liczę wjazdy i wyjazdy…" |
| regulamin/kontakt/zarządca | "Przeszukuję bazę wiedzy osiedla…" |
| inne | "Przeszukuję bazę zdarzeń…" → "Sprawdzam rejestry…" |

Zawsze: start "Analizuję pytanie…" (1.3s), finał "Formułuję odpowiedź…"
(9s) → long-tail "Jeszcze chwila — analizuję większą ilość danych…"
(zostaje do odpowiedzi).

Implementacja: `AssistantView.swift` — `progressStages(for:)` (keyword
match client-side) + `runLoadingStages` Task cancelowany w defer send().
Etapy SYMULOWANE (backend nie streamuje trace) ale timing dobrany pod
realny flow ai-prototype: classify ~0.5s → SQL/KB 1-3s → Bielik 3-40s.

TODO follow-up: prawdziwy trace streaming — Edge ma SSE endpoint
`/assistant/ask-stream`; Cloud musiałby proxy'ować SSE i iOS konsumować
realne etapy. Symulacja pokrywa 95% wartości UX przy zerowym backendzie.

### 8.h.21 — AI Assistant: schemat na wiele pytań ✅ DONE (2026-06-12)

Koniec z punktowym łataniem asystenta (każde nowe pytanie = chirurgia w 3-4
plikach z pilnowaniem kolejności if-ów, zero testów). Refactor w 3 warstwach:

**1. Katalog pytań + eval (`questions_catalog.yaml` + `eval_classifier.py`):**
- 143 golden questions (140 regex + 3 needs_llm), wszystkie 21 intentów,
  w tym pełna historia zgłoszeń 8.h.12-8.h.17
- Runner: subset-match parametrów, exit 1 przy failu, flaga `--llm`
- **KAŻDA zmiana w klasyfikatorze MUSI przejść `python3 eval_classifier.py`
  przed deployem** (140/140). Nowe zgłoszenie usera → najpierw dodaj do
  katalogu jako failing test, potem napraw.
- Pierwszy audyt znalazł 9 realnych błędów, m.in. pytanie day-summary
  z Cloud szło w `unknown` ("jest zaplanowane" omijało triggery),
  "Pokaż listę urządzeń" (genitive „urządzeń" poza regexem), brand-check
  za późno w kolejności (DPD→detections, DHL→courier zamiast brand).

**2. Deklaratywny rejestr (`intents_registry.yaml` + `intent_registry.py`):**
- Kaskada ~310 linii if-ów → pętla po rejestrze sortowanym po `priority`
- Wpis per intent: patterns/not_patterns, guardy, schema parametrów
  (extractor/default/enum/source), examples (few-shot dla tool-calling)
- **Nowe pytanie = wpis w YAML**, nie edycja kaskady. Ekstraktory
  (range_hours/color/plate/brand/waste) jako nazwane funkcje w Pythonie.
- Publiczne API intent_classifier nietknięte (classify, classify_regex,
  validate, BRAND_KEYWORD_MAP, VALID_INTENTS)

**3. Tool-calling fallback (`tool_calling.py`) — ZA FLAGĄ, default OFF:**
- `TOOL_CALLING_ENABLED=true` (env) włącza Ollama tool-calling jako
  fallback po regex-miss (przed classify_llm)
- **Bielik NIE wspiera tools** (Ollama 400: "does not support tools" —
  limit oficjalnego template SpeakLeash). Na qwen2.5:14b działa 8/10
  parafraz. Włączyć dopiero przy modelu z tools (qwen2.5/qwen3 —
  przełączalne z Cloud Integrator UI).
- Chain: regex → tool-calling (opt-in) → classify_llm → unknown

**Nowa zależność:** `pyyaml` (w requirements.txt; na Edge zainstalowane
w .venv).

**Weryfikacja na produkcji:** eval na Edge 140/140, smoke 3 pytań OK
(w tym wcześniej zepsute "Pokaż listę urządzeń"), day-summary loop żyje.

### 8.h.20 — Day Summary: background pre-generation co 20 min ✅ DONE (2026-06-11)

Zgłoszenie: sekcja "Co dziś się wydarzy" czasem pusta + user musiał czekać
na LLM przy każdym zimnym cache.

**Diagnoza:** logi ai-prototype pokazywały `Knowledge natural answer failed:`
z PUSTYM komunikatem = `httpx.ReadTimeout` (str() pusty — dlatego log mówił
nic). Bielik 11B na M1 z długim KB contextem przekraczał timeout
`ollama_timeout_s * 2 = 30s` → fallback chain → pusta/generic sekcja.

**Fix (4 warstwy):**

1. **`apps/ai-prototype/day_summary.py`** (nowy) — background loop:
   - Generuje predictions + recap co 20 min (SEKWENCYJNIE — Ollama na M1
     i tak serializuje; parallel tylko podbija timeouty)
   - Stale-while-error: nieudana sekcja zachowuje poprzednią wartość
   - Po pełnym failu retry za 5 min zamiast 20
   - Raw-template fallback ("Znalazłem N fragmentów") NIE jest cache-owany
   - `start(ask_fn)` — ask wstrzyknięte z app.py (unika cyklicznego importu)
   - Predictions question z fallbackiem: "Jeśli na dziś nic → podaj
     NAJBLIŻSZE nadchodzące wydarzenia z datami"
2. **`app.py`** — `@app.on_event("startup")` odpala loop;
   `GET /day-summary` zwraca cache w ~5ms
3. **Edge Node** `assistant.controller.ts` — proxy `GET /assistant/day-summary`
   → `:8000/day-summary`
4. **Cloud controller** — `/resident/assistant/day-summary` najpierw próbuje
   cached route (8s timeout), fallback do starej on-demand ścieżki gdy
   Edge starszy build / cache pusty (pierwsze ~60s po boot)
5. **`smart_responder.py`** — knowledge timeout *2→*4 (60s) + `%r` w logach
   (httpx.ReadTimeout ma puste str() — diagnoza trwała przez to za długo)

**iOS (`DaySummaryCard.swift` + `TypewriterText.swift`):**
- Typewriter ZAWSZE przy otwarciu aplikacji — również dla treści z cache
  (decyzja UX: animacja jak ChatGPT to prezentacja, nie maskowanie latencji)
- Dynamiczna prędkość zamiast skip dla >500 znaków: cap całkowitego czasu
  ~8s (320 zn → 40 ch/s, 800 zn → 100 ch/s)

**Efekt:** user otwiera apkę → podsumowanie pojawia się NATYCHMIAST
(z cache wygenerowanego w tle ≤20 min temu) z animacją litera-po-literze.
Transient timeouty LLM same się leczą przy następnym ticku.

### 8.h.19 — Bielik halucynuje datę w "Podsumowanie dnia" ✅ DONE (2026-06-10)

Zgłoszenie: iOS DaySummaryCard pokazywał "Podsumowanie ostatniej doby
(**23 maja 2026**)" mimo że dziś jest 9-10 czerwca. Halucynacja daty.

**Root cause:** 8.h.16 dodał `BIEŻĄCA DATA` injection do
`generate_knowledge_natural_answer` (KB), ale `generate_activity_natural_answer`
(używany dla `recent_activity_summary` = recap w day-summary) wciąż NIE
dostawał daty. Bielik bez kontekstu generuje arbitralną z treningu.

**Fix `apps/ai-prototype/smart_responder.py`:**

1. **Inject `BIEŻĄCA DATA: 2026-06-10`** do user_msg dla activity
2. **System prompt rule:**
   ```
   DATY:
   - ZAKAZ zgadywania konkretnej daty.
   - Używaj relatywnych form: "dzisiaj" / "ostatnia doba".
   - Cytuj BIEŻĄCĄ DATĘ podaną wyżej.
   - NIGDY nie pisz konkretnej daty z głowy ("23 maja") — to halucynacja.
   ```

**Cache invalidate:** Cloud `/day-summary` ma in-memory cache 30 min per
buildingId. Po deploy konieczny restart machine (`flyctl machine restart
<id> -a gatelynk-api`) żeby wyczyścić — alternatywnie pull-to-refresh
w iOS używa `?refresh=1`.

**Verified live:**
```
Przed: "Podsumowanie ostatniej doby (23 maja 2026)..."
Po:    "Podsumowanie ostatniej doby (2026-06-10)..."
```

### 8.h.16 — Filtrowanie przeszłych dat z harmonogramu ✅ DONE (2026-06-09)

Zgłoszenie: "Kiedy planowany odbiór zmieszanych?" → odpowiedź zawierała datę
**2026-06-02** mimo że dziś jest 2026-06-09 (data minęła 7 dni temu). LLM
brał całą listę z fragmentu bez świadomości "dziś".

**Pierwsza próba (sama instrukcja w prompcie):** dodanie "BIEŻĄCA DATA" +
"pokaż TYLKO daty >= bieżącej" — Bielik filtrował tylko dla krótkich list
(2 daty). Przy 3+ datach dalej zwracał wszystkie. LLM nie zinternalizował
warunku consistently.

**Fix deterministic** w `apps/ai-prototype/smart_responder.py`:

1. **Python pre-processing** w `generate_knowledge_natural_answer`:
   ```python
   iso_re = re.compile(r"\b(20\d{2})-(\d{2})-(\d{2})\b")
   def _annotate_dates(text: str) -> str:
       def _repl(m):
           d = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
           if d < today:
               return f"{m.group(0)} (MINĘŁA)"
           return m.group(0)
       return iso_re.sub(_repl, text)
   ```
   Każda data < today dostaje sufix `(MINĘŁA)` PRZED wysłaniem do LLM.

2. **System prompt rule** dla SYSTEM_PROMPT_KNOWLEDGE:
   "KAŻDA data oznaczona (MINĘŁA) = NIE umieszczaj w odpowiedzi.
    Pokaż TYLKO daty BEZ tego oznaczenia. Sortuj rosnąco."

**Verified live (2026-06-09):**
| Pytanie | Odpowiedź |
|---|---|
| Zmieszane | "16 czerwca i 30 lipca 2026" (2 czerwca pominięte) |
| Szkło | "30 lipca 2026" (5 czerwca pominięte) |
| BIO | "26 czerwca i 31 lipca" (22/29 maja, 6 czerwca pominięte) |
| Papier | "12 czerwca i 7 sierpnia" (pełna lista przyszła) |

**Generalne lekcja:** LLM (nawet Bielik) nie jest niezawodnym filterem
dat/liczb. Deterministic Python pre-processing zostawia LLM tylko do
generowania naturalnego polskiego, fakty są pre-filtered.

### 8.h.15 — Multi-turn rewrite zachowuje KB context ✅ DONE (2026-06-09)

Zgłoszenie: po pytaniu "Jak wygląda harmonogram odbioru odpadów?" follow-up
"A Zmieszane?" spadał do `search_by_waste_today` (vision history, 24h, 0
detekcji) zamiast `search_knowledge_base` (harmonogram).

**Root cause:** Multi-turn rewrite w `conversation.py` używa LLM ale
SYSTEM_PROMPT_REWRITE nie miał przykładu dla harmonogramu. Bielik przepisywał
"A Zmieszane?" jako "Czy były zmieszane?" zamiast "Kiedy planowany odbiór
zmieszanych?" — i intent_classifier matchował "zmieszane" w WASTE_KEYWORDS
→ waste history zamiast KB.

**Fix `conversation.py`:**

Dodanych 3 nowych przykładów w `SYSTEM_PROMPT_REWRITE`:
```
HISTORIA: "Kiedy jest planowany odbiór śmieci?" → "..."
PYTANIE: "A Zmieszane?"
WYNIK: "Kiedy jest planowany odbiór zmieszanych?"

HISTORIA: "Kiedy następny odbiór szkła?" → "..."
PYTANIE: "A papier?"
WYNIK: "Kiedy następny odbiór papieru?"

HISTORIA: "Jak wygląda harmonogram odbioru odpadów?" → "..."
PYTANIE: "A papier?"
WYNIK: "Kiedy w harmonogramie jest planowany odbiór papieru?"
```

**Verified live:**
```
History: "Jak wygląda harmonogram odbioru odpadów?" → list of dates
Q: "A Zmieszane?"
Rewritten: "Kiedy w harmonogramie jest planowany odbiór zmieszanych odpadów?"
Intent: search_knowledge_base
A (smart, Bielik): "Planowany odbiór zmieszanych odpadów dla adresu ul.
   Niewinna 4, 02-995 Warszawa jest zaplanowany na 2026-06-02 oraz 2026-07-28."
```

**Edge case M1 latency:** Bielik 14B + smart_responder + długi context history
może timeout (60s default). Mitigacja: bardziej zwięzły history (max 4 ostatnich
tur), lub fallback do template mode automatycznie po 30s. TODO follow-up.

### 8.h.14 — KB routing dla harmonogramu śmieci ✅ DONE (2026-06-09)

Zgłoszenie: "Kiedy jest planowany odbiór śmieci?" → spadało do
`search_by_waste_today` (vision history) zamiast `search_knowledge_base`
(harmonogram). KNOWLEDGE_TRIGGER_KEYWORDS miało tylko literal triggers
("kiedy odbier"/"kiedy odbiór") — pytanie "kiedy jest planowany odbiór"
ma słowa w środku, nie matchuje.

**Fix `apps/ai-prototype/intent_classifier.py`:**

Dodanych 16 nowych KNOWLEDGE_TRIGGER_KEYWORDS dla pytań o przyszłość:
- "planowany odbiór" / "planowany wywóz"
- "kiedy jest odbiór" / "kiedy będzie odbiór"
- "następny odbiór" / "kolejny odbiór" / "najbliższy odbiór"
- "kiedy śmieciarka będzie" / "kiedy zabiorą śmieci"
- Warianty bez polskich znaków

**Semantyka routing:**
| Pytanie | Intent | Powód |
|---|---|---|
| "ostatnio była śmieciarka" / "ostatnio był odbiór" | `search_by_waste_today` | HISTORIA (vision) |
| "planowany" / "następny" / "kiedy będzie" | `search_knowledge_base` | HARMONOGRAM (KB doc) |

**Verified live (Bielik smart):**
```
Q: "Kiedy jest planowany odbiór śmieci?"
A: "Niewinna 4, 02-995 Warszawa, planowany jest odbiór śmieci w
   następujących terminach:
   - BIO: 2026-05-22, 2026-05-29, 2026-06-06, 2026-06-26, ...
   - ZIELONE: 2026-05-28, ...
   - ZMIESZANE: 2026-06-02, ...
   - SZKŁO: 2026-06-05, ...
   - METALE_I_TWORZYWA_SZTUCZNE: 2026-06-12, ...
   - PAPIER: 2026-06-12, ..."
```

KB ma uploaded dokument `harmonogram_smieci_strukturalny_llm` (INNE).
Routing prawidłowy + Bielik rendering pięknie po polsku.

### 8.h.13 — Full brand keyword map (50+ entries) ✅ DONE (2026-06-09)

Zgłoszenie: "Kiedy ostatnio było FRISCO?" zwracało "nie było" mimo że
`vision_detections.brand_detected = 'FRISCO'` z 2026-06-08 09:44.

**Bug:** `BRAND_KEYWORDS` w `intent_classifier.py` miał tylko 15 starych
kurierów (DHL/DPD/InPost/UBER itp.). Po 8.h.5 YOLO `brand_matcher.py` zna
40+ brandów (retail/AGD/spożywka/apteki) ale intent_classifier ich nie
rozpoznawał. Dodatkowo `validate()` sprawdzał brand w hardcoded set z
`BRAND_KEYWORDS` — nawet gdyby keyword był rozpoznany, validate odrzucił.

**Fix `apps/ai-prototype/intent_classifier.py`:**
- Nowy `BRAND_KEYWORD_MAP: dict[str, str]` — 50+ wpisów (lowercase keyword
  → canonical UPPER), w sync z YOLO BRAND_PATTERNS
- Multi-word brands ("media expert"/"rtv euro agd") z wariantami spacja/bez
- `_extract_brand_keyword` sort by length desc — dłuższe matche wygrywają
- `validate` brand: `set(BRAND_KEYWORD_MAP.values())` zamiast `BRAND_KEYWORDS`

**TODO: maintenance** — kolejność źródeł brandów:
1. `apps/yolo-vision/brand_matcher.py` — BRAND_PATTERNS (regex per brand)
2. `apps/ai-prototype/intent_classifier.py` — BRAND_KEYWORD_MAP
3. UI Cloud Integrator (WASTE_KEYWORDS w vision page) — analogicznie

Dodanie nowego brandu wymaga 3 plików. Future: shared registry / autocodegen
z YOLO source. Na razie manual sync (sprawdź `grep -oE '"[A-Z_]+":' brand_matcher.py`).

**Verified live (po deploy):**
```
Q: "Kiedy ostatnio było FRISCO?" (smart, Bielik)
A: "Ostatnio marka FRISCO została zarejestrowana wczoraj, 8 czerwca 2026
   roku, o godzinie 9:44. W obrazie z kamery widoczne były 4 samochody
   osobowe, 1 ciężarówka i 2 pieszych."

Q: "Czy był Media Expert?" → intent=search_by_brand_today, brand=MEDIA_EXPERT
```

### 8.h.12 — Brand keyword → vision intent (bezwarunkowo) ✅ DONE (2026-06-09)

Zgłoszenie: iOS Assistant odpowiada "Ostatnio nie było żadnego Ubera" mimo
że BA Vision page pokazuje 5 detekcji UBER w `vision_detections.brand_detected`.

**Bug:** `intent_classifier.classify` wymagał "camera-phrasing"
(`widziałeś|kamera|zobacz|wykrył|rozpozna|monitoring`) żeby aktywować
`search_by_brand_today` (query `vision_detections`). Naturalne pytanie
"Kiedy ostatnio był Uber?" nie ma tych słów → fallback do `search_vehicles_today`
który query `lpr_reads.vehicle_brand`. Ale `vehicle_brand` w lpr_reads to
**numerical Hikvision model IDs** (`#1631`/`#1102`, patrz pułapka #7), NIE
nazwy marek. `LIKE '%uber%'` zawsze 0 rows.

**Fix `apps/ai-prototype/intent_classifier.py`:**
- Brand keyword match → **bezwarunkowo** `search_by_brand_today` (vision intent)
- `_extract_range_hours` rozpoznaje "kiedy ostatnio"/"kiedy był" → 168h (tydzień)
- W brand intent override: jeśli "ostatnio" → min 168h (domyślnie 24h za wąskie)

**Verified live (po deploy):**
```
Q: "Kiedy ostatnio był Uber?" (template mode)
A: 5 detections, intent=search_by_brand_today, brand=UBER, range=168h

Q: "Kiedy ostatnio był Uber?" (smart mode, Bielik)
A: "Ostatni raz Uber był widziany dzisiaj, 8 czerwca 2026 roku,
    o godzinie 19:16. W ciągu ostatnich 168 godzin zarejestrowano
    pięć obserwacji tej marki."

Q: "A wczoraj?" (multi-turn z context)
A: search_by_brand_today, dalej UBER, range 168h
```

### 8.h.11 — iOS Assistant czyta LLM z Edge DB ✅ DONE (2026-06-09)

Problem: po fazie 8.h.7 Bielik był aktywny tylko dla `VisionLlmSummarizerService`
(Edge Node). iOS Assistant przez `apps/ai-prototype` (Python FastAPI na Edge
:8000) dalej używał env var `OLLAMA_MODEL=qwen2.5:14b`. Cloud Integrator UI
nie kontrolował tego.

Rozwiązanie — unified config:
- Nowy moduł `apps/ai-prototype/llm_config.py` z `get_active_llm()`:
  - Czyta `llmUrl`/`llmModel`/`llmEnabled` z Edge `/ai-engine` REST (localhost:4000)
  - Cache 30s (cost: ~1ms cache miss)
  - Fallback env vars przy błędach (backwards compat)
  - `source: 'edge_db' | 'env_fallback'` flag w `/health`
- Refactor `CONFIG.ollama_url`/`model` → `get_active_llm().url`/`model`
  w `app.py`, `conversation.py`, `intent_classifier.py`, `smart_responder.py`
- 6 + 1 + 9 + 1 = 17 call-sites zaktualizowanych
- Edge process restart (kill + uvicorn nohup background)

**Verified live (Edge PID 92993):**
```
GET http://localhost:8000/health →
  model: SpeakLeash/bielik-11b-v2.3-instruct:Q4_K_M
  llm_source: edge_db
```

**Single source of truth:**
```
Cloud Integrator UI → ai_engines.llmModel (Edge sqlite)
         ├→ VisionLlmSummarizerService (Edge Node, Vision summaries)
         └→ ai-prototype get_active_llm() (Edge Python, iOS Assistant)
```

1 zmiana w Cloud UI → oba services przełączają model w max 30s (cache TTL).

### 8.h.10 — Bielik 11B pobrany + zweryfikowany ✅ DONE (2026-06-08)

Tag w Ollama wymaga `:Q4_K_M` (default quantization), bez tagu zwraca
"manifest unknown". Pull dla Villa Natura:
```bash
ollama pull SpeakLeash/bielik-11b-v2.3-instruct:Q4_K_M
```
6.7 GB, ~1 min na MacBooku M1.

**Test PL prompt** (truck=1, car=2, brand=MEDIA_EXPERT):
- Bielik (4.7s): "Na wjeździe wykryto 2 samochody i 1 ciężarówkę.
  Media Expert jest rozpoznana z 84% pewnością." — naturalne PL, ale 2 zdania.
- Sysprompt zaktualizowany: "DOKŁADNIE 1 zdanie. Bez procentów ani »pewności«".

Edge sysprompt + tag w dropdown zsynchronizowane. User może teraz przełączyć
przez Cloud Integrator UI (1 klik na badge → Save).

### 8.h.9 — Modele rekomendowane dla polskiego ✅ DONE (2026-06-08)

Zgłoszenie: "qwen2.5:14b słabo radzi sobie z polskim". Dorzucone rekomendacje
do dropdownów (Cloud Integrator + Edge UI):

**🇵🇱 Najlepsze dla polskiego (priority order):**
1. **`SpeakLeash/bielik-11b-v2.3-instruct`** ⭐ — dedykowany PL model od
   konsorcjum SpeakLeash. Trenowany na polskich tekstach, świetny w
   składni/fleksji/formach grzecznościowych. ~7GB, ~30-50 tokens/s na M1.
2. **`qwen3:30b-a3b`** — Qwen3 MoE (mixture-of-experts), aktywne tylko 3B
   parametrów per token. Szybkie + nowsza generacja od qwen2.5 z poprawionym
   treningiem PL. User Villa Natura już ma zainstalowany ✓.
3. **`aya-expanse:8b`** — Cohere multilingual, dobry PL.

**Pomijać:** PLLuM (nie ma w Ollama registry, tylko HuggingFace), llama3.3:70b
(za duży dla M1 — 45GB).

**Weryfikacja URL Ollama 2026-06-08:**
- ✓ `SpeakLeash/bielik-11b-v2.3-instruct` (200, tag namespace)
- ✓ `qwen3`, `qwen3:30b-a3b`, `aya-expanse` (200)
- ✗ `bielik:11b` (404, nie ma w official library)
- ✗ `pllum` (404, tylko HuggingFace)

LLM_MODEL_PRESETS w `IntegratorAiEngineCard.tsx` + datalist w `ai-engine.html`
zsynchronizowane: PL/Qwen3 na górze, general-purpose poniżej.

### 8.h.8 — Wybór z faktycznie zainstalowanych modeli Ollama ✅ DONE (2026-06-08)

Zgłoszenie: "czy modele w dropdown są zainstalowane czy się pobierają?".
Odpowiedź: **NIE są auto-pulled** — dropdown to PRESETY popularnych. Wybranie
nieinstalowanego = HTTP 404 z Ollamy przy pierwszym frame, retry w pętli.

Dorzucone narzędzie do sprawdzenia co user faktycznie ma pulled:

- Migration `20260608170000_add_llm_available_models` — `ALTER TABLE
  ai_engines ADD COLUMN llmAvailableModels JSONB`
- Tunnel: nowy CMD `LLM_TEST` (Cloud→Edge) + EVT `LLM_TEST_RESULT`
  (Edge→Cloud z `availableModels: string[]`)
- Edge `tunnel.service.ts` handler `LLM_TEST` — wywołuje
  `llm.testLlmConnection()`, wysyła EVT z availableModels
- Cloud `EdgeGateway` handler `LLM_TEST_RESULT` — zapisuje
  `llmLastTest*` + `llmAvailableModels` (JSON array)
- Cloud endpoint `POST /api/integrator/buildings/:id/ai-engine/test-llm`
- Cloud Integrator UI `IntegratorAiEngineCard`:
  - Przycisk "🔍 Sprawdź zainstalowane modele" — emit LLM_TEST + poll 30s
  - Dropdown z prefiksem (✓ zainstalowane / ⚠ trzeba pobrać)
  - Modele spoza presetów też pokazywane (np. qwen2.5:32b zainstalowane)
  - Panel "Zainstalowane w Ollama (N)" z klikalnymi badge — klik = wybór

**Weryfikacja na produkcji (Villa Natura, MacBook M1):**
```
POST /ai-engine/test-llm → 27ms OK
availableModels: ["bge-m3:latest", "qwen2.5:14b", "qwen2.5:32b", "qwen3:30b-a3b"]
```
Tylko `qwen2.5:14b` z presetów jest pulled. Pozostałe presety (7b, 3b,
llama, mistral, gemma, phi) wymagają `ollama pull` przed użyciem.

### 8.h.7 — LLM Summarizer config (Ollama) w obu panelach ✅ DONE (2026-06-08)

Zgłoszenie: "gdzie wybór LLM?". Dotąd `VisionLlmSummarizerService` używał
TYLKO env vars (`VISION_LLM_OLLAMA_URL`, `VISION_LLM_MODEL`) — niewidoczne
w UI, nieedytowalne bez SSH. Rozszerzenie `ai_engines` o LLM fields zamiast
osobnej tabeli — semantycznie zawsze 1:1 (YOLO bez LLM jest useful, LLM bez
YOLO nie ma sensu — brak klatek do summarization).

- Migration `20260608140000_add_llm_to_ai_engines` — `ALTER TABLE ai_engines
  ADD llmUrl/llmModel/llmEnabled + 5× llmLastTest*` (Cloud Postgres)
- Edge sqlite — `ensureColumns` migration `llm_url/llm_model/llm_enabled`
- `aiEngineGet/Upsert` — partial update (undefined = zachowaj obecne)
- `VisionLlmSummarizerService.resolveActiveLlm()` — DB priority, env fallback,
  dynamiczny reload przy każdym ticku (zmiana w UI = efekt w max 30s bez restartu)
- `VisionLlmSummarizerService.testLlmConnection()` — `GET /api/tags` na Ollama,
  zwraca `availableModels: string[]` (lista zainstalowanych modeli)
- Edge REST `POST /ai-engine/test-llm` — wywołuje powyższe lokalnie
- Tunnel: `AI_ENGINE_CONFIG_UPDATE` + `AI_ENGINE_REPORT` payload rozszerzone
  o `llmUrl/llmModel/llmEnabled`
- Cloud `IntegratorService.upsertAiEngineConfig` — partial update z COALESCE
  w ON CONFLICT (zachowuje istniejące pola gdy podzbiór patcha)
- Edge UI `ai-engine.html` — sekcja "🧠 LLM Summarizer (Ollama)" z URL +
  datalist (presety + availableModels po teście), klikalne badge → ustaw model
- Cloud Integrator `IntegratorAiEngineCard.tsx` — sekcja LLM z purple
  gradient po YOLO config, dropdown 8 modeli + custom, wspólny "Zapisz"
  zapisuje YOLO + LLM razem

**LLM model presety** (popularne dla PL polskiego output):
- qwen2.5:14b (rekomendowany, ~9GB)
- qwen2.5:7b/3b (szybsze, mniejsze)
- llama3.2:3b, llama3.1:8b, mistral:7b, gemma2:9b, phi3.5:3.8b

**Weryfikacja na produkcji:** Migration applied, Edge endpoint zwraca LLM
fields, VisionLlmSummarizerService log `source=env` dopóki user nie wpisze
URL w Cloud/Edge UI.

### 8.h.6 — Edge UI dla AI Engine + Edge→Cloud sync ✅ DONE (2026-06-08)

Zgłoszenie: "gdzie wskazujemy adres Edge AI?". Odkryta rozbieżność —
Edge miał config (z auto-migracji env var `YOLO_URL`, buildingId=0 placeholder),
Cloud DB `ai_engines` był pusty, Cloud Integrator UI pokazywał "Brak konfiguracji"
mimo że Edge działał.

- Edge REST endpointy `apps/edge/src/devices/cameras/ai-engine.controller.ts`:
  - `GET /ai-engine` — zwraca current config + source (`env`|`cloud`|`manual`|`none`)
  - `PUT /ai-engine` — walidacja URL (http[s]://), zapis do sqlite, emit AI_ENGINE_REPORT
  - `POST /ai-engine/test` — local test (bez tunela) z URL/healthPath override
- Edge UI strona `apps/edge/public/ai-engine.html` (Alpine.js, standalone):
  - URL / Health path / Model dropdown / Enabled
  - "🩺 Testuj połączenie" — POST `/ai-engine/test`, wyświetla ms + statusCode
  - "💾 Zapisz" — PUT, badge source zmienia się na "manual"
  - Auto-load aktualnego stanu z `GET /ai-engine`
- React SPA Sidebar — Bot icon link do `/ui/ai-engine.html` (external page, poza Wouter routing)
- Legacy index.html — przycisk "🤖 AI Engine" obok "Dodaj urządzenie"
- main.ts alias `app.use('/ui/ai-engine.html', sendFile(...))` PRZED SPA fallback
- Tunnel: nowy EVT `AI_ENGINE_REPORT` (Edge → Cloud, payload `{url, healthPath, model, enabled, sourceBuildingId}`)
- Edge `VisionDetectService.setTunnelSend()` auto-emit przy każdym tunnel reconnect (defense-in-depth)
- Cloud `EdgeGateway.handleMessage` reaguje na `AI_ENGINE_REPORT` — raw SQL `INSERT ... ON CONFLICT(buildingId) DO NOTHING` — Cloud user-set z Integrator panel ZAWSZE wygrywa, Edge auto-migration z env tylko gdy Cloud nie ma row

**Cyclic dependency napotkany:** AiEngineController potrzebuje TunnelService,
ale TunnelModule importuje DevicesModule. Rozwiązanie: użyć lazy-injected
`VisionDetectService.tunnelSend` (wzorzec już istnieje od fazy 8.g dla
ANOMALY_DETECTED) — dodać metodę `emitAiEngineReport()` na VisionDetectService,
AiEngineController woła ją.

**Weryfikacja na produkcji (Villa Natura):**
- `GET http://localhost:4000/ai-engine` → `source: "cloud"`, buildingId=9
- Cloud DB `ai_engines` ma 1 row (b9, url=http://192.168.1.109:11500)
- AI_ENGINE_REPORT z Edge przy reconnect → ON CONFLICT skipped (Cloud user-set już istnieje)

### 8.h.5 — Waste operators PL + filter "tylko śmieciarki" ✅ DONE (2026-06-05)

Zgłoszenie: "jak wyszukać śmieciarkę?". Diagnoza:
- 0 detekcji w bazie miało `waste_category != null` mimo że waste_matcher.py
  istnieje od 2026-05-19 (5 frakcji SZKŁO/PAPIER/PLASTIK/BIO/ZMIESZANE +
  REMONDIS/MPGK/MPO/STENA/AMEST/FBSERWIS jako operatorzy)
- Powód: większość operatorów PL nie była w liście (SUEZ/Veolia/ZGK/FCC/BYŚ/itd.)
- Plus brak quick-filter w UI; user musiał wpisywać po kolei "szkło"/"papier"

Naprawione:
- `waste_matcher.py` — 13 nowych operatorów + `GENERIC_WASTE` catch-all
  (odpady/komunal/wywóz/śmieciarka):
  - SUEZ (SUEZ + SITA legacy), VEOLIA, TONSMEIER, ENERIS, BYS, FCC, LEMAR,
    EKOSYSTEM, PARTNER, ZGK, PUK, ZUK
- UI: dedykowany toggle "🗑️ Tylko śmieciarki" w sidebar Vision page
  - Filter: `wasteCategory != null` OR textRaw zawiera któreś z 30+
    keywords (frakcje + operatorzy)
  - WASTE_KEYWORDS list w sync z waste_matcher.py — manual maintenance
- YOLO daemon restart na MacBooku (launchctl reload)

**TODO follow-up:**
- WASTE_KEYWORDS duplikat z waste_matcher.py — single source of truth byłby
  ładniejszy (eksport z YOLO endpoint `GET /brand_known` / `GET /waste_known`).
  Na razie manual sync.
- BA Vision page → BA v2 layout (legacy panel migracja, większy refactor)

### Konstanty i enum-y (źródło prawdy)

| Plik | Co |
|---|---|
| `apps/api/src/buildings/buildings.constants.ts` | OBJECT_TYPES, OBJECT_TYPE_LABELS, BuildingFeatures, DEFAULT_FEATURES |
| `apps/api/src/access-points/access-points.constants.ts` | AP_CATEGORIES, AP_CATEGORY_LABELS, LPR_DIRECTIONS |
| `apps/api/src/buildings/feature-permissions.constants.ts` (faza e+g) | SYSTEM_FEATURES, FEATURE_LABELS, ROLE_LABELS, DEFAULT_PERMISSIONS, AI_ENGINE_DEPENDENT_FEATURES |

Wszystkie konstanty mają polskie labels w `*_LABELS` mapach — UI bierze stamtąd
żeby nie hardkodować w komponentach.

## Mapa osiedla w panelu BA (2026-09-08)

Wytyczne: paczka `gatelynk-mapa-villa-natura` (render + `konfiguracja-budynkow.json`,
28 obszarów, 55 miejsc). Zasady: przypisanie = (osiedle, obszar `buildings[].id`,
część A/B) → **ID lokalu z bazy** (nigdy adres); A/B to obszary na rysunku, NIE
numery /1 i /2; Budynek 16 ma tylko A. Nieczytelne adresy zostają puste.

- **DB:** `estate_maps` (1 per Building: `imageUrl`, canvas, `config` JSON) i
  `estate_map_slots` (UNIQUE `(buildingId, mapBuildingId, slot)` + UNIQUE `unitId`).
- **API** `apps/api/src/estate-map/` — `GET/PUT /building-admin/buildings/:id/estate-map`,
  `PUT/DELETE …/estate-map/slots/:mapBuildingId/:slot`. Zamiana atomowa w
  `$transaction` + `pg_advisory_xact_lock(ns::int, buildingId::int)` (**rzutuj
  na int — Prisma wysyła liczby jako bigint i funkcja „nie istnieje"**).
  Konflikty: `expectedUnitId` ≠ stan bazy → 409 `STALE`; zajęte miejsce bez
  `replace` → 409 `SLOT_OCCUPIED`; lokal gdzie indziej bez `move` → 409
  `UNIT_ASSIGNED_ELSEWHERE`; wyścig na UNIQUE → 409 `RACE`. Testy:
  `test/estate-map.e2e-spec.ts` (12, w tym równoległe żądania dwóch adminów).
- **Web:** zakładka „Mapa osiedla" (`v2/buildings/[id]/map`), komponent
  `components/ba-v2/estate-map/EstateMapView.tsx` (obszary w % canvasu, zoom
  przez szerokość plane, bez transformów). Konfiguracja Villa Natura bundlowana
  w `apps/web/public/estate-maps/` — pierwszy start: przycisk „Użyj wbudowanej
  mapy" (PUT config). Podmiana konfiguracji usuwa przypisania do nieistniejących
  obszarów i raportuje `removedAssignments`.
- Bramy na mapie są tylko informacyjne (`connection: null` w paczce) — powiązanie
  z access-pointami to osobny krok.

## LPR: odczyty niepotwierdzone i dopasowanie łagodne (2026-09-15)

Incydent VN 13.09 17:51: mieszkaniec (WE387YT) wjechał tuż za poprzednim autem
przez otwartą bramę, kamera zebrała 1 czytelną klatkę i odczytała „WE38711"
(Y→1, T→1). Reguła `MIN_AGREED_FRAMES=2` w `lpr-alertstream.service.ts`
odrzucała taki odczyt CAŁKOWICIE — bez wpisu w `lpr_reads`, bez Cloud, bez
pusha; w panelu przejazd nie istniał.

- **Odczyt niepotwierdzony** (1 klatka / poniżej `MIN_CONFIDENCE`) jest
  wstrzymywany 8 s (`UNCERTAIN_HOLD_MS`) i anulowany, jeśli ta kamera da w tym
  czasie pewny odczyt; inaczej trafia do `HikvisionLprService.handleUncertainRead`.
- **Dopasowanie łagodne** (`plate-fuzzy.util.ts`, testy node:test w
  `plate-fuzzy.util.spec.ts`): koszt 1 za znak z tej samej klasy pomyłek OCR
  (szersze klasy niż ścisłe `OCR_EQUIV_SETS`: m.in. 1/I/L/T/Y/7), twarda
  różnica = odrzucenie; budżet 2 dla tablic 7-znakowych, 1 dla krótszych;
  DOKŁADNIE jedna tablica z rejestru w budżecie, inaczej niejednoznaczność.
  Sprawdzane też w `handleAnprEvent` po fail ścisłego OCR-fuzzy.
- **Wynik:** dopasowanie → read `matched=1, gate_opened=0, reason=probable_match`
  (Cloud push „🚗 Prawdopodobnie Twój pojazd wjechał … kamera odczytała X",
  panel: pill „prawdopodobny · nie otwarto"); brak dopasowania i pewność ≥0.5 →
  read `matched=0, reason=unconfirmed` (panel: „odczyt niepotwierdzony", Cloud
  nie pushuje). **Brama NIGDY nie otwiera się z dopasowania łagodnego** —
  otwiera ją wyłącznie odczyt ścisły lub ścisły OCR-fuzzy.
- Payload `LPR_READ` ma nowe pole `ocrRaw` (surowy odczyt); starszy Cloud je
  ignoruje. Wdrożone na oba Edge (VN + Villa Natura) 2026-09-15.

## Pojazdy: przełącznik „otwieraj bramę po rozpoznaniu" (autoOpen, 2026-09-25)

- `vehicles.autoOpen` (default `true`) — mieszkaniec przełącza w karcie pojazdu
  (Glass: karta statusu ANPR; GateLynk: sekcja „Automatyczny wjazd" w formularzu).
  `PATCH /resident/vehicles/:id { autoOpen }`. Dostępne tylko dla pojazdu
  APPROVED (PENDING zapisuje wartość, ale nie synchronizuje do Edge — nie był
  w allowliście).
- Egzekwowane OFFLINE na Edge: `lpr_plates.auto_open` (NULL/1 = otwieraj,
  0 = nie). `handleAnprEvent`: po cooldownie, przed regułami gościa —
  `match.autoOpen === false` → `finalizeRead(matched:1, opened:0,
  reason:'auto_open_disabled')`, bez wyzwalania AP i bez cooldownu. Tablica
  jest nadal ZNANA (historia, push „rozpoznano… brama nie została otwarta").
- Pole leci w każdym `PLATE_UPSERT` (BA `buildPlateSyncPayload`, wspólny
  `common/plate-sync.ts` dla mieszkańca i konsjerża) i w `PLATE_SYNC_ALL`
  (`collectPlateSyncItems`). Stary Edge ignoruje pole (= otwiera).
- **PUŁAPKA: `PLATE_UPSERT` ZAWSZE pełnym wpisem.** Edge robi
  `INSERT OR REPLACE` — częściowy payload (np. `{plate, owner}`) kasuje na Edge
  `unit_label`, `vehicle_kind`, `vehicle_tags`, okno ważności i `auto_open`.
  Tak działała ścieżka „kosmetyczna" mieszkańca (kolor, `notifyOnUse`) do
  2026-09-25. Nowe ścieżki: `vehiclePlateSyncPayload(prisma, row)`.
- Test: `apps/api/test/vehicle-auto-open.e2e-spec.ts` (outbox jest
  asynchroniczny — test odpytuje z oczekiwaniem, nie od razu po odpowiedzi).

## LPR: kamera MUSI mieć jawne powiązanie z punktem dostępu (2026-09-27)

Incydent VN (WE1MH70, 26.09 22:37): obie kamery LPR na VN nie miały ani
`lpr_camera_ap_links`, ani `linkedAccessPointId`, ani
`linkedIntercomDeviceId`/`linkedRelayIndex`. Edge wpadał w fallback „pierwszy
zarejestrowany domofon + przekaźnik 1 (DoorNum=2)" — przez 7 tygodni każde
dopasowanie z kamery WJAZDOWEJ i WYJAZDOWEJ pulsowało ten sam przekaźnik nr 2
domofonu wjazdowego (.10), a szlaban wjazdowy wisi na przekaźniku 0 (tak
otwiera go apka). Akuvox odpowiada OK także na przekaźnik bez szlabanu →
`gate_opened=1` w odczycie mimo zamkniętej bramy. Ta sama wada na b9 (kamera
wjazdowa → domofon WYJAZDOWY .100), niewidoczna, bo kamera .64 leży.

Decyzja: **fallback usunięty** (`firstIntercomId` skasowany). Kolejność w
`handleAnprEvent`: (1) `lpr_camera_ap_links` (integrator: Urządzenia →
„Powiązania kamer LPR", z kierunkiem IN/OUT — zasila też exit-grace),
(2) `config.linkedAccessPointId` (BA: `PATCH …/lpr-cameras/:uuid/linked-ap`),
(3) JAWNE `linkedIntercomDeviceId` + `linkedRelayIndex`. Bez żadnego z nich →
`reason='camera_not_linked'`, brama NIE otwierana, wpis `error` w event_log.
Deploy tej wersji na osiedle bez powiązań ZATRZYMUJE automatyczne otwieranie —
najpierw powiązania w panelu, potem Edge. Etykiety reason w iOS
(`LprEventReading`) i panelu (vehicles/lpr-reads/LprViewer).

## Akuvox R29: ucięte nocne snapshoty = szary pas na podglądzie (2026-09-27)

Firmware kasety ma sztywny bufor snapshotu (~700 KB): nocny, zaszumiony kadr
1920×1080 nie mieści się i `:8080/picture.jpg` ORAZ każda klatka
`:8080/video.cgi` wracają ucięte — poprawny nagłówek, stałe `Content-Length`
(VN .23: 724 801 B), brak FFD9. Dekoder rysuje tyle, ile dostał, resztę
wypełnia szarością. Parametry `?resolution=…/?quality=…` → 404 (brak wsparcia).
Edge: `isCompleteJpeg` (`devices/cameras/jpeg.util.ts`) odrzuca taki plik →
fallback RTSP przez ffmpeg (`live/ch00_0`, 704×576, ~1.8 s, memo 2 s), a
`pipeVideoStream` po sondzie przełącza stream na ffmpeg (flaga per IP,
TTL 10 min). Objaw w logu: `Akuvox <ip>: snapshot ucięty przez firmware`.
Test: `jpeg.util.spec.ts` (node:test, kompilacja standalone jak exit-grace).

## LPR (edge-ocr): decyzja w trakcie serii klatek + wyzwalacz ruchem (2026-09-29)

Pomiar VN (7 dni): od zdarzenia kamery do decyzji ~3,7 s (5 klatek co 500 ms +
wspólny OCR), a w 52 % przejazdów tablica czytelna tylko na 2/5 klatek; dla aut
z rejestru 30–50 % przejazdów kończyło się `probable_match` (bez otwarcia).
Zmiana w `lpr-alertstream.service.ts` + czysty `lpr-pass.ts` (`PassAccumulator`,
testy node:test):
- klatki bez przerw (~4–5/s, ISAPI picture ~200 ms), OCR każdej od razu
  (≤2 równolegle), głosowanie po każdej klatce; pisownie różniące się znakami
  mylonymi przez OCR (O/0, I/1, S/5, Z/2, B/8) scalają się w jeden głos;
- WCZESNE OTWARCIE: jedna tablica z rejestru kamery (`resolveWhitelistPlate`:
  ścisłe → OCR-fuzzy) z ≥2 zgodnymi klatkami (pewność ≥0.4) albo 1 klatką
  ≥0.85 → `handleAnprEvent` natychmiast; dwie różne tablice z rejestru = czekaj;
- bez decyzji: okno 3,5 s / 14 klatek, potem dawne reguły (≥2 klatki, ≥0.55,
  inaczej odczyt niepotwierdzony po 8 s);
- debounce 8 s TYLKO po serii z decyzją; po serii bez decyzji kolejne zdarzenie
  kamery (co ~1 s) startuje nową serię po 300 ms (4 nieudane z rzędu → 8 s ciszy);
- `VMD` (ruch) z alertStream jako wczesny wyzwalacz (min. odstęp 2,5 s), obok
  `vehicledetection`; w logu: „decyzja po N ms od zdarzenia [motion|vehicle]".
Weryfikacja po deployu: `grep "decyzja po" edge.log` — oczekiwane setki ms,
nie tysiące; udział `probable_match` dla tablic z rejestru powinien spaść.

## Powiadomienie o przyjeździe śmieciarki (2026-10-02)

- Edge: `SituationCorrelator.detectWasteTruck` + czysty `waste-truck.util.ts`
  (`findWasteVisits`, testy node:test). Klatka się liczy przy `waste_category`
  z pewnością ≥0.5 albo rozpoznanym napisie firmy (`waste_operator`); wizyta
  POTWIERDZONA, gdy druga taka klatka (dowolna kamera) w ≤10 min; przerwa
  >20 min = nowa wizyta; 3 h od poprzedniego przyjazdu = ta sama runda.
  Zapis `situation_events` typ `WASTE_TRUCK` od razu po potwierdzeniu (nie po
  końcu wizyty); tunel `WASTE_TRUCK_ARRIVED {ts, confirmedTs, frames, cameras}`
  tylko przy świeżym potwierdzeniu (≤20 min) — bootstrap 24 h nie budzi ludzi.
- API: `WasteTruckService` (moduł `waste-truck`): odbiorcy
  `COALESCE(residents.notifyWasteTruck, buildings.wasteTruckNotifyAll)`, push
  „Śmieciarka na osiedlu", blokada 2 h per budynek, odrzuca potwierdzenia
  starsze niż 30 min. Mieszkaniec: `PATCH /resident/profile/notify-waste-truck`,
  `/resident/me.notifyWasteTruck` = skuteczna wartość. Administrator:
  `GET/PATCH /building-admin/buildings/:id/waste-truck-notify` (+ liczba
  odbiorców, ile osób wyłączyło/włączyło u siebie).
- UI: panel BA › Powiadomienia › „Powiadomienia automatyczne"; Glass › Konto ›
  Powiadomienia; GateLynk › Profil › Powiadomienia; etykieta „Śmieciarka"
  w Zdarzeniach (web + Glass admin).

## Glass ma wygląd Black (2026-10-02)

Gałąź `codex/gatelynk-black-vnext` scalona do `main`; target **GateLynkGlass**
(bundle `com.gatelynk.app.glass`, ten sam co na TestFlight) kompiluje pliki
`GateLynkBlack/*.swift`, `BlackAssets.xcassets` i fonty Barlow (UIAppFonts
w `GateLynkGlass/Info.plist`) oraz ma `SWIFT_ACTIVE_COMPILATION_CONDITIONS =
"$(inherited) GATELYNK_BLACK"` (Debug i Release). Pod flagą: ekran główny
Black (`blackResidentRoot`), paleta/promienie w `GlassTheme`, `GlassBackground`
renderuje `BlackBackground` (bez zdjęcia budynku — logowanie, formularze),
splash i nagłówek logowania w palecie/kroju Black. Podgląd `-black-design-preview`
działa też w Glass (Debug). Powrót do starego wyglądu = usunąć flagę z dwóch
konfiguracji targetu Glass. PUŁAPKA: konfiguracje targetu znajdować po
`INFOPLIST_FILE = GateLynkGlass/Info.plist` — lista tuż za `DD01` w pbxproj
należy do GlassNotificationService.
