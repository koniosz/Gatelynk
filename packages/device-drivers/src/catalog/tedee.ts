/**
 * ⚠️  STATUS: ZAREZERWOWANY — NIE w `DRIVERS[]` w `index.ts`.
 *
 * Decyzja architektoniczna 2026-05-13 (Konrad):
 * ─────────────────────────────────────────────
 * Tedee / Nuki to **prywatne klucze mieszkańca**, nie infrastruktura budynku.
 * Jeśli Edge (= administracja budynku) przechowywałby PAK Tedee:
 *   • administrator / instalator widziałby klucz w sqlite Edge,
 *   • administrator mógłby otworzyć zamek mieszkańca bez jego zgody,
 *   • backup Edge zawierałby klucze prywatne wszystkich mieszkań.
 *
 * To poważne naruszenie prywatności i model GateLynk tego nie akceptuje.
 *
 * Przyszły model (do implementacji w iOS app):
 * ──────────────────────────────────────────────
 *  1. Mieszkaniec loguje się do tedee.com w aplikacji mobilnej GateLynk
 *     (OAuth / Personal Access Key).
 *  2. PAK przechowywany TYLKO w **iOS Keychain** mieszkańca, nie w żadnej
 *     bazie po stronie serwera (GateLynk Cloud, Edge — nigdzie).
 *  3. Komenda `lock`/`unlock` idzie z mobile-app **bezpośrednio** do
 *     `api.tedee.com`. GateLynk Cloud jedynie wyzwala intencję
 *     (np. „mieszkaniec wskazuje wejście do mieszkania w panelu") —
 *     samego klucza nie widzi.
 *  4. Sharing dla gościa: mieszkaniec generuje **guest PIN** przez Tedee
 *     API w swojej app (Tedee API ma natywne guest-codes). PIN trafia do
 *     gościa przez kanał z guest-invite v2 (link/SMS/email), ale faktyczne
 *     uprawnienie ustawia tylko mieszkaniec → Tedee. GateLynk Cloud
 *     przechowuje tylko `pinId` (referencję), nie kod.
 *
 * Driver istnieje fizycznie w katalogu jako szkic — może być punktem
 * wyjścia dla osobnego pakietu `@gatelynk/mobile-drivers` (TBD), z którego
 * korzysta TYLKO iOS app, nie Edge.
 *
 * NIE dodawać `tedeeCloud` do `DRIVERS[]` w `index.ts`. NIE wystawiać przez
 * `GET /devices/drivers` na Edge. Wizard dodawania urządzeń NIE pokazuje
 * typu `LOCK`.
 *
 * Driver Tedee (cloud) — smart-lock przez API tedee.com.
 *
 * **Wyłom w naszym modelu**: Tedee NIE ma adresu IP w LAN. Komunikuje się
 * z chmurą Tedee przez własny BLE-most (Tedee Bridge) — z punktu widzenia
 * Edge to po prostu HTTPS do `api.tedee.com`.
 *
 * Konsekwencje:
 *   • brak `FIELD_IP`, `FIELD_HTTP_PORT` — driver pomija sieć LAN,
 *   • `pingProtocol: 'cloud'` — Edge robi authenticated GET na konkretny zamek
 *     żeby sprawdzić online (zamiast HTTP ping na IP),
 *   • `discovery.cloudBound: true` — moduł discovery w Edge pomija ten driver
 *     przy mDNS-scan, ale wizard pokazuje go normalnie w pickerze,
 *   • brak `restart`/`snapshot` — Tedee Cloud API tego nie wystawia,
 *   • brak `openDoor` — sensowne tylko `lock`/`unlock` (zamek, nie brama).
 *
 * Auth: Personal Access Key (PAK) z `tedee.com → Profile → Personal Access Key`.
 * Każdy request: `Authorization: PersonalKey {pak}` (NIE `Bearer` — Tedee ma własny schemat).
 *
 * UWAGA: Tedee API ma rate limit ~10 req/min per konto. Edge powinien throttle-ować
 * (przyszłość — w driver-engine albo per-cloud-driver). Dziś nikt nie strzela
 * tak często, bo każda akcja to ręczne kliknięcie.
 */
import type { DeviceDriver } from '../types'
import { FIELD_NAME, FIELD_TEDEE_PAK, FIELD_TEDEE_LOCK_ID } from './_common'

export const tedeeCloud: DeviceDriver = {
  id: 'tedee-cloud',
  type: 'LOCK',
  manufacturer: 'Tedee',
  models: [
    'Tedee GO',
    'Tedee PRO',
    'Tedee PRO+',
    'Tedee LOCK',
  ],
  label: 'Tedee (przez chmurę tedee.com)',
  icon: '🔐',
  notes: 'Zamek Tedee sterowany przez API tedee.com (nie wymaga IP w LAN — komunikacja przez Tedee Bridge). Wymagany Personal Access Key + ID zamka.',
  capabilities: ['lock', 'unlock'],
  fields: [
    FIELD_NAME,
    FIELD_TEDEE_PAK,
    FIELD_TEDEE_LOCK_ID,
  ],
  defaults: {},
  endpoints: {
    // „Ping" cloud-bound: GET na konkretny zamek; 200 = online, 404 = brak dostępu, 5xx = problem chmury.
    ping: ['https://api.tedee.com/api/v1.32/lock/{lockId}'],
    pingProtocol: 'cloud',
    lock: {
      protocol: 'cloud',
      method: 'POST',
      url: 'https://api.tedee.com/api/v1.32/lock/{lockId}/operation/lock',
      // Tedee używa schematu `PersonalKey <token>` zamiast `Bearer`.
      // Edge cloud-runner musi to wesprzeć (Faza 2 — patrz CloudActionExecutor).
      auth: 'apikey',
      contentType: 'application/json',
    },
    unlock: {
      protocol: 'cloud',
      method: 'POST',
      url: 'https://api.tedee.com/api/v1.32/lock/{lockId}/operation/unlock',
      auth: 'apikey',
      contentType: 'application/json',
    },
    discovery: {
      cloudBound: true,
      // Brak mDNS / OUI — Tedee Bridge nie pojawia się jednolicie w LAN (BLE proxy).
      // Wizard zaproponuje ręczne wpisanie PAK + lockId, dopóki nie zrobimy
      // „auto-list locks for this PAK" (osobna faza — wymaga Edge wywołującego
      // GET /api/v1.32/my/lock i listującego zamki).
    },
  },
}
