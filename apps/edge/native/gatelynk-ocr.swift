// gatelynk-ocr — natywny czytnik tekstu z obrazu dla Edge.
//
// Po co osobny plik w Swifcie zamiast Pythona:
//   • OCR w GateLynku i tak korzysta z systemowego frameworku Vision (ANE),
//     więc Python był tylko opakowaniem — a ciągnął ze sobą pip, venv,
//     pyobjc i wersję Pythona nowszą niż systemowa. Na Macu Mini z 8 GB,
//     który obsługuje Edge i Janusa, to nieproporcjonalny koszt.
//   • Edge (Node) i tak uruchamia procesy pomocnicze (ffmpeg) — spawn
//     małego binarium to ten sam, sprawdzony wzorzec.
//   • Efekt: rozpoznawanie tablic działa LOKALNIE na Edge, więc brama nie
//     zależy od tego, czy Mac Studio i tunel Tailscale żyją. To zgodne
//     z zasadą offline-first całej platformy.
//
// Kontrakt (stabilny — Edge na nim polega):
//   wejście : ścieżki plików JPEG/PNG jako argumenty; `-` = jeden obraz z stdin
//   wyjście : JSON {"results":[{"file":…,"lines":[{"text":…,"confidence":…}]}]}
//   kod 0   — sukces (także gdy nic nie rozpoznano: pusta lista `lines`)
//   kod 1   — błąd użycia lub odczytu wszystkich obrazów
//
// Świadomy wybór: `.accurate` + korekcja językowa WYŁĄCZONA. Tablica
// rejestracyjna to nie słowo — autokorekta „poprawiłaby" ją na coś
// wyglądającego na wyraz i psuła odczyt.

import Foundation
import Vision
import CoreImage
import AppKit

struct Line: Codable {
    let text: String
    let confidence: Float
}

struct FileResult: Codable {
    let file: String
    let lines: [Line]
    let error: String?
}

struct Output: Codable {
    let results: [FileResult]
    let engine: String
    let ms: Int
}

func makeRequest() -> VNRecognizeTextRequest {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    // Polskie tablice to litery i cyfry; podpowiedź językowa i tak nie pomaga,
    // ale zostawiamy „pl-PL" — Vision używa jej tylko do wyboru modelu.
    request.recognitionLanguages = ["pl-PL", "en-US"]
    return request
}

/** Czy ciąg wygląda na tablicę na tyle, by warto go było doczytać z bliska. */
func looksLikePlate(_ s: String) -> Bool {
    let alnum = s.uppercased().filter { $0.isLetter || $0.isNumber }
    guard alnum.count >= 5 && alnum.count <= 9 else { return false }
    return alnum.contains(where: \.isNumber) && alnum.contains(where: \.isLetter)
}

/**
 * Wycina fragment obrazu i powiększa go do sensownej rozdzielczości.
 *
 * `boundingBox` z Vision jest znormalizowany (0…1) i liczony od LEWEGO
 * DOLNEGO rogu — CGImage liczy od lewego GÓRNEGO, stąd odwrócenie osi Y.
 */
func cropUpscaled(_ image: CGImage, box: CGRect, margin: CGFloat, minWidth: CGFloat) -> CGImage? {
    let w = CGFloat(image.width), h = CGFloat(image.height)
    var rect = CGRect(
        x: box.minX * w,
        y: (1 - box.maxY) * h,        // odwrócenie osi Y
        width: box.width * w,
        height: box.height * h
    )
    rect = rect.insetBy(dx: -rect.width * margin, dy: -rect.height * margin * 2)
    rect = rect.intersection(CGRect(x: 0, y: 0, width: w, height: h))
    guard rect.width > 10, rect.height > 5, let crop = image.cropping(to: rect) else { return nil }

    let scale = max(1.0, minWidth / rect.width)
    if scale <= 1.0 { return crop }

    let newW = Int(rect.width * scale), newH = Int(rect.height * scale)
    guard let ctx = CGContext(
        data: nil, width: newW, height: newH, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    ) else { return crop }
    ctx.interpolationQuality = .high
    ctx.draw(crop, in: CGRect(x: 0, y: 0, width: newW, height: newH))
    return ctx.makeImage() ?? crop
}

