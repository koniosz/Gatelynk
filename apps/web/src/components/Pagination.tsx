'use client'

/**
 * Reusable pagination footer dla list (LPR reads, access events, etc.).
 *
 * Trzymamy ją głupią — przyjmuje stan z parenta (controlled), bo i tak
 * page+pageSize jest sprzężone z fetchem przez `useEffect`. Komponent
 * tylko rysuje przyciski i licznik.
 *
 * UX:
 *   • Page-size selector (25 / 50 / 100 / 200) — większość ekranów
 *     mieści wygodnie 50, ale niektórzy konsjerże wolą zobaczyć więcej.
 *   • Strzałki « ‹ › »  + numerek strony X z Y.
 *   • Tekst „pokazane A–B z N" — żeby było jasne ile w ogóle wpisów
 *     siedzi w bazie po aktualnych filtrach (krytyczne dla wyszukiwania:
 *     user wpisuje plate i widzi ile przejazdów było tego auta w 30 dni).
 */
export interface PaginationProps {
  /** Numer aktualnej strony, 1-based (UX-friendly). */
  page: number
  /** Ile wierszy na stronę. */
  pageSize: number
  /** Łączna liczba wierszy po filtrach (z `total` z API). */
  total: number
  /** Wywoływane przy zmianie strony. */
  onPageChange: (page: number) => void
  /** Wywoływane przy zmianie rozmiaru strony. Reset do strony 1 jest po stronie wywołującego. */
  onPageSizeChange: (size: number) => void
  /** Domyślnie [25, 50, 100, 200]. */
  pageSizeOptions?: number[]
  /** Czy ukryć selektor rozmiaru strony (np. przy compact view). */
  hidePageSize?: boolean
  /** Dodatkowy className dla wrappera. */
  className?: string
}

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [25, 50, 100, 200],
  hidePageSize,
  className,
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(Math.max(1, page), totalPages)
  const from = total === 0 ? 0 : (safePage - 1) * pageSize + 1
  const to = Math.min(safePage * pageSize, total)

  const go = (p: number) => {
    const next = Math.min(Math.max(1, p), totalPages)
    if (next !== safePage) onPageChange(next)
  }

  return (
    <div
      className={`flex items-center justify-between gap-3 px-3 py-2 text-sm bg-gray-50 border-t border-gray-100 flex-wrap ${className ?? ''}`}
    >
      <div className="text-gray-500 whitespace-nowrap">
        {total === 0
          ? 'Brak wyników'
          : <>Pokazane <span className="font-medium text-gray-700">{from}–{to}</span> z <span className="font-medium text-gray-700">{total}</span></>}
      </div>

      <div className="flex items-center gap-3">
        {!hidePageSize && (
          <label className="flex items-center gap-2 text-gray-500">
            Wierszy:
            <select
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              className="border border-gray-200 rounded px-2 py-1 text-sm bg-white"
            >
              {pageSizeOptions.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
        )}

        <div className="flex items-center gap-1">
          <PageBtn disabled={safePage === 1} onClick={() => go(1)} title="Pierwsza strona">«</PageBtn>
          <PageBtn disabled={safePage === 1} onClick={() => go(safePage - 1)} title="Poprzednia strona">‹</PageBtn>
          <span className="px-2 text-gray-600 whitespace-nowrap">
            Strona <span className="font-medium text-gray-800">{safePage}</span> z {totalPages}
          </span>
          <PageBtn disabled={safePage === totalPages} onClick={() => go(safePage + 1)} title="Następna strona">›</PageBtn>
          <PageBtn disabled={safePage === totalPages} onClick={() => go(totalPages)} title="Ostatnia strona">»</PageBtn>
        </div>
      </div>
    </div>
  )
}

function PageBtn({
  children,
  disabled,
  onClick,
  title,
}: {
  children: React.ReactNode
  disabled?: boolean
  onClick: () => void
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`min-w-[28px] h-7 px-1.5 rounded border text-sm leading-none transition ${
        disabled
          ? 'border-gray-100 text-gray-300 cursor-not-allowed'
          : 'border-gray-200 text-gray-600 hover:bg-white hover:border-gray-300'
      }`}
    >
      {children}
    </button>
  )
}

/**
 * Mały hook do trzymania `(page, pageSize)` + reset do strony 1 przy zmianie
 * filtrów. Używany w wielu listach — wyciągnięty żeby nie copy-pastować.
 */
import { useCallback, useEffect, useState } from 'react'

export function usePagination(defaultPageSize = 50): {
  page: number
  pageSize: number
  offset: number
  setPage: (p: number) => void
  setPageSize: (n: number) => void
  resetToFirstPage: () => void
} {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSizeRaw] = useState(defaultPageSize)
  // useCallback z pustymi deps żeby identity było stabilne między renderami.
  // Bez tego konsumenci wstawiający `resetToFirstPage` / `setPageSize` w
  // useEffect deps wpadali w pętlę „klik page 2 → re-render → nowa lambda
  // → effect re-run → reset do page 1" (bug zaraportowany 2026-05-10).
  // `setPage` z `useState` jest już stabilne — React gwarantuje.
  const setPageSize = useCallback((n: number) => {
    setPageSizeRaw(n)
    setPage(1)
  }, [])
  const resetToFirstPage = useCallback(() => setPage(1), [])
  return {
    page, pageSize,
    offset: (page - 1) * pageSize,
    setPage,
    setPageSize,
    resetToFirstPage,
  }
}

/**
 * Debounce hook — używany przy live-search żeby nie biło API na każde
 * pojedyncze naciśnięcie klawisza. 300 ms to złoty środek między
 * responsywnością a oszczędzaniem zapytań.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])
  return debounced
}
