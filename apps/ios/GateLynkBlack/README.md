# GateLynk_black

Osobny wariant natywnej aplikacji mieszkańca: kompaktowy ekran główny, przesuwane karty punktów dostępu z kamerą oraz zachowana paleta GateLynk. Korzysta ze wspólnych modeli, API, logowania, domofonu i ekranów szczegółowych GateLynkGlass.

## Uruchomienie

- Projekt: `apps/ios/GateLynk.xcodeproj`.
- Schemat i target: `GateLynk_black`.
- Bundle ID: `com.gatelynk.app.black`.
- Rozszerzenie: `BlackNotificationService` (`com.gatelynk.app.black.BlackNotificationService`).
- Flaga kompilacji: `GATELYNK_BLACK`.
- Xcode 26.5; minimalny iOS 17.

Do lokalnego przeglądu wyglądu wybierz Debug i dodaj argument Run `-black-design-preview`. Podgląd ma fikcyjne dane, nie odtwarza sesji, nie rejestruje APNs i nie steruje urządzeniami. Bez tego argumentu aplikacja korzysta z istniejącego logowania i realnego API. Release nie zawiera wejścia do podglądu.

## Kontrakt interfejsu

- Kolory i geometria: `BlackTheme.swift`; font Barlow Semi Condensed jest dołączony lokalnie.
- Ikony: dokładne wektory Lucide w `BlackAssets.xcassets`; licencja w katalogu zasobów.
- Nagłówek, sześć modułów, informacje kontekstowe, AI i dolna nawigacja: `BlackHomeComponents.swift`.
- Karty: `BlackAccessDeck.swift`; produkcyjna lista i uprawnienia pochodzą z istniejącego API.
- Stan polecenia należy do konkretnego punktu dostępu i jest przechowywany przez rodzica ekranu. Zmiana zakładki nie usuwa wyniku ani oczekującego polecenia.
- Dwusekundowy gest rozpoznaje UIKit. Wcześniejsze puszczenie, przesunięcie, zmiana karty, tło aplikacji lub otwarcie innego ekranu anuluje niedokończone przytrzymanie. Wynik terminalny trzeba zresetować lokalnie przed kolejnym świadomym poleceniem.
- API przekaźnika potwierdza przyjęcie polecenia. Nie oznacza to fizycznego otwarcia. Brama pożarowa zachowuje istniejący osobny przebieg potwierdzenia.
- Aktywna karta pobiera autoryzowany JPG kamery co dwie sekundy. Pokazujemy „Podgląd”, czas odebrania oraz „Ostatni obraz” po 15 sekundach, nie fałszywy live stream. Pobieranie zatrzymuje się poza widocznym ekranem.
- Trzy obrazy dołączone do podglądu są grafikami demonstracyjnymi. Nie są fallbackiem dla rzeczywistej kamery.

## Sprawdzone 2026-09-29

- Kompilacja Black Debug i Release dla symulatora: PASS.
- Kompilacja istniejącego GateLynkGlass Debug dla symulatora: PASS.
- 13 testów logiki `../BlackLogicTests/run-tests.sh`: PASS.
- 5 testów UI `../BlackUITests/BlackUITests.swift`: PASS (cztery na 390 × 844, anulowanie gestu na 375 × 812).
- Przegląd screenshotów natywnych na obu rozmiarach: kompaktowy ekran z jedną informacją kontekstową mieści się bez przewijania. Więcej realnych spraw pozostaje dostępnych w przewijanej treści.

Testy UI uruchamiają wyłącznie izolowany podgląd. Nie testowano rzeczywistych bram, APNs, VoIP, płatności ani produkcyjnego logowania. Nie wykonano pełnego audytu VoiceOver i wszystkich rozmiarów Dynamic Type.

Na fizycznym iPhonie nowy Bundle ID wymaga własnych App ID/profili i konfiguracji APNs/VoIP. Nie dokonano publikacji, konfiguracji konta Apple Developer ani wdrożenia serwera.

Kompletny wzorzec HTML, PNG, tokeny, grafiki, instrukcje Claude i patch są przekazywane w oddzielnym pakiecie `GateLynk_black-vNext-handoff`. Bazą gałęzi `codex/gatelynk-black-vnext` jest `5a50a87`.
