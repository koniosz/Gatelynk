/**
 * OUI lookup — mapowanie pierwszych 3 oktetów MAC na producenta.
 *
 * Lista celowo wąska — zawiera tylko producentów, których drivery mamy
 * w katalogu (lub planujemy mieć). Pełna baza IEEE OUI to ~17 MB i nie ma
 * sensu jej tu trzymać; gdy zajdzie potrzeba bardziej szerokiego pokrycia,
 * doda się ją osobno (np. lazy-loaded JSON).
 *
 * Format wpisu: prefiks (uppercase, separator `:`) → manufacturer name + lista
 * sugerowanych driverIdów. Lista ma znaczenie — przy konflikcie (np. Espressif
 * = Shelly Gen2 lub generyczny ESP32) sugerujemy pierwszy, a UI pokazuje
 * pozostałe jako alternatywy.
 *
 * Źródło OUI: IEEE Public Listing (manuf.txt z Wiresharka). Aktualizowane
 * ręcznie gdy doda się nowy driver.
 */

export interface OuiEntry {
  manufacturer: string
  suggestedDriverIds: string[]
}

/**
 * Mapa OUI → manufacturer. Klucz to MAC prefix w formacie `XX:XX:XX`
 * (uppercase, separator `:`).
 *
 * Pełna mapa wygenerowana z list driverów + popularnych prefiksów; dodaj nowy
 * wpis gdy doda się nowy producent z LAN-driverem.
 */
export const OUI_MAP: ReadonlyMap<string, OuiEntry> = new Map([
  // Allterco Robotics — Shelly Pro line (Ethernet)
  ['34:94:54', { manufacturer: 'Shelly (Allterco)', suggestedDriverIds: ['shelly-pro1'] }],
  ['DC:53:60', { manufacturer: 'Shelly (Allterco)', suggestedDriverIds: ['shelly-pro1'] }],
  ['9C:90:0E', { manufacturer: 'Shelly (Allterco)', suggestedDriverIds: ['shelly-pro1'] }],
  ['2C:6A:6F', { manufacturer: 'Shelly (Allterco)', suggestedDriverIds: ['shelly-pro1'] }],
  // Espressif (bazowe ESP32 — Shelly Plus, ale też masa innego IoT)
  ['8C:AA:B5', { manufacturer: 'Espressif (Shelly Plus?)', suggestedDriverIds: ['shelly-pro1'] }],
  ['84:CC:A8', { manufacturer: 'Espressif (Shelly Plus?)', suggestedDriverIds: ['shelly-pro1'] }],

  // Akuvox (intercom)
  ['B0:1F:81', { manufacturer: 'Akuvox', suggestedDriverIds: ['akuvox-smartplus'] }],
  ['0C:11:05', { manufacturer: 'Akuvox', suggestedDriverIds: ['akuvox-smartplus'] }],

  // Hikvision (intercom / kamery / LPR — wszystkie drivery). OUI nie różnicuje
  // typu urządzenia, więc UI w Step 2 pokazuje dropdown alternatyw. Hostname-pattern
  // w driverach (`mdnsHostnamePattern`) zwykle to ujednoznacznia.
  ['C0:51:7E', { manufacturer: 'Hikvision', suggestedDriverIds: ['hikvision-camera', 'hikvision-intercom', 'hikvision-lpr'] }],
  ['44:19:B6', { manufacturer: 'Hikvision', suggestedDriverIds: ['hikvision-camera', 'hikvision-intercom', 'hikvision-lpr'] }],
  ['18:68:CB', { manufacturer: 'Hikvision', suggestedDriverIds: ['hikvision-camera', 'hikvision-intercom', 'hikvision-lpr'] }],
  ['44:47:CC', { manufacturer: 'Hikvision', suggestedDriverIds: ['hikvision-camera', 'hikvision-intercom', 'hikvision-lpr'] }],
  ['B4:A3:82', { manufacturer: 'Hikvision', suggestedDriverIds: ['hikvision-camera', 'hikvision-intercom', 'hikvision-lpr'] }],
  ['BC:AD:28', { manufacturer: 'Hikvision', suggestedDriverIds: ['hikvision-camera', 'hikvision-intercom', 'hikvision-lpr'] }],
  ['F4:B7:E2', { manufacturer: 'Hikvision', suggestedDriverIds: ['hikvision-camera', 'hikvision-intercom', 'hikvision-lpr'] }],
  ['F8:4D:FC', { manufacturer: 'Hikvision', suggestedDriverIds: ['hikvision-camera', 'hikvision-intercom', 'hikvision-lpr'] }],

  // Dahua (kamery + LPR ITC)
  ['90:02:A9', { manufacturer: 'Dahua', suggestedDriverIds: ['dahua-camera', 'dahua-itc-lpr'] }],
  ['3C:EF:8C', { manufacturer: 'Dahua', suggestedDriverIds: ['dahua-camera', 'dahua-itc-lpr'] }],

  // 2N (Helios)
  ['7C:1E:B3', { manufacturer: '2N (Helios)', suggestedDriverIds: ['twoN-helios'] }],

  // KNX-IP routery — Gira, Weinzierl (OEM)
  ['00:0E:8C', { manufacturer: 'Gira', suggestedDriverIds: ['knx-ip-bridge'] }],
  ['00:01:E2', { manufacturer: 'Siemens (KNX?)', suggestedDriverIds: ['knx-ip-bridge'] }],
  ['00:1F:7C', { manufacturer: 'Weinzierl (OEM KNX-IP)', suggestedDriverIds: ['knx-ip-bridge'] }],
])

/**
 * Normalizuje MAC do formatu `XX:XX:XX:XX:XX:XX` (uppercase, separator `:`).
 * Akceptuje wejście z `:`, `-`, lub bez separatorów. Zwraca null jeśli format
 * nie pasuje.
 */
export function normalizeMac(mac: string | undefined | null): string | null {
  if (!mac) return null

  // macOS `arp -an` wypisuje oktety BEZ zer wiodących: `c:11:5:a:b3:17`
  // zamiast `0c:11:05:0a:b3:17`. Bez uzupełnienia zer adres ma 10 znaków
  // i cała identyfikacja producenta po cichu zwracała null — czyli kaseta
  // Akuvox nigdy nie zostałaby rozpoznana (VN, 2026-08-07).
  const parts = mac.trim().split(':')
  if (parts.length === 6 && parts.every((p) => /^[0-9a-fA-F]{1,2}$/.test(p))) {
    mac = parts.map((p) => p.padStart(2, '0')).join(':')
  }

  const cleaned = mac.toUpperCase().replace(/[^0-9A-F]/g, '')
  if (cleaned.length !== 12) return null
  return [
    cleaned.slice(0, 2), cleaned.slice(2, 4), cleaned.slice(4, 6),
    cleaned.slice(6, 8), cleaned.slice(8, 10), cleaned.slice(10, 12),
  ].join(':')
}

/**
 * Lookup OUI dla podanego MAC. Zwraca wpis z mapy albo null.
 */
export function lookupOui(mac: string | undefined | null): OuiEntry | null {
  const norm = normalizeMac(mac)
  if (!norm) return null
  const prefix = norm.slice(0, 8) // "XX:XX:XX"
  return OUI_MAP.get(prefix) ?? null
}
