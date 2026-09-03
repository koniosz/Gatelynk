# GateLynk — stan platformy na 28.07.2026 (brief do drugiej opinii)

> Kontekst dla oceniającego: to jest opis realnego, działającego produkcyjnie systemu,
> zbudowanego przez jedną osobę (właściciel + AI-asystowany development). Szukam
> **drugiej opinii na temat pozycji rynkowej, priorytetów i tego, co odciąć** — nie
> pochwał. Pytania na końcu dokumentu.

---

## 1. Czym jest GateLynk

Platforma zarządzania nieruchomością mieszkalną, łącząca w jednym produkcie trzy
kategorie, które na rynku są zwykle oddzielne:

1. **Kontrola dostępu** (bramy, furtki, domofony, LPR, PIN-y, zamki)
2. **Zarządzanie osiedlem** (mieszkańcy, lokale, czynsze, zgłoszenia, goście, ogłoszenia)
3. **AI** (wizja komputerowa + polskojęzyczny asystent LLM działający lokalnie)

Grupa docelowa: wspólnoty i osiedla domów w Polsce; użytkownik końcowy to **mieszkaniec**
(apka iOS) i **zarządca/administrator** (panel web), często osoba starsza — stąd nacisk
na czytelność UI.

Pierwsze wdrożenie produkcyjne: osiedle **Villa Natura** (Warszawa, Wilanów) — obiekt
liczy ok. 55 domów.

---

## 2. Architektura

```
apps/api        NestJS + Prisma + PostgreSQL   → Fly.io (region FRA), api produkcyjne
apps/web        Next.js                        → Fly.io, panel.gatelynk.com
apps/ios        SwiftUI                        → 2 targety produkcyjne + 1 eksperymentalny
apps/edge       NestJS + SQLite                → Mac Mini na obiekcie (LAN), tunel WS do Cloud
apps/yolo-vision  Python/FastAPI               → Mac Studio M4 Max 64 GB (wizja)
apps/ai-prototype Python/FastAPI               → na Edge, asystent LLM + RAG
```

**Zasada projektowa: offline-first.** Edge trzyma lokalną kopię whitelisty tablic,
PIN-ów gości i PIN-ów mieszkańców w SQLite. Zanik internetu **nie blokuje wjazdu ani
gościa** — brama otwiera się lokalnie, audyt dosyła się do chmury po odzyskaniu łącza.
Do tego trwała kolejka synchronizacji (outbox) z retry i replay po reconnect.

**Role i separacja:** Mieszkaniec / Konsjerż / Administrator budynku / Integrator —
osobne JWT, osobne prefiksy API, macierz uprawnień per obiekt (19 przełączalnych funkcji
systemowych, konfigurowana przez integratora, egzekwowana po stronie backendu).

---

## 3. Co działa produkcyjnie

### Kontrola dostępu i sprzęt
- Punkty dostępu z abstrakcją sterowników wyjść (Akuvox, Hikvision, przełącznik LAN/PoE),
  harmonogramy cron (np. brama otwarta w godzinach wywozu śmieci)
- **LPR** na kamerach Hikvision ANPR; whitelist synchronizowana Cloud→Edge
  (obecnie ok. 66 tablic), pełny resync przy każdym reconnect Edge
- **Rozmowy domofonowe Akuvox R29 ↔ iPhone**: most SIP↔WebRTC (Janus) na Edge,
  CallKit + VoIP push, TURN we Frankfurcie. Wideo hybrydowe (audio WebRTC + klatki
  ze snapshotów kamery domofonu). Działa na sprzęcie.
- **Nuki Smart Lock Pro** — integracja przez Web API, w tym onboarding zamka
  z aplikacji mieszkańca za jego świadomą zgodą
- Ujednolicony audyt wejść (`access_events`): LPR, PIN, zdalne otwarcie, domofon —
  jedno źródło prawdy dla wszystkich ról

### Moduły zarządcze
- **Mieszkańcy i lokale** (kreator dodawania, import, zaproszenia)
- **Pojazdy** z workflow zatwierdzania (mieszkaniec zgłasza → admin akceptuje → tablica
  leci na Edge), kategoryzacja (mieszkańcy / kurierzy / śmieciarki / uprzywilejowane),
  historia przejazdów per pojazd, miniatury z kamery LPR