/**
 * Odczyt dwuetapowy.
 *
 * Etap 1 — cała klatka: znajduje, GDZIE jest tekst.
 * Etap 2 — sam kandydat na tablicę, wycięty i powiększony: czyta go dokładnie.
 *
 * Po co (zgłoszenie Konrada 2026-08-07): na klatce 1920×1080 tablica ma ~300 px
 * szerokości, więc pojedyncza litera to kilkanaście pikseli. Przy tej skali
 * `W` i `N` są dla OCR niemal nierozróżnialne — stąd `WE8FN26` odczytane jako
 * `NE8FN26` mimo idealnie ostrego zdjęcia. Dedykowana kamera ANPR czyta
 * tablicę powiększoną; drugi etap robi to samo programowo.
 *
 * Koszt jest mały: powiększamy WYŁĄCZNIE mały wycinek wokół tekstu, który już
 * wygląda na tablicę — nie całą klatkę.
 */
func recognize(cgImage: CGImage) throws -> [Line] {
    let first = makeRequest()
    try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([first])
    guard let observations = first.results else { return [] }

    var lines: [Line] = []
    var refinedRegions = 0

    for obs in observations {
        // Bierzemy kilka wariantów: OCR bywa niepewny między O/0 czy I/1,
        // a matcher po stronie Edge i tak odsieje te bez sensu.
        let candidates = obs.topCandidates(3)
        for candidate in candidates {
            lines.append(Line(text: candidate.string, confidence: candidate.confidence))
        }

        // Etap 2 tylko dla fragmentów, które mogą być tablicą — i najwyżej
        // kilku, żeby jedna klatka z dużą ilością napisów nie rozdęła czasu.
        guard refinedRegions < 3,
              let top = candidates.first, looksLikePlate(top.string),
              let zoomed = cropUpscaled(cgImage, box: obs.boundingBox, margin: 0.15, minWidth: 900)
        else { continue }
        refinedRegions += 1

        let second = makeRequest()
        if (try? VNImageRequestHandler(cgImage: zoomed, options: [:]).perform([second])) != nil,
           let refined = second.results {
            for o in refined {
                for c in o.topCandidates(3) {
                    // Odczyt z powiększenia jest wiarygodniejszy, więc dostaje
                    // premię — przy głosowaniu ma przeważyć nad wersją z całej
                    // klatki, jeśli obie trafią do puli kandydatów.
                    lines.append(Line(text: c.string, confidence: min(1.0, c.confidence + 0.10)))
                }
            }
        }
    }
    return lines
}

func loadImage(_ path: String) throws -> CGImage {
    let data: Data
    if path == "-" {
        data = FileHandle.standardInput.readDataToEndOfFile()
    } else {
        data = try Data(contentsOf: URL(fileURLWithPath: path))
    }
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw NSError(domain: "gatelynk-ocr", code: 2,
                      userInfo: [NSLocalizedDescriptionKey: "nie udało się zdekodować obrazu"])
    }
    return image
}


/**
 * Odczyt kafelkowy — dla napisów MAŁYCH WZGLĘDEM KADRU.
 *
 * Pomiar na obiekcie VN (2026-08-09, dostawczak DPD): logo „dpd" na masce było
 * na klatce 1920×1080 doskonale widoczne dla człowieka, a mimo to nie zostało
 * odczytane. Powiększenie CAŁEJ klatki 2× nic nie dało — dopiero wycięcie
 * samego fragmentu maski zwróciło `dPd`, a wycinek powiększony `dpd` + `GEOPOST`.
 *
 * Wniosek: silnik pomija tekst mały w stosunku do wymiarów obrazu, niezależnie
 * od jego rozdzielczości. Tablica przechodzi mimo podobnej wielkości, bo ma
 * ostry czarno-biały kontrast; stylizowane logo na błyszczącej karoserii nie.
 *
 * Dzielimy więc kadr na zachodzące na siebie kafelki i czytamy każdy osobno —
 * w kafelku ten sam napis jest kilkakrotnie większy względem obrazu. Zakładka
 * między kafelkami zapobiega przecięciu napisu na granicy.
 *
 * Uruchamiane WYŁĄCZNIE z flagą `--tiles`, bo kosztuje kilka przebiegów OCR.
 * Wywołujący robi to raz na przejazd, na najlepszej klatce — nie na każdej.
 */
