import { Logger } from '@nestjs/common'
import { exec } from 'child_process'
import * as net from 'net'
import * as os from 'os'
import { promisify } from 'util'
import { DRIVERS } from '@gatelynk/device-drivers'
import { DiscoveryCandidate } from './discovery.types'
import { lookupOui, normalizeMac } from './oui-lookup'

const execAsync = promisify(exec)
const logger = new Logger('LanScan')

/**
 * Aktywny skan sieci lokalnej — znajduje urządzenia, które SIĘ NIE OGŁASZAJĄ.
 *
 * Powód powstania (zgłoszenie Konrada 2026-08-07): wyszukiwanie opierało się
 * wyłącznie na mDNS, więc pokazywało same kamery Hikvision. Kasety Akuvox
 * w ogóle nie pojawiały się na liście — bo mDNS-a nie rozgłaszają. Instalator
 * musiał wpisywać je ręcznie, znając adres IP.
 *
 * Zasada: nie pytamy urządzeń, czy chcą się przedstawić — pytamy SIEĆ, kto
 * w niej jest.
 *
 *   1. Ping na całą podsieć równolegle → system wypełnia tablicę ARP.
 *   2. Odczyt tablicy ARP → adresy sprzętowe (MAC) wszystkich sąsiadów.
 *   3. MAC → producent (baza OUI). To identyfikacja PEWNA: prefiks adresu
 *      sprzętowego jest przypisany producentowi na stałe, w przeciwieństwie
 *      do nagłówków HTTP, które bywają puste (Akuvox nie podaje `Server`).
 *   4. Sprawdzenie, czy urządzenie ma otwarty port zarządzania — odsiewa
 *      telefony i laptopy, które też są w sieci.
 *
 * Skanujemy tylko sieci prywatne i tylko maski /24 lub węższe. Większa sieć
 * oznaczałaby tysiące hostów i skan trwający minutami — a taka instalacja
 * i tak wymaga rozmowy z administratorem, nie automatu.
 */

/** Porty zarządzania — obecność któregokolwiek świadczy, że to urządzenie, nie telefon. */
const DEVICE_PORTS = [80, 443, 8080]

/** Ile hostów sprawdzamy równocześnie. Kompromis: szybkość vs obciążenie sieci. */
const PING_CONCURRENCY = 64
const PORT_CONCURRENCY = 24

function isPrivate(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** Adresy IPv4 do przeskanowania — z interfejsów tej maszyny. */
function subnetHosts(): { hosts: string[]; networks: string[] } {
  const hosts: string[] = []
  const networks: string[] = []

  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || !isPrivate(a.address)) continue
      // Tylko /24 i węższe — patrz uzasadnienie w nagłówku pliku.
      const maskOctets = a.netmask.split('.').map(Number)
      if (maskOctets[0] !== 255 || maskOctets[1] !== 255 || maskOctets[2] !== 255) continue

      const base = a.address.split('.').slice(0, 3).join('.')
      if (networks.includes(base)) continue
      networks.push(base)
      for (let i = 1; i <= 254; i++) {
        const ip = `${base}.${i}`
        if (ip !== a.address) hosts.push(ip)
      }
    }
  }
  return { hosts, networks }
}

async function runBounded<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let idx = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const item = items[idx++]
      try { await fn(item) } catch { /* pojedynczy host nie może wysadzić skanu */ }
    }
  })
  await Promise.all(workers)
}

/** Puka do hosta, żeby system zapisał jego MAC w tablicy ARP. Wynik nieistotny. */
async function pingSweep(hosts: string[]) {
  await runBounded(hosts, PING_CONCURRENCY, async (ip) => {
    // -c1 jeden pakiet, -t1 sekunda timeout, -q cicho. Host, który nie
    // odpowiada na ping, i tak bywa widoczny w ARP — dlatego ignorujemy błąd.
    await execAsync(`ping -c1 -t1 -q ${ip}`).catch(() => null)
  })
}

/** Odczyt tablicy ARP: IP → MAC. */
async function readArpTable(): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const { stdout } = await execAsync('arp -an').catch(() => ({ stdout: '' }))
  for (const line of stdout.split('\n')) {
    // Format macOS: `? (192.168.1.10) at c:11:5:a:b3:17 on en0 ifscope [ethernet]`
    const m = line.match(/\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9a-fA-F:]+)/)
    if (!m) continue
    const mac = normalizeMac(m[2])          // uzupełnia zera wiodące macOS-a
    if (!mac || mac === '00:00:00:00:00:00' || /^FF:FF/i.test(mac)) continue
    out.set(m[1], mac)
  }
  return out
}

/** Czy na hoście jest otwarty któryś port zarządzania. */
function probePort(ip: string, port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    const done = (ok: boolean) => { sock.destroy(); resolve(ok) }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
    sock.connect(port, ip)
  })
}

/**
 * Skanuje sieci lokalne i zwraca kandydatów.
 *
 * Zwracamy WSZYSTKIE urządzenia z otwartym portem zarządzania, nie tylko te
 * o znanym producencie — instalator ma zobaczyć, co realnie jest w sieci.
 * Znany producent dostaje podpowiedź sterownika i wysoką pewność; nieznany
 * pojawia się jako „nierozpoznane urządzenie" i można go dodać ręcznie.
 */
export async function lanScan(timeoutMs = 30_000): Promise<DiscoveryCandidate[]> {
  const started = Date.now()
  const { hosts, networks } = subnetHosts()
  if (!hosts.length) {
    logger.warn('Brak sieci prywatnej /24 na interfejsach — skan pominięty')
    return []
  }
  logger.log(`Skan sieci: ${networks.map((n) => `${n}.0/24`).join(', ')} (${hosts.length} adresów)`)

  await pingSweep(hosts)
  const arp = await readArpTable()
  logger.log(`ARP: ${arp.size} urządzeń w sieci (${Date.now() - started} ms)`)

  const candidates: DiscoveryCandidate[] = []
  const entries = [...arp.entries()]

  await runBounded(entries, PORT_CONCURRENCY, async ([ip, mac]) => {
    if (Date.now() - started > timeoutMs) return

    let openPort: number | null = null
    for (const p of DEVICE_PORTS) {
      if (await probePort(ip, p)) { openPort = p; break }
    }
    if (openPort === null) return   // telefon/laptop — nie interesuje nas

    const oui = lookupOui(mac)
    const driverId = oui?.suggestedDriverIds?.[0] ?? null
    const driver = driverId ? DRIVERS.find((d) => d.id === driverId) : null

    candidates.push({
      ip,
      port: openPort,
      mac,
      vendor: oui?.manufacturer,
      friendlyName: oui
        ? `${oui.manufacturer} (${ip})`
        : `Nierozpoznane urządzenie (${ip})`,
      suggestedType: driver?.type,
      suggestedDriverId: driverId,
      alternativeDrivers: oui?.suggestedDriverIds?.slice(1),
      foundVia: 'lan-scan',
      discoveredAt: Date.now(),
    })
  })

  logger.log(
    `Skan sieci zakończony: ${candidates.length} urządzeń ` +
    `(${candidates.filter((c) => c.vendor).length} rozpoznanych) w ${Date.now() - started} ms`,
  )
  return candidates
}
