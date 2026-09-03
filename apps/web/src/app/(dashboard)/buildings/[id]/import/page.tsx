'use client'
import { useState, useCallback, useRef, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import * as XLSX from 'xlsx'
import { api } from '@/lib/api'

// ─── Typy ─────────────────────────────────────────────────────────────────────

interface ParsedUnit {
  _row: number
  numer: string
  pietro?: number | null
  typ: string
  powierzchnia?: number | null
  opis?: string
  errors: string[]
}

interface ParsedResident {
  _row: number
  imie: string
  nazwisko: string
  email: string
  telefon?: string
  lokal?: string
  errors: string[]
}

interface UnitType { id: number; name: string; code: string; isCommonArea: boolean }

// ─── Główny komponent ──────────────────────────────────────────────────────────

export default function ImportPage() {
  const { id } = useParams()
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)

  const [step, setStep] = useState<'upload' | 'preview' | 'importing' | 'done'>('upload')
  const [unitTypes, setUnitTypes] = useState<UnitType[]>([])
  const [units, setParsedUnits] = useState<ParsedUnit[]>([])
  const [residents, setParsedResidents] = useState<ParsedResident[]>([])
  const [fileName, setFileName] = useState('')
  const [progress, setProgress] = useState({ done: 0, total: 0, errors: 0 })
  const [log, setLog] = useState<{ ok: boolean; msg: string }[]>([])

  useEffect(() => {
    api.get(`/buildings/${id}/unit-types`).then((r) => setUnitTypes(r.data)).catch(() => {})
  }, [id])

  // ── Generuj szablon XLSX ──────────────────────────────────────────────────
  const downloadTemplate = () => {
    const wb = XLSX.utils.book_new()

    // Arkusz Lokale
    const unitsData = [
      ['Numer lokalu *', 'Piętro', 'Typ *', 'Powierzchnia m²', 'Opis'],
      ['1A', '1', 'Mieszkanie', '52.5', ''],
      ['1B', '1', 'Mieszkanie', '48', 'Lokal narożny'],
      ['G1', '', 'Garaż', '18', ''],
    ]
    const wsUnits = XLSX.utils.aoa_to_sheet(unitsData)
    wsUnits['!cols'] = [{ wch: 16 }, { wch: 8 }, { wch: 18 }, { wch: 16 }, { wch: 24 }]
    XLSX.utils.book_append_sheet(wb, wsUnits, 'Lokale')

    // Arkusz Mieszkańcy
    const residentsData = [
      ['Imię *', 'Nazwisko *', 'Email *', 'Telefon', 'Numer lokalu'],
      ['Jan', 'Kowalski', 'jan.kowalski@example.com', '600 123 456', '1A'],
      ['Anna', 'Nowak', 'anna.nowak@example.com', '', '1B'],
    ]
    const wsResidents = XLSX.utils.aoa_to_sheet(residentsData)
    wsResidents['!cols'] = [{ wch: 14 }, { wch: 16 }, { wch: 30 }, { wch: 16 }, { wch: 16 }]
    XLSX.utils.book_append_sheet(wb, wsResidents, 'Mieszkańcy')

    // Arkusz Typy (pomocniczy, tylko do odczytu)
    const typesData = [
      ['Dostępne typy lokali (kolumna "Typ *" w arkuszu Lokale)'],
      ...unitTypes.filter((t) => !t.isCommonArea).map((t) => [t.name]),
      ['Mieszkanie'],
      ['Komercyjny'],
      ['Garaż'],
      ['Miejsce parkingowe'],
      ['Magazyn'],
    ].filter((row, i, arr) => i === 0 || !arr.slice(1, i).some((r) => r[0] === row[0]))
    const wsTypes = XLSX.utils.aoa_to_sheet(typesData)
    wsTypes['!cols'] = [{ wch: 40 }]
    XLSX.utils.book_append_sheet(wb, wsTypes, 'Typy (info)')

    XLSX.writeFile(wb, 'GateLynk_szablon_importu.xlsx')
  }

  // ── Parsuj wgrany plik ────────────────────────────────────────────────────
  const handleFile = useCallback((file: File) => {
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = (e) => {
      const data = new Uint8Array(e.target!.result as ArrayBuffer)
      const wb = XLSX.read(data, { type: 'array' })

      const parsedUnits: ParsedUnit[] = []
      const parsedResidents: ParsedResident[] = []

      // Arkusz Lokale
      const wsU = wb.Sheets['Lokale'] ?? wb.Sheets[wb.SheetNames[0]]
      if (wsU) {
        const rows: any[][] = XLSX.utils.sheet_to_json(wsU, { header: 1, defval: '' })
        rows.slice(1).forEach((row, i) => {
          const [numer, pietro, typ, powierzchnia, opis] = row.map((c: any) => String(c ?? '').trim())
          if (!numer && !typ) return // pusta linia
          const errors: string[] = []
          if (!numer) errors.push('Brak numeru lokalu')
          if (!typ) errors.push('Brak typu lokalu')
          const pFloat = powierzchnia ? parseFloat(powierzchnia.replace(',', '.')) : null
          if (powierzchnia && isNaN(pFloat!)) errors.push('Nieprawidłowa powierzchnia')
          const pietroParsed = pietro ? parseInt(pietro) : null
          if (pietro && isNaN(pietroParsed!)) errors.push('Nieprawidłowe piętro')
          parsedUnits.push({ _row: i + 2, numer, pietro: pietroParsed, typ, powierzchnia: pFloat, opis: opis || undefined, errors })
        })
      }

      // Arkusz Mieszkańcy
      const wsR = wb.Sheets['Mieszkańcy'] ?? wb.Sheets['Mieszkancy'] ?? wb.Sheets[wb.SheetNames[1]]
      if (wsR) {
        const rows: any[][] = XLSX.utils.sheet_to_json(wsR, { header: 1, defval: '' })
        const emailsSeen = new Set<string>()
        rows.slice(1).forEach((row, i) => {
          const [imie, nazwisko, email, telefon, lokal] = row.map((c: any) => String(c ?? '').trim())
          if (!imie && !nazwisko && !email) return
          const errors: string[] = []
          if (!imie) errors.push('Brak imienia')
          if (!nazwisko) errors.push('Brak nazwiska')
          if (!email) errors.push('Brak emaila')
          else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Nieprawidłowy email')
          else if (emailsSeen.has(email.toLowerCase())) errors.push('Zduplikowany email')
          else emailsSeen.add(email.toLowerCase())
          parsedResidents.push({ _row: i + 2, imie, nazwisko, email, telefon: telefon || undefined, lokal: lokal || undefined, errors })
        })
      }

      setParsedUnits(parsedUnits)
      setParsedResidents(parsedResidents)
      setStep('preview')
    }
    reader.readAsArrayBuffer(file)
  }, [])

  // ── Import ────────────────────────────────────────────────────────────────
  const handleImport = async () => {
    setStep('importing')
    const newLog: { ok: boolean; msg: string }[] = []
    const validUnits = units.filter((u) => u.errors.length === 0)
    const validResidents = residents.filter((r) => r.errors.length === 0)
    const total = validUnits.length + validResidents.length
    let done = 0; let errors = 0
    setProgress({ done: 0, total, errors: 0 })

    // Mapa: nazwa lokalu → jego id (po imporcie)
    const unitNumberToId = new Map<string, number>()

    // Pomocnicza kopia typów (może rosnąć podczas importu o nowe)
    const knownTypes = [...unitTypes]

    // 1. Importuj lokale
    for (const u of validUnits) {
      try {
        // Znajdź typ lokalu po nazwie (dopasowanie case-insensitive)
        let unitType = knownTypes.find((t) =>
          !t.isCommonArea && t.name.toLowerCase() === u.typ.toLowerCase()
        )
        if (!unitType) {
          // Typ nie istnieje — utwórz go na bieżąco z dokładną nazwą z pliku
          const created = await api.post(`/buildings/${id}/unit-types`, {
            name: u.typ,
            icon: '🏠',
            isCommonArea: false,
          })
          unitType = created.data
          if (unitType) knownTypes.push(unitType)
          newLog.push({ ok: true, msg: `Utworzono nowy typ lokalu: „${u.typ}"` })
        }
        if (!unitType) { throw new Error('Brak zgodnego typu lokalu') }

        const res = await api.post(`/buildings/${id}/units`, {
          unitTypeId: unitType.id,
          number: u.numer,
          floor: u.pietro ?? undefined,
          areaSqm: u.powierzchnia ?? undefined,
          description: u.opis ?? undefined,
        })
        unitNumberToId.set(u.numer.toLowerCase(), res.data.id)
        newLog.push({ ok: true, msg: `Lokal ${u.numer} — zaimportowano` })
        done++
      } catch (err: any) {
        newLog.push({ ok: false, msg: `Lokal ${u.numer} — błąd: ${err?.response?.data?.message ?? err.message}` })
        errors++
        done++
      }
      setProgress({ done, total, errors })
    }

    // 2. Importuj mieszkańców
    for (const r of validResidents) {
      try {
        const res = await api.post(`/buildings/${id}/residents`, {
          firstName: r.imie,
          lastName: r.nazwisko,
          email: r.email,
          phone: r.telefon ?? undefined,
        })
        const residentId = res.data.id

        // Przypisz do lokalu jeśli podany
        if (r.lokal) {
          const unitId = unitNumberToId.get(r.lokal.toLowerCase())
            ?? (await api.get(`/buildings/${id}/units`).then((ures) =>
                ures.data.find((u: any) => u.number.toLowerCase() === r.lokal!.toLowerCase())?.id
              ).catch(() => undefined))
          if (unitId) {
            await api.post(`/buildings/${id}/residents/${unitId}/assign`, {
              residentId,
              role: 'OWNER',
              sinceDate: new Date().toISOString().slice(0, 10),
            }).catch(() => {})
          }
        }
        newLog.push({ ok: true, msg: `Mieszkaniec ${r.imie} ${r.nazwisko} — zaimportowano` })
        done++
      } catch (err: any) {
        newLog.push({ ok: false, msg: `Mieszkaniec ${r.imie} ${r.nazwisko} — błąd: ${err?.response?.data?.message ?? err.message}` })
        errors++
        done++
      }
      setProgress({ done, total, errors })
    }

    setLog(newLog)
    setStep('done')
  }

  // ── Eksport aktualnych danych ─────────────────────────────────────────────
  const handleExport = async () => {
    const [unitsRes, residentsRes] = await Promise.all([
      api.get(`/buildings/${id}/units`),
      api.get(`/buildings/${id}/residents`),
    ])

    const wb = XLSX.utils.book_new()

    // Lokale
    const unitsRows = [['Numer lokalu', 'Piętro', 'Typ', 'Powierzchnia m²', 'Opis']]
    for (const u of unitsRes.data) {
      unitsRows.push([u.number, u.floor ?? '', u.unitType?.name ?? '', u.areaSqm ?? '', u.description ?? ''])
    }
    const wsU = XLSX.utils.aoa_to_sheet(unitsRows)
    wsU['!cols'] = [{ wch: 14 }, { wch: 8 }, { wch: 18 }, { wch: 16 }, { wch: 28 }]
    XLSX.utils.book_append_sheet(wb, wsU, 'Lokale')

    // Mieszkańcy
    const residentsRows = [['Imię', 'Nazwisko', 'Email', 'Telefon', 'Numer lokalu']]
    for (const r of residentsRes.data) {
      const lokale = r.unitResidents?.map((ur: any) => ur.unit?.number).filter(Boolean).join(', ') ?? ''
      residentsRows.push([r.firstName, r.lastName, r.email, r.phone ?? '', lokale])
    }
    const wsR = XLSX.utils.aoa_to_sheet(residentsRows)
    wsR['!cols'] = [{ wch: 14 }, { wch: 16 }, { wch: 30 }, { wch: 16 }, { wch: 16 }]
    XLSX.utils.book_append_sheet(wb, wsR, 'Mieszkańcy')

    XLSX.writeFile(wb, `GateLynk_eksport_${new Date().toISOString().slice(0, 10)}.xlsx`)
  }

  const totalErrors = [...units, ...residents].reduce((s, r) => s + r.errors.length, 0)
  const validCount = units.filter((u) => u.errors.length === 0).length + residents.filter((r) => r.errors.length === 0).length

  return (
    <div className="max-w-3xl">
      {/* Nagłówek */}
      <div className="mb-6">
        <Link href={`/buildings/${id}`} className="text-sm text-gray-400 hover:text-gray-600">← Wróć do obiektu</Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-1">📂 Import / Eksport danych</h1>
        <p className="text-sm text-gray-400 mt-1">Importuj lokale i mieszkańców z pliku Excel lub pobierz aktualne dane.</p>
      </div>

      {/* ── KROK 1: Upload ────────────────────────────────────────────────── */}
      {(step === 'upload' || step === 'preview') && (
        <div className="space-y-4">

          {/* Eksport */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="font-semibold text-gray-900">⬇️ Eksport danych</h2>
                <p className="text-sm text-gray-400 mt-0.5">Pobierz aktualne lokale i mieszkańców jako plik Excel.</p>
              </div>
              <button onClick={handleExport}
                className="flex-shrink-0 bg-green-600 text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-green-700 transition">
                ⬇️ Pobierz XLSX
              </button>
            </div>
          </div>

          {/* Szablon */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="font-semibold text-gray-900">📋 Szablon importu</h2>
                <p className="text-sm text-gray-400 mt-0.5">
                  Pobierz gotowy szablon Excel z przykładowymi danymi i instrukcją.
                  Uzupełnij go i wgraj poniżej.
                </p>
                <div className="mt-2 text-xs text-gray-500 space-y-0.5">
                  <p>📄 Arkusz <strong>Lokale</strong>: Numer lokalu, Piętro, Typ, Powierzchnia m², Opis</p>
                  <p>👤 Arkusz <strong>Mieszkańcy</strong>: Imię, Nazwisko, Email, Telefon, Numer lokalu</p>
                </div>
              </div>
              <button onClick={downloadTemplate}
                className="flex-shrink-0 border border-blue-300 text-blue-600 text-sm font-medium px-4 py-2 rounded-lg hover:bg-blue-50 transition">
                📋 Pobierz szablon
              </button>
            </div>
          </div>

          {/* Upload */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="font-semibold text-gray-900 mb-3">⬆️ Wgraj plik</h2>
            <div
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
              className="border-2 border-dashed border-gray-300 rounded-xl p-10 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/30 transition">
              <p className="text-4xl mb-3">📂</p>
              <p className="text-sm font-medium text-gray-700">Kliknij lub przeciągnij plik tutaj</p>
              <p className="text-xs text-gray-400 mt-1">Obsługiwane formaty: .xlsx, .xls, .csv</p>
              {fileName && <p className="text-xs text-blue-600 mt-2 font-medium">✓ {fileName}</p>}
            </div>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
          </div>

          {/* Podgląd */}
          {step === 'preview' && (
            <div className="space-y-4">
              {/* Podsumowanie */}
              <div className={`rounded-xl border p-4 ${totalErrors > 0 ? 'bg-amber-50 border-amber-200' : 'bg-green-50 border-green-200'}`}>
                <div className="flex items-center justify-between">
                  <div>
                    <p className={`font-semibold ${totalErrors > 0 ? 'text-amber-800' : 'text-green-800'}`}>
                      {totalErrors > 0 ? `⚠️ Znaleziono ${totalErrors} błęd${totalErrors === 1 ? '' : totalErrors < 5 ? 'y' : 'ów'} w danych` : '✅ Dane wyglądają poprawnie'}
                    </p>
                    <p className="text-sm mt-0.5 text-gray-600">
                      Gotowe do importu: <strong>{validCount}</strong> rekordów
                      ({units.filter(u => u.errors.length === 0).length} lokali,{' '}
                      {residents.filter(r => r.errors.length === 0).length} mieszkańców)
                      {totalErrors > 0 && ` · Pominięte (błędy): ${totalErrors}`}
                    </p>
                  </div>
                  <button onClick={handleImport} disabled={validCount === 0}
                    className="bg-blue-600 text-white text-sm font-medium px-5 py-2.5 rounded-lg hover:bg-blue-700 disabled:opacity-40 transition flex-shrink-0">
                    ✅ Importuj {validCount} rekordów
                  </button>
                </div>
              </div>

              {/* Tabela lokali */}
              {units.length > 0 && (
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
                    <h3 className="font-semibold text-gray-800">🏠 Lokale ({units.length})</h3>
                    <span className="text-xs text-gray-400">z arkusza „Lokale"</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                        <tr>
                          <th className="px-4 py-2 text-left">Wiersz</th>
                          <th className="px-4 py-2 text-left">Numer</th>
                          <th className="px-4 py-2 text-left">Piętro</th>
                          <th className="px-4 py-2 text-left">Typ</th>
                          <th className="px-4 py-2 text-left">Pow. m²</th>
                          <th className="px-4 py-2 text-left">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {units.map((u) => (
                          <tr key={u._row} className={u.errors.length > 0 ? 'bg-red-50' : ''}>
                            <td className="px-4 py-2 text-gray-400 text-xs">{u._row}</td>
                            <td className="px-4 py-2 font-medium text-gray-900">{u.numer || <span className="text-red-400 italic">brak</span>}</td>
                            <td className="px-4 py-2 text-gray-600">{u.pietro ?? '—'}</td>
                            <td className="px-4 py-2 text-gray-600">{u.typ || <span className="text-red-400 italic">brak</span>}</td>
                            <td className="px-4 py-2 text-gray-600">{u.powierzchnia ?? '—'}</td>
                            <td className="px-4 py-2">
                              {u.errors.length === 0
                                ? <span className="text-green-600 text-xs">✓ OK</span>
                                : <span className="text-red-600 text-xs">✗ {u.errors.join(', ')}</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Tabela mieszkańców */}
              {residents.length > 0 && (
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
                    <h3 className="font-semibold text-gray-800">👤 Mieszkańcy ({residents.length})</h3>
                    <span className="text-xs text-gray-400">z arkusza „Mieszkańcy"</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                        <tr>
                          <th className="px-4 py-2 text-left">Wiersz</th>
                          <th className="px-4 py-2 text-left">Imię i nazwisko</th>
                          <th className="px-4 py-2 text-left">Email</th>
                          <th className="px-4 py-2 text-left">Telefon</th>
                          <th className="px-4 py-2 text-left">Lokal</th>
                          <th className="px-4 py-2 text-left">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {residents.map((r) => (
                          <tr key={r._row} className={r.errors.length > 0 ? 'bg-red-50' : ''}>
                            <td className="px-4 py-2 text-gray-400 text-xs">{r._row}</td>
                            <td className="px-4 py-2 font-medium text-gray-900">{r.imie} {r.nazwisko}</td>
                            <td className="px-4 py-2 text-gray-600 text-xs">{r.email}</td>
                            <td className="px-4 py-2 text-gray-600">{r.telefon ?? '—'}</td>
                            <td className="px-4 py-2 text-gray-600">{r.lokal ?? '—'}</td>
                            <td className="px-4 py-2">
                              {r.errors.length === 0
                                ? <span className="text-green-600 text-xs">✓ OK</span>
                                : <span className="text-red-600 text-xs">✗ {r.errors.join(', ')}</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── KROK 2: Import w toku ─────────────────────────────────────────── */}
      {step === 'importing' && (
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center space-y-4">
          <p className="text-4xl">⏳</p>
          <h2 className="font-semibold text-gray-900 text-lg">Importowanie danych…</h2>
          <div className="w-full bg-gray-100 rounded-full h-3 overflow-hidden">
            <div
              className="bg-blue-600 h-3 rounded-full transition-all duration-300"
              style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
            />
          </div>
          <p className="text-sm text-gray-500">
            {progress.done} / {progress.total} rekordów
            {progress.errors > 0 && <span className="text-red-500 ml-2">({progress.errors} błędów)</span>}
          </p>
        </div>
      )}

      {/* ── KROK 3: Wynik ────────────────────────────────────────────────── */}
      {step === 'done' && (
        <div className="space-y-4">
          <div className={`rounded-xl border p-5 ${progress.errors === 0 ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'}`}>
            <h2 className={`text-lg font-bold mb-1 ${progress.errors === 0 ? 'text-green-800' : 'text-amber-800'}`}>
              {progress.errors === 0 ? '✅ Import zakończony pomyślnie!' : '⚠️ Import zakończony z błędami'}
            </h2>
            <p className="text-sm text-gray-600">
              Zaimportowano <strong>{progress.done - progress.errors}</strong> rekordów,
              błędy: <strong>{progress.errors}</strong>
            </p>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100">
              <h3 className="font-semibold text-gray-800">📋 Dziennik importu</h3>
            </div>
            <div className="max-h-80 overflow-y-auto divide-y divide-gray-50">
              {log.map((entry, i) => (
                <div key={i} className={`px-5 py-2 text-sm flex items-center gap-2 ${entry.ok ? 'text-gray-700' : 'bg-red-50 text-red-700'}`}>
                  <span>{entry.ok ? '✓' : '✗'}</span>
                  <span>{entry.msg}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="flex gap-3">
            <Link href={`/buildings/${id}`}
              className="flex-1 text-center bg-blue-600 text-white text-sm font-medium py-2.5 rounded-lg hover:bg-blue-700 transition">
              ← Wróć do obiektu
            </Link>
            <button onClick={() => { setStep('upload'); setParsedUnits([]); setParsedResidents([]); setFileName('') }}
              className="flex-1 border border-gray-300 text-gray-700 text-sm font-medium py-2.5 rounded-lg hover:bg-gray-50 transition">
              Importuj kolejny plik
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
