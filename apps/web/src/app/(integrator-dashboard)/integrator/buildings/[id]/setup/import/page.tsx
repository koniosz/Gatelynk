'use client'
/**
 * PR-5 (2026-07-05) — Import mieszkańców z CSV (setup-hub).
 *
 * Flow: wybór pliku → FileReader (tekst po stronie klienta) →
 *   POST /integrator/buildings/:id/residents-import/dry-run  → podgląd
 *   POST /integrator/buildings/:id/residents-import/commit   → zapis
 *
 * Parser po stronie API jest tolerancyjny (średnik/przecinek/tab, BOM,
 * polskie nagłówki, cudzysłowy). Hasła NIE są ustawiane — konta aktywują
 * się przez zaproszenia (PR-6, strona obok).
 */
import { useCallback, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeft, Upload, CheckCircle2, AlertTriangle, XCircle,
  FileSpreadsheet, Users, Mail, ChevronRight,
} from 'lucide-react'
import { integratorApi } from '@/lib/integrator-api'
import { Spinner } from '@/components/integrator/property/shared/Spinner'

interface ImportRow {
  rowNumber: number
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
  unitNumber: string
  street: string | null
  status: 'create' | 'skip' | 'error'
  messages: string[]
  willCreateUnit: boolean
}

interface Preview {
  totalRows: number
  toCreate: number
  toSkip: number
  errors: number
  unitsToCreate: string[]
  unknownHeaders: string[]
  matchedColumns: string[]
  delimiter: string
  rows: ImportRow[]
}

interface CommitResult {
  createdResidents: number
  createdUnits: number
  skipped: number
  errors: number
  invitableCount: number
}

const EXAMPLE_CSV = `Imię;Nazwisko;Email;Telefon;Lokal;Ulica
Anna;Kowalska;anna.kowalska@example.com;600100200;1;Niewinna 4
Piotr;Nowak;piotr.nowak@example.com;600300400;2;Niewinna 4`

