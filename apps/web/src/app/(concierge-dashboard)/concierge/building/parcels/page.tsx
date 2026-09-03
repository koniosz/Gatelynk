'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { conciergeApi } from '@/lib/concierge-api'
import { unitIconEmoji } from '@/lib/unit-icon'

// ── Types ─────────────────────────────────────────────────────────────────────
interface Unit {
  id: number
  number: string
  unitType: { name: string; icon: string }
}

interface Parcel {
  id: number
  trackingNumber: string
  courier: 'DHL' | 'INPOST' | 'ALLEGRO' | 'OTHER'
  status: 'RECEIVED' | 'ISSUED'
  unitId: number
  unit: { number: string; unitType: { name: string; icon: string } }
  receivedAt: string
  issuedAt: string | null
  issuedPhotoUrl: string | null
  concierge: { name: string }
}

// ── Constants ──────────────────────────────────────────────────────────────────
const COURIERS = [
  { value: 'DHL',     label: 'DHL',     color: 'bg-yellow-100 text-yellow-800 border-yellow-200' },
  { value: 'INPOST',  label: 'InPost',  color: 'bg-orange-100 text-orange-800 border-orange-200' },
  { value: 'ALLEGRO', label: 'Allegro', color: 'bg-red-100 text-red-800 border-red-200' },
  { value: 'OTHER',   label: 'Inne',    color: 'bg-gray-100 text-gray-700 border-gray-200' },
]

function courierInfo(courier: string) {
  return COURIERS.find((c) => c.value === courier) ?? COURIERS[3]
}