- **Goście**: PIN offline-first, portal zaproszenia, wybór konkretnych wejść, limit
  otwarć, dostęp cykliczny, zaproszenia e-mail, chronologiczny podgląd wejść
- **Płatności**: składowe czynszu (kwotowe i za m²), automatyczne naliczanie miesięczne,
  import wyciągów MT940, przypomnienia (push + e-mail), wykres składowych i pełna
  historia w apce mieszkańca, wyliczanie zaległości po terminie
- **Zgłoszenia** z wątkami (do administracji lub konsjerża), **ogłoszenia/powiadomienia**
  z szablonami i podglądem telefonu przed wysyłką
- **Panel integratora**: multi-obiektowy dashboard, konfiguracja urządzeń i AI, macierz
  uprawnień, logi zapytań do AI z oceną „OK / źle" (dataset do strojenia)

### AI — wizja
- YOLO11l @ 960 px na Mac Studio M4 Max (MPS)
- **OCR: natywny Apple Vision** (Neural Engine) — zastąpił EasyOCR, wyraźnie lepsza
  jakość odczytu napisów na pojazdach
- Rozpoznawanie marek/firm z napisów (kurierzy, sieci handlowe, operatorzy odpadów)
- Karta „Wizja AI" w panelu: filtry czasu, kamer, klas, marek, wyszukiwanie po
  dowolnym napisie zauważonym w kadrze

### AI — asystent
- **Bielik 11B** (polski model) przez Ollama, lokalnie na Mac Studio — żadne dane
  nie wychodzą poza obiekt
- Deklaratywny rejestr ~21 intentów + **katalog 143 pytań kontrolnych z automatycznym
  ewaluatorem** (regresja klasyfikatora wykrywana przed wdrożeniem)
