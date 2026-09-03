# Polityka prywatności — § Odbiorcy danych osobowych (DRAFT)

> Draft z 2026-06-10. Stan zweryfikowany względem kodu (audyt zewnętrznych
> procesorów: Resend w `apps/api/src/mail/mail.service.ts`, APNs w
> `apps/api/src/push/push.service.ts`, hosting Fly.io FRA, tunel Tailscale).
> Brak realnej integracji płatności (BLIK/PayPo to tylko logotypy w iOS).

---

**§ X. Odbiorcy danych osobowych**

1. Administrator udostępnia dane osobowe Użytkowników wyłącznie w zakresie
   niezbędnym do realizacji celów przetwarzania określonych w niniejszej
   Polityce oraz wyłącznie podmiotom wskazanym poniżej.

2. **Podmioty przetwarzające dane na zlecenie Administratora** (na podstawie
   umów powierzenia przetwarzania danych, zgodnie z art. 28 RODO):

   a) **Fly.io, Inc.** z siedzibą w Chicago, Stany Zjednoczone — dostawca
      infrastruktury serwerowej i bazodanowej, na której utrzymywana jest
      Platforma; dane przechowywane są na serwerach zlokalizowanych na
      terenie Unii Europejskiej (Frankfurt, Niemcy);

   b) **Resend, Inc.** z siedzibą w San Francisco, Stany Zjednoczone —
      dostawca usługi wysyłki transakcyjnych wiadomości e-mail (m.in.
      aktywacja konta, powiadomienia systemowe); przetwarzane dane obejmują
      adres e-mail, imię i nazwisko oraz treść wiadomości;

   c) **Apple Inc.** z siedzibą w Cupertino, Stany Zjednoczone — dostawca
      usługi powiadomień push (Apple Push Notification service) dla
      aplikacji mobilnej; przetwarzane dane obejmują identyfikator (token)
      urządzenia oraz treść powiadomienia;

   d) **Tailscale Inc.** z siedzibą w Toronto, Kanada — dostawca usługi
      szyfrowanej komunikacji sieciowej pomiędzy infrastrukturą chmurową
      a urządzeniami zainstalowanymi w nieruchomości; podmiot ten
      pośredniczy wyłącznie w zestawianiu połączeń i nie posiada dostępu
      do treści przesyłanych danych (szyfrowanie end-to-end).

3. W zakresie, w jakim podmioty wskazane w ust. 2 mają siedzibę poza
   Europejskim Obszarem Gospodarczym, przekazywanie danych odbywa się na
   podstawie standardowych klauzul umownych zatwierdzonych przez Komisję
   Europejską (art. 46 ust. 2 lit. c RODO) lub — w przypadku podmiotów
   certyfikowanych — na podstawie decyzji Komisji Europejskiej
   stwierdzającej odpowiedni stopień ochrony w ramach programu EU-U.S.
   Data Privacy Framework (art. 45 RODO).

4. **Odbiorcy danych w ramach Platformy.** Dane osobowe Użytkownika mogą
   być widoczne dla innych użytkowników Platformy wyłącznie w zakresie
   wynikającym z przypisanej im roli oraz wyłącznie w odniesieniu do
   nieruchomości, do której są przypisani:

   a) **zarządca lub administrator budynku** — w zakresie danych mieszkańców
      zarządzanej nieruchomości: imię i nazwisko, adres e-mail, numer
      lokalu, dane pojazdów, historia zdarzeń dostępowych, zgłoszenia,
      salda opłat oraz dane zaproszonych gości;

   b) **pracownik recepcji (konsjerż, portier)** — w zakresie niezbędnym do
      bieżącej obsługi nieruchomości: dane mieszkańców, pojazdów, gości
      oraz przesyłek;

   c) **integrator systemu** (podmiot odpowiedzialny za instalację i serwis
      techniczny) — w zakresie danych konfiguracyjnych i technicznych;
      dostęp do danych osobowych ograniczony jest do przypadków niezbędnych
      przy czynnościach serwisowych;

   d) **osoba zaproszona (gość)** — otrzymuje wyłącznie dane niezbędne do
      skorzystania z zaproszenia (kod dostępu, oznaczenie wejścia); nie
      uzyskuje dostępu do danych osobowych innych Użytkowników.

5. **Organy publiczne.** Dane osobowe mogą zostać udostępnione organom
   publicznym (w szczególności Policji, prokuraturze, sądom) wyłącznie na
   podstawie i w granicach obowiązujących przepisów prawa, na ich
   uzasadnione żądanie.

6. **Lokalne przetwarzanie danych z monitoringu i funkcji asystenta AI.**
   Administrator informuje, że analiza obrazu z kamer (w tym rozpoznawanie
   tablic rejestracyjnych oraz detekcja zdarzeń) oraz funkcje asystenta
   opartego o sztuczną inteligencję realizowane są w całości na urządzeniach
   zlokalizowanych w infrastrukturze nieruchomości lub infrastrukturze
   lokalnej Administratora. Obraz z kamer oraz treść zapytań kierowanych do
   asystenta **nie są przekazywane zewnętrznym dostawcom usług sztucznej
   inteligencji** ani innym podmiotom trzecim. Do infrastruktury chmurowej
   przekazywane są wyłącznie metadane zdarzeń (np. numer tablicy
   rejestracyjnej, data i godzina, rodzaj zdarzenia).

7. Administrator nie udostępnia danych osobowych Użytkowników podmiotom
   trzecim w celach marketingowych.

---

## Uwagi redakcyjne (usunąć przed publikacją)

- Ust. 3 — przed publikacją zweryfikować aktualny status DPA/SCC u Fly.io,
  Resend i Apple (linki do ich Data Processing Agreements dodać w przypisie).
- Gdy zostanie uruchomiony realny operator płatności (BLIK/PayPo działają
  dziś tylko jako oznaczenia w UI), dodać go jako lit. e) w ust. 2.
- Numerację „§ X" dopasować do struktury całego dokumentu.
- Retencja wspierająca politykę (do osobnego paragrafu): odczyty tablic
  (lpr_reads) — 30 dni; historia zdarzeń dostępowych (access_events) —
  dłużej, jako audyt.
- Hikvision/Akuvox działają lokalnie, chmurowe funkcje producenta (np.
  Hik-Connect) NIE są używane — jeśli to się zmieni, zaktualizować listę.
