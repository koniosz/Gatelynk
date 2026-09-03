# Akuvox Directory Sync v2 — procedura instalatora (12 kroków)

Dotyczy: Akuvox R29 (docelowo firmware **29.30.10.465 LTS**) + panel Integratora GateLynk
(`Obiekt → Urządzenia → Akuvox → Directory Sync`). Analiza techniczna:
`docs/akuvox-directory-v2-analysis.md`.

> **WAŻNE — template z urządzenia jest obowiązkowy.** GateLynk nie generuje pliku importu
> „na oko": dla adaptera `directory-user` generator **odmawia generacji**, dopóki instalator
> nie wgra realnego przykładowego eksportu z urządzenia o tym samym modelu i firmware
> (kroki 3–4). Pierwszy realny template dla 29.30.10.465 musi pochodzić z urządzenia —
> do tego czasu w systemie istnieją wyłącznie template'y syntetyczne używane w testach.
> Wyjątek: adapter `legacy-contacts` ma wbudowany format UserData.tgz potwierdzony
> sprzętowo na E18C.

## Procedura

1. **Aktualizacja firmware do LTS.** Zaktualizuj R29 do 29.30.10.465 LTS (web UI →
   Upgrade). Zanotuj model, wersję firmware i hardware — wpiszesz je w GateLynk.
   Urządzenia na starszym firmware (np. 29.30.10.128) mogą zostać na adapterze
   `legacy-contacts` do czasu migracji.

2. **Kopia zapasowa konfiguracji urządzenia.** W web UI urządzenia wykonaj pełny eksport
   konfiguracji (Upgrade → Others / Config backup) i zachowaj plik. To Twój rollback.

3. **Eksport przykładowego użytkownika.** Utwórz na urządzeniu 2–3 testowych użytkowników
   (różne nazwy/numery/grupy — dzięki temu parser odróżni pola danych od wartości stałych),
   następnie wyeksportuj listę użytkowników (Directory → User → Export). Zachowaj plik
   dokładnie tak, jak zszedł z urządzenia (nie otwieraj/nie zapisuj w Excelu — psuje
   kodowanie i separator).

   > **WAŻNE (odkryte na R29C, 2026-07-30): eksportuj LOKALNE kontakty.** Eksport listy
   > pochodzącej z Remote Phonebook daje plik z pustymi wierszami danych — to ograniczenie
   > stacji, nie GateLynk. Przed eksportem dodaj użytkownika ręcznie NA urządzeniu (kontakt
   > lokalny) i dopiero wtedy eksportuj. Lokalny eksport kontaktów R29C ma format CSV
   > w stylu vCard (nagłówki FN, N, TEL_HOME/TEL_WORK/…, GROUP, END) — obsługiwany.

3a. **Host SIP dzwonienia (dialHost).** Formaty kontaktów CSV dzwonią na SUROWY string
   z kolumny numeru — żeby dzwonić do konkretnego lokalu (a nie fallback-all na hub),
   ustaw w widoku **A · Urządzenie** pole „Host SIP dzwonienia (dialHost)" = **LAN IP huba
   Edge** (np. 192.168.1.127). GateLynk wygeneruje numery `lokal@host`. NIE kopiuj ślepo
   IP z listy urządzeń w panelu — bywa tam adres Tailscale, nieosiągalny dla stacji.
   Bez dialHost generacja przejdzie, ale z głośnym ostrzeżeniem (dry-run + historia).

4. **Upload template do GateLynk.** Panel Integratora → budynek → Urządzenia →
   „Akuvox → Directory Sync" → dodaj/wybierz urządzenie (uzupełnij MODEL i FIRMWARE —
   template jest przypisany do tej pary) → zakładka **E · Import/Eksport** →
   „Wgraj template". GateLynk parsuje format (kolumny/atrybuty, kolejność, stałe,
   separator, kodowanie) i od tej chwili potrafi generować pliki dla tego firmware.

5. **Konfiguracja mapowania.** Zakładka **B · Mapowanie**: tryb wpisów (na lokal /
   na mieszkańca), grupowanie (grupy kontaktowe BA / klatka / piętro), szablony nazwy
   i numeru, opcje prywatności (ukryj nazwiska / anonimizuj). Sprawdź efekt w
   **C · Podgląd** — to dokładna lista, która pojawi się na ekranie domofonu.

