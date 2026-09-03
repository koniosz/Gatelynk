import { spawn } from 'child_process'
import { existsSync } from 'fs'
import * as path from 'path'
import { Logger } from '@nestjs/common'

/**
 * Most do natywnego czytnika tekstu (`native/gatelynk-ocr`, Swift + Vision).
 *
 * Dlaczego osobny proces zamiast biblioteki w Node: OCR na macOS to systemowy
 * framework Vision działający na akceleratorze Apple (ANE). Nie ma dla niego
 * sensownego wiązania w Node, a alternatywa (Python + pyobjc + PyTorch) to
 * kilka GB zależności na maszynie, która ma 8 GB i obsługuje już Edge oraz
 * Janusa. Edge i tak uruchamia procesy pomocnicze (ffmpeg) — to ten sam wzorzec.
 *
 * Binarium buduje się na maszynie docelowej:
 *   swiftc -O -o native/gatelynk-ocr native/gatelynk-ocr.swift
 * Gdy go nie ma, `isAvailable()` zwraca false i warstwa wyżej po prostu
 * pomija odczyt lokalny — brak OCR nie może wysadzić Edge.
 */
const log = new Logger('NativeOcr')

const BINARY = path.join(process.cwd(), 'native', 'gatelynk-ocr')

interface OcrLine {
  text: string
  confidence: number
}

interface OcrFileResult {
  file: string
  lines: OcrLine[]
  error?: string | null
}

export interface NativeOcrResult {
  /** Pary (tekst, pewność) per plik wejściowy — kolejność jak w argumentach. */
  perFile: Array<Array<[string, number]>>
  ms: number
  engine: string
}

export function isAvailable(): boolean {
  return existsSync(BINARY)
}

/**
 * Uruchamia OCR na plikach JPEG. Zwraca pary (tekst, pewność) per plik.
 *
 * Timeout jest twardy: czytnik ma zwrócić wynik w czasie przejazdu auta,
 * a nie kiedykolwiek. Przekroczenie traktujemy jak brak odczytu.
 */
export function readText(
  files: string[],
  timeoutMs = 15_000,
  opts: { tiles?: boolean } = {},
): Promise<NativeOcrResult> {
  return new Promise((resolve) => {
    const empty: NativeOcrResult = { perFile: files.map(() => []), ms: 0, engine: 'unavailable' }
    if (!isAvailable() || files.length === 0) return resolve(empty)

    // `--tiles` = dodatkowy przebieg po kafelkach obrazu. Potrzebny do napisów
    // MAŁYCH WZGLĘDEM KADRU (logo kuriera na burcie) — patrz komentarz w
    // `native/gatelynk-ocr.swift`. Kosztuje ~0,4 s, więc włączamy go świadomie
    // tylko tam, gdzie szukamy marki, a nie przy każdej klatce z serii.
    const argv = opts.tiles ? ['--tiles', ...files] : files
    const proc = spawn(BINARY, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (result: NativeOcrResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      log.warn(`OCR timeout po ${timeoutMs} ms (${files.length} klatek)`)
      finish(empty)
    }, timeoutMs)

    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => { stderr += d.toString() })

    proc.on('error', (err) => {
      log.warn(`Nie udało się uruchomić czytnika OCR: ${err.message}`)
      finish(empty)
    })

    proc.on('close', () => {
      try {
        const parsed = JSON.parse(stdout) as { results: OcrFileResult[]; ms: number; engine: string }
        const byFile = new Map<string, Array<[string, number]>>()
        for (const r of parsed.results ?? []) {
          byFile.set(r.file, (r.lines ?? []).map((l) => [l.text, l.confidence] as [string, number]))
        }
        finish({
          perFile: files.map((f) => byFile.get(f) ?? []),
          ms: parsed.ms ?? 0,
          engine: parsed.engine ?? 'apple-vision',
        })
      } catch {
        if (stderr.trim()) log.warn(`Czytnik OCR: ${stderr.trim().slice(0, 200)}`)
        finish(empty)
      }
    })
  })
}
