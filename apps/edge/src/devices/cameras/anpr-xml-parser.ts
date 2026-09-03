import { resolveHikvisionBrand } from './hikvision-vehicle-brands'

/**
 * anpr-xml-parser — czysty (bez NestJS) moduł parsujący eventy ANPR z kamer
 * Hikvision. Wydzielony z `LprEventsController` (2026-07-05, MVP „stare
 * kamery") żeby:
 *
 *   1. dało się go testować standalone (patrz `apps/edge/tools/test-anpr-parser.ts`
 *      — Edge nie ma test runnera, skrypt asercji odpalany node-em),
 *   2. tolerancja na warianty firmware była w JEDNYM miejscu.
 *
 * Warianty które musi znieść (potwierdzone w docs ISAPI + dumpach z produkcji):
 *
 *   • DeepinView V5.7/5.8 (Villa Natura, ground truth 2026-07-05):
 *     `<EventNotificationAlert version="2.0"
 *        xmlns="http://www.hikvision.com/ver20/XMLSchema">` z blokiem
 *     `<ANPR><licensePlate>…</licensePlate>…<vehicleInfo><color>…` itd.
 *   • Starsze ANPR (V5.3–5.6, np. DS-2CD4A26FWD, iDS-TCM/TCG):
 *     ten sam kształt, ale namespace bywa `http://www.std-cgi.com/ver20/…`
 *     lub `…/ver10/…`, a WEWNĄTRZ `<ANPR>` brakuje `vehicleInfo`
 *     (kolor/marka/typ w ogóle nie występują — muszą wyjść jako undefined,
 *     nie crash / nie pusty string).
 *   • Firmware z prefiksem namespace (`<ns1:EventNotificationAlert>`),
 *     spotykane przy forwardzie przez NVR.
 *   • `confidenceLevel` jako float ("92.5") na części starszych buildów.
 *   • multipart: XML part (`anpr.xml`) + JPEG-i; starsze firmware potrafi
 *     nadać częściom `application/octet-stream` zamiast `image/jpeg` —
 *     rozpoznajemy wtedy po magic bytes FFD8.
 *
 * UWAGA: zachowanie dla obecnego formatu produkcyjnego (DeepinView V5.8,
 * Villa Natura) NIE może się zmienić — kolejność fallbacków tagów jest
 * 1:1 z poprzednią wersją kontrolera.
 */

export interface AnprImagePart {
  name: string | null
  data: Buffer
}

export interface ParsedAnprFields {
  eventType: string | null
  plate: string | null
  confidence: number
  direction?: string
  vehicleColor?: string
  vehicleBrand?: string
  vehicleType?: string
  vehicleSubtype?: string
}

/**
 * Regex na tag XML tolerancyjny na: prefiks namespace (`<ns1:licensePlate>`),
 * atrybuty na tagu i wielkość liter. `[^<]+` w capture — jak dotychczas —
 * nie łapie tagów zagnieżdżonych.
 */
function tagRe(name: string): RegExp {
  return new RegExp(
    `<(?:[A-Za-z0-9_-]+:)?${name}(?:\\s[^>]*)?>([^<]+)</(?:[A-Za-z0-9_-]+:)?${name}>`,
    'i',
  )
}

function firstMatch(s: string, re: RegExp): string | null {
  const m = s.match(re)
  return m ? m[1].trim() : null
}

/** Pierwszy niepusty match z listy nazw tagów (w podanej kolejności). */
function firstTag(xml: string, names: string[]): string | null {
  for (const n of names) {
    const v = firstMatch(xml, tagRe(n))
    if (v) return v
  }
  return null
}

/**
 * Wytnij sekcję XML eventu z dowolnego body (inline XML albo multipart).
 * Dekodujemy cały bufor jako UTF-8 — sekcja XML jest ASCII-safe, binarne
 * części obrazkowe wokół dekodują się na mojibake, ale kotwice regexów
 * i tak trafiają we właściwe bajty.
 */
