/**
 * Drivery KNX — KNX-IP Bridge (router/interface) i logiczny KNX_OBJECT.
 *
 * Model dwupoziomowy:
 *   • `KNX_BRIDGE` — fizyczne urządzenie sieciowe (eelectron / Jung / Gira)
 *     pełniące rolę bramki między LAN-em a magistralą KNX TP. Jeden bridge
 *     obsługuje typowo 1 linię (do 256 obiektów).
 *   • `KNX_OBJECT` — logiczne mapowanie: „włącznik kuchnia" → GA 1/0/1 + DPT 1.001.
 *     Każdy obiekt referuje rodzica przez `bridgeDeviceId`.
 *
 * Protokół: KNXnet/IP (UDP).
 *   • Discovery: SEARCH_REQUEST → multicast 224.0.23.12:3671 → bridge odpowiada
 *     unicast SEARCH_RESPONSE z `physicalAddress`, `friendlyName`, `serialNumber`.
 *   • Tunneling: CONNECT_REQUEST (unicast UDP 3671) → bridge zwraca channel-id →
 *     TUNNELLING_REQUEST z cEMI frame (GA + APCI value).
 *
 * Edge musi mieć osobny moduł obsługujący KNXnet/IP — driver-engine sam tego
 * nie zrobi (template engine tylko URLe rozwija). Faza 3 (Discovery) doda
 * `apps/edge/src/discovery/knxnet-ip.ts` z biblioteką `knx-ip-js` lub własną
 * mini-implementacją.
 *
 * Producenci wspierani (Q2 decyzja Konrada):
 *   • eelectron — IN/Quad IP Router, IPSwitch (Italia)
 *   • Jung — IPS 200, IPS 300 SREG, IPR 300 SREG (Niemcy)
 *   • Gira — 216700 (KNX/IP Router), 216800 (KNX/IP Interface), HomeServer 4
 *
 * Wszystkie używają tego samego standardu KNXnet/IP (KNX Association
 * Specification AN0096) — różnice tylko w mDNS hostname (jeśli w ogóle
 * publikują mDNS — większość nie) i OUI MAC.
 *
 * KNX-IP routery zwykle **NIE** publikują mDNS — Discovery działa natywnym
 * SEARCH_REQUEST. Dlatego `mdnsService` jest pusty, ale `pingProtocol`
 * jest `knxnet-ip` (Edge wywołuje search-by-IP zamiast HTTP ping).
 */
import type { DeviceDriver } from '../types'
import {
  FIELD_NAME, FIELD_IP, FIELD_MAC,
  FIELD_KNX_PHYS_ADDR, FIELD_KNX_BRIDGE_REF, FIELD_GROUP_ADDR,
  FIELD_KNX_DPT, FIELD_KNX_FUNCTION,
} from './_common'

// ─────────────────────────────────────────────────────────────────────────────
//  KNX-IP Bridge (eelectron / Jung / Gira) — jeden generyczny driver
// ─────────────────────────────────────────────────────────────────────────────

export const knxIpBridge: DeviceDriver = {
  id: 'knx-ip-bridge',
  type: 'KNX_BRIDGE',
  manufacturer: 'KNX-IP (Generic)',
  models: [
    // eelectron
    'eelectron IN/Quad', 'eelectron IPSwitch',
    // Jung
    'Jung IPR 300 SREG', 'Jung IPS 300 SREG', 'Jung IPS 200',
    // Gira
    'Gira 216700 (KNX/IP Router)', 'Gira 216800 (KNX/IP Interface)',
    'Gira HomeServer 4',
  ],
  label: 'KNX-IP Router / Interface',
  icon: '🏗️',
  notes: 'Bramka KNX-IP (eelectron, Jung, Gira). Konfiguracja: IP + port 3671 (default). Edge wykrywa przez KNXnet/IP SEARCH (multicast 224.0.23.12:3671). Wszystkie producenci kompatybilne — standard KNX Association.',
  capabilities: ['discoverable', 'restart'],
  fields: [
    FIELD_NAME,
    FIELD_IP,
    {
      key: 'knxPort',
      label: 'Port KNXnet/IP',
      type: 'number',
      group: 'network',
      default: 3671,
      min: 1,
      max: 65535,
      help: 'Standard KNX Association: 3671/UDP. Zmieniaj tylko gdy bridge ma niestandardową konfigurację.',
    },
    FIELD_MAC,
    FIELD_KNX_PHYS_ADDR,
    {
      key: 'connectionMode',
      label: 'Tryb pracy',
      type: 'select',
      group: 'network',
      default: 'tunneling',
      help: 'Tunneling: 1 klient = 1 kanał (bezpieczne, max 4-8 kanałów per router). Routing: multicast do wszystkich bridge\'y w sieci.',
      options: [
        { value: 'tunneling', label: 'Tunneling (zalecane)' },
        { value: 'routing',   label: 'Routing (multicast)' },
      ],
    },
    {
      key: 'multicastGroup',
      label: 'Multicast group',
      type: 'text',
      group: 'advanced',
      default: '224.0.23.12',
      help: 'Adres multicast dla KNXnet/IP routing. Zmień tylko gdy używasz niestandardowej grupy (rzadko).',
      showWhen: (cfg) => cfg.connectionMode === 'routing',
    },
  ],
  defaults: {
    knxPort: 3671,
    connectionMode: 'tunneling',
    multicastGroup: '224.0.23.12',
  },
  endpoints: {
    // KNXnet/IP nie jest HTTP — Edge musi rozpoznać `pingProtocol='knxnet-ip'`
    // i wysłać SEARCH_REQUEST na unicast {ip}:{knxPort} (lub multicast).
    // `ping[]` jest tu jako placeholder z formatem URI-like (`knx://...`) żeby
    // logi diagnostyczne i UI miały czytelny opis co Edge robi.
    ping: ['knx://{ip}:{knxPort}/search'],
    pingProtocol: 'knxnet-ip',
    // Restart — nie wszystkie bridge'e wspierają. Gira 216700 ma to przez web UI,
    // eelectron przez KNX object (Engineering Tool). Driver wystawia jako TODO —
    // Faza 6 doda producent-specific endpointy gdzie się da.
    discovery: {
      // Brak mDNS — KNX-IP routery nie publikują się w mDNS jednolicie.
      // Discovery przez natywny KNXnet/IP SEARCH (Faza 3 — apps/edge/src/discovery/knxnet-ip.ts).
      macPrefixes: [
        // Gira (ein.de OUI)
        '00:0E:8C',
        // Siemens (też produkował dla Jung/Gira w przeszłości)
        '00:01:E2',
        // Weinzierl (OEM dla wielu marek)
        '00:1F:7C',
      ],
    },
  },
  certification: {
    status: 'beta',
    recommendedFor: 'residential',
    knownIssues: [
      'KNXnet/IP discovery (SEARCH) działa — testowane u Konrada na 192.168.1.128.',
      'Tunneling: faktyczne wysyłanie GroupValueWrite jeszcze nie zaimplementowane w Edge (Faza 6).',
    ],
  },
}

