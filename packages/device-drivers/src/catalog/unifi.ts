/**
 * Drivery Ubiquiti UniFi — managed switche L2 z PoE.
 *
 * UniFi Switch Pro 8 PoE (USW-Pro-8-PoE) — 8 portów RJ45 (2× 10G SFP+, 8× 1G PoE+),
 * zarządzany przez UniFi Network Controller (UDM / Cloud Key / self-host).
 *
 * Architektura komunikacji:
 *   Edge ─HTTPS→ UniFi Controller ─(internal)→ Switch
 *
 * NIE łączymy się bezpośrednio ze switch-em (Ubiquiti nie udostępnia oficjalnego
 * lokalnego API per-device w trybie adopted). Wszystko leci przez REST controllera.
 *
 * Obsługiwane controller-y:
 *   • self-hosted (Linux, Docker)         → port 8443, prefix `/api/...`
 *   • UniFi OS  (UDM/UDR/CloudKey Gen2)   → port 443,  prefix `/proxy/network/api/...`
 *   • UniFi Network Standalone Application (v9+ na macOS/Linux) → 8443, jak self-hosted
 *
 * Auth: session cookie po POST /api/login (self-host) lub /api/auth/login (UniFi OS).
 * Cookies trzymamy w pamięci procesu Edge — re-login przy 401.
 *
 * Capabilities (per port):
 *   • status (link up/down, speed, PoE state, current/voltage, tx/rx bytes)
 *   • PoE toggle (poe_mode: 'auto' | 'off' | 'passive24')
 *   • port label override (port_overrides[].name) — pushed na switch
 *   • przypisanie do innego urządzenia GateLynk (storage lokalny w `config.portMap`)
 *
 * Driver `fields` opisuje TYLKO config controllera + identyfikację switcha.
 * Logika port-management żyje w `apps/edge/src/devices/lan-switch/` (osobny serwis,
 * NIE driver-engine — UniFi REST nie pasuje do prostego template-engine).
 */
import type { DeviceDriver } from '../types'
import { FIELD_NAME, FIELD_IP, FIELD_LOGIN, FIELD_PASSWORD, FIELD_MAC } from './_common'

export const unifiSwitchPro8PoE: DeviceDriver = {
  id: 'unifi-switch-pro-8-poe',
  type: 'LAN_SWITCH',
  manufacturer: 'Ubiquiti',
  models: ['USW-Pro-8-PoE', 'USW-Pro-8'],
  label: 'UniFi Switch Pro 8 PoE',
  icon: '🌐',
  notes: 'Zarządzanie przez UniFi Network Controller (UDM, Cloud Key lub self-host). Edge pyta controller-a o status portów i wymusza overrides PoE. Wymaga lokalnego konta admin w controllerze (NIE Ubiquiti SSO).',
  capabilities: ['toggle', 'restart', 'discoverable'],
  fields: [
    FIELD_NAME,
    {
      key: 'controllerUrl',
      label: 'Adres controllera',
      type: 'text',
      group: 'network',
      required: true,
      placeholder: 'https://192.168.1.1',
      help: 'Pełen URL UniFi Network Controllera (UDM/CloudKey/self-host). Self-host typowo :8443, UDM :443.',
    },
    {
      key: 'controllerType',
      label: 'Typ controllera',
      type: 'select',
      group: 'network',
      required: true,
      default: 'unifi-os',
      options: [
        { value: 'unifi-os',    label: 'UniFi OS (UDM, CloudKey Gen2)' },
        { value: 'standalone',  label: 'Self-host / Network Standalone' },
      ],
      help: 'UniFi OS dodaje prefix /proxy/network/. Self-host używa bezpośrednio /api/.',
    },
    {
      key: 'site',
      label: 'Site',
      type: 'text',
      group: 'network',
      default: 'default',
      help: 'Identyfikator site-a w controllerze. Default to „default" — większość instalacji ma tylko jeden site.',
    },
    {
      ...FIELD_IP,
      help: 'IP samego switcha (do echo-test ping w LAN). Opcjonalne — controller zna IP, ale Edge weryfikuje LAN reachability.',
    },
    FIELD_LOGIN('admin'),
    FIELD_PASSWORD,
    {
      ...FIELD_MAC,
      required: true,
      help: 'MAC switcha (na obudowie albo z UniFi UI). Edge używa go żeby zidentyfikować ten switch w odpowiedzi /stat/device controllera.',
    },
    {
      key: 'pollSeconds',
      label: 'Częstotliwość pollingu (sek)',
      type: 'number',
      group: 'advanced',
      default: 15,
      min: 5,
      max: 300,
      help: 'Co ile sekund Edge odpytuje controller o stan portów. 15 sek = świeży status bez obciążania controllera.',
    },
    {
      key: 'portCount',
      label: 'Liczba portów',
      type: 'number',
      group: 'advanced',
      default: 8,
      min: 4,
      max: 48,
      help: 'Pre-fill: USW-Pro-8-PoE = 8. Edge wykryje rzeczywistą liczbę z controllera, to pole tylko do walidacji configu.',
    },
  ],
  defaults: {
    controllerType: 'unifi-os',
    site: 'default',
    login: 'admin',
    portCount: 8,
    pollSeconds: 15,
  },
  endpoints: {
    // Driver-engine NIE używa tych URL-i — UniFi REST jest obsługiwane przez
    // dedykowany UnifiClient w `apps/edge/src/devices/lan-switch/`. Trzymamy
    // pole `endpoints` puste-z-stubem żeby `DeviceDriver` typ był zadowolony.
    ping: ['{controllerUrl}/api/self'],
    pingProtocol: 'http',
  },
  certification: {
    status: 'beta',
    testedFirmware: ['UniFi Network 9.x'],
    recommendedFor: 'commercial',
    knownIssues: [
      'Driver wymaga lokalnego konta admin w UniFi Controller — Ubiquiti SSO/cloud-only nie jest obsługiwane.',
      'Self-signed cert kontrolera UniFi jest akceptowany (Edge ma NODE_TLS_REJECT_UNAUTHORIZED=0 dla całego LAN-u).',
      'Discovery: UniFi nie publikuje switchy na mDNS w LAN — trzeba dodać ręcznie przez controller URL.',
    ],
  },
}
