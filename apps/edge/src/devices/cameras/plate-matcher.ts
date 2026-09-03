/**
 * Rozpoznawanie polskich tablic w surowym tekście z OCR — wersja Edge.
 *
 * Odpowiednik `apps/yolo-vision/plate_matcher.py`, celowo przeniesiony na
 * Edge: dzięki temu odczyt tablicy działa LOKALNIE i brama nie zależy od
 * tego, czy Mac Studio i tunel Tailscale żyją (zasada offline-first).
 *
 * ⚠️ Przy zmianie reguł trzymaj OBIE wersje zgodne — rozjazd oznaczałby, że
 * ta sama klatka daje inny wynik zależnie od tego, kto ją policzył.
 *
 * Format polskiej tablicy: 1-3 znaki kodu regionu (litery) + 4-5 znaków
 * (litery/cyfry). Po normalizacji 5-8 znaków alfanumerycznych.
 */

/** Napisy, które OCR regularnie myli z tablicą — marki, elementy otoczenia. */
const BLACKLIST = new Set([
  'SCANIA', 'VOLVO', 'RENAULT', 'IVECO', 'MERCEDES', 'TOYOTA', 'NISSAN',
  'CAMERA', 'CAMERAS', 'HIKVISION', 'DAHUA', 'AKUVOX',
  'STOP', 'WYJAZD', 'WJAZD', 'UWAGA', 'PRYWATNY', 'TEREN',
])

/**
 * Znaki, które OCR notorycznie myli. Używane do KARY za pewność, nie do
 * poprawiania — poprawianie na siłę tworzyłoby tablice, których nie ma.
 */
const CONFUSABLE = new Set(['O', '0', 'I', '1', 'S', '5', 'Z', '2', 'B', '8'])

/**
 * Litery, od których MOŻE zaczynać się polska tablica.
 *
 * Kody województw: B C D E F G K L N O P R S T W Z.
 * Dodatkowo H (służby mundurowe: HP policja, HW straż graniczna…) i U (wojsko).
 *
 * Zbiór jest zamknięty i to czyni go użytecznym: `I`, `A`, `J`, `M`, `V`, `X`,
 * `Y` NIE występują na początku polskiej tablicy. Wykrycie takiego znaku to
 * niemal zawsze śmieć doklejony przez OCR — najczęściej krawędź niebieskiego
 * paska UE z lewej strony tablicy.
 */
const VALID_FIRST = new Set('BCDEFGKLNOPRSTWZHU'.split(''))

/**
 * Znaki, jakie OCR robi z pionowej krawędzi niebieskiego paska UE.
 * Wszystkie mają kształt kreski i żaden nie jest legalnym początkiem polskiej
 * tablicy — dzięki temu obcięcie ich jest bezpieczne.
 */
const BAND_ARTIFACT = new Set(['I', '1', 'J', '7', 'Y'])

