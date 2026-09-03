/**
 * Document parsers — PDF i DOCX → plain text dla RAG.
 *
 * Wgrywane przez `POST /knowledge/file` (multipart). Parsowanie po stronie
 * Cloud (nie Edge) — Edge dostaje gotowy plain text przez tunnel KNOWLEDGE_UPSERT.
 *
 * pdf-parse: stable, no native deps, działa na Alpine + Fly machines.
 * mammoth: oficjalna lib dla DOCX → markdown/text/HTML.
 *
 * Limitations:
 *  - PDF skany (image-based) zwracają pusty text — wymaga OCR (tesseract.js, osobna feature).
 *  - DOCX z tabelami: mammoth.extractRawText ignoruje formatting, zachowuje tekst kolumn osobno.
 *  - PDF z formularzami: tylko statyczny tekst, wartości pól pomijane.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{
  text: string
  numpages: number
  info?: { Title?: string }
}>
import * as mammoth from 'mammoth'

export interface ParsedDocument {
  text: string
  /** Detected page count (PDF) lub paragraph count (DOCX) dla metadata. */
  pageCount?: number
  /** Title z metadata (jeśli PDF ma `/Title` w info, DOCX core properties). */
  detectedTitle?: string
}

/**
 * Parse PDF buffer → plain text. Pages łączymy przez podwójny newline,
 * akapity zachowane wstępnie (pdf-parse robi heurystykę spacing-u).
 */
export async function parsePdf(buffer: Buffer): Promise<ParsedDocument> {
  const data = await pdfParse(buffer)
  return {
    text: cleanWhitespace(data.text),
    pageCount: data.numpages,
    detectedTitle: data.info?.Title || undefined,
  }
}

/**
 * Parse DOCX buffer → plain text. mammoth `extractRawText` zachowuje
 * akapity (\n\n) bez markdown/HTML noise.
 */
export async function parseDocx(buffer: Buffer): Promise<ParsedDocument> {
  const result = await mammoth.extractRawText({ buffer })
  return {
    text: cleanWhitespace(result.value),
    pageCount: undefined, // DOCX brak per-page info bez renderowania
  }
}

/**
 * Auto-detect based on filename extension lub MIME, parse odpowiednim parserem.
 */
export async function parseDocument(
  buffer: Buffer,
  filename: string,
  mimeType?: string,
): Promise<ParsedDocument & { fileExt: string }> {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  if (ext === 'pdf' || mimeType === 'application/pdf') {
    const parsed = await parsePdf(buffer)
    return { ...parsed, fileExt: 'pdf' }
  }
  if (
    ext === 'docx' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    const parsed = await parseDocx(buffer)
    return { ...parsed, fileExt: 'docx' }
  }
  if (ext === 'txt' || ext === 'md' || mimeType?.startsWith('text/')) {
    return {
      text: cleanWhitespace(buffer.toString('utf-8')),
      fileExt: ext,
    }
  }
  throw new Error(`Nieobsługiwany format: ${ext} (${mimeType ?? 'brak MIME'}). Akceptowane: PDF, DOCX, TXT, MD.`)
}

/**
 * Normalize whitespace — usuwa nadmiar spacji/newline z PDF extracts.
 * Behavior:
 *  - >3 newlines → 2 (paragraph break OK)
 *  - >2 spaces → 1
 *  - trim leading/trailing
 */
function cleanWhitespace(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}