- RAG po bazie wiedzy osiedla (regulaminy, kontakty, harmonogram wywozu odpadów)
- Multi-turn (pytania uzupełniające typu „a szkło?")
- Wbudowana prywatność: zapytanie „do kogo należy ten pojazd?" zwraca **tylko lokal**,
  nigdy danych właściciela — trzy niezależne warstwy zabezpieczenia
- „Podsumowanie dnia" generowane w tle co 20 minut (w apce pojawia się natychmiast)

### Inżynieria
- Testy e2e na krytycznych ścieżkach + CI (GitHub Actions, Postgres w kontenerze)
- Ograniczenia na poziomie bazy (unikalność tablicy per obiekt, PIN-y aktywnych gości)
- Polityka prywatności RODO w modelu **procesora** (administratorem jest wspólnota),
  usuwanie konta zgodne z wymogami App Store

---

## 4. Realna skala wdrożenia (bez upiększeń)

| Wskaźnik | Stan |
|---|---|
| Obiekty produkcyjne | **1** (Villa Natura) + drugi w przygotowaniu (MVP) |
| Lokale skonfigurowane w systemie | ok. 11 (obiekt ma ~55 domów) |
| Zarejestrowani mieszkańcy | ok. 6 |
| Tablice na whiteliście | ok. 66 |
| Płacący klienci | **0** — brak modelu rozliczeniowego i cennika |

To jest **zaawansowany technicznie pilotaż, nie biznes**. Produkt ma znacznie więcej
funkcji niż użytkowników.

MVP drugiego obiektu (zdefiniowany): 3× domofon Akuvox R29 + 4× kamera LPR (dwie stare,
model do potwierdzenia), **bez modułu AI**, rozmowy domofonowe obowiązkowe, bez konsjerża,
termin 2–3 tygodnie.

---

## 5. Świadomie odroczone i dług techniczny

Odroczone decyzją właściciela (nie z niewiedzy):
- **Brak środowiska staging** — `deploy` idzie prosto na produkcję
- **Brak Sentry / monitoringu uptime** — awarie wykrywa użytkownik, nie alert
- **Brak rotacji sekretów urządzeń** (hasła do domofonów/kamer w konfiguracji)

Dług i słabości:
- ~143 miejsca z surowym SQL zamiast typowanego ORM (historyczny konflikt wersji, dziś
  już naprawiony — kod zostaje do refaktoru)
- **Rozpoznawanie marek oparte na regexach** wymaga edycji w 3 plikach przy każdej nowej
  firmie — nie skaluje się; kandydat do zastąpienia modelem wizyjno-językowym (VLM)
- **Pojedyncze punkty awarii**: Mac Mini (Edge) i Mac Studio (AI) bez redundancji.
  Realny incydent z 24.07: aktualizacja Ollamy przestawiła ścieżkę aplikacji, usługa
  systemowa nie wstała, LLM zaczął nasłuchiwać tylko lokalnie → asystent przestał
  działać na 3 dni i **nikt tego nie zauważył**, aż zgłosił to właściciel
- **Trzy aplikacje iOS** (dwie produkcyjne + jedna eksperymentalna) współdzielą warstwę
  sieciową, ale UI jest zduplikowane
- Brak bramki SMS (rozważane), brak integracji płatności online

---

## 6. Pozycjonowanie — teza do weryfikacji

Skan rynku (lipiec 2026) pokazuje, że pojedyncze warstwy są towarem masowym:
detekcja obiektów, LPR i wyszukiwanie nagrań językiem naturalnym mają dziś Verkada,
Coram, Ambient.ai, Ubiquiti UniFi Protect, a nawet darmowy open source (Frigate + Ollama).

Natomiast rynek jest podzielony na dwa obozy, które się nie spotykają:
- **VMS-y z AI** mówią do ochroniarza — nie wiedzą, kto mieszka w lokalu 4/2 ani kto
  zalega z czynszem
- **Proptech dla mieszkańców** (asystenci tekstowi dla wspólnot) jest ślepy — nie ma
  dostępu do kamer ani bramy

**Teza:** przewagą GateLynk nie jest jakość wizji (tam przegra z firmami mającymi
zespoły ML), tylko **połączenie kontekstu zarządczego z dostępem i wizją, po polsku,
lokalnie**. Stąd proponowane pozycjonowanie: *„asystent osiedla, który akurat widzi"*,
a nie *„monitoring z AI"*.

Argumenty wspierające: konkurencja liczy licencje w setkach dolarów za kamerę rocznie;
tu koszt to jednorazowy sprzęt. Wyszukiwanie językiem naturalnym u Ubiquiti działa
wyłącznie po angielsku. Od sierpnia 2026 unijne przepisy o AI wchodzą w pełne
stosowanie, co premiuje przetwarzanie lokalne.

---

## 7. Pytania, na które proszę o drugą opinię

1. **Pozycjonowanie** — czy teza z sekcji 6 jest trafna, czy to racjonalizacja tego, co
   już zbudowano? Czy „asystent osiedla" sprzeda się zarządcy lepiej niż „monitoring"?
2. **Szerokość vs głębokość** — mam 1 obiekt i bardzo dużo funkcji. Czy iść w kolejne
   wdrożenia (nawet okrojone, bez AI), czy dokończyć produkt? Co jest większym ryzykiem?
3. **Gotowość operacyjna** — czy brak stagingu i monitoringu to blocker przed drugim
   klientem, czy akceptowalne ryzyko przy tej skali? Incydent z Ollamą sugeruje, że
   to pierwsze.
4. **Model biznesowy** — jak wycenić taki produkt w Polsce: od lokalu miesięcznie,
   od obiektu, czy wdrożenie + abonament? Kto podpisuje umowę: wspólnota, zarządca,
   czy deweloper przy odbiorze osiedla?
5. **Co odciąć** — które moduły są rozpraszaczem? Kandydaci: trzecia apka iOS,
   moduł płatności (konkuruje z systemami księgowymi wspólnot), rozpoznawanie marek
   kurierów.
6. **AI** — czy zastąpienie regexowego rozpoznawania marek modelem wizyjno-językowym
   na tym sprzęcie to dobra inwestycja, czy złocenie klamki przy 6 użytkownikach?
7. **Największe ryzyko, którego nie widzę** — co jeszcze przeoczam?