/** Normalizacja: wielkie litery, tylko alfanumeryczne, typowe śmieci OCR usunięte. */
export function normalizePlate(token: string): string {
  return (token || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .trim()
}

/**
 * Usuwa śmieci doklejone z lewej krawędzi tablicy.
 *
 * Zgłoszenie Konrada (2026-08-07): tablica `NO 330AF` odczytana jako
 * `INO330AF` — OCR wciągnął fragment niebieskiego paska UE jako literę „I".
 * To systematyczny błąd tego typu tablic, nie przypadek, więc leczymy go
 * regułą, a nie podnoszeniem progu.
 *
 * Obcinamy TYLKO wtedy, gdy skrócona wersja jest LEPSZA niż oryginał: ma
 * poprawny pierwszy znak i nadal wygląda jak tablica. Dzięki temu reguła nie
 * może zepsuć poprawnego odczytu — w najgorszym razie nic nie zmieni.
 */
export function stripLeadingNoise(normalized: string): string {
  if (!normalized) return normalized

  // Naprawiamy WYŁĄCZNIE odczyt, który sam w sobie nie jest poprawną tablicą.
  // Bez tego warunku reguła kaleczyłaby prawdziwe rejestracje — np. `PL12345`
  // z Leszna („PL" to legalny kod powiatu) zostałoby obcięte do `12345`.
  if (isPlateShape(normalized) && VALID_FIRST.has(normalized[0])) return normalized

  // 1) „PL" z paska UE sklejone z tablicą (odczyt jest wtedy za długi).
  if (normalized.startsWith('PL')) {
    const c = normalized.slice(2)
    if (c.length >= 5 && VALID_FIRST.has(c[0]) && isPlateShape(c)) return c
  }

  // 2) Pionowa krawędź paska UE odczytana jako pojedynczy znak. Zbiór jest
  //    wąski celowo — to znaki o kształcie kreski, których polska tablica i
  //    tak nie może mieć na początku. Gdyby dopuścić dowolny znak, reguła
  //    „naprawiałaby" śmieci na prawdopodobnie wyglądające tablice
  //    (VN 2026-08-07: `AR41517` → `R41517`), czyli produkowała fałszywe
  //    rejestracje zamiast je odsiewać.
  if (BAND_ARTIFACT.has(normalized[0])) {
    const c = normalized.slice(1)
    if (c.length >= 5 && VALID_FIRST.has(c[0]) && isPlateShape(c)) return c
  }

  return normalized
}

/**
 * Czy ciąg ma kształt polskiej tablicy.
 *
 * Świadomie NIE sprawdzamy listy kodów powiatów — nowe kody dochodzą, a
 * tablice zabytkowe i służbowe mają własne reguły. Lepiej przepuścić odczyt
 * z niższą pewnością niż odrzucić prawdziwą tablicę.
 */
export function isPlateShape(normalized: string): boolean {
  if (normalized.length < 5 || normalized.length > 8) return false
  if (!/^[A-Z]/.test(normalized)) return false          // zaczyna się od litery (region)
  if (!/[0-9]/.test(normalized)) return false           // musi mieć cyfrę
  if (/^[A-Z]+$/.test(normalized)) return false         // same litery = słowo, nie tablica
  if (/^[0-9]+$/.test(normalized)) return false         // same cyfry = np. godzina z nakładki
  return true
}

/**
 * Lekka kara za znaki mylone przez OCR.
 *
 * ⚠️ Kara była pierwotnie 0.35 i okazała się szkodliwa (pomiar na VN,
 * 2026-08-07): polskie tablice SKŁADAJĄ SIĘ w większości z cyfr, więc kara
 * uderzała w każdy prawidłowy odczyt równomiernie. Zweryfikowana ze zdjęciem
 * tablica `WU2355N` dostała 0.55 (trzy „podejrzane" znaki: 2,5,5), a
 * prawdopodobnie błędny `AR41517` — 0.57. Miara przestała odróżniać dobre
 * odczyty od złych, czyli robiła dokładnie odwrotnie, niż miała.
 *
 * Prawdziwym sygnałem jakości jest ZGODNOŚĆ MIĘDZY KLATKAMI (patrz
 * `voteAcrossFrames`) — losowy błąd OCR rzadko powtarza się identycznie.
 * Kara za znaki zostaje symbolicznie, jako tie-break przy równej zgodności.
 */
function confidencePenalty(normalized: string, rawConf: number): number {
  let confusable = 0
  for (const ch of normalized) if (CONFUSABLE.has(ch)) confusable++
  const ratio = confusable / Math.max(1, normalized.length)
  return Math.max(0, rawConf * (1 - 0.08 * ratio))
}

export interface PlateCandidate {
  plate: string
  confidence: number
}

/**
 * Wyciąga kandydatów na tablicę z par (tekst, pewność) zwróconych przez OCR.
 * Wynik posortowany malejąco po pewności.
 */
export function matchPlates(ocrResults: Array<[string, number]>): PlateCandidate[] {
  const seen = new Set<string>()
  const out: PlateCandidate[] = []

  for (const [text, conf] of ocrResults) {
    if (!text) continue
    const normalized = stripLeadingNoise(normalizePlate(text))
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    if (BLACKLIST.has(normalized)) continue
    if (!isPlateShape(normalized)) continue

    let confidence = confidencePenalty(normalized, conf)

    // Pierwszy znak spoza polskiego zbioru — po próbie naprawy nadal nietypowy.
    // NIE odrzucamy: po osiedlu jeżdżą auta zagraniczne (ukraińskie, niemieckie),
    // a ich tablice są prawdziwe. Ale obniżamy pewność, bo to również typowy
    // kształt śmiecia z OCR (VN 2026-08-07: „AR41517" z kadru bez tablicy).
    // O losie takiego odczytu zdecyduje próg i zgodność między klatkami.
    if (!VALID_FIRST.has(normalized[0])) confidence *= 0.7

    out.push({ plate: normalized, confidence })
  }

  out.sort((a, b) => b.confidence - a.confidence || a.plate.localeCompare(b.plate))
  return out
}

/**
 * Scala odczyty z wielu klatek jednego przejazdu.
 *
 * Zgodność między klatkami to najmocniejszy dostępny sygnał poprawności:
 * losowy błąd OCR rzadko powtarza się identycznie na kolejnym ujęciu.
 * Dlatego każda kolejna klatka potwierdzająca tablicę podnosi pewność.
 */
export function voteAcrossFrames(
  perFrame: PlateCandidate[][],
  agreementBonus = 0.15,
): { best: PlateCandidate | null; agreedFrames: number; candidates: Array<PlateCandidate & { frames: number }> } {
  const bestConf = new Map<string, number>()
  const frames = new Map<string, number>()

  for (const list of perFrame) {
    for (const { plate, confidence } of list) {
      bestConf.set(plate, Math.max(bestConf.get(plate) ?? 0, confidence))
      frames.set(plate, (frames.get(plate) ?? 0) + 1)
    }
  }

  const scored = [...bestConf.entries()]
    .map(([plate, conf]) => ({
      plate,
      confidence: Math.min(1, conf + agreementBonus * ((frames.get(plate) ?? 1) - 1)),
      frames: frames.get(plate) ?? 1,
    }))
    .sort((a, b) => b.confidence - a.confidence || b.frames - a.frames)

  const top = scored[0]
  return {
    best: top ? { plate: top.plate, confidence: top.confidence } : null,
    agreedFrames: top?.frames ?? 0,
    candidates: scored.slice(0, 5),
  }
}
