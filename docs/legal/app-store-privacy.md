# GateLynk — Załączniki do polityki prywatności: sklepy aplikacji i uprawnienia

> Dokument towarzyszący `privacy-policy-pl.md`. Zawiera mapowania gotowe do
> wpisania w **App Store Connect** (Apple) i **Google Play Console** (Data Safety),
> oraz teksty uzasadnień uprawnień mobilnych (Info.plist / Android runtime).
>
> ⚠️ **Wymaga weryfikacji prawnej przed publikacją.** Mapowania oparto na faktycznym
> przetwarzaniu w kodzie (patrz `data-inventory.md`). Uzupełnij `[...]`.
>
> **Uwaga o platformach:** aplikacja produkcyjna to **iOS (natywny Swift)**.
> Aplikacja **Android** jest w przygotowaniu (scaffold Expo/React Native) — Załącznik B
> przygotowano dla wdrożenia; **przed publikacją na Google Play zweryfikuj, czy
> zakres zbieranych danych w buildzie Android pokrywa się z poniższym.**

---

## Załącznik A — Apple App Store: Privacy Nutrition Labels

Mapowanie kategorii danych Apple („App Privacy" w App Store Connect). Dla każdej
kategorii: czy zbierana, w jakim celu, czy powiązana z tożsamością, czy używana do
śledzenia.

**Śledzenie (Tracking):** ❌ **Aplikacja NIE śledzi użytkowników.** Brak SDK
reklamowych/analitycznych firm trzecich. Brak udostępniania danych brokerom. App
Tracking Transparency nie jest wymagane (brak trackingu).

| Kategoria danych (Apple) | Zbierana? | Konkretne dane | Cel (Apple) | Powiązane z tożsamością? | Śledzenie? |
|---|---|---|---|---|---|
| **Contact Info** | ✅ | Imię i nazwisko, e-mail, telefon (opcj.) | App Functionality | Tak | Nie |
| **User Content** | ✅ | Zdjęcie profilowe, zdjęcia w zgłoszeniach, treść zgłoszeń, **audio połączenia domofonowego (na żywo, nienagrywane)** | App Functionality | Tak | Nie |
| **Identifiers** | ✅ | ID konta użytkownika, token urządzenia (push/VoIP) | App Functionality | Tak | Nie |
| **Usage Data** | ✅ (ograniczone) | Zapytania do asystenta AI (treść pytania/odpowiedzi — do oceny jakości) | App Functionality / Product Personalization | Tak | Nie |
| **Sensitive Info** | ✅ | Numer tablicy rejestracyjnej; dane o dostępie i obecności na terenie nieruchomości (zdarzenia wjazdu/wejścia) | App Functionality | Tak | Nie |
| **User ID / Device ID** | ✅ | Token APNs / VoIP | App Functionality | Tak | Nie |
| **Location** | ❌ | Nie zbieramy lokalizacji urządzenia (brak uprawnienia lokalizacji) | — | — | — |
| **Financial Info** | ❌ (obecnie) | Brak realnego przetwarzania płatności (oznaczenia BLIK/PayPo w UI nie przetwarzają danych płatniczych) | — | — | — |
| **Health & Fitness** | ❌ | — | — | — | — |
| **Browsing/Search History** | ❌ | — | — | — | — |
| **Contacts** | ❌ | Nie odczytujemy książki adresowej | — | — | — |
| **Photos (biblioteka)** | ✅ warunkowo | Tylko zdjęcie wybrane przez użytkownika (profil / zgłoszenie) | App Functionality | Tak | Nie |

> **Uwaga „Sensitive Info":** Apple klasyfikuje dane o dostępie do nieruchomości i
> tablice rejestracyjne jako potencjalnie wrażliwe — zadeklaruj je rzetelnie.
> **Uwaga o domofonie:** audio jest transmitowane na żywo i **nie jest nagrywane**;
> wideo jest jednokierunkowe i **nie pochodzi z kamery urządzenia użytkownika**.
> **Data Deletion:** aplikacja udostępnia możliwość usunięcia konta (wymóg Apple) —
> link/ścieżka: `[WSKAŻ ścieżkę w aplikacji / URL]`.

---

## Załącznik B — Google Play: Data Safety

Mapowanie sekcji „Bezpieczeństwo danych" (Data collected / Data shared) w Google
Play Console.

**Deklaracje ogólne:**
- **Szyfrowanie w tranzycie:** ✅ Tak (HTTPS/TLS; strumienie SRTP/DTLS).
- **Możliwość usunięcia danych:** ✅ Tak — użytkownik może zażądać usunięcia konta
  i danych.
- **Udostępnianie danych firmom trzecim w rozumieniu Google:** ograniczone do
  dostawców infrastruktury działających na zlecenie (processing), nie do brokerów/
  reklamy. Zweryfikuj definicję „shared" Google dla podprocesorów.

| Typ danych (Google) | Zbierane? | Udostępniane? | Cel | Wymagane / opcjonalne |
|---|---|---|---|---|
| **Personal info** — imię, e-mail, telefon | ✅ | Nie | Account management, App functionality | Wymagane (część opcjonalne, np. telefon) |
| **Photos** — zdjęcie profilowe, zdjęcia zgłoszeń | ✅ | Nie | App functionality | Opcjonalne |
| **Audio** — rozmowa domofonowa (na żywo, nienagrywana) | ✅ | Nie | App functionality (komunikacja) | Opcjonalne (gdy korzysta z domofonu) |
| **App activity** — zapytania do asystenta AI | ✅ | Nie | App functionality, Analytics (poprawa jakości) | Opcjonalne |
| **App info & performance** — diagnostyka/logi | ✅ (minimalnie) | Nie | App functionality | Wymagane |
| **Device or other IDs** — token push/VoIP | ✅ | Nie (przekazywany dostawcy push w celu dostarczenia) | App functionality (powiadomienia) | Wymagane |
| **„Sensitive" — tablice rejestracyjne / dostęp** | ✅ | Nie | App functionality (kontrola dostępu, bezpieczeństwo) | Wymagane |
| **Location** | ❌ | — | — | — |
| **Financial info** | ❌ (obecnie) | — | — | — |
| **Contacts** | ❌ | — | — | — |

> Android korzystać będzie z **FCM (Firebase Cloud Messaging)** do powiadomień push
> — gdy zostanie wdrożony, **dodaj Google jako odbiorcę tokenu/treści powiadomienia**
> w tej sekcji oraz w polityce (§ 8). `[Do uzupełnienia przy realnym buildzie Android.]`

---

## Załącznik C — Uzasadnienia uprawnień mobilnych (in-app notice)

Krótkie, jasne wyjaśnienia dlaczego aplikacja prosi o uprawnienia — do użycia jako
teksty `Info.plist` (iOS) oraz rationale przy żądaniu uprawnień (Android).

### C.1. iOS — Info.plist usage strings

> Stan obecny w `apps/ios/GateLynk/Info.plist`: zadeklarowany jest tylko
> `NSLocalNetworkUsageDescription`. Przed włączeniem domofonu (`INTERCOM_CALL_ENABLED`)
> **dodaj `NSMicrophoneUsageDescription`** oraz Background Modes `voip` + `audio`
> (patrz `docs/intercom-akuvox-call.md`, sekcja 8.6). **Kamera (`NSCameraUsageDescription`)
> NIE jest wymagana** — wideo domofonu jest jednokierunkowe, telefon nie publikuje obrazu.

```xml
<!-- Sieć lokalna (już obecne) — łączenie z urządzeniem Edge w LAN -->
<key>NSLocalNetworkUsageDescription</key>
<string>Aplikacja łączy się z urządzeniem GateLynk w Twojej sieci lokalnej, aby udzielać odpowiedzi asystenta oraz obsługiwać domofon i kontrolę dostępu.</string>

<!-- Mikrofon — DODAĆ przy włączeniu domofonu -->
<key>NSMicrophoneUsageDescription</key>
<string>Mikrofon jest używany do rozmowy z gościem podczas połączenia domofonowego. Rozmowa nie jest nagrywana.</string>

<!-- Biblioteka zdjęć — jeśli wybór zdjęcia profilowego/do zgłoszenia z galerii -->
<key>NSPhotoLibraryUsageDescription</key>
<string>Dostęp do zdjęć pozwala ustawić zdjęcie profilowe lub dołączyć zdjęcie do zgłoszenia. Wybierasz tylko konkretne zdjęcia.</string>

<!-- Powiadomienia: rejestrowane przez UNUserNotificationCenter / PushKit (VoIP) -->
<!-- Tryby pracy w tle wymagane dla połączeń domofonowych: -->
<key>UIBackgroundModes</key>
<array>
  <string>voip</string>
  <string>audio</string>
</array>
```

> **Powiadomienia push/VoIP:** nie wymagają usage-string w Info.plist, ale przy
> pierwszym uruchomieniu aplikacja prosi o zgodę na powiadomienia. Zalecany krótki
> komunikat kontekstowy (pre-permission) w UI: *„Włącz powiadomienia, aby otrzymywać
> alerty o wjazdach, gościach i połączeniach z domofonu."*

### C.2. Android — runtime permission rationale

Teksty do wyświetlenia przy żądaniu uprawnień (np. dialog rationale przed
`requestPermissions`):

| Uprawnienie | Rationale (PL) |
|---|---|
| `RECORD_AUDIO` (mikrofon) | „Mikrofon jest potrzebny do rozmowy z gościem przez domofon. Rozmowa nie jest nagrywana." |
| `POST_NOTIFICATIONS` (Android 13+) | „Powiadomienia informują Cię o wjazdach, gościach przy bramie i połączeniach z domofonu." |
| `READ_MEDIA_IMAGES` / wybór zdjęcia | „Dostęp do zdjęć pozwala ustawić zdjęcie profilowe lub dołączyć je do zgłoszenia." |
| Sieć lokalna / `INTERNET` | (uprawnienie normalne — bez dialogu) „Aplikacja łączy się z urządzeniem GateLynk w Twojej sieci, aby obsłużyć domofon i kontrolę dostępu." |

> **Kamera:** aplikacja **nie wymaga uprawnienia do kamery** dla domofonu (wideo
> jednokierunkowe, urządzenie nie publikuje obrazu). Uprawnienie `CAMERA` deklaruj
> wyłącznie, jeśli dodasz funkcję robienia zdjęć w aplikacji (np. zdjęcie do
> zgłoszenia aparatem) — wtedy z osobnym uzasadnieniem.
> **Lokalizacja:** nie jest wymagana ani zbierana.

### C.3. Zasady dobrego komunikatu (dla zespołu)

- Pytaj o uprawnienie **w kontekście** (gdy użytkownik faktycznie uruchamia funkcję),
  nie hurtem przy starcie.
- Każdy komunikat: **co**, **po co**, **co się NIE dzieje** (np. „nie nagrywamy").
- Spójność z polityką: nie proś o więcej, niż deklarujesz w `privacy-policy-pl.md`
  i etykietach sklepów.