export function extractAnprXml(raw: Buffer, contentType: string): string | null {
  const text = raw.toString('utf8')

  // Standard: <EventNotificationAlert …>…</EventNotificationAlert>
  const start = text.indexOf('<EventNotificationAlert')
  if (start >= 0) {
    const end = text.indexOf('</EventNotificationAlert>', start)
    if (end > 0) return text.slice(start, end + '</EventNotificationAlert>'.length)
  }

  // Wariant z prefiksem namespace (np. forward przez NVR): <ns1:EventNotificationAlert>
  const prefixed = text.match(
    /<([A-Za-z0-9_-]+):EventNotificationAlert[\s>][\s\S]*?<\/\1:EventNotificationAlert>/,
  )
  if (prefixed) return prefixed[0]

  // Non-standard body: jeśli pachnie XML-em, zwróć co mamy.
  if (contentType.includes('xml') || text.trimStart().startsWith('<')) return text
  return null
}

/**
 * Wyciągnij pola ANPR z XML-a. Wszystkie pola vehicle* są opcjonalne —
 * starszy firmware (bez vehicle-attribute recognition) w ogóle ich nie
 * wysyła i wtedy zwracamy `undefined`, nie pusty string.
 */
export function parseAnprFields(xml: string): ParsedAnprFields {
  const eventType = firstTag(xml, ['eventType'])

  // Plate: DeepinView → licensePlate; starsze/egzotyczne → plate / plateNumber;
  // originalLicensePlate jako ostatnia deska (DeepinView duplikuje tam wartość,
  // niektóre starsze buildy wysyłają TYLKO ten tag).
  const plate = firstTag(xml, ['licensePlate', 'plate', 'plateNumber', 'originalLicensePlate'])

  // Float tolerancja — starsze buildy potrafią wysłać "92.5".
  const confRaw = firstMatch(
    xml,
    /<(?:[A-Za-z0-9_-]+:)?confidenceLevel(?:\s[^>]*)?>([\d.]+)<\/(?:[A-Za-z0-9_-]+:)?confidenceLevel>/i,
  )
  const confidence = Number(confRaw ?? '0')

  const direction = firstTag(xml, ['direction']) ?? undefined

  // Kolor: DeepinView V5.7+ raportuje nested `<color>` w `<vehicleInfo>`;
  // starsze/inne firmware używa top-level tagów. Goły `<color>` musi być
  // ostatni (w innych miejscach payloadu też występuje).
  const vehicleColor = firstTag(xml, [
    'vehicleColor',
    'colorOfVehicle',
    'vehicleColorName',
    'colorName',
  ])
    ?? firstMatch(xml, /<vehicleInfo>[\s\S]*?<color>([^<]+)<\/color>[\s\S]*?<\/vehicleInfo>/i)

  // Marka: DeepinView V5.7+ → numeryczne ID w <vehicleLogoRecog> (mapowane
  // przez hikvision-vehicle-brands; nieznane ID → "#NNNN"). Starsze firmware
  // wysyła tagi tekstowe — próbujemy ich najpierw, potem numeric fallback.
  const logoRecogRaw = firstMatch(
    xml,
    /<(?:[A-Za-z0-9_-]+:)?vehicleLogoRecog(?:\s[^>]*)?>(\d+)<\/(?:[A-Za-z0-9_-]+:)?vehicleLogoRecog>/i,
  )
  const logoRecogId = logoRecogRaw ? Number(logoRecogRaw) : null
  const vehicleBrand = firstTag(xml, [
    'vehicleLogo',
    'vehicleBrand',
    'vehicleLogoRecognize',
    'vehicleLogoName',
    'vehicleLogoDescribe',
  ])
    ?? resolveHikvisionBrand(logoRecogId)
    ?? firstTag(xml, ['logo', 'brand', 'manufacturer'])

  const vehicleType = firstTag(xml, ['vehicleType', 'carType'])
  const vehicleSubtype = firstTag(xml, [
    'vehicleSubType',
    'vehicleSeries',
    'vehicleModel',
  ])

  return {
    eventType,
    plate,
    confidence,
    direction,
    vehicleColor: vehicleColor ?? undefined,
    vehicleBrand: vehicleBrand ?? undefined,
    vehicleType: vehicleType ?? undefined,
    vehicleSubtype: vehicleSubtype ?? undefined,
  }
}

