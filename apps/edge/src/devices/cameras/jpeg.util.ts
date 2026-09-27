/**
 * Kompletność pliku JPEG (2026-09-27).
 *
 * Akuvox R29C (VN .23/.89) ma w firmware sztywny bufor snapshotu (~700 KB):
 * nocny, zaszumiony kadr 1920×1080 nie mieści się i urządzenie odsyła plik
 * ucięty w połowie danych — z poprawnym nagłówkiem, ale BEZ znacznika końca
 * (FFD9). Dekoder rysuje tyle wierszy, ile dostał, a resztę wypełnia szarością
 * (szary pas u dołu kafla i podglądu). Dotyczy tak samo `picture.jpg`, jak
 * każdej klatki natywnego MJPEG z `:8080/video.cgi`.
 *
 * Czysta funkcja — testowana standalone (`jpeg.util.spec.ts`, node:test).
 */
export function isCompleteJpeg(buf: Uint8Array | null | undefined, tailWindow = 64): boolean {
  if (!buf || buf.length < 4) return false
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return false
  // EOI musi być w ogonie pliku — część urządzeń dopisuje kilka bajtów
  // paddingu po FFD9. FFD9 gdzieś w środku (np. EOI miniatury EXIF) nie liczy się.
  const start = Math.max(2, buf.length - tailWindow)
  for (let i = buf.length - 2; i >= start; i--) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd9) return true
  }
  return false
}
