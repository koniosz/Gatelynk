'use client'

/**
 * Pełnoekranowa przeglądarka odczytów LPR — łączy w jedno:
 *   • duży podgląd zdjęcia z kamery,
 *   • nawigację strzałkami ← / → po przefiltrowanej liście odczytów,
 *   • boczny panel z identyfikacją (mieszkaniec / usługa) lub info o właścicielu.
 *
 * Wcześniej były osobno: `Lightbox` (sam obraz) i `IdentifyModal` (mała forma
 * w okienku). Konsjerż musiał klikać między oboma. Tu jest wszystko razem,
 * z miejscem na duże zdjęcie.
 *
 * Komponent jest „tłumaczem" między wspólnym UI a różnymi axios-instancjami
 * (admin / konsjerż) — przyjmuje fabrykę URL-i i klienta przez propsy.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AxiosInstance } from 'axios'
import {
  LprRead, VehicleKind, VEHICLE_KIND_OPTIONS,
  brandLabel, colorLabel, colorSwatch, formatReadTs,
  ownerDisplay, vehicleTypePl,
} from '@/lib/lpr'
import { TagPicker, TagChips } from '@/components/TagPicker'

export interface LprViewerProps {
  reads: LprRead[]
  initialIndex: number
  apiClient: AxiosInstance
  /** Endpoint do pobrania obrazu blob-em (z bearer-em). */
  buildImageUrl: (readId: number) => string
  /** POST `/.../vehicles` — zwracany URL trafia do `apiClient.post(...)`. */
  buildVehiclesUrl: () => string
  /**
   * PATCH `/.../vehicles/:id` — używane przy „Zmień klasyfikację" zamiast
   * POST-a. Bez tego edycja literówki tworzy duplikat (nowy wpis z tą samą
   * tablicą zamiast aktualizacji istniejącego — patrz duplicate-guard
   * w BA/Concierge.createVehicle).
   */
  buildVehicleUrl: (vehicleId: number) => string
  /** GET listy mieszkańców budynku. */
  buildResidentsUrl: () => string
  /** GET autocomplete'a nazw serwisów w budynku. */
  buildServiceNamesUrl: () => string
  /** GET autocomplete'a tagów już użytych w budynku. */
  buildVehicleTagsUrl: () => string
  onClose: () => void
  /** Wywoływane po udanym zapisie identyfikacji — do refetchu listy. */
  onSaved?: () => void
}

export function LprViewer(props: LprViewerProps) {
  const { reads, initialIndex, onClose } = props
  const [index, setIndex] = useState(initialIndex)
  const total = reads.length
  const read = reads[index]

  // Strzałki ← / → przeskakują po przefiltrowanej liście. ESC zamyka.
  // Reset stanu identyfikacji następuje przy zmianie indeksu (kluczowanie
  // panelu po `read.id`).
  const goPrev = useCallback(() => setIndex(i => (i - 1 + total) % total), [total])
  const goNext = useCallback(() => setIndex(i => (i + 1) % total), [total])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Pomijamy gdy fokus jest w polu tekstowym/select-cie — żeby pisanie w
      // nazwie firmy nie przeskakiwało zdjęć.
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) {
        if (e.key === 'Escape') (t as HTMLElement).blur()
        return
      }
      if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev() }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goNext() }
      else if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goPrev, goNext, onClose])

  if (!read) return null

  return (
    <div
      className="fixed inset-0 bg-black/85 z-50 flex flex-col"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      {/* Górny pasek — pozycja, tablica, czas, X. */}
      <div className="flex items-center justify-between px-5 py-3 bg-black/40 text-white">
        <div className="flex items-center gap-4">
          <span className="text-xs text-gray-400">
            {index + 1} / {total}
          </span>
          <span className="font-mono font-bold text-lg">{read.plate}</span>
          <span className="text-sm text-gray-300">{formatReadTs(read.ts)}</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-400">
          <span className="hidden md:inline">
            ← → nawigacja · Esc zamyka
          </span>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-white text-lg leading-none"
            aria-label="Zamknij"
          >
            ×
          </button>
        </div>
      </div>

      {/* Główny widok: zdjęcie + boczny panel. */}
      <div className="flex-1 flex min-h-0">
        {/* Lewa strona — zdjęcie + strzałki. */}
        <div className="relative flex-1 flex items-center justify-center min-w-0">
          <ViewerImage
            key={read.id}
            apiClient={props.apiClient}
            url={props.buildImageUrl(read.id)}
            hasImage={read.hasImage}
          />

          {/* Strzałki nawigacyjne. Trzymamy je w warstwie nad obrazem. */}
          {total > 1 && (
            <>
              <button
                onClick={goPrev}
                className="absolute left-3 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-black/40 hover:bg-black/60 text-white text-2xl"
                aria-label="Poprzedni"
              >
                ‹
              </button>
              <button
                onClick={goNext}
                className="absolute right-3 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-black/40 hover:bg-black/60 text-white text-2xl"
                aria-label="Następny"
              >
                ›
              </button>
            </>
          )}
        </div>

        {/* Prawy panel — info o pojeździe + ewentualnie formularz. */}
        <aside className="w-[420px] max-w-[42vw] shrink-0 bg-white overflow-y-auto">
          <SidePanel
            key={read.id}                     // reset stanu formy przy zmianie zdjęcia
            read={read}
            apiClient={props.apiClient}
            buildVehiclesUrl={props.buildVehiclesUrl}
            buildVehicleUrl={props.buildVehicleUrl}
            buildResidentsUrl={props.buildResidentsUrl}
            buildServiceNamesUrl={props.buildServiceNamesUrl}
            buildVehicleTagsUrl={props.buildVehicleTagsUrl}
            onSaved={props.onSaved}
          />
        </aside>
      </div>
    </div>
  )
}

