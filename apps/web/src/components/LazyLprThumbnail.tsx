'use client'

/**
 * LazyLprThumbnail — miniaturka odczytu LPR z trzema zabezpieczeniami przed
 * zatkaniem łącza Cloud→Edge (fix 2026-06-12, diagnoza: 50 wierszy ×
 * ~780 KB pełnowymiarowego JPEG-a fetchowane równolegle przy mount → ogon
 * requestów przekraczał timeout proxy `proxySnapshot` → 504 → "błąd"):
 *
 *   1. **Lazy-load** — blob jest pobierany DOPIERO gdy wiersz wjeżdża
 *      w viewport (IntersectionObserver, rootMargin 200px — prefetch
 *      lekko przed scrollem). Strona z 50 wierszami startuje od ~10
 *      widocznych fetchy zamiast 50.
 *   2. **Kolejka współbieżności** — semafor w module-scope ogranicza
 *      RÓWNOCZESNE fetche obrazków do 4 (współdzielony przez wszystkie
 *      instancje komponentu na stronie). Reszta czeka w FIFO.
 *   3. **Retry 1×** — pojedynczy fail (np. przejściowy 504) jest ponawiany
 *      raz po 2 s, dopiero drugi fail pokazuje "błąd".
 *
 * Fetch idzie przez axios-instancję (Authorization header), więc komponent
 * przyjmuje `apiClient` + gotowy `url` — działa i dla BA, i dla konsjerża.
 */
import { useEffect, useRef, useState } from 'react'
import type { AxiosInstance } from 'axios'

// ── Semafor współbieżności (module-scope — wspólny dla całej strony) ─────────
const MAX_CONCURRENT_FETCHES = 4
let activeFetches = 0
const waitQueue: (() => void)[] = []

function acquireSlot(): Promise<void> {
  if (activeFetches < MAX_CONCURRENT_FETCHES) {
    activeFetches += 1
    return Promise.resolve()
  }
  return new Promise((resolve) => waitQueue.push(resolve))
}

function releaseSlot(): void {
  const next = waitQueue.shift()
  if (next) {
    // Slot przechodzi bezpośrednio na następnego oczekującego —
    // `activeFetches` się nie zmienia.
    next()
  } else {
    activeFetches = Math.max(0, activeFetches - 1)
  }
}

export interface LazyLprThumbnailProps {
  /** Axios z bearer-em (buildingAdminApi / conciergeApi). */
  apiClient: AxiosInstance
  /** Relatywny URL endpointu obrazka (np. `/building-admin/.../image`). */
  url: string
  onClick?: () => void
  /** Klasy wspólne dla <img> i placeholderów (rozmiar, zaokrąglenie). */
  className?: string
  /** Styl inline — alternatywa dla `className` w ba-v2 (tokeny CSS). */
  style?: React.CSSProperties
  alt?: string
}

export function LazyLprThumbnail({
  apiClient,
  url,
  onClick,
  className,
  style,
  alt = '',
}: LazyLprThumbnailProps) {
  const holderRef = useRef<HTMLDivElement | null>(null)
  const [visible, setVisible] = useState(false)
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  // 1. Lazy: obserwujemy placeholder — pierwszy kontakt z viewportem
  //    (z 200px zapasu) ustawia `visible` i kończy obserwację.
  useEffect(() => {
    if (visible) return
    const el = holderRef.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      // Stare przeglądarki / środowisko testowe — fallback do eager.
      setVisible(true)
      return
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true)
          obs.disconnect()
        }
      },
      { rootMargin: '200px' },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [visible])

  // 2+3. Fetch przez semafor, z jednym retry po 2 s.
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let objectUrl: string | null = null

    const run = async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (cancelled) return
        await acquireSlot()
        try {
          if (cancelled) return
          const res = await apiClient.get(url, { responseType: 'blob' })
          if (cancelled) return
          objectUrl = URL.createObjectURL(res.data as Blob)
          setSrc(objectUrl)
          return
        } catch {
          // fallthrough → retry / fail
        } finally {
          // Zwalniamy slot PRZED 2-sekundowym czekaniem na retry —
          // inaczej jeden failujący obrazek blokowałby kolejkę innym.
          releaseSlot()
        }
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 2000))
        }
      }
      if (!cancelled) setFailed(true)
    }
    void run()

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [visible, apiClient, url])

  if (failed) {
    return (
      <div
        ref={holderRef}
        className={className}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 10,
          color: 'var(--muted-2, #9ca3af)',
          background: 'var(--bg-2, #f3f4f6)',
          ...style,
        }}
      >
        błąd
      </div>
    )
  }
  if (!src) {
    return (
      <div
        ref={holderRef}
        className={`${className ?? ''} animate-pulse`}
        style={{ background: 'var(--bg-2, #f3f4f6)', ...style }}
      />
    )
  }
  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src={src}
      alt={alt}
      onClick={onClick}
      className={className}
      style={{ objectFit: 'cover', cursor: onClick ? 'pointer' : undefined, ...style }}
    />
  )
}
