# GateLynk — status wdrożenia poprawek UX (audyt 2026-09-21)

Źródło wymagań: `gatelynk-ux-audit-2026-09-21/gatelynk-claude-code/01-WYTYCZNE.md` + `02-AUDYT.md`.
Nagranie pokazuje aplikację **GateLynkGlass** (iOS, SwiftUI, target `GateLynkGlass`
w `apps/ios/GateLynk.xcodeproj`, bundle `com.gatelynk.app.glass`). Backend: `apps/api`
(NestJS), sterowanie urządzeniami przez Edge (`apps/edge`). Panel administratora
(web BA v2 i tryb admina w Glass) — poza zakresem, nietknięty.

Legenda: ✅ zrobione · 🟡 częściowo · ⏳ w toku · ⛔ zablokowane (z przyczyną) · 📝 backlog

## 1. Mapa: wymaganie → pliki → źródło danych → zmiana

| Wymaganie | Pliki / komponenty | Źródło danych | Zmiana / status |
|---|---|---|---|
| Dom, dolna nawigacja, konto, nieruchomości | `GlassHomeView.swift`, `GlassMoreSheet.swift` (`GlassPropertiesSheet`) | `/resident/building`, `/resident/me` | patrz §5 |
| Sterowanie wejściami | `GlassAccessDeck.swift`, `GlassGateSheet.swift`, `GlassCameraSheet.swift`, wspólny `GateLynk/AccessOpenControl.swift` | `POST /resident/access-points/:id/open` → `{success,label}` = Edge przyjął komendę przekaźnika (brak telemetrii stanu); Nuki: `GET /resident/smart-lock` (realny stan) | patrz §2–3 |
| Kamera | `GlassCameraSheet.swift` | `/resident/access-points/:id/stream` (MJPEG) + `/snapshot?live=1` | patrz §3 |
| Domofon | `GateLynk/IntercomCallView.swift`, `GateLynk/CallManager.swift` (wspólne z główną apką) | WebRTC (rozmowa full-duplex + mute), `POST /resident/intercom/calls/:id/open` | patrz §3 |
| Goście / przepustki | `GlassGuestsSheet.swift`, model `Guest` w `Models.swift` | `/resident/guests` (GET/POST/PATCH/DELETE), `/resident/access-events?guestsOnly=true` | patrz §4 |
| Pojazdy / LPR | `GlassVehiclesSheet.swift` | `/resident/vehicles`, `/resident/vehicles/:id/history` (access_events z `reason`) | patrz §4 |
| Zgłoszenia, płatności, paczki, ogłoszenia, kalendarz, historia | `GlassTicketsSheet`, `GlassPaymentsSheet`, `GlassParcelsSheet`, `GlassAnnouncementsSheet`, `GlassCalendarSheet`, `GlassHistorySheet` | odpowiednie `/resident/*` | nawigacja §5, nazwy §7 |
| Linki z powiadomień | `AppDelegate` route'y → `GlassHomeView` (`activeSheet`) | push payload | zachowane bez zmian (§5) |

## 2. Kandydaci P0 — wynik weryfikacji w kodzie

_(uzupełniane w toku prac — sekcje „Potwierdzony problem / Naprawione / Niezweryfikowane" na końcu dokumentu)_

## 3–7. Etapy

_(uzupełniane w toku prac)_