// ── Image (blob fetch) ───────────────────────────────────────────────────────
function ViewerImage({
  apiClient, url, hasImage,
}: { apiClient: AxiosInstance; url: string; hasImage: boolean }) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!hasImage) { setFailed(true); return }
    let cancelled = false
    let blobUrl: string | null = null
    setSrc(null); setFailed(false)
    apiClient.get(url, { responseType: 'blob' })
      .then((res) => {
        if (cancelled) return
        blobUrl = URL.createObjectURL(res.data as Blob)
        setSrc(blobUrl)
      })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => {
      cancelled = true
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [apiClient, url, hasImage])

  if (failed) {
    return (
      <div className="w-[60vw] max-w-[800px] h-[60vh] rounded bg-white/5 flex items-center justify-center text-white/40 text-sm">
        Brak zdjęcia
      </div>
    )
  }
  if (!src) {
    return <div className="w-[60vw] max-w-[800px] h-[60vh] rounded bg-white/5 animate-pulse" />
  }
  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src={src}
      alt=""
      className="max-w-full max-h-full object-contain"
    />
  )
}

// ── Side panel ──────────────────────────────────────────────────────────────
function SidePanel({
  read, apiClient, buildVehiclesUrl, buildVehicleUrl, buildResidentsUrl, buildServiceNamesUrl, buildVehicleTagsUrl, onSaved,
}: {
  read: LprRead
  apiClient: AxiosInstance
  buildVehiclesUrl: () => string
  buildVehicleUrl: (vehicleId: number) => string
  buildResidentsUrl: () => string
  buildServiceNamesUrl: () => string
  buildVehicleTagsUrl: () => string
  onSaved?: () => void
}) {
  const owner = ownerDisplay(read)
  const brand = brandLabel(read) || '—'
  const color = colorLabel(read)
  const swatch = colorSwatch(read.vehicleColorStored ?? read.vehicleColor)
  const type = vehicleTypePl(read.vehicleType)

  // Domyślnie pokazujemy formę identyfikacji od razu dla nieprzypisanych
  // odczytów — to jest główny use case („zobacz zdjęcie i sklasyfikuj"). Dla
  // już zidentyfikowanych pokazujemy info; admin może kliknąć „Zmień", ale
  // domyślnie panel jest tylko-do-odczytu.
  const [showForm, setShowForm] = useState(!read.vehicleId)

  return (
    <div className="p-5 space-y-4">
      <header>
        <div className="text-xs text-gray-500 uppercase tracking-wide">Pojazd</div>
        <div className="mt-1 flex items-center gap-2">
          {swatch && (
            <span
              className="inline-block w-3 h-3 rounded-full border border-gray-300"
              style={{ backgroundColor: swatch }}
            />
          )}
          <span className={brand === '—' ? 'text-gray-400' : 'font-semibold text-gray-900 text-lg'}>
            {brand}
          </span>
        </div>
        {(type || color) && (
          <div className="text-xs text-gray-500 mt-0.5">
            {[type, color].filter(Boolean).join(' · ')}
          </div>
        )}
      </header>

      {/* Kafelek właściciela albo „nieprzypisany". */}
      {owner ? (
        <div className="rounded-lg bg-gray-50 border border-gray-200 p-3 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2 min-w-0">
              {owner.icon && owner.badgeClass && (
                <span className={`text-xs px-1.5 py-0.5 rounded ${owner.badgeClass} shrink-0`}>
                  {owner.icon}
                </span>
              )}
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-900 truncate">
                  {owner.primary}
                </div>
                {owner.secondary && (
                  <div className="text-xs text-gray-500 truncate">{owner.secondary}</div>
                )}
              </div>
            </div>
            {!showForm && (
              <button
                onClick={() => setShowForm(true)}
                className="text-xs text-blue-600 hover:underline whitespace-nowrap"
              >
                Zmień…
              </button>
            )}
          </div>
          {read.vehicleTags && read.vehicleTags.length > 0 && (
            <TagChips tags={read.vehicleTags} />
          )}
        </div>
      ) : (
        <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
          ⚠️ Pojazd nieprzypisany — zaklasyfikuj poniżej.
        </div>
      )}

      {/* Brama. */}
      <div className="text-xs text-gray-600 border border-gray-100 rounded-lg px-3 py-2">
        Brama:{' '}
        {read.gateOpened ? (
          <span className="text-green-700 font-medium">✓ otwarta</span>
        ) : read.matched ? (
          <span className="text-amber-600">przypisana, nie otwarto</span>
        ) : (
          <span className="text-gray-400">nieotwarta</span>
        )}
        {read.confidence != null && (
          <span className="ml-3 text-gray-400">
            ufność OCR: {(read.confidence * 100).toFixed(0)}%
          </span>
        )}
      </div>

      {showForm && (
        <IdentifyForm
          read={read}
          apiClient={apiClient}
          buildVehiclesUrl={buildVehiclesUrl}
          buildVehicleUrl={buildVehicleUrl}
          buildResidentsUrl={buildResidentsUrl}
          buildServiceNamesUrl={buildServiceNamesUrl}
          buildVehicleTagsUrl={buildVehicleTagsUrl}
          onSaved={onSaved}
          onCancel={read.vehicleId ? () => setShowForm(false) : undefined}
        />
      )}
    </div>
  )
}

