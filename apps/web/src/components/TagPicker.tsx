'use client'

/**
 * TagPicker — chip multi-select dla pola `tags` na pojeździe.
 *
 * Trzy źródła sugestii w jednym UI:
 *   1. Curated dictionary (`lib/vehicle-tags.ts`) — popularne grupy (kabrio,
 *      Glovo, opiekunka…). Klik chipsem dodaje/usuwa.
 *   2. Tagi już używane w danym budynku (autocomplete z backendu) — np.
 *      „opiekunka Aniela", którą wpisał inny admin tydzień temu.
 *   3. Free-form input — użytkownik wpisuje cokolwiek i Enter / przecinek
 *      dodaje jako nowy chip.
 *
 * Komponent jest "controlled": rodzic trzyma `value: string[]` i odbiera
 * `onChange`. Endpoint do autocomplete'a podajemy URL-em + axios-instancją
 * (admin/konsjerż używają różnych klientów, jak w `LprViewer`).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AxiosInstance } from 'axios'
import {
  TAG_MAX_COUNT, TAG_MAX_LENGTH, VEHICLE_TAG_GROUPS,
  mergeTagSuggestions, normalizeTagInput,
} from '@/lib/vehicle-tags'

export interface TagPickerProps {
  value: string[]
  onChange: (next: string[]) => void
  apiClient: AxiosInstance
  /** GET zwracający DISTINCT używane tagi w budynku. Może być pusty (skip). */
  buildSuggestionsUrl?: () => string
  /** Dodatkowy `aria-label` na pole — przy wielu pickerach na ekranie. */
  ariaLabel?: string
}

export function TagPicker({
  value, onChange, apiClient, buildSuggestionsUrl, ariaLabel,
}: TagPickerProps) {
  const [used, setUsed] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [showAll, setShowAll] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Zaciągamy używane w budynku tagi raz — ten endpoint jest tani (DISTINCT
  // unnest z GIN-em po stronie Postgresa).
  useEffect(() => {
    if (!buildSuggestionsUrl) return
    apiClient.get(buildSuggestionsUrl())
      .then((r) => setUsed(Array.isArray(r.data) ? (r.data as string[]) : []))
      .catch(() => { /* best-effort — picker działa też bez podpowiedzi */ })
  }, [apiClient, buildSuggestionsUrl])

  const { groups, custom } = useMemo(() => mergeTagSuggestions(used), [used])
  const selected = useMemo(() => new Set(value), [value])

  /** Toggle chipsa — jeśli był, usuń; jeśli nie — dodaj (z limitem ilości). */
  const toggle = (tag: string) => {
    const t = normalizeTagInput(tag)
    if (!t) return
    if (selected.has(t)) {
      onChange(value.filter(x => x !== t))
    } else {
      if (value.length >= TAG_MAX_COUNT) return
      onChange([...value, t])
    }
  }

  /** Dodaje to, co jest w polu tekstowym. Wywołane przez Enter/przecinek/blur. */
  const commitDraft = () => {
    const t = normalizeTagInput(draft)
    if (!t) { setDraft(''); return }
    if (!selected.has(t) && value.length < TAG_MAX_COUNT) {
      onChange([...value, t])
    }
    setDraft('')
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      commitDraft()
    } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      // Backspace na pustym polu zdejmuje ostatni dodany chip — wzorzec
      // znany z Gmaila / Slacka.
      onChange(value.slice(0, -1))
    }
  }

  // Domyślnie pokazujemy tylko 2 pierwsze grupy (Nadwozie + Kolor) —
  // reszta po kliknięciu „pokaż więcej". Inaczej picker zajmowałby
  // pół ekranu, a w typowym przypadku admin tagi po prostu wpisze.
  const visibleGroups = showAll ? groups : groups.slice(0, 2)

  return (
    <div className="space-y-2">
      {/* Wybrane chipsy + input. */}
      <div
        className="min-h-[40px] w-full border border-gray-200 rounded-lg px-2 py-1.5 flex flex-wrap items-center gap-1.5 bg-white focus-within:ring-2 focus-within:ring-blue-400"
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-800 border border-blue-200 rounded-full pl-2 pr-1 py-0.5"
          >
            {t}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); toggle(t) }}
              className="w-4 h-4 rounded-full hover:bg-blue-100 text-blue-700 leading-none flex items-center justify-center"
              aria-label={`Usuń tag ${t}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={commitDraft}
          maxLength={TAG_MAX_LENGTH}
          placeholder={value.length === 0 ? 'np. kabrio, Glovo, żółty…' : ''}
          aria-label={ariaLabel ?? 'Tagi pojazdu'}
          className="flex-1 min-w-[120px] text-sm bg-transparent outline-none px-1 py-0.5"
        />
      </div>

      {/* Sugestie z curated dictionary, pogrupowane. */}
      <div className="space-y-2">
        {visibleGroups.map((g) => (
          <div key={g.label}>
            <div className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">
              {g.label}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {g.tags.map((t) => {
                const isOn = selected.has(t)
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => toggle(t)}
                    className={`text-xs px-2.5 py-1 rounded-full border transition ${
                      isOn
                        ? 'bg-blue-600 border-blue-600 text-white'
                        : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    {t}
                  </button>
                )
              })}
            </div>
          </div>
        ))}

        {/* Custom tagi (te, które admin wpisał sam — pokazujemy tylko gdy są). */}
        {showAll && custom.length > 0 && (
          <div>
            <div className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">
              Już użyte w budynku
            </div>
            <div className="flex flex-wrap gap-1.5">
              {custom.map((t) => {
                const isOn = selected.has(t)
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => toggle(t)}
                    className={`text-xs px-2.5 py-1 rounded-full border transition ${
                      isOn
                        ? 'bg-blue-600 border-blue-600 text-white'
                        : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    {t}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {!showAll && (groups.length > 2 || custom.length > 0) && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="text-xs text-blue-600 hover:underline"
          >
            Pokaż wszystkie kategorie {custom.length > 0 ? `+ ${custom.length} własnych` : ''}
          </button>
        )}
      </div>

      {value.length >= TAG_MAX_COUNT && (
        <div className="text-[11px] text-amber-600">
          Limit {TAG_MAX_COUNT} tagów osiągnięty.
        </div>
      )}
    </div>
  )
}

/**
 * Tylko-do-wyświetlania lista chipsów — używamy w wierszu listy odczytów
 * i w `SidePanel` (gdy admin nie edytuje, a tylko podgląda).
 */
export function TagChips({
  tags, max, className,
}: { tags: string[]; max?: number; className?: string }) {
  if (!tags || tags.length === 0) return null
  const limit = max ?? tags.length
  const shown = tags.slice(0, limit)
  const overflow = tags.length - shown.length
  return (
    <span className={`inline-flex flex-wrap gap-1 ${className ?? ''}`}>
      {shown.map((t) => (
        <span
          key={t}
          className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-700 border border-gray-200"
        >
          {t}
        </span>
      ))}
      {overflow > 0 && (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-50 text-gray-500 border border-gray-200">
          +{overflow}
        </span>
      )}
    </span>
  )
}