// ─────────────────────────────────────────────────────────────────────────────
//  KNX Object — logiczny obiekt mapowany na GA. Capabilities zależą od `function`.
// ─────────────────────────────────────────────────────────────────────────────

export const knxGenericObject: DeviceDriver = {
  id: 'knx-generic-object',
  type: 'KNX_OBJECT',
  manufacturer: 'KNX (Generic)',
  models: ['Switch', 'Dimmer', 'Blinds', 'Thermostat', 'Scene', 'Sensor'],
  label: 'KNX obiekt (group address)',
  icon: '💡',
  notes: 'Logiczny obiekt KNX — np. „Światło kuchnia" na GA 1/0/1. Wymaga wybranego KNX-IP Bridge\'a (rodzica). Capabilities dynamicznie zależą od pola „Funkcja" (switch/dimmer/blinds/...).',
  // Te capabilities pokrywają cały zakres KNX_OBJECT — runtime włącza je per
  // `function` (np. blinds → toggle+setLevel, scene → toggle only, sensor → nic).
  // Wizard pokaże tylko te relewantne dla wybranej funkcji.
  capabilities: ['toggle', 'setLevel'],
  fields: [
    FIELD_NAME,
    FIELD_KNX_BRIDGE_REF,
    FIELD_KNX_FUNCTION,
    FIELD_GROUP_ADDR,
    FIELD_KNX_DPT,
    // Dla dimmera / rolet — second GA (np. on/off osobno od level).
    {
      key: 'statusGroupAddress',
      label: 'GA odczytu stanu (opcjonalnie)',
      type: 'group-address',
      group: 'knx',
      help: 'Niektóre obiekty mają osobny GA do odczytu aktualnego stanu (np. dim "1/0/2", a sterowanie "1/0/1"). Pozostaw puste jeśli ten sam GA obsługuje oba.',
      validate: (v) => {
        if (v == null || v === '') return null
        if (typeof v !== 'string') return 'Nieprawidłowy format'
        if (!/^([0-9]{1,2})\/([0-9])\/([0-9]{1,3})$/.test(v) &&
            !/^([0-9]{1,2})\/([0-9]{1,4})$/.test(v)) {
          return 'Format: "1/0/1" lub "1/1"'
        }
        return null
      },
    },
    {
      key: 'inverted',
      label: 'Logika odwrócona',
      type: 'boolean',
      group: 'advanced',
      default: false,
      help: 'KNX czasem koduje on=0, off=1 (zależy od aktora). Zaznacz jeśli odwrotnie działa.',
    },
  ],
  defaults: {
    function: 'switch',
    dpt: '1.001',
    inverted: false,
  },
  endpoints: {
    // KNX_OBJECT nie ma własnego ping — to logiczny obiekt na buście.
    // „Online" obiekt = jego bridge jest online. Edge dziedziczy status z bridge'a.
    pingProtocol: 'knxnet-ip',
    // Toggle przez KNXnet/IP tunneling. Edge konwertuje:
    //   groupAddress "1/0/1" → 16-bit raw GA (1<<11 | 0<<8 | 1 = 0x0801)
    //   value (true/false) → APCI A_GroupValue_Write (DPT 1.001 = 1 bit)
    // Body to JSON dla Edge-runner-a, nie HTTP body — runner i tak nie używa
    // HTTP dla `protocol='knxnet-ip'`.
    toggle: {
      protocol: 'knxnet-ip',
      method: 'POST',           // ignorowane dla KNXnet/IP
      url: 'knx://{bridgeDeviceId}/{groupAddress}',
      auth: 'none',
      body: '{"value":{state},"dpt":"{dpt}","inverted":{inverted}}',
    },
    // setLevel dla dimmera (DPT 5.001 = 0..100%) — value 0..255 raw.
    // Edge zna mapowanie scaling % → byte przy DPT 5.001.
    // (capability `setLevel` zarejestrowane w driverze — w przyszłej wersji
    // doda się osobne endpointy; na razie jeden uniwersalny dla `function='dimmer'`.)
  },
  certification: {
    status: 'beta',
    recommendedFor: 'residential',
    knownIssues: [
      'Mapowanie GA → komenda zaimplementowane w katalogu, ale faktyczne wysyłanie cEMI przez KNX-IP bridge — Faza 6.',
    ],
  },
}