// ── Identify form ───────────────────────────────────────────────────────────
type IdentifyMode = 'RESIDENT' | 'SERVICE'

function IdentifyForm({
  read, apiClient, buildVehiclesUrl, buildVehicleUrl, buildResidentsUrl, buildServiceNamesUrl, buildVehicleTagsUrl, onSaved, onCancel,
}: {
  read: LprRead
  apiClient: AxiosInstance
  buildVehiclesUrl: () => string
  buildVehicleUrl: (vehicleId: number) => string
  buildResidentsUrl: () => string
  buildServiceNamesUrl: () => string
  buildVehicleTagsUrl: () => string
  onSaved?: () => void
  onCancel?: () => void
}) {
  const [mode, setMode] = useState<IdentifyMode>('RESIDENT')
  const [residents, setResidents] = useState<any[]>([])
  const [serviceNames, setServiceNames] = useState<string[]>([])
  const [residentId, setResidentId] = useState<string>('')
  const [kind, setKind] = useState<VehicleKind>('DELIVERY')
  const [serviceName, setServiceName] = useState<string>('')
  const [make, setMake] = useState<string>('')
  const [model, setModel] = useState<string>('')
  const [color, setColor] = useState<string>('')
  const [notes, setNotes] = useState<string>('')
  const [tags, setTags] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [residentSearch, setResidentSearch] = useState('')

  // Pre-fill marka/kolor/tagi z tego co już mamy: ręcznie zaklasyfikowane
  // wartości > kamerowe. Zwykle wystarczy wybrać mieszkańca i zapisać.
  useEffect(() => {
    const camBrand = read.vehicleBrand ?? ''
    setMake(read.vehicleMake ?? (camBrand && !camBrand.startsWith('#') ? camBrand : ''))
    setModel(read.vehicleModel ?? '')
    setColor(read.vehicleColorStored ?? read.vehicleColor ?? '')
    setTags(read.vehicleTags ?? [])
  }, [read])

  useEffect(() => {
    apiClient.get(buildResidentsUrl())
      .then((r) => setResidents(r.data as any[]))
      .catch(() => { /* 401 obsłużone globalnie */ })
    apiClient.get(buildServiceNamesUrl())
      .then((r) => setServiceNames(r.data as string[]))
      .catch(() => { /* best-effort */ })
  }, [apiClient, buildResidentsUrl, buildServiceNamesUrl])

  const filteredResidents = useMemo(() => {
    const q = residentSearch.trim().toLowerCase()
    if (!q) return residents
    return residents.filter((r) =>
      `${r.firstName} ${r.lastName}`.toLowerCase().includes(q) ||
      (r.email ?? '').toLowerCase().includes(q) ||
      (r.phone ?? '').toLowerCase().includes(q),
    )
  }, [residents, residentSearch])

  const filteredServiceNames = useMemo(() => {
    const q = serviceName.trim().toLowerCase()
    if (!q) return []
    return serviceNames
      .filter(n => n.toLowerCase().includes(q) && n.toLowerCase() !== q)
      .slice(0, 6)
  }, [serviceNames, serviceName])

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (mode === 'RESIDENT') {
      if (!residentId) { setError('Wybierz mieszkańca'); return }
      if (!make.trim()) { setError('Podaj markę'); return }
      if (!color.trim()) { setError('Podaj kolor'); return }
    } else {
      if (!serviceName.trim()) { setError('Podaj nazwę firmy/serwisu'); return }
    }
    setSaving(true)
    try {
      // KEY FIX: gdy edytujemy istniejący wpis (read.vehicleId), wysyłamy
      // PATCH na konkretny pojazd. Wcześniej zawsze był POST — co przy
      // edycji literówki tworzyło drugi wpis z tą samą tablicą („Rangę ROver"
      // + „Range Rover" obok siebie). Backend ma duplicate-guard, ale UI
      // powinno wysyłać prawidłową semantykę REST.
      const payload = {
        kind: mode === 'RESIDENT' ? 'RESIDENT' : kind,
        residentId: residentId ? Number(residentId) : undefined,
        make: (make.trim() || read.vehicleBrand || '—'),
        model: model.trim() || undefined,
        color: (color.trim() || '—'),
        serviceName: mode === 'SERVICE' ? serviceName.trim() : undefined,
        notes: notes.trim() || undefined,
        tags,
      }
      if (read.vehicleId) {
        await apiClient.patch(buildVehicleUrl(read.vehicleId), payload)
      } else {
        await apiClient.post(buildVehiclesUrl(), {
          ...payload,
          licensePlate: read.plate,
        })
      }
      onSaved?.()
    } catch (err: any) {
      setError(err?.response?.data?.message ?? 'Nie udało się zapisać')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSave} className="space-y-3">
      <div className="text-xs font-semibold text-gray-700 uppercase tracking-wide pt-1">
        {read.vehicleId ? 'Zmień klasyfikację' : 'Sklasyfikuj pojazd'}
      </div>

      <div className="grid grid-cols-2 gap-1 rounded-lg bg-gray-100 p-1">
        {([
          ['RESIDENT', '👤 Mieszkaniec'],
          ['SERVICE',  '🚛 Usługa'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setMode(key)}
            className={`text-sm py-1.5 rounded-md transition ${
              mode === key
                ? 'bg-white text-gray-900 font-medium shadow-sm'
                : 'text-gray-500 hover:text-gray-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'RESIDENT' ? (
        <div>
          <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
            Mieszkaniec
          </label>
          <input
            type="text"
            value={residentSearch}
            onChange={(e) => setResidentSearch(e.target.value)}
            placeholder="Szukaj mieszkańca…"
            className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
          <select
            value={residentId}
            onChange={(e) => setResidentId(e.target.value)}
            size={5}
            className="mt-2 w-full border border-gray-200 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
          >
            <option value="">— wybierz —</option>
            {filteredResidents.map((r: any) => (
              <option key={r.id} value={r.id}>
                {r.lastName} {r.firstName}
                {r.email ? ` · ${r.email}` : ''}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <>
          <div>
            <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              Kategoria
            </label>
            <div className="mt-1 grid grid-cols-2 gap-2">
              {VEHICLE_KIND_OPTIONS.filter(o => o.value !== 'RESIDENT').map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setKind(opt.value)}
                  className={`text-left text-sm px-3 py-2 rounded-lg border transition ${
                    kind === opt.value
                      ? 'border-blue-500 bg-blue-50 text-blue-800'
                      : 'border-gray-200 hover:bg-gray-50 text-gray-700'
                  }`}
                >
                  <span className="text-base mr-1">{opt.icon}</span>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="relative">
            <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              Nazwa firmy / serwisu
            </label>
            <input
              type="text"
              value={serviceName}
              onChange={(e) => setServiceName(e.target.value)}
              placeholder={
                kind === 'DELIVERY'  ? 'np. Glovo, InPost, DPD' :
                kind === 'SERVICE'   ? 'np. MPO Odpady, MPWiK' :
                kind === 'EMERGENCY' ? 'np. Pogotowie, Straż' :
                                       'np. Urząd Miasta'
              }
              autoComplete="off"
              className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
            {filteredServiceNames.length > 0 && (
              <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-md max-h-40 overflow-y-auto">
                {filteredServiceNames.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setServiceName(n)}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-blue-50"
                  >
                    {n}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              Mieszkaniec <span className="text-gray-300">(opcj.)</span>
            </label>
            <input
              type="text"
              value={residentSearch}
              onChange={(e) => setResidentSearch(e.target.value)}
              placeholder="Szukaj (opcjonalnie)…"
              className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
            <select
              value={residentId}
              onChange={(e) => setResidentId(e.target.value)}
              className="mt-2 w-full border border-gray-200 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            >
              <option value="">— brak (usługa ogólna) —</option>
              {filteredResidents.map((r: any) => (
                <option key={r.id} value={r.id}>
                  {r.lastName} {r.firstName}
                </option>
              ))}
            </select>
          </div>
        </>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
            Marka {mode === 'SERVICE' && <span className="text-gray-300">(opcj.)</span>}
          </label>
          <input
            type="text"
            value={make}
            onChange={(e) => setMake(e.target.value)}
            placeholder="np. Fiat"
            className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
            Model <span className="text-gray-300">(opcj.)</span>
          </label>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="np. Ducato"
            className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
        </div>
      </div>

      <div>
        <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
          Kolor {mode === 'SERVICE' && <span className="text-gray-300">(opcj.)</span>}
        </label>
        <input
          type="text"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          placeholder="np. biały"
          className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
        />
      </div>

      {mode === 'SERVICE' && (
        <div>
          <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
            Notatka <span className="text-gray-300">(opcj.)</span>
          </label>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="np. Śmieciarka — wt./pt. 6-8"
            className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
        </div>
      )}

      <div>
        <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
          Tagi <span className="text-gray-300">(opcj.)</span>
        </label>
        <p className="text-[11px] text-gray-400 mt-0.5 mb-1.5">
          Pomaga wyszukiwaniu — np. „kabrio", „Glovo", „opiekunka". Wpisz Enter aby dodać własny.
        </p>
        <TagPicker
          value={tags}
          onChange={setTags}
          apiClient={apiClient}
          buildSuggestionsUrl={buildVehicleTagsUrl}
          ariaLabel="Tagi pojazdu"
        />
      </div>

      {error && (
        <div className="text-sm text-red-600 bg-red-50 rounded px-3 py-2">{error}</div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="text-sm px-3 py-1.5 rounded-lg text-gray-600 hover:bg-gray-100"
          >
            Anuluj
          </button>
        )}
        <button
          type="submit"
          disabled={saving}
          className="text-sm px-4 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? 'Zapisywanie…' : 'Zapisz'}
        </button>
      </div>
    </form>
  )
}