func recognizeTiled(cgImage: CGImage) -> [Line] {
    let cols = 3, rows = 2   // 4×3 sprawdzone: 3× wolniej, ten sam wynik
    let overlap: CGFloat = 0.15          // 12 % zakładki — napis na styku kafelków
    let w = CGFloat(image_width(cgImage)), h = CGFloat(image_height(cgImage))
    var lines: [Line] = []

    for r in 0..<rows {
        for c in 0..<cols {
            let tw = w / CGFloat(cols), th = h / CGFloat(rows)
            var rect = CGRect(x: CGFloat(c) * tw, y: CGFloat(r) * th, width: tw, height: th)
            rect = rect.insetBy(dx: -tw * overlap, dy: -th * overlap)
                       .intersection(CGRect(x: 0, y: 0, width: w, height: h))
            guard let tile = cgImage.cropping(to: rect) else { continue }

            // Powiększenie kafelka pomaga dodatkowo przy drobnym druku.
            let scaled = upscale(tile, minWidth: 1400) ?? tile
            let req = makeRequest()
            guard (try? VNImageRequestHandler(cgImage: scaled, options: [:]).perform([req])) != nil,
                  let obs = req.results else { continue }
            for o in obs {
                for cand in o.topCandidates(2) {
                    lines.append(Line(text: cand.string, confidence: cand.confidence))
                }
            }
        }
    }
    return lines
}

func image_width(_ i: CGImage) -> Int { i.width }
func image_height(_ i: CGImage) -> Int { i.height }

/** Skalowanie obrazu do zadanej szerokości minimalnej (bez pomniejszania). */
func upscale(_ image: CGImage, minWidth: CGFloat) -> CGImage? {
    let w = CGFloat(image.width)
    let scale = max(1.0, minWidth / w)
    if scale <= 1.0 { return image }
    let newW = Int(w * scale), newH = Int(CGFloat(image.height) * scale)
    guard let ctx = CGContext(
        data: nil, width: newW, height: newH, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    ) else { return image }
    ctx.interpolationQuality = .high
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: newW, height: newH))
    return ctx.makeImage()
}

let args_marker = 0

let rawArgs = Array(CommandLine.arguments.dropFirst())
/// `--tiles` — dodatkowy przebieg po kafelkach obrazu. Patrz `recognizeTiled`.
let useTiles = rawArgs.contains("--tiles")
let args = rawArgs.filter { $0 != "--tiles" }
guard !args.isEmpty else {
    FileHandle.standardError.write(
        "użycie: gatelynk-ocr <plik.jpg> [plik2.jpg …]  |  gatelynk-ocr -  (obraz z stdin)\n"
            .data(using: .utf8)!)
    exit(1)
}

let start = Date()
var results: [FileResult] = []
var anySuccess = false

for path in args {
    do {
        let image = try loadImage(path)
        var lines = try recognize(cgImage: image)
        if useTiles { lines.append(contentsOf: recognizeTiled(cgImage: image)) }
        results.append(FileResult(file: path, lines: lines, error: nil))
        anySuccess = true
    } catch {
        results.append(FileResult(file: path, lines: [], error: "\(error.localizedDescription)"))
    }
}

let out = Output(
    results: results,
    engine: "apple-vision",
    ms: Int(Date().timeIntervalSince(start) * 1000)
)

let encoder = JSONEncoder()
encoder.outputFormatting = [.withoutEscapingSlashes]
if let json = try? encoder.encode(out), let text = String(data: json, encoding: .utf8) {
    print(text)
}
exit(anySuccess ? 0 : 1)
