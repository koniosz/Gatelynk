'use client'
import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import Link from 'next/link'

// ─── Pomocnicze komponenty ─────────────────────────────────────────────────────

const inputCls = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'
const selectCls = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
      <h2 className="font-semibold text-gray-800">{title}</h2>
      {children}
    </div>
  )
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      {children}
    </div>
  )
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-3 cursor-pointer select-none">
      <div
        onClick={() => onChange(!checked)}
        className={`relative w-10 h-5 rounded-full transition-colors ${checked ? 'bg-blue-600' : 'bg-gray-300'}`}
      >
        <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </div>
      <span className="text-sm text-gray-700">{label}</span>
    </label>
  )
}

interface NominatimResult {
  place_id: number
  display_name: string
}

function AddressAutocomplete({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [suggestions, setSuggestions] = useState<NominatimResult[]>([])
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(value)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const search = (q: string) => {
    setQuery(q)
    onChange(q)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (q.length < 4) { setSuggestions([]); setOpen(false); return }
    debounceRef.current = setTimeout(async () => {
      try {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&addressdetails=1&countrycodes=pl&limit=6`
        const res = await fetch(url, { headers: { 'Accept-Language': 'pl' } })
        const data: NominatimResult[] = await res.json()
        setSuggestions(data)
        setOpen(data.length > 0)
      } catch { /* sieć offline — cicho pomiń */ }
    }, 350)
  }

  const pick = (item: NominatimResult) => {
    // Skróć display_name: usuń kraj i długie przyrostki
    const parts = item.display_name.split(', ')
    const short = parts.slice(0, Math.min(parts.length - 1, 4)).join(', ')
    setQuery(short)
    onChange(short)
    setSuggestions([])
    setOpen(false)
  }

  return (
    <div ref={wrapRef} className="relative">
      <input
        type="text"
        value={query}
        onChange={(e) => search(e.target.value)}
        onFocus={() => suggestions.length > 0 && setOpen(true)}
        required
        placeholder="Zacznij pisać adres…"
        className={inputCls}
        autoComplete="off"
      />
      {open && (
        <ul className="absolute z-50 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-56 overflow-y-auto text-sm">
          {suggestions.map((s) => (
            <li
              key={s.place_id}
              onMouseDown={() => pick(s)}
              className="px-3 py-2 hover:bg-blue-50 cursor-pointer text-gray-700 border-b border-gray-100 last:border-0"
            >
              {s.display_name}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function AmenityChip({ checked, onChange, icon, label }: { checked: boolean; onChange: (v: boolean) => void; icon: string; label: string }) {
  return (
    <button type="button" onClick={() => onChange(!checked)}
      className={`flex flex-col items-center gap-1 p-3 rounded-xl border-2 transition ${
        checked ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'
      }`}>
      <span className="text-2xl">{icon}</span>
      <span className="text-xs font-medium">{label}</span>
    </button>
  )
}

// ─── Główna strona ──────────────────────────────────────────────────────────────

export default function NewBuildingPage() {
  const router = useRouter()

  // Typ obiektu
  const [objectType, setObjectType] = useState<'BUILDING' | 'PARKING' | 'ESTATE' | 'APART_HOTEL'>('BUILDING')

  // Dane podstawowe
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [nip, setNip] = useState('')
  const [regon, setRegon] = useState('')

  // Parametry ogólne
  const [numberOfFloors, setNumberOfFloors] = useState('')
  const [numberOfHouses, setNumberOfHouses] = useState('')
  const [hasElevator, setHasElevator] = useState(false)
  const [hasCctv, setHasCctv] = useState(false)
  const [hasLightingControl, setHasLightingControl] = useState(false)
  const [hasEdgeAI, setHasEdgeAI] = useState(false)
  const [hasEdge, setHasEdge] = useState(false)
  const [hasPhotovoltaics, setHasPhotovoltaics] = useState(false)

  // Udogodnienia
  const [hasPool, setHasPool] = useState(false)
  const [hasGym, setHasGym] = useState(false)
  const [hasSauna, setHasSauna] = useState(false)
  const [hasPlayroom, setHasPlayroom] = useState(false)
  const [hasBanquetHall, setHasBanquetHall] = useState(false)
  const [hasLobby, setHasLobby] = useState(false)

  // Domofon
  const [hasIntercom, setHasIntercom] = useState(false)

  // LPR
  const [hasLprSystem, setHasLprSystem] = useState(false)

  // Paczki
  const [packageHandling, setPackageHandling] = useState<'NONE' | 'LOCKER' | 'CONCIERGE'>('NONE')

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const res = await api.post('/buildings', {
        objectType,
        name, address,
        nip: nip || undefined,
        regon: regon || undefined,
        numberOfFloors: objectType !== 'ESTATE' && numberOfFloors ? Number(numberOfFloors) : undefined,
        numberOfHouses: objectType === 'ESTATE' && numberOfHouses ? Number(numberOfHouses) : undefined,
        hasElevator, hasCctv, hasLightingControl, hasEdgeAI, hasEdge, hasPhotovoltaics,
        hasPool, hasGym, hasSauna, hasPlayroom, hasBanquetHall, hasLobby,
        hasIntercom,
        hasLprSystem,
        packageHandling: packageHandling !== 'NONE' ? packageHandling : undefined,
      })
      router.push(`/buildings/${res.data.id}`)
    } catch (err: any) {
      setError(err?.response?.data?.message ?? 'Błąd podczas tworzenia budynku')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <Link href="/buildings" className="text-sm text-gray-400 hover:text-gray-600">← Obiekty</Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-1">
          {{ BUILDING: 'Nowy budynek wielorodzinny', PARKING: 'Nowy parking', ESTATE: 'Nowe osiedle domów', APART_HOTEL: 'Nowy apart hotel' }[objectType] ?? 'Nowy obiekt'}
        </h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3">{error}</div>
        )}

        {/* 0. Typ obiektu */}
        <Section title="🏢 Typ obiektu">
          <div className="grid grid-cols-2 gap-3">
            {([
              { val: 'BUILDING',    icon: '🏢', title: 'Budynek wielorodzinny', desc: 'Wspólnota mieszkaniowa, blok, kamienica' },
              { val: 'ESTATE',      icon: '🏘️', title: 'Osiedle domów',         desc: 'Osiedle domów jednorodzinnych lub szeregowych' },
              { val: 'APART_HOTEL', icon: '🏨', title: 'Apart Hotel',            desc: 'Apartamenty na wynajem krótkoterminowy' },
              { val: 'PARKING',     icon: '🅿️', title: 'Parking',               desc: 'Parking, garaż wielostanowiskowy' },
            ] as const).map((opt) => (
              <button key={opt.val} type="button" onClick={() => setObjectType(opt.val)}
                className={`p-4 rounded-xl border-2 text-left transition ${
                  objectType === opt.val
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 bg-white hover:border-gray-300'
                }`}>
                <div className="text-2xl mb-1">{opt.icon}</div>
                <p className={`text-sm font-semibold ${objectType === opt.val ? 'text-blue-700' : 'text-gray-800'}`}>
                  {opt.title}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">{opt.desc}</p>
              </button>
            ))}
          </div>
        </Section>

        {/* 1. Dane podstawowe */}
        <Section title="📋 Dane podstawowe">
          <Field label="Nazwa obiektu" required>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required
              placeholder="np. Wspólnota Mieszkaniowa Testowa" className={inputCls} />
          </Field>
          <Field label="Adres" required>
            <AddressAutocomplete value={address} onChange={setAddress} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="NIP">
              <input type="text" value={nip} onChange={(e) => setNip(e.target.value)}
                placeholder="000-000-00-00" className={inputCls} />
            </Field>
            <Field label="REGON">
              <input type="text" value={regon} onChange={(e) => setRegon(e.target.value)}
                placeholder="000000000" className={inputCls} />
            </Field>
          </div>
        </Section>

        {/* 2. Parametry ogólne */}
        <Section title="🏗️ Parametry ogólne">
          {objectType === 'ESTATE' ? (
            <Field label="Liczba domów">
              <input type="number" min="0" value={numberOfHouses}
                onChange={(e) => setNumberOfHouses(e.target.value)}
                placeholder="np. 24" className={`${inputCls} w-32`} />
            </Field>
          ) : (
            <Field label="Liczba pięter">
              <input type="number" min="0" value={numberOfFloors}
                onChange={(e) => setNumberOfFloors(e.target.value)}
                placeholder="np. 8" className={`${inputCls} w-32`} />
            </Field>
          )}
          <div className="grid grid-cols-2 gap-x-8 gap-y-3">
            <Toggle checked={hasElevator}        onChange={setHasElevator}        label="🛗 Winda" />
            <Toggle checked={hasCctv}            onChange={setHasCctv}            label="📹 Monitoring CCTV" />
            <Toggle checked={hasLightingControl} onChange={setHasLightingControl} label="💡 Oświetlenie części wspólnych" />
            <Toggle checked={hasIntercom}        onChange={setHasIntercom}        label="🔔 Domofon" />
            <Toggle checked={hasLprSystem}       onChange={setHasLprSystem}       label="🚗 Kamery LPR" />
            <Toggle checked={hasPhotovoltaics}   onChange={setHasPhotovoltaics}   label="☀️ Fotowoltaika" />
            <Toggle checked={packageHandling !== 'NONE'} onChange={(v) => setPackageHandling(v ? 'CONCIERGE' : 'NONE')} label="📦 Obsługa przesyłek" />
          </div>
          {packageHandling !== 'NONE' && (
            <div className="border-t border-gray-100 pt-3 mt-1">
              <p className="text-xs font-medium text-gray-600 mb-2">Sposób obsługi przesyłek:</p>
              <div className="flex gap-2">
                {[
                  { val: 'CONCIERGE', icon: '🧑‍💼', label: 'Przez konsjerża' },
                  { val: 'LOCKER',    icon: '📦',   label: 'Paczkomat Pointpack' },
                ].map(({ val, icon, label }) => (
                  <button key={val} type="button" onClick={() => setPackageHandling(val as 'CONCIERGE' | 'LOCKER')}
                    className={`flex items-center gap-2 text-sm px-3 py-2 rounded-lg border-2 transition ${
                      packageHandling === val
                        ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium'
                        : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'
                    }`}>
                    <span>{icon}</span>{label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </Section>

        {/* 3. GateLynk Edge */}
        <Section title="🖥️ Sprzęt GateLynk Edge">
          <p className="text-xs text-gray-500 -mt-1">
            Wybierz serwery Edge, które zostaną zainstalowane w obiekcie. Możesz wybrać oba.
          </p>
          <div className="grid grid-cols-1 gap-3">

            {/* GateLynk Edge */}
            <button type="button" onClick={() => setHasEdge(!hasEdge)}
              className={`relative text-left p-4 rounded-xl border-2 transition ${
                hasEdge
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-gray-200 bg-white hover:border-gray-300'
              }`}>
              <div className="flex items-start gap-4">
                <div className={`mt-0.5 w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition ${
                  hasEdge ? 'border-blue-500 bg-blue-500' : 'border-gray-300'
                }`}>
                  {hasEdge && <div className="w-2 h-2 bg-white rounded-full" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-gray-900">GateLynk Edge</span>
                    <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full font-medium">Mac Mini</span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    Lokalny serwer komunikacyjny dla urządzeń w sieci LAN obiektu.
                  </p>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {['🔔 Domofon', '📹 Kamery IP', '🛗 Przywołanie windy', '💡 Zarządzanie oświetleniem'].map((f) => (
                      <span key={f} className={`text-xs px-2 py-0.5 rounded-full border ${
                        hasEdge ? 'bg-blue-100 text-blue-700 border-blue-200' : 'bg-gray-50 text-gray-500 border-gray-200'
                      }`}>{f}</span>
                    ))}
                  </div>
                </div>
              </div>
            </button>

            {/* GateLynk Edge AI */}
            <button type="button" onClick={() => setHasEdgeAI(!hasEdgeAI)}
              className={`relative text-left p-4 rounded-xl border-2 transition ${
                hasEdgeAI
                  ? 'border-violet-500 bg-violet-50'
                  : 'border-gray-200 bg-white hover:border-gray-300'
              }`}>
              <div className="flex items-start gap-4">
                <div className={`mt-0.5 w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition ${
                  hasEdgeAI ? 'border-violet-500 bg-violet-500' : 'border-gray-300'
                }`}>
                  {hasEdgeAI && <div className="w-2 h-2 bg-white rounded-full" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-gray-900">GateLynk Edge AI</span>
                    <span className="text-xs bg-violet-100 text-violet-600 px-2 py-0.5 rounded-full font-medium">HP ZGX Nano</span>
                    <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-medium">⚡ AI onsite</span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    Lokalny serwer analityki AI — przetwarzanie obrazu i danych bez wysyłania do chmury.
                  </p>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {['🧠 Analityka AI', '👁️ Rozpoznawanie twarzy', '🚗 LPR / ANPR', '🔒 Detekcja zagrożeń'].map((f) => (
                      <span key={f} className={`text-xs px-2 py-0.5 rounded-full border ${
                        hasEdgeAI ? 'bg-violet-100 text-violet-700 border-violet-200' : 'bg-gray-50 text-gray-500 border-gray-200'
                      }`}>{f}</span>
                    ))}
                  </div>
                </div>
              </div>
            </button>

          </div>
        </Section>

        {/* 4. Udogodnienia */}
        <Section title="✨ Udogodnienia">
          <div className="grid grid-cols-3 gap-3">
            <AmenityChip checked={hasPool} onChange={setHasPool} icon="🏊" label="Basen" />
            <AmenityChip checked={hasGym} onChange={setHasGym} icon="💪" label="Siłownia" />
            <AmenityChip checked={hasSauna} onChange={setHasSauna} icon="🧖" label="Sauna" />
            <AmenityChip checked={hasPlayroom} onChange={setHasPlayroom} icon="🎮" label="Sala zabaw" />
            <AmenityChip checked={hasBanquetHall} onChange={setHasBanquetHall} icon="🎉" label="Sala bankietowa" />
            <AmenityChip checked={hasLobby} onChange={setHasLobby} icon="🛋️" label="Lobby" />
          </div>
        </Section>

        {/* Przyciski */}
        <div className="flex gap-3 pb-8">
          <button type="submit" disabled={loading}
            className="flex-1 bg-blue-600 text-white text-sm font-medium py-2.5 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition">
            {loading ? 'Tworzenie...' : '✅ Utwórz budynek'}
          </button>
          <Link href="/buildings"
            className="flex-1 text-center border border-gray-300 text-gray-700 text-sm font-medium py-2.5 rounded-lg hover:bg-gray-50 transition">
            Anuluj
          </Link>
        </div>
      </form>
    </div>
  )
}
