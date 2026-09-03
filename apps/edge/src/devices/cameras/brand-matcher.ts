/**
 * Rozpoznawanie marek z napisów na pojeździe — wersja Edge.
 *
 * WYGENEROWANE z `apps/yolo-vision/brand_matcher.py` (45 marek). Nie edytuj
 * ręcznie: przy zmianie wzorców przegeneruj, żeby obie instalacje widziały te
 * same marki. Rozjazd oznaczałby, że ten sam kurier jest rozpoznany na jednym
 * obiekcie, a na drugim nie.
 *
 * Dlaczego to prawie nic nie kosztuje: napisy na aucie odczytujemy z TEGO
 * SAMEGO przebiegu OCR, który i tak wykonujemy dla tablicy. Dochodzi wyłącznie
 * przejście wzorcami po gotowym tekście — ułamek milisekundy. Napis „DPD" na
 * burcie jest przy tym DUŻO większy niż tablica, więc czyta się go łatwiej.
 */

export interface BrandMatch {
  brand: string
  confidence: number
  matchedText: string
}

/** brand → wzorce (bez rozróżniania wielkości liter). */
export const BRAND_PATTERNS: Record<string, RegExp[]> = {
  DHL: [/\bDHL\b/i, /deutsche\s*post/i, /\bexcellence\b/i],
  DPD: [/\bdpd\b/i, /your\s+delivery\s+experts/i, /geo\s*post/i],
  INPOST: [/\binpost\b/i, /paczkomat/i, /in\s*post/i],
  FEDEX: [/\bfedex\b/i, /fed\s*ex/i],
  GLS: [/\bGLS\b/i, /general\s+logistics/i],
  UPS: [/\bUPS\b/i, /united\s+parcel/i],
  POCZTA: [/poczta\s+polska/i, /\bpocztex\b/i, /\bpoczta\b/i],
  ALLEGRO: [/allegro\s+one/i, /allegro\s+paczka/i, /\ballegro\b/i],
  DACHSER: [/\bdachser\b/i],
  GLOVO: [/\bglovo\b/i],
  WOLT: [/\bwolt\b/i],
  UBER: [/\buber\s*eats\b/i, /\buber\b/i],
  BOLT: [/\bbolt\s*food\b/i, /\bbolt\b/i],
  PYSZNE: [/\bpyszne\b/i, /pyszne\.pl/i],
  NTFY: [/\bntfy(?:[.\s]?pl)?(?:[.\s]?24)?/i, /nice\s+to\s+fit\s+you/i],
  MACZFIT: [/\bmaczfit\b/i, /macz\s*fit/i],
  LIGHTBOX: [/\blight\s*box\b/i, /\blightbox\b/i],
  BODYCHIEF: [/\bbody\s*chief\b/i, /\bbodychief\b/i],
  BEDIET: [/\bbe\s*diet\b/i, /\bbediet\b/i],
  DIETLY: [/\bdietly\b/i],
  FITME: [/\bfit\s*me\b/i, /\bfitme\b/i, /fitme24/i],
  DIETBOX: [/\bdiet\s*box\b/i, /\bdietbox\b/i],
  PALEOPOWER: [/\bpaleo\s*power\b/i, /\bpaleopower\b/i],
  SMARTFOOD: [/\bsmart\s*food\b/i, /\bsmartfood\b/i],
  FITWAY: [/\bfit\s*way\b/i, /\bfitway\b/i],
  MEDIA_EXPERT: [/\bmedia\s*expert\b/i, /\bmediaexpert\b/i],
  MEDIA_MARKT: [/\bmedia\s*markt\b/i, /\bmediamarkt\b/i],
  RTV_EURO_AGD: [/\brtv\s*euro\s*agd\b/i, /\beuro\s*agd\b/i, /\brtveuroagd\b/i],
  X_KOM: [/\bx[-\s]?kom\b/i, /\bxkom\b/i],
  KOMPUTRONIK: [/\bkomputronik\b/i],
  NEONET: [/\bneonet\b/i],
  AVANS: [/\bavans\b/i],
  IKEA: [/\bikea\b/i],
  OBI: [/\bobi\b/i],
  LEROY_MERLIN: [/\bleroy\s*merlin\b/i, /\bleroymerlin\b/i],
  CASTORAMA: [/\bcastorama\b/i],
  JYSK: [/\bjysk\b/i],
  FRISCO: [/\bfrisco\b/i, /frisco\.pl/i],
  BARBORA: [/\bbarbora\b/i],
  BIEDRONKA: [/\bbiedronka\b/i],
  LIDL: [/\blidl\b/i],
  AUCHAN: [/\bauchan\b/i],
  CARREFOUR: [/\bcarrefour\b/i],
  DOZ: [/\bdoz\b/i, /doz\.pl/i],
  GEMINI: [/\bgemini\s*apteka\b/i, /\bgeminiapteka\b/i],
}

/**
 * Znajduje markę w tekście z OCR.
 *
 * Zwraca najlepsze trafienie: wygrywa wzorzec dopasowany z najwyższą pewnością
 * OCR. Napis firmowy bywa rozbity na kilka fragmentów („DPD" + „delivery
 * experts"), więc sprawdzamy każdy token osobno ORAZ ich sklejenie — inaczej
 * wieloczłonowe hasła (np. „media expert") nigdy by nie trafiły.
 */
export function matchBrand(ocrResults: Array<[string, number]>): BrandMatch | null {
  if (!ocrResults.length) return null

  const joined = ocrResults.map(([t]) => t).join(' ')
  let best: BrandMatch | null = null

  for (const [brand, patterns] of Object.entries(BRAND_PATTERNS)) {
    for (const re of patterns) {
      // Najpierw pojedyncze tokeny — znamy wtedy pewność OCR dla trafienia.
      for (const [text, conf] of ocrResults) {
        if (re.test(text)) {
          if (!best || conf > best.confidence) {
            best = { brand, confidence: conf, matchedText: text }
          }
        }
      }
      // Sklejenie łapie hasła rozbite przez OCR na kilka pudełek. Pewność
      // zaniżamy, bo nie wiemy, który fragment faktycznie zadecydował.
      if (!best && re.test(joined)) {
        best = { brand, confidence: 0.5, matchedText: joined.slice(0, 60) }
      }
    }
  }
  return best
}
