/**
 * test-anpr-parser — standalone skrypt asercji dla `anpr-xml-parser.ts`.
 *
 * Edge nie ma test runnera (brak jest/vitest w package.json), więc testy
 * odpalamy zwykłym node-em na SKOMPILOWANYM dist:
 *
 *   pnpm --filter @gatelynk/edge build
 *   node apps/edge/tools/test-anpr-parser.ts
 *
 * (Node ≥ 22.18 strip-uje typy z .ts natywnie; starszy node → `npx tsx`.)
 *
 * Fixtures pokrywają warianty firmware Hikvision ANPR:
 *   1. DeepinView V5.8 (kształt 1:1 z produkcyjnego dumpa Villa Natura)
 *   2. Starszy firmware (V5.3–5.6, np. DS-2CD4A26FWD): namespace std-cgi
 *      ver10, BRAK bloku vehicleInfo (bez koloru/marki)
 *   3. Prefiks namespace (forward przez NVR)
 *   4. confidenceLevel jako float
 *   5. Legacy tagi <plate> / <plateNumber> / <originalLicensePlate>
 *   6. multipart: XML + JPEG-i (w tym application/octet-stream z magic FFD8)
 *   7. Event bez tablicy (motion) → plate null
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import * as fs from 'node:fs'

const require = createRequire(import.meta.url)
const toolsDir = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.join(toolsDir, '..', 'dist', 'devices', 'cameras', 'anpr-xml-parser.js')
if (!fs.existsSync(distPath)) {
  console.error(`✗ Brak ${distPath} — najpierw: pnpm --filter @gatelynk/edge build`)
  process.exit(1)
}
const {
  extractAnprXml,
  parseAnprFields,
  extractAllAnprImages,
  pickBestAnprImage,
} = require(distPath)

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}${detail !== undefined ? ` — got: ${JSON.stringify(detail)}` : ''}`)
  }
}

// ── Fixture 1: DeepinView V5.8 (kształt z produkcji, plate zanonimizowany) ──
const deepinviewV58 = `<EventNotificationAlert version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<ipAddress>192.168.1.64</ipAddress>
<portNo>4000</portNo>
<channelID>1</channelID>
<dateTime>2026-07-05T20:44:40+01:00</dateTime>
<eventType>ANPR</eventType>
<eventState>active</eventState>
<eventDescription>ANPR</eventDescription>
<channelName>Camera 01</channelName>
<ANPR>
<country>7</country>
<licensePlate>WX1234A</licensePlate>
<line>1</line>
<direction>reverse</direction>
<confidenceLevel>92</confidenceLevel>
<plateType>unknown</plateType>
<plateColor>unknown</plateColor>
<licenseBright>79</licenseBright>
<plateCharBelieve>99,99,99,61,99,99,99</plateCharBelieve>
<vehicleType>SUVMPV</vehicleType>
<vehicleInfo>
<index>3301</index>
<colorDepth>0</colorDepth>
<color>black</color>
<length>0</length>
<vehicleLogoRecog>1036</vehicleLogoRecog>
<vehileSubLogoRecog>0</vehileSubLogoRecog>
<vehileModel>0</vehileModel>
</vehicleInfo>
<originalLicensePlate>WX1234A</originalLicensePlate>
<vehicleListName>otherList</vehicleListName>
</ANPR>
<UUID>x</UUID>
</EventNotificationAlert>`

console.log('\n[1] DeepinView V5.8 (format produkcyjny)')
{
  const f = parseAnprFields(deepinviewV58)
  check('eventType=ANPR', f.eventType === 'ANPR', f.eventType)
  check('plate=WX1234A', f.plate === 'WX1234A', f.plate)
  check('confidence=92', f.confidence === 92, f.confidence)
  check('direction=reverse', f.direction === 'reverse', f.direction)
  check('vehicleColor=black (nested vehicleInfo)', f.vehicleColor === 'black', f.vehicleColor)
  check('vehicleBrand=#1036 (numeric logoRecog)', f.vehicleBrand === '#1036', f.vehicleBrand)
  check('vehicleType=SUVMPV', f.vehicleType === 'SUVMPV', f.vehicleType)
  check('vehicleSubtype undefined (vehileModel typo NIE łapany)', f.vehicleSubtype === undefined, f.vehicleSubtype)
}

// ── Fixture 2: starszy firmware (V5.4, DS-2CD4A26FWD-like) ─────────────────
// std-cgi ver10 namespace, brak vehicleInfo / kolorów / marki.
const olderNoVehicleInfo = `<EventNotificationAlert version="1.0" xmlns="http://www.std-cgi.com/ver10/XMLSchema">
<ipAddress>192.168.1.201</ipAddress>
<channelID>1</channelID>
<dateTime>2020-03-10T09:12:00+01:00</dateTime>
<eventType>ANPR</eventType>
<eventState>active</eventState>
<ANPR>
<licensePlate>EL123AB</licensePlate>
<line>1</line>
<direction>forward</direction>
<confidenceLevel>85</confidenceLevel>
<plateType>92wex</plateType>
<plateColor>white</plateColor>
</ANPR>
</EventNotificationAlert>`

console.log('\n[2] Starszy firmware bez vehicleInfo (std-cgi ver10)')
{
  const f = parseAnprFields(olderNoVehicleInfo)
  check('plate=EL123AB', f.plate === 'EL123AB', f.plate)
  check('confidence=85', f.confidence === 85, f.confidence)
  check('direction=forward', f.direction === 'forward', f.direction)
  check('vehicleColor undefined (brak pola — graceful)', f.vehicleColor === undefined, f.vehicleColor)
  check('vehicleBrand undefined (brak pola — graceful)', f.vehicleBrand === undefined, f.vehicleBrand)
  check('vehicleType undefined', f.vehicleType === undefined, f.vehicleType)
}

// ── Fixture 3: prefiks namespace (forward przez NVR) ────────────────────────
const prefixedNs = `<?xml version="1.0" encoding="UTF-8"?>
<ns1:EventNotificationAlert xmlns:ns1="http://www.hikvision.com/ver20/XMLSchema" version="2.0">
<ns1:eventType>ANPR</ns1:eventType>
<ns1:ANPR>
<ns1:licensePlate>WA99999</ns1:licensePlate>
<ns1:confidenceLevel>90</ns1:confidenceLevel>
<ns1:direction>forward</ns1:direction>
</ns1:ANPR>
</ns1:EventNotificationAlert>`

console.log('\n[3] Prefiks namespace (NVR forward)')
{
  const xml = extractAnprXml(Buffer.from(prefixedNs, 'utf8'), 'application/xml')
  check('extractAnprXml znajduje prefiksowany root', !!xml && xml.includes('EventNotificationAlert'))
  const f = parseAnprFields(xml ?? '')
  check('plate=WA99999', f.plate === 'WA99999', f.plate)
  check('confidence=90', f.confidence === 90, f.confidence)
  check('eventType=ANPR', f.eventType === 'ANPR', f.eventType)
}

// ── Fixture 4: float confidence ──────────────────────────────────────────────
console.log('\n[4] confidenceLevel jako float')
{
  const f = parseAnprFields('<EventNotificationAlert><eventType>ANPR</eventType><ANPR><licensePlate>PO55X</licensePlate><confidenceLevel>92.5</confidenceLevel></ANPR></EventNotificationAlert>')
  check('confidence=92.5', f.confidence === 92.5, f.confidence)
}

// ── Fixture 5: legacy tagi tablicy ───────────────────────────────────────────
console.log('\n[5] Legacy tagi tablicy')
{
  check('<plate>', parseAnprFields('<x><plate>DW111</plate></x>').plate === 'DW111')
  check('<plateNumber>', parseAnprFields('<x><plateNumber>DW222</plateNumber></x>').plate === 'DW222')
  check('<originalLicensePlate> (jedyny tag)', parseAnprFields('<x><originalLicensePlate>DW333</originalLicensePlate></x>').plate === 'DW333')
  check('<plateType> NIE jest brany za plate', parseAnprFields('<x><plateType>unknown</plateType></x>').plate === null)
}

// ── Fixture 6: multipart z JPEG-ami ─────────────────────────────────────────
console.log('\n[6] Multipart (XML + JPEG-i)')
{
  const boundary = 'MIME_boundary'
  const jpeg = (size: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, 0x42), Buffer.from([0xff, 0xd9])])
  const plateCrop = jpeg(3_000)
  const scene = jpeg(120_000)
  const part = (headers: string, body: Buffer) =>
    Buffer.concat([Buffer.from(`--${boundary}\r\n${headers}\r\n\r\n`), body, Buffer.from('\r\n')])
  const body = Buffer.concat([
    part('Content-Disposition: form-data; name="anpr.xml"\r\nContent-Type: application/xml', Buffer.from(olderNoVehicleInfo)),
    part('Content-Disposition: form-data; name="licensePlatePicture.jpg"\r\nContent-Type: image/jpeg', plateCrop),
    part('Content-Disposition: form-data; name="detectionPicture.jpg"\r\nContent-Type: image/jpeg', scene),
    Buffer.from(`--${boundary}--\r\n`),
  ])
  const ct = `multipart/form-data; boundary=${boundary}`

  const xml = extractAnprXml(body, ct)
  check('XML wyciągnięty z multipart', !!xml && parseAnprFields(xml!).plate === 'EL123AB')

  const images = extractAllAnprImages(body, ct)
  check('2 obrazki wyciągnięte', images.length === 2, images.length)
  const best = pickBestAnprImage(images)
  check('pickBest → detectionPicture (full scene)', best?.name === 'detectionPicture.jpg', best?.name)
  check('scena ma pełny rozmiar', best?.data.length === scene.length, best?.data.length)
}

// ── Fixture 6b: multipart z application/octet-stream (starszy fw) ───────────
console.log('\n[6b] Multipart: JPEG jako application/octet-stream')
{
  const boundary = 'octbound'
  const jpegBuf = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40_000, 0x41), Buffer.from([0xff, 0xd9])])
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="anpr.xml"\r\nContent-Type: text/xml\r\n\r\n${olderNoVehicleInfo}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; filename="vehiclePicture.jpg"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    jpegBuf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  const ct = `multipart/form-data; boundary=${boundary}`
  const images = extractAllAnprImages(body, ct)
  check('octet-stream JPEG rozpoznany po magic bytes', images.length === 1, images.length)
  check('filename= użyty jako name', images[0]?.name === 'vehiclePicture.jpg', images[0]?.name)
}

// ── Fixture 7: event bez tablicy (motion) ────────────────────────────────────
console.log('\n[7] Event nie-ANPR (motion) → plate null')
{
  const f = parseAnprFields('<EventNotificationAlert><eventType>VMD</eventType><eventState>active</eventState></EventNotificationAlert>')
  check('plate=null', f.plate === null, f.plate)
  check('eventType=VMD', f.eventType === 'VMD', f.eventType)
}

// ── Fixture 8: plate "unknown" (kamera widzi auto, nie czyta tablicy) ───────
console.log('\n[8] licensePlate=unknown — zachowanie udokumentowane (przechodzi dalej)')
{
  const f = parseAnprFields('<EventNotificationAlert><eventType>ANPR</eventType><ANPR><licensePlate>unknown</licensePlate><confidenceLevel>0</confidenceLevel></ANPR></EventNotificationAlert>')
  check('plate=unknown (świadomie NIE filtrujemy — prod loguje odczyty UNKNOWN)', f.plate === 'unknown', f.plate)
}

console.log(`\n${'─'.repeat(50)}\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