/**
 * Przejdź multipart body i zwróć WSZYSTKIE części obrazkowe z ich
 * Content-Disposition name. Zwraca [] dla body inline-XML.
 *
 * Tolerancja na starszy firmware: część JPEG bywa opisana jako
 * `application/octet-stream` — akceptujemy każdą część, której body zaczyna
 * się od JPEG magic (FFD8), o ile ma nagłówki części.
 */
export function extractAllAnprImages(raw: Buffer, contentType: string): AnprImagePart[] {
  if (!contentType.includes('multipart/')) return []
  const boundary = parseBoundary(contentType)
  if (!boundary) return []

  const delim = Buffer.from(`--${boundary}`)
  const parts: Buffer[] = []
  let offset = 0
  while (offset < raw.length) {
    const start = raw.indexOf(delim, offset)
    if (start < 0) break
    const next = raw.indexOf(delim, start + delim.length)
    if (next < 0) {
      parts.push(raw.slice(start + delim.length))
      break
    }
    parts.push(raw.slice(start + delim.length, next))
    offset = next
  }

  const out: AnprImagePart[] = []
  for (const part of parts) {
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
    if (headerEnd < 0) continue
    const headerBlock = part.slice(0, headerEnd).toString('utf8')
    const lower = headerBlock.toLowerCase()

    let bodyEnd = part.length
    if (bodyEnd >= 2 && part[bodyEnd - 2] === 0x0d && part[bodyEnd - 1] === 0x0a) bodyEnd -= 2
    const data = part.slice(headerEnd + 4, bodyEnd)

    const declaredImage =
      lower.includes('image/jpeg') || lower.includes('image/jpg') || lower.includes('image/pjpeg')
    const looksLikeJpeg = data.length > 4 && data[0] === 0xff && data[1] === 0xd8
    if (!declaredImage && !(lower.includes('application/octet-stream') && looksLikeJpeg)) continue

    // Content-Disposition: name= lub filename= (starsze firmware używa filename).
    const nameMatch = headerBlock.match(/(?:file)?name="?([^";\r\n]+)"?/i)
    const name = nameMatch ? nameMatch[1] : null
    out.push({ name, data })
  }
  return out
}

/**
 * Wybierz „najlepszy" JPEG z załączników multipart. Hikvision wysyła do 3
 * obrazków per event — chcemy full-scene:
 *   1. name zawiera "detection"/"scene"/"vehiclepicture" → wygrywa.
 *   2. Odrzuć oczywiste plate cropy (name z "plate" i <10 KB), weź największy.
 *   3. Zostały same plate cropy → największy (lepszy crop niż nic).
 */
export function pickBestAnprImage(images: AnprImagePart[]): AnprImagePart | null {
  if (images.length === 0) return null
  const named = (n: string | null) => (n ?? '').toLowerCase()
  const isPlateCrop = (i: AnprImagePart) => {
    const n = named(i.name)
    return (n.includes('licenseplate') || n.includes('plate')) && i.data.length < 10_000
  }

  const sceneHit = images.find((i) => {
    const n = named(i.name)
    return n.includes('detectionpicture') || n.includes('scene') || n.includes('vehiclepicture')
  })
  if (sceneHit) return sceneHit

  const rest = images.filter((i) => !isPlateCrop(i))
  if (rest.length > 0) {
    return rest.reduce((a, b) => (b.data.length > a.data.length ? b : a))
  }
  return images.reduce((a, b) => (b.data.length > a.data.length ? b : a))
}

export function parseBoundary(contentType: string): string | null {
  const m = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)
  return (m && (m[1] ?? m[2]))?.trim() ?? null
}