6. **Wgraj bieżący eksport z urządzenia + dry-run.** W zakładce **E** wgraj aktualny
   eksport użytkowników z urządzenia („Wgraj eksport z urządzenia") — to baza porównań,
   która chroni kontakty lokalne i SmartPlus. Potem „Sprawdź zgodność (dry-run)":
   zobaczysz ile wpisów zostanie utworzonych/zmienionych/wyłączonych/usuniętych oraz
   konflikty. **Dry-run niczego nie zmienia.**

7. **Pobranie pliku importu.** Po akceptacji dry-run kliknij „Pobierz plik importu".
   Plik jest wygenerowany 1:1 w formacie template'a; checksum katalogu w nagłówku
   odpowiedzi i w historii.

8. **Import do R29.** Web UI urządzenia → Directory → User → Import → wskaż pobrany
   plik. Uwaga na opcje importu urządzenia (zastąp/dodaj) — przy pierwszym imporcie
   w trybie GATELYNK zalecane „zastąp"; w trybie MERGED **wyłącznie** „dodaj/aktualizuj".

9. **Weryfikacja ekranu.** Na ekranie dotykowym R29 otwórz listę kontaktów i porównaj
   z **C · Podgląd**: liczba wpisów, nazwy (polskie znaki!), grupy, kolejność.

10. **Próbne połączenia.** Wykonaj minimum 2 próbne wywołania z ekranu domofonu do
    różnych lokali i potwierdź, że dzwoni właściwy lokal (routing po numerze = unit.id,
    obsługiwany przez Edge/Cloud — bez zmian względem dotychczasowego działania).

11. **Kontrola SmartPlus.** Jeśli urządzenie jest podpięte do chmury SmartPlus: sprawdź
    w aplikacji/portalu SmartPlus, że kontakty chmurowe przetrwały import, oraz że tryb
    urządzenia w GateLynk to **MERGED** (GateLynk zarządza wyłącznie swoimi wpisami).
    Konflikty widać w dry-run.

12. **Zapis wyniku.** Wróć do GateLynk → zakładka **E** → „Potwierdź wykonany import".
    To zapisuje snapshot stanu, datę i checksum synchronizacji (audyt + baza kolejnych
    diffów). W polu urządzenia uzupełnij ewentualne uwagi (np. wersję hardware).

## Migracja urządzenia ze starej integracji (Remote Phonebook) — Etap 2

Dla urządzeń działających dziś na Remote Phonebook URL: zakładka **A · Urządzenie** →
karta „Migracja z Remote Phonebook (legacy → v2)":

1. „Podgląd migracji" — porównanie wpis-po-wpisie tego, co produkuje stara integracja,
   z projekcją v2 (nazwy, numery wybierania, grupy, kolejność). Różnice OCZEKIWANE
   (np. grupa „Mieszkańcy" → „Pozostali" — zmiana fallbacku decyzją właściciela,
   inna kolejność nazwisk w lokalu) nie blokują migracji; różnice „wymaga uwagi"
   (zwłaszcza RÓŻNY NUMER WYBIERANIA) — blokują przycisk adopt do wyjaśnienia.
2. „Przejmij konfigurację (adopt)" — zapisuje mapowanie parytetowe na urządzeniu i raport
   w Historii (F). **Remote Phonebook nadal działa** — wyłączasz go na urządzeniu dopiero
   po udanym imporcie pliku v2 i próbnych połączeniach (kroki 6–12 głównej procedury).
   Rollback: ponowne włączenie Remote Phonebook na urządzeniu.

## Provisioning (przygotowane, DOMYŚLNIE WYŁĄCZONE)

GateLynk potrafi wystawić plik katalogu pod stabilnym URL-em z tokenem per urządzenie
(zakładka A, tryb synchronizacji PROVISIONING) — wzorzec autop: urządzenie samo pobiera plik.

> **UWAGA:** oficjalna dokumentacja Akuvox NIE potwierdza dystrybucji katalogu
> użytkowników (Directory/User) przez autoprovisioning dla R29 na firmware 29.30.10.x —
> potwierdzone jest provisionowanie konfiguracji. Endpoint jest przygotowany na zapas;
> flaga `AKUVOX_PROVISIONING_SYNC` pozostaje wyłączona (endpoint odpowiada 404) do czasu
> potwierdzenia dokumentacją producenta lub testem na urządzeniu. Nie włączaj na produkcji
> bez decyzji właściciela.

## Rollback

- Remote Phonebook URL (stara integracja) **pozostaje aktywny** — w razie problemów
  włącz z powrotem Remote Phonebook na urządzeniu (Phone → Remote Phonebook) i/lub
  przywróć backup konfiguracji z kroku 2.
- Import poprzedniej listy: użyj eksportu wgranego w kroku 6 (GateLynk przechowuje go
  jako snapshot) lub pliku z kroku 3.

## Bezpieczeństwo

- Poświadczenia web UI urządzenia zapisane w GateLynk są szyfrowane (AES-256-GCM,
  klucz `AKUVOX_CRED_KEY` w env) i nie są nigdzie wyświetlane po zapisie.
- Nie zostawiaj na urządzeniu domyślnych poświadczeń admin/admin; preferuj HTTPS
  w web UI urządzenia.
- Synchronizacja przez API urządzenia (bez plików) jest celowo wyłączona do czasu
  potwierdzenia oficjalnych endpointów Akuvox (flaga `AKUVOX_DIRECTORY_WRITE_API`).