export default function ResidentsImportPage() {
  const { id } = useParams()
  const buildingId = id as string
  const fileInput = useRef<HTMLInputElement>(null)

  const [csvText, setCsvText] = useState<string | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [committed, setCommitted] = useState<CommitResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const runDryRun = useCallback(async (text: string) => {
    setBusy(true)
    setError(null)
    setCommitted(null)
    try {
      const res = await integratorApi.post<Preview>(
        `/integrator/buildings/${buildingId}/residents-import/dry-run`,
        { csv: text },
      )
      setPreview(res.data)
    } catch (err: any) {
      setPreview(null)
      setError(err?.response?.data?.message ?? err?.message ?? 'Błąd analizy pliku')
    } finally {
      setBusy(false)
    }
  }, [buildingId])

  const onFile = useCallback((file: File) => {
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result ?? '')
      setCsvText(text)
      runDryRun(text)
    }
    reader.onerror = () => setError('Nie udało się odczytać pliku')
    reader.readAsText(file, 'utf-8')
  }, [runDryRun])

  const commit = useCallback(async () => {
    if (!csvText) return
    setBusy(true)
    setError(null)
    try {
      const res = await integratorApi.post<CommitResult>(
        `/integrator/buildings/${buildingId}/residents-import/commit`,
        { csv: csvText },
      )
      setCommitted(res.data)
      setPreview(null)
    } catch (err: any) {
      setError(err?.response?.data?.message ?? err?.message ?? 'Błąd importu')
    } finally {
      setBusy(false)
    }
  }, [buildingId, csvText])

  return (
    <div className="max-w-4xl mx-auto">
      <Link
        href={`/integrator/buildings/${buildingId}/setup`}
        className="inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-ink mb-4 transition-colors"
      >
        <ArrowLeft size={13} /> Wróć do checklisty
      </Link>

      <div className="bg-surface border border-border rounded-r3 p-5 mb-5">
        <div className="flex items-center gap-2.5 mb-1">
          <FileSpreadsheet size={18} strokeWidth={1.8} className="text-brand" />
          <h1 className="text-[16px] font-semibold text-ink">Import mieszkańców (CSV)</h1>
        </div>
        <p className="text-[12px] text-muted">
          Kolumny: <strong>imię, nazwisko, lokal</strong> (wymagane) + e-mail, telefon, ulica
          (opcjonalne). Separator średnik lub przecinek, polskie nagłówki OK. Lokale, których
          nie ma w budynku, zostaną utworzone automatycznie. Hasła nie są ustawiane — konta
          aktywują się przez zaproszenia e-mail.
        </p>
        <details className="mt-2">
          <summary className="text-[11px] text-brand cursor-pointer">Przykładowy plik</summary>
          <pre className="text-[11px] bg-surface-2 rounded-r1 p-2.5 mt-1.5 overflow-x-auto text-ink-2">{EXAMPLE_CSV}</pre>
        </details>

        <div className="mt-4">
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv,text/plain"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onFile(f)
              e.target.value = ''
            }}
          />
          <button
            onClick={() => fileInput.current?.click()}
            disabled={busy}
            className="inline-flex items-center gap-2 text-[13px] font-medium text-white bg-brand hover:bg-brand-600 px-4 py-2 rounded-r2 transition-colors disabled:opacity-50"
          >
            <Upload size={14} strokeWidth={2} />
            {fileName ? 'Wybierz inny plik' : 'Wybierz plik CSV'}
          </button>
          {fileName && (
            <span className="ml-3 text-[12px] text-muted">{fileName}</span>
          )}
        </div>
      </div>

      {busy && (
        <div className="flex items-center gap-2 py-4 text-muted text-[13px]">
          <Spinner size={14} /> Przetwarzanie…
        </div>
      )}

      {error && (
        <div className="bg-danger-50 border border-danger/30 rounded-r3 p-4 mb-5 text-[13px] text-danger flex items-start gap-2">
          <XCircle size={15} strokeWidth={2} className="mt-0.5 flex-shrink-0" /> {error}
        </div>
      )}

      {committed && (
        <div className="bg-success-50 border border-success/30 rounded-r3 p-5 mb-5">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle2 size={16} strokeWidth={2} className="text-success" />
            <h2 className="text-[14px] font-semibold text-ink">Import zakończony</h2>
          </div>
          <p className="text-[13px] text-ink-2">
            Utworzono <strong>{committed.createdResidents}</strong> mieszkańców
            {committed.createdUnits > 0 && <> i <strong>{committed.createdUnits}</strong> lokali</>}
            {committed.skipped > 0 && <>, pominięto {committed.skipped} (duplikaty)</>}
            {committed.errors > 0 && <>, {committed.errors} wierszy z błędami</>}.
          </p>
          {committed.invitableCount > 0 && (
            <Link
              href={`/integrator/buildings/${buildingId}/setup/invitations`}
              className="inline-flex items-center gap-1.5 text-[13px] font-medium text-brand hover:text-brand-600 mt-3 transition-colors"
            >
              <Mail size={14} /> Wyślij zaproszenia do {committed.invitableCount} mieszkańców
              <ChevronRight size={14} />
            </Link>
          )}
        </div>
      )}

      {preview && (
        <>
          {/* Podsumowanie dry-run */}
          <div className="grid grid-cols-3 gap-3 mb-4">
            <StatCard label="Do utworzenia" value={preview.toCreate} tone="success" />
            <StatCard label="Pominięte (duplikaty)" value={preview.toSkip} tone="muted" />
            <StatCard label="Błędy" value={preview.errors} tone={preview.errors > 0 ? 'danger' : 'muted'} />
          </div>

          {preview.unitsToCreate.length > 0 && (
            <p className="text-[12px] text-muted mb-3">
              Nowe lokale ({preview.unitsToCreate.length}):{' '}
              <span className="text-ink-2">{preview.unitsToCreate.join(', ')}</span>
            </p>
          )}
          {preview.unknownHeaders.length > 0 && (
            <p className="text-[12px] text-warn mb-3 flex items-center gap-1.5">
              <AlertTriangle size={13} /> Nierozpoznane kolumny (pominięte): {preview.unknownHeaders.join(', ')}
            </p>
          )}

          {/* Tabela podglądu */}
          <div className="bg-surface border border-border rounded-r3 overflow-hidden mb-4">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-surface-2 text-muted text-left">
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Imię i nazwisko</th>
                  <th className="px-3 py-2 font-medium">E-mail</th>
                  <th className="px-3 py-2 font-medium">Lokal</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Uwagi</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.rowNumber} className="border-t border-border">
                    <td className="px-3 py-2 text-muted-2">{r.rowNumber}</td>
                    <td className="px-3 py-2 text-ink">{r.firstName} {r.lastName}</td>
                    <td className="px-3 py-2 text-ink-2">{r.email ?? <span className="text-muted-2">brak</span>}</td>
                    <td className="px-3 py-2 text-ink-2">
                      {r.unitNumber}{r.willCreateUnit && <span className="text-brand ml-1">(nowy)</span>}
                    </td>
                    <td className="px-3 py-2">
                      {r.status === 'create' ? (
                        <span className="text-success font-medium">utworzy</span>
                      ) : r.status === 'skip' ? (
                        <span className="text-muted">pominie</span>
                      ) : (
                        <span className="text-danger font-medium">błąd</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted">{r.messages.join(' · ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            onClick={commit}
            disabled={busy || preview.toCreate === 0}
            className="inline-flex items-center gap-2 text-[13px] font-semibold text-white bg-success hover:opacity-90 px-5 py-2.5 rounded-r2 transition-opacity disabled:opacity-50"
          >
            <Users size={15} strokeWidth={2} />
            Importuj {preview.toCreate} {preview.toCreate === 1 ? 'mieszkańca' : 'mieszkańców'}
          </button>
          {preview.errors > 0 && (
            <p className="text-[11px] text-muted mt-2">
              Wiersze z błędami zostaną pominięte — możesz poprawić plik i wgrać ponownie
              (import jest idempotentny, duplikaty nie powstaną).
            </p>
          )}
        </>
      )}
    </div>
  )
}

function StatCard({ label, value, tone }: { label: string; value: number; tone: 'success' | 'danger' | 'muted' }) {
  const color =
    tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-danger' : 'text-ink'
  return (
    <div className="bg-surface border border-border rounded-r3 p-3.5">
      <p className={`text-[20px] font-bold ${color}`}>{value}</p>
      <p className="text-[11px] text-muted">{label}</p>
    </div>
  )
}