function formatDate(d: string) {
  return new Date(d).toLocaleString('pl-PL', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function daysWaiting(receivedAt: string): number {
  return Math.floor((Date.now() - new Date(receivedAt).getTime()) / (1000 * 60 * 60 * 24))
}

function daysLabel(days: number): string {
  if (days === 0) return 'dziś'
  if (days === 1) return '1 dzień'
  return `${days} dni`
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function ParcelsPage() {
  const router = useRouter()
  const [units, setUnits] = useState<Unit[]>([])
  const [activeParcels, setActiveParcels] = useState<Parcel[]>([])
  const [historyParcels, setHistoryParcels] = useState<Parcel[]>([])
  const [tab, setTab] = useState<'active' | 'history'>('active')
  const [historySearch, setHistorySearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [issuingParcel, setIssuingParcel] = useState<Parcel | null>(null)
  const [remindingId, setRemindingId] = useState<number | null>(null)
  const [reminderDoneId, setReminderDoneId] = useState<number | null>(null)

  // Form state
  const [trackingNumber, setTrackingNumber] = useState('')
  const [courier, setCourier] = useState('DHL')
  const [unitId, setUnitId] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState('')
  const [formSuccess, setFormSuccess] = useState('')
  const trackingInputRef = useRef<HTMLInputElement>(null)

  const loadData = async () => {
    try {
      const [uRes, aRes, hRes] = await Promise.all([
        conciergeApi.get('/concierge/building/units'),
        conciergeApi.get('/concierge/building/parcels?status=RECEIVED'),
        conciergeApi.get('/concierge/building/parcels?status=ISSUED'),
      ])
      setUnits(uRes.data)
      setActiveParcels(aRes.data)
      setHistoryParcels(hRes.data)
      if (!unitId && uRes.data.length > 0) setUnitId(String(uRes.data[0].id))
    } catch {
      router.push('/concierge/login')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadData() }, [])

  // Handle receive parcel
  const handleReceive = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!trackingNumber.trim()) { setFormError('Podaj numer przesyłki'); return }
    if (!unitId) { setFormError('Wybierz lokal'); return }
    setSubmitting(true)
    setFormError('')
    setFormSuccess('')
    try {
      await conciergeApi.post('/concierge/building/parcels', {
        trackingNumber: trackingNumber.trim(),
        courier,
        unitId: parseInt(unitId),
      })
      setTrackingNumber('')
      setFormSuccess('✅ Przesyłka przyjęta pomyślnie')
      setTimeout(() => setFormSuccess(''), 4000)
      trackingInputRef.current?.focus()
      await loadData()
    } catch (err: any) {
      setFormError(err?.response?.data?.message ?? 'Błąd podczas przyjmowania przesyłki')
    } finally {
      setSubmitting(false)
    }
  }

  // Remind about parcel
  const handleRemind = async (parcelId: number) => {
    setRemindingId(parcelId)
    try {
      await conciergeApi.post(`/concierge/building/parcels/${parcelId}/remind`, {})
      setReminderDoneId(parcelId)
      setTimeout(() => setReminderDoneId((prev) => (prev === parcelId ? null : prev)), 5000)
    } catch {
      // silently fail — could show error toast here
    } finally {
      setRemindingId(null)
    }
  }

  // Filtered history
  const filteredHistory = historyParcels.filter((p) => {
    const q = historySearch.toLowerCase()
    return !q ||
      p.trackingNumber.toLowerCase().includes(q) ||
      p.unit.number.toLowerCase().includes(q) ||
      courierInfo(p.courier).label.toLowerCase().includes(q)
  })

  if (loading) return <p className="text-gray-400">Ładowanie...</p>

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">📦 Przesyłki</h1>

      {/* ── Formularz przyjęcia ───────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h2 className="text-base font-semibold text-gray-800 mb-4">Przyjmij przesyłkę</h2>
        <form onSubmit={handleReceive} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {/* Numer przesyłki */}
            <div className="sm:col-span-1">
              <label className="block text-xs font-medium text-gray-500 mb-1">Numer przesyłki *</label>
              <input
                ref={trackingInputRef}
                type="text"
                value={trackingNumber}
                onChange={(e) => setTrackingNumber(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleReceive(e as any) } }}
                placeholder="Wpisz lub zeskanuj..."
                autoFocus
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Kurier */}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Kurier *</label>
              <select
                value={courier}
                onChange={(e) => setCourier(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {COURIERS.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>

            {/* Lokal */}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Lokal *</label>
              <select
                value={unitId}
                onChange={(e) => setUnitId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {unitIconEmoji(u.unitType.icon)} {u.unitType.name} {u.number}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {formError && <p className="text-sm text-red-600">{formError}</p>}
          {formSuccess && <p className="text-sm text-green-600 font-medium">{formSuccess}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition"
          >
            {submitting ? 'Przyjmowanie...' : '📦 Przyjmij przesyłkę'}
          </button>
        </form>
      </div>

      {/* ── Tabs ─────────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {/* Tab bar */}
        <div className="flex border-b border-gray-200">
          <button
            onClick={() => setTab('active')}
            className={`px-5 py-3 text-sm font-medium transition ${tab === 'active' ? 'border-b-2 border-blue-600 text-blue-700' : 'text-gray-500 hover:text-gray-700'}`}
          >
            📦 Aktywne ({activeParcels.length})
          </button>
          <button
            onClick={() => setTab('history')}
            className={`px-5 py-3 text-sm font-medium transition ${tab === 'history' ? 'border-b-2 border-blue-600 text-blue-700' : 'text-gray-500 hover:text-gray-700'}`}
          >
            📋 Historia ({historyParcels.length})
          </button>
        </div>

        {/* Active parcels */}
        {tab === 'active' && (
          <div className="p-4">
            {activeParcels.length === 0 ? (
              <p className="text-center text-gray-400 py-8">Brak aktywnych przesyłek w depozycie</p>
            ) : (
              <div className="space-y-2">
                {activeParcels.map((p) => {
                  const ci = courierInfo(p.courier)
                  const days = daysWaiting(p.receivedAt)
                  const isReminding = remindingId === p.id
                  const reminderDone = reminderDoneId === p.id
                  return (
                    <div key={p.id} className={`p-3 rounded-lg border transition ${days >= 3 ? 'border-amber-200 bg-amber-50' : 'border-gray-100 hover:bg-gray-50'}`}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <span className={`shrink-0 text-xs font-semibold px-2 py-0.5 rounded border ${ci.color}`}>{ci.label}</span>
                          <div className="min-w-0">
                            <p className="text-sm font-mono font-medium text-gray-900 truncate">{p.trackingNumber}</p>
                            <p className="text-xs text-gray-500">
                              {unitIconEmoji(p.unit.unitType.icon)} {p.unit.unitType.name} {p.unit.number}
                              {' · '}
                              <span className={days >= 3 ? 'text-amber-600 font-medium' : ''}>
                                czeka {daysLabel(days)}
                              </span>
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {reminderDone ? (
                            <span className="text-xs text-green-600 font-medium">✓ Wysłano!</span>
                          ) : (
                            <button
                              onClick={() => handleRemind(p.id)}
                              disabled={isReminding}
                              title="Wyślij przypomnienie do mieszkańca"
                              className="px-3 py-1.5 border border-amber-300 bg-amber-50 text-amber-700 rounded-lg text-xs font-medium hover:bg-amber-100 disabled:opacity-50 transition"
                            >
                              {isReminding ? '...' : '🔔 Przypomnij'}
                            </button>
                          )}
                          <button
                            onClick={() => setIssuingParcel(p)}
                            className="px-4 py-1.5 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition"
                          >
                            Wydaj
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* History */}
        {tab === 'history' && (
          <div className="p-4 space-y-3">
            <input
              type="text"
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
              placeholder="Szukaj po numerze, lokalu, kurierze..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {filteredHistory.length === 0 ? (
              <p className="text-center text-gray-400 py-6">Brak przesyłek w historii</p>
            ) : (
              <div className="space-y-2">
                {filteredHistory.map((p) => {
                  const ci = courierInfo(p.courier)
                  return (
                    <div key={p.id} className="p-3 rounded-lg border border-gray-100 bg-gray-50">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${ci.color}`}>{ci.label}</span>
                          <p className="text-sm font-mono font-medium text-gray-900">{p.trackingNumber}</p>
                        </div>
                        <span className="text-xs font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded border border-green-200">Wydana ✓</span>
                      </div>
                      <div className="mt-1.5 text-xs text-gray-500 flex flex-wrap gap-x-4">
                        <span>{unitIconEmoji(p.unit.unitType.icon)} {p.unit.unitType.name} {p.unit.number}</span>
                        <span>Przyjęta: {formatDate(p.receivedAt)}</span>
                        {p.issuedAt && <span>Wydana: {formatDate(p.issuedAt)}</span>}
                      </div>
                      {p.issuedPhotoUrl && (
                        <img
                          src={p.issuedPhotoUrl}
                          alt="Zdjęcie wydania"
                          className="mt-2 h-20 w-auto rounded border border-gray-200 object-cover"
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Modal wydania ─────────────────────────────────────────────────── */}
      {issuingParcel && (
        <IssueModal
          parcel={issuingParcel}
          onClose={() => setIssuingParcel(null)}
          onIssued={() => { setIssuingParcel(null); loadData() }}
        />
      )}
    </div>
  )
}

// ── Issue Modal ───────────────────────────────────────────────────────────────
function IssueModal({ parcel, onClose, onIssued }: {
  parcel: Parcel
  onClose: () => void
  onIssued: () => void
}) {
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)
  const [cameraActive, setCameraActive] = useState(false)
  const [cameraError, setCameraError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const ci = courierInfo(parcel.courier)

  const startCamera = async () => {
    setCameraError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        videoRef.current.play()
      }
      setCameraActive(true)
    } catch {
      setCameraError('Nie można uruchomić kamery. Sprawdź uprawnienia w przeglądarce.')
    }
  }

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setCameraActive(false)
    if (videoRef.current) videoRef.current.srcObject = null
  }

  const takePhoto = () => {
    if (!videoRef.current || !canvasRef.current) return
    const video = videoRef.current
    const canvas = canvasRef.current
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d')?.drawImage(video, 0, 0)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.7)
    setPhotoUrl(dataUrl)
    stopCamera()
  }

  const removePhoto = () => {
    setPhotoUrl(null)
  }

  // Cleanup camera on unmount
  useEffect(() => () => stopCamera(), [])

  const handleIssue = async () => {
    setSubmitting(true)
    setError('')
    try {
      await conciergeApi.patch(`/concierge/building/parcels/${parcel.id}/issue`, {
        photoUrl: photoUrl ?? undefined,
      })
      onIssued()
    } catch (err: any) {
      setError(err?.response?.data?.message ?? 'Błąd podczas wydawania przesyłki')
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-200">
          <h3 className="text-base font-semibold text-gray-900">Wydaj przesyłkę</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        <div className="p-5 space-y-4">
          {/* Parcel details */}
          <div className="bg-gray-50 rounded-xl p-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Numer śledzenia</span>
              <span className="font-mono font-medium text-gray-900">{parcel.trackingNumber}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Kurier</span>
              <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${ci.color}`}>{ci.label}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Lokal</span>
              <span className="font-medium text-gray-900">{unitIconEmoji(parcel.unit.unitType.icon)} {parcel.unit.unitType.name} {parcel.unit.number}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Przyjęta</span>
              <span className="text-gray-700">{formatDate(parcel.receivedAt)}</span>
            </div>
          </div>

          {/* Camera section */}
          <div className="border border-dashed border-gray-300 rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-3 font-medium">📷 Zdjęcie wydania (opcjonalnie)</p>

            {/* Photo preview */}
            {photoUrl ? (
              <div className="space-y-2">
                <img src={photoUrl} alt="Zdjęcie wydania" className="w-full rounded-lg border border-gray-200" />
                <button
                  onClick={removePhoto}
                  className="text-xs text-red-600 hover:text-red-800 font-medium"
                >
                  🗑 Usuń zdjęcie
                </button>
              </div>
            ) : cameraActive ? (
              <div className="space-y-2">
                <video
                  ref={videoRef}
                  autoPlay
                  muted
                  playsInline
                  className="w-full rounded-lg border border-gray-200 bg-black"
                />
                <div className="flex gap-2">
                  <button
                    onClick={takePhoto}
                    className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition"
                  >
                    📸 Zrób zdjęcie
                  </button>
                  <button
                    onClick={stopCamera}
                    className="px-3 py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50 transition"
                  >
                    Anuluj
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <button
                  onClick={startCamera}
                  className="w-full py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50 transition"
                >
                  📷 Aktywuj kamerę
                </button>
                {cameraError && <p className="text-xs text-red-600 mt-1">{cameraError}</p>}
              </div>
            )}

            <canvas ref={canvasRef} className="hidden" />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-5 border-t border-gray-200">
          <button
            onClick={onClose}
            className="flex-1 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 transition"
          >
            Anuluj
          </button>
          <button
            onClick={handleIssue}
            disabled={submitting}
            className="flex-1 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition"
          >
            {submitting ? 'Wydawanie...' : '✅ Potwierdź wydanie'}
          </button>
        </div>
      </div>
    </div>
  )
}
