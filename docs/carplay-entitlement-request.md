# CarPlay „Driving Task" — wniosek o entitlement (GateLynk Glass)

Status: **do złożenia** (2026-07-16). Krok 2 planu CarPlay — krok 1 (Siri /
App Intents „Otwórz wjazd w GateLynk") jest już wdrożony w apce
(`GateLynkGlass/GlassAppIntents.swift`) i działa w aucie bez entitlementu.

## Gdzie i jak złożyć

1. Zaloguj się na konto Apple Developer (Account Holder lub Admin).
2. Formularz: **https://developer.apple.com/contact/carplay/**
3. Wybierz kategorię: **Driving Task** (iOS 16+; przykład kanoniczny Apple:
   „control car accessories such as garage door opener" — nasz use case 1:1).
4. Po przyznaniu Apple doda entitlement
   `com.apple.developer.carplay-driving-task` do App ID
   `com.gatelynk.app.glass` (odśwież provisioning profile).

## Dane do formularza

| Pole | Wartość |
|---|---|
| App Name | GateLynk |
| Bundle ID | `com.gatelynk.app.glass` |
| Team | (zespół Apple Developer GateLynk / Smart Home Center) |
| Category | CarPlay Driving Task |
| App Store status | published / in review (formularz wymaga apki realnie istniejącej) |

## Uzasadnienie (EN — do wklejenia)

> GateLynk is a residential community access-control app used by residents
> of gated housing estates and apartment buildings. Residents use the app
> to open vehicle entry barriers and gates of their community.
>
> We request the CarPlay **Driving Task** entitlement to let a resident,
> while driving up to their community's entry or exit barrier, open it
> safely from the CarPlay screen with a single large button — instead of
> picking up the phone. This is functionally identical to Apple's canonical
> Driving Task example of a garage-door-opener accessory control.
>
> Planned CarPlay UI (templates only): a `CPGridTemplate` listing the
> resident's authorized access points (e.g., "Entry", "Exit"), each opening
> the corresponding barrier via our cloud API after the tap. No custom UI,
> no video, no keyboard input while driving. The task takes place strictly
> at the start/end of a drive and requires a single tap.
>
> The app already supports the same action via Siri App Intents ("Open the
> entry gate in GateLynk"), and license-plate recognition opens barriers
> automatically for approved vehicles; the CarPlay buttons are a manual
> fallback (replacement car, guest driver, camera outage).

## Po przyznaniu entitlementu — plan implementacji

1. **Entitlements** (`GateLynkGlass/GateLynkGlass.entitlements`):
   `com.apple.developer.carplay-driving-task = true`.
2. **Info.plist** — scena CarPlay w `UIApplicationSceneManifest`:
   `CPTemplateApplicationSceneSessionRoleApplication` →
   `GlassCarPlaySceneDelegate`.
3. **`GlassCarPlaySceneDelegate`** (`CPTemplateApplicationSceneDelegate`):
   - `templateApplicationScene(_:didConnect:)` → `CPGridTemplate` z punktami
     dostępu z `GlassEntranceStore` (ten sam cache co Siri; bez bram
     pożarowych),
   - tap w przycisk → istniejące `POST /resident/access-points/:id/open`
     przez `APIClient` + `CPAlertTemplate` z potwierdzeniem/błędem,
   - opcjonalnie geofencing: sortowanie „najbliższa brama pierwsza".
4. **Testy**: symulator CarPlay w Xcode (I/O → External Displays → CarPlay),
   potem realne radio.

## Ograniczenia (zakomunikowane właścicielowi 2026-07-16)

- UI CarPlay nie może wyskoczyć samo przy podjeździe (zakaz Apple) — kierowca
  dotyka ikony apki albo używa Siri.
- Tylko szablony Apple (grid/lista/alert) — bez podglądu kamery i rozmów.
- Brak press-and-hold — w aucie zostaje tap (+ ewentualny alert potwierdzenia).
