/**
 * KNXnet/IP SEARCH — wyszukiwanie KNX-IP routerów/interfejsów w sieci.
 *
 * Protokół: KNX Association Standard, AN0096 (KNXnet/IP Core).
 *   Adres multicast: 224.0.23.12
 *   Port:            3671/UDP
 *
 * Flow:
 *   1. Edge bindu je UDP socket na efemerycznym porcie.
 *   2. Wysyła SEARCH_REQUEST (14 bajtów) na multicast 224.0.23.12:3671.
 *   3. Każdy KNX-IP router odpowiada UNICAST SEARCH_RESPONSE
 *      (header + HPAI + DIB Device Info + DIB Supported Services).
 *   4. Z odpowiedzi parsujemy: friendly name (30B padded), MAC, KNX physical
 *      address, multicast addr, serial.
 *
 * Brak biblioteki — pure Node `dgram`. Cały protokół to ~150 linii kodu,
 * stabilny od dekady (KNX 2.0 podtrzymuje wsteczną kompatybilność).
 *
 * Wariant routing: gdy bridge pracuje w trybie routing (zamiast tunneling),
 * też odpowiada na SEARCH_REQUEST — nie ma sensu różnicować na poziomie
 * discovery (różnica dotyczy później, gdy faktycznie wysyłamy GroupValueWrite).
 */
import * as dgram from 'dgram'
import { Logger } from '@nestjs/common'
import type { DiscoveryCandidate } from './discovery.types'

const KNX_MULTICAST = '224.0.23.12'
const KNX_PORT = 3671

// Service type identifiers (AN0096 Tab. 3)
const ST_SEARCH_REQUEST  = 0x0201
const ST_SEARCH_RESPONSE = 0x0202

// DIB type codes (AN0096 §7.5.4)
const DIB_DEVICE_INFO     = 0x01
const DIB_SUPP_SVC_FAMILIES = 0x02

const logger = new Logger('KnxnetIpDiscovery')

/**
 * Builduje SEARCH_REQUEST.
 *
 *   Byte 0:    0x06              Header size
 *   Byte 1:    0x10              Protocol version (KNXnet/IP 1.0)
 *   Bytes 2-3: 0x0201            Service type (big-endian)
 *   Bytes 4-5: 0x000e            Total length = 14 (BE)
 *   ── HPAI Discovery endpoint (length 8) ──
 *   Byte 6:    0x08              HPAI size
 *   Byte 7:    0x01              Protocol code (IPv4 UDP)
 *   Bytes 8-11:  IP (4 bytes)    Source IP (Edge's IP) — większość routerów ignoruje, można dać 0.0.0.0
 *   Bytes 12-13: Port (BE 2B)    Source port (efemeryczny, na którym Edge nasłuchuje)
 *
 * Source IP = 0.0.0.0 — router i tak odpowiada unicastem na rzeczywisty src
 * z pakietu UDP, więc nie musimy znać własnego IP w sieci.
 */
function buildSearchRequest(sourcePort: number): Buffer {
  const buf = Buffer.alloc(14)
  buf.writeUInt8(0x06, 0)            // header size
  buf.writeUInt8(0x10, 1)            // protocol version
  buf.writeUInt16BE(ST_SEARCH_REQUEST, 2)
  buf.writeUInt16BE(14, 4)           // total length
  // HPAI
  buf.writeUInt8(0x08, 6)            // HPAI size
  buf.writeUInt8(0x01, 7)            // protocol IPv4 UDP
  // IP 4B (0.0.0.0) — bytes 8-11 już są zero z Buffer.alloc
  buf.writeUInt16BE(sourcePort, 12)  // source port
  return buf
}

/**
 * Parsuje SEARCH_RESPONSE i wyciąga: HPAI control endpoint + DIB Device Info.
 *
 * Format (AN0096 §7.5.2):
 *   Header (6 bytes):   0x06 0x10 0x0202 <total length>
 *   HPAI (8 bytes):     0x08 0x01 <IP 4B> <Port 2B>
 *   DIB Device Info (54 bytes):
 *     Byte 0:  0x36 (length)
 *     Byte 1:  0x01 (DIB_DEVICE_INFO)
 *     Byte 2:  KNX medium (0x02 = TP)
 *     Byte 3:  device status
 *     Bytes 4-5: KNX individual address (BE) → "X.Y.Z"
 *     Bytes 6-7: project install ID
 *     Bytes 8-13: KNX serial number (6B)
 *     Bytes 14-17: routing multicast addr
 *     Bytes 18-23: MAC (6B)
 *     Bytes 24-53: friendly name (30B ASCII padded with 0x00)
 *   DIB Supported Service Families: pomijamy (informacyjne).
 */
function parseSearchResponse(buf: Buffer, fromIp: string): DiscoveryCandidate | null {
  // Minimalna długość: 6 (header) + 8 (HPAI) + 0x36 (54 DIB Device Info) = 68
  if (buf.length < 68) return null
  if (buf.readUInt16BE(2) !== ST_SEARCH_RESPONSE) return null

  // HPAI Control endpoint — IP + port
  const hpaiOffset = 6
  if (buf.readUInt8(hpaiOffset) !== 0x08) return null
  const controlIp = [
    buf.readUInt8(hpaiOffset + 2),
    buf.readUInt8(hpaiOffset + 3),
    buf.readUInt8(hpaiOffset + 4),
    buf.readUInt8(hpaiOffset + 5),
  ].join('.')
  const controlPort = buf.readUInt16BE(hpaiOffset + 6)

  // DIB Device Info zaczyna się po HPAI (off 14)
  const dibOffset = 14
  const dibLen = buf.readUInt8(dibOffset)
  if (dibLen !== 0x36 || buf.readUInt8(dibOffset + 1) !== DIB_DEVICE_INFO) return null

  // KNX individual address — 2 bajty big-endian: AAAA LLLL DDDDDDDD (4+4+8 bits)
  const knxAddr16 = buf.readUInt16BE(dibOffset + 4)
  const knxArea = (knxAddr16 >> 12) & 0x0f
  const knxLine = (knxAddr16 >> 8) & 0x0f
  const knxDev  = knxAddr16 & 0xff
  const physicalAddress = `${knxArea}.${knxLine}.${knxDev}`

  // Serial — 6 bytes hex
  const serialBytes = Array.from({ length: 6 }, (_, i) => buf.readUInt8(dibOffset + 8 + i))
  const serial = serialBytes.map((b) => b.toString(16).padStart(2, '0')).join(':').toUpperCase()

  // MAC — 6 bytes
  const macBytes = Array.from({ length: 6 }, (_, i) => buf.readUInt8(dibOffset + 18 + i))
  const mac = macBytes.map((b) => b.toString(16).padStart(2, '0')).join(':').toUpperCase()

  // Friendly name — 30 bytes ASCII, null-terminated padded
  let friendlyName = ''
  for (let i = 0; i < 30; i++) {
    const c = buf.readUInt8(dibOffset + 24 + i)
    if (c === 0) break
    friendlyName += String.fromCharCode(c)
  }

  return {
    ip: controlIp || fromIp,
    port: controlPort,
    mac,
    serial,
    friendlyName: friendlyName.trim(),
    vendor: 'KNX-IP',  // konkretny producent dojedzie z OUI lookup (knx.adapter wraca raw,
                       // service.ts robi enrichment przez `lookupOui(mac)`)
    suggestedType: 'KNX_BRIDGE',
    suggestedDriverId: 'knx-ip-bridge',
    foundVia: 'knxnet-ip',
    discoveredAt: Date.now(),
    txt: {
      physicalAddress,
    },
  }
}

/**
 * Uruchamia KNXnet/IP SEARCH — emit SEARCH_REQUEST + zbieranie SEARCH_RESPONSE
 * przez `timeoutMs`. Zwraca listę kandydatów.
 *
 * Side-effect-free poza socketem — sam się zamyka po timeout.
 */
export async function knxnetIpSearch(timeoutMs: number): Promise<DiscoveryCandidate[]> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    const candidates = new Map<string, DiscoveryCandidate>() // dedup po IP+MAC

    socket.on('error', (err) => {
      logger.warn(`KNXnet/IP socket error: ${err.message}`)
      try { socket.close() } catch {}
      resolve([...candidates.values()])
    })

    socket.on('message', (msg, rinfo) => {
      const candidate = parseSearchResponse(msg, rinfo.address)
      if (candidate) {
        const key = `${candidate.ip}|${candidate.mac ?? ''}`
        if (!candidates.has(key)) {
          candidates.set(key, candidate)
          logger.log(`Found KNX-IP: ${candidate.friendlyName} @ ${candidate.ip} (${candidate.mac})`)
        }
      }
    })

    socket.bind(0, () => {
      // Po bind socket dostaje port — używamy go w SEARCH_REQUEST HPAI source.
      // Multicast: TTL=2 (default 1 może nie przeskoczyć jednego routera),
      // setMulticastLoopback(false) bo nie chcemy słyszeć siebie.
      try {
        socket.setMulticastTTL(2)
        socket.setMulticastLoopback(false)
      } catch (err: any) {
        logger.warn(`setMulticast failed: ${err.message}`)
      }

      const port = socket.address().port
      const req = buildSearchRequest(port)
      socket.send(req, 0, req.length, KNX_PORT, KNX_MULTICAST, (err) => {
        if (err) {
          logger.warn(`KNXnet/IP send failed: ${err.message}`)
          try { socket.close() } catch {}
          resolve([])
          return
        }
        logger.log(`SEARCH_REQUEST broadcast to ${KNX_MULTICAST}:${KNX_PORT} (waiting ${timeoutMs}ms)`)
      })

      // Zamknij po timeout
      setTimeout(() => {
        try { socket.close() } catch {}
        resolve([...candidates.values()])
      }, timeoutMs)
    })
  })
}
