'use client'
/**
 * Baza wiedzy budynku — panel Building Admin do wgrywania repozytoriów
 * dla LLM RAG (uchwały, regulaminy, chat z Messengera, kontakty serwisowe).
 *
 * Każdy dokument wgrany przez ten panel:
 *  1. Trafia do Cloud (Postgres) z metadata + parsedText
 *  2. Syncuje się przez tunnel do Edge (KNOWLEDGE_UPSERT)
 *  3. Edge chunkuje (~800 znaków, 150 overlap) i embeduje (bge-m3, 1024-dim)
 *  4. LLM dostaje tool `search_knowledge(query)` → semantic search
 *
 * UI:
 *  - Type tabs (Wszystko / Messenger / Uchwały / Regulaminy / Kontakty / Inne)
 *  - Upload area — drag-drop JSON / text input
 *  - Lista doc-ów z preview + delete
 *  - Modal "Dodaj manual" dla UCHWALA/REGULAMIN/KONTAKT/INNE (textarea)
 */
import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { buildingAdminApi } from '@/lib/building-admin-api'

type KnowledgeType = 'MESSENGER_CHAT' | 'UCHWALA' | 'REGULAMIN' | 'KONTAKT' | 'INNE'

interface KnowledgeDoc {
  id: number
  type: KnowledgeType
  title: string
  metadata: any
  fileExt: string | null
  fileSizeB: number | null
  uploadedAt: string
  preview: string
}

const TYPE_LABELS: Record<KnowledgeType | 'ALL', { label: string; icon: string; color: string }> = {
  ALL:            { label: 'Wszystko',    icon: '📚', color: 'bg-gray-100 text-gray-700' },
  MESSENGER_CHAT: { label: 'Messenger',   icon: '💬', color: 'bg-blue-50 text-blue-700' },
  UCHWALA:        { label: 'Uchwały',     icon: '📜', color: 'bg-amber-50 text-amber-700' },
  REGULAMIN:      { label: 'Regulaminy',  icon: '📋', color: 'bg-purple-50 text-purple-700' },
  KONTAKT:        { label: 'Kontakty',    icon: '📞', color: 'bg-emerald-50 text-emerald-700' },
  INNE:           { label: 'Inne',        icon: '📎', color: 'bg-slate-50 text-slate-700' },
}

function formatBytes(b: number | null): string {
  if (!b) return '—'
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} kB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('pl-PL', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

export default function BuildingKnowledgePage() {
  const params = useParams()
  const buildingId = Number(params.id)

  const [docs, setDocs] = useState<KnowledgeDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeType, setActiveType] = useState<KnowledgeType | 'ALL'>('ALL')

  const [uploadModal, setUploadModal] = useState<KnowledgeType | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadMsg, setUploadMsg] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    buildingAdminApi
      .get<KnowledgeDoc[]>(`/building-admin/buildings/${buildingId}/knowledge`)
      .then((r) => setDocs(r.data))
      .catch((e) => setError(e.response?.data?.message ?? 'Błąd ładowania bazy wiedzy'))
      .finally(() => setLoading(false))
  }, [buildingId])

  useEffect(() => { load() }, [load])

  const filtered = activeType === 'ALL' ? docs : docs.filter((d) => d.type === activeType)
  const countsByType = docs.reduce<Record<string, number>>((acc, d) => {
    acc[d.type] = (acc[d.type] ?? 0) + 1
    return acc
  }, {})

  const handleDelete = async (docId: number) => {
    if (!confirm('Usunąć dokument? Edge usunie go z indeksu LLM.')) return
    try {
      await buildingAdminApi.delete(`/building-admin/buildings/${buildingId}/knowledge/${docId}`)
      setDocs((prev) => prev.filter((d) => d.id !== docId))
    } catch (e: any) {
      alert(`Błąd: ${e.response?.data?.message ?? e.message}`)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto p-6">
        <div className="mb-6 flex items-center justify-between gap-4">
          <div>
            <Link href={`/building-admin/buildings/${buildingId}`} className="text-sm text-gray-400 hover:text-gray-600">
              ← Wróć do budynku
            </Link>
            <h1 className="text-2xl font-semibold text-gray-900 mt-1">📚 Baza wiedzy budynku</h1>
            <p className="text-sm text-gray-600 mt-1">
              Dokumenty z których LLM Asystent czerpie wiedzę — uchwały, regulaminy, chat mieszkańców, kontakty.
              Wszystko indeksowane semantycznie (bge-m3) na Edge.
            </p>
          </div>
        </div>

        {/* Type tabs */}
        <div className="flex flex-wrap gap-2 mb-6">
          {(Object.keys(TYPE_LABELS) as Array<keyof typeof TYPE_LABELS>).map((t) => {
            const meta = TYPE_LABELS[t]
            const count = t === 'ALL' ? docs.length : countsByType[t] ?? 0
            const isActive = activeType === t
            return (
              <button
                key={t}
                onClick={() => setActiveType(t as KnowledgeType | 'ALL')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                  isActive
                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                    : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
                }`}
              >
                <span>{meta.icon}</span>
                <span>{meta.label}</span>
                <span className={`text-xs px-1.5 py-0.5 rounded ${isActive ? 'bg-blue-100' : 'bg-gray-100'}`}>
                  {count}
                </span>
              </button>
            )
          })}
        </div>

        {/* Upload buttons row */}
        <div className="flex flex-wrap gap-2 mb-6">
          <button
            onClick={() => setUploadModal('MESSENGER_CHAT')}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
          >
            💬 Wgraj Messenger
          </button>
          <button
            onClick={() => setUploadModal('UCHWALA')}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700"
          >
            📜 Dodaj uchwałę
          </button>
          <button
            onClick={() => setUploadModal('REGULAMIN')}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-purple-600 text-white text-sm font-medium hover:bg-purple-700"
          >
            📋 Dodaj regulamin
          </button>
          <button
            onClick={() => setUploadModal('KONTAKT')}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700"
          >
            📞 Dodaj kontakt
          </button>
          <button
            onClick={() => setUploadModal('INNE')}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-600 text-white text-sm font-medium hover:bg-slate-700"
          >
            📎 Inne
          </button>
        </div>

        {/* Loading / error */}
        {loading && (
          <div className="bg-white border border-gray-200 rounded-xl p-6 text-center text-sm text-gray-500">
            Ładowanie…
          </div>
        )}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">{error}</div>
        )}

        {/* Empty state */}
        {!loading && !error && filtered.length === 0 && (
          <div className="bg-white border border-dashed border-gray-300 rounded-xl p-12 text-center">
            <div className="text-4xl mb-3">📚</div>
            <p className="text-sm text-gray-600 mb-1">Brak dokumentów {activeType !== 'ALL' ? `typu ${TYPE_LABELS[activeType].label}` : ''}</p>
            <p className="text-xs text-gray-500">Użyj przycisków powyżej aby wgrać pierwsze repozytorium.</p>
          </div>
        )}

        {/* Doc list */}
        {!loading && filtered.length > 0 && (
          <div className="space-y-3">
            {filtered.map((d) => {
              const meta = TYPE_LABELS[d.type]
              return (
                <div key={d.id} className="bg-white border border-gray-200 rounded-xl p-4 hover:shadow-sm transition-shadow">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${meta.color}`}>
                          {meta.icon} {meta.label}
                        </span>
                        <span className="text-xs text-gray-400">
                          {formatDate(d.uploadedAt)} • {formatBytes(d.fileSizeB)}
                          {d.fileExt && <span> • .{d.fileExt}</span>}
                        </span>
                      </div>
                      <h3 className="font-semibold text-gray-900 truncate">{d.title}</h3>
                      <p className="text-sm text-gray-600 mt-1 line-clamp-2">{d.preview}</p>
                      {d.metadata?.participants && (
                        <p className="text-xs text-gray-500 mt-1">
                          Uczestnicy: {(d.metadata.participants as string[]).slice(0, 3).join(', ')}
                          {(d.metadata.participants as string[]).length > 3
                            ? ` +${(d.metadata.participants as string[]).length - 3}`
                            : ''}
                          {d.metadata?.messageCount ? ` • ${d.metadata.messageCount} wiadomości` : ''}
                        </p>
                      )}
                    </div>
                    <button
                      onClick={() => handleDelete(d.id)}
                      className="text-sm text-red-600 hover:text-red-700 hover:bg-red-50 px-2 py-1 rounded shrink-0"
                      title="Usuń (Edge zaktualizuje indeks)"
                    >
                      🗑
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Upload modal */}
      {uploadModal && (
        <UploadModal
          type={uploadModal}
          buildingId={buildingId}
          onClose={() => { setUploadModal(null); setUploadMsg(null) }}
          onUploaded={(msg) => {
            setUploadMsg(msg)
            setUploadModal(null)
            load()
            setTimeout(() => setUploadMsg(null), 5000)
          }}
        />
      )}

      {uploadMsg && (
        <div className="fixed bottom-6 right-6 bg-green-600 text-white px-4 py-3 rounded-lg shadow-lg text-sm z-50">
          ✓ {uploadMsg}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// UploadModal — różne typy upload formy w jednym modal.
// ─────────────────────────────────────────────────────────────────────────────

function UploadModal({
  type, buildingId, onClose, onUploaded,
}: {
  type: KnowledgeType
  buildingId: number
  onClose: () => void
  onUploaded: (msg: string) => void
}) {
  const meta = TYPE_LABELS[type]
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Messenger: drag-drop JSON files
  const [jsonFiles, setJsonFiles] = useState<File[]>([])
  const [chatTitle, setChatTitle] = useState('')

  // Text-based: title + content
  const [textTitle, setTextTitle] = useState('')
  const [textContent, setTextContent] = useState('')
  const [contactMetadata, setContactMetadata] = useState({ role: '', phone: '', email: '', hours: '' })

  const handleSubmit = async () => {
    setSubmitting(true)
    setErr(null)
    try {
      if (type === 'MESSENGER_CHAT') {
        if (jsonFiles.length === 0) throw new Error('Wgraj przynajmniej 1 plik JSON')
        const contents = await Promise.all(jsonFiles.map((f) => f.text()))
        await buildingAdminApi.post(`/building-admin/buildings/${buildingId}/knowledge/messenger`, {
          title: chatTitle.trim() || undefined,
          rawJsonFiles: contents,
        })
        onUploaded(`Messenger chat zapisany (${jsonFiles.length} plik${jsonFiles.length === 1 ? '' : 'i'})`)
      } else {
        if (!textTitle.trim()) throw new Error('Wymagany tytuł')
        if (!textContent.trim()) throw new Error('Wymagana treść')
        const metadata = type === 'KONTAKT' ? contactMetadata : undefined
        await buildingAdminApi.post(`/building-admin/buildings/${buildingId}/knowledge/text`, {
          type,
          title: textTitle.trim(),
          content: textContent.trim(),
          metadata,
        })
        onUploaded(`${meta.label} dodany`)
      }
    } catch (e: any) {
      setErr(e.response?.data?.message ?? e.message ?? 'Błąd zapisu')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span>{meta.icon}</span>
            <span>Dodaj: {meta.label}</span>
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">×</button>
        </header>

        <div className="p-6 overflow-y-auto flex-1">
          {err && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{err}</div>
          )}

          {type === 'MESSENGER_CHAT' && (
            <MessengerUploadForm
              files={jsonFiles}
              onFiles={setJsonFiles}
              title={chatTitle}
              onTitle={setChatTitle}
            />
          )}

          {type !== 'MESSENGER_CHAT' && (
            <TextUploadForm
              type={type}
              title={textTitle}
              onTitle={setTextTitle}
              content={textContent}
              onContent={setTextContent}
              contactMetadata={contactMetadata}
              onContactMetadata={setContactMetadata}
              buildingId={buildingId}
              onUploaded={(msg) => onUploaded(msg)}
            />
          )}
        </div>

        <footer className="px-6 py-4 border-t border-gray-200 flex items-center justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">
            Anuluj
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Zapisuję…' : 'Zapisz i syncuj do Edge'}
          </button>
        </footer>
      </div>
    </div>
  )
}

function MessengerUploadForm({
  files, onFiles, title, onTitle,
}: {
  files: File[]
  onFiles: (f: File[]) => void
  title: string
  onTitle: (s: string) => void
}) {
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    const dropped = Array.from(e.dataTransfer.files).filter((f) => f.name.endsWith('.json'))
    onFiles(dropped)
  }
  return (
    <div>
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-1">Tytuł rozmowy (opcjonalny)</label>
        <input
          type="text"
          value={title}
          onChange={(e) => onTitle(e.target.value)}
          placeholder="Np. Sąsiedzi Niewinna (override domyślnego z exportu)"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
        />
      </div>

      <label className="block text-sm font-medium text-gray-700 mb-2">Pliki Messenger JSON</label>
      <div
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
        className="border-2 border-dashed border-gray-300 rounded-xl p-6 text-center hover:border-blue-400 transition-colors"
      >
        <div className="text-3xl mb-2">📂</div>
        <p className="text-sm text-gray-600 mb-2">
          Przeciągnij <code>message_1.json</code> (i opcjonalnie message_2.json...) z eksportu FB
        </p>
        <input
          type="file"
          accept=".json"
          multiple
          onChange={(e) => onFiles(Array.from(e.target.files ?? []))}
          className="hidden"
          id="fb-files"
        />
        <label htmlFor="fb-files" className="inline-block text-sm text-blue-600 hover:text-blue-700 cursor-pointer underline">
          albo wybierz pliki
        </label>
      </div>

      {files.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {files.map((f, i) => (
            <li key={i} className="flex items-center justify-between p-2 bg-gray-50 rounded">
              <span>📄 {f.name}</span>
              <span className="text-xs text-gray-500">{formatBytes(f.size)}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-800 leading-relaxed">
        <strong>Jak pobrać:</strong> Facebook → Settings & privacy → Settings → Your information →
        Download your information → Select &quot;Messages&quot; → Format JSON. Wybierz konkretną rozmowę,
        ściągnij ZIP, znajdź <code>messages/inbox/&lt;rozmowa&gt;/message_1.json</code>.
      </div>
    </div>
  )
}

function TextUploadForm({
  type, title, onTitle, content, onContent, contactMetadata, onContactMetadata,
  buildingId, onUploaded,
}: {
  type: Exclude<KnowledgeType, 'MESSENGER_CHAT'>
  title: string
  onTitle: (s: string) => void
  content: string
  onContent: (s: string) => void
  contactMetadata: { role: string; phone: string; email: string; hours: string }
  onContactMetadata: (m: { role: string; phone: string; email: string; hours: string }) => void
  buildingId: number
  onUploaded: (msg: string) => void
}) {
  const supportsFile = type === 'UCHWALA' || type === 'REGULAMIN' || type === 'INNE'
  const [uploading, setUploading] = useState(false)
  const [fileErr, setFileErr] = useState<string | null>(null)

  const handleFileUpload = async (file: File) => {
    setUploading(true)
    setFileErr(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('type', type)
      if (title.trim()) fd.append('title', title.trim())
      const res = await buildingAdminApi.post(
        `/building-admin/buildings/${buildingId}/knowledge/file`,
        fd,
        { headers: { 'Content-Type': 'multipart/form-data' } },
      )
      onUploaded(`${res.data.title} (${res.data.charCount} znaków${res.data.pageCount ? `, ${res.data.pageCount} stron` : ''})`)
    } catch (e: any) {
      setFileErr(e.response?.data?.message ?? e.message ?? 'Błąd uploadu')
    } finally {
      setUploading(false)
    }
  }

  const placeholder = {
    UCHWALA: 'Treść uchwały — wklej tekst albo skopiuj z PDF/Word.\n\nPrzykład:\nUchwała nr 5/2024 z dnia 15.03.2024\n§ 1. Trzymanie zwierząt domowych w lokalach mieszkalnych...',
    REGULAMIN: 'Treść regulaminu (np. korzystania z części wspólnych, mieszkania, parkingu).',
    KONTAKT: 'Notatki o kontakcie — np. zakres usług, ceny, historia współpracy.',
    INNE: 'Dowolny tekst — notatki, instrukcje, polityki...',
  }[type]
  const titlePlaceholder = {
    UCHWALA: 'Np. Uchwała 5/2024 — zwierzęta domowe',
    REGULAMIN: 'Np. Regulamin korzystania z sauny',
    KONTAKT: 'Np. Hydraulik Pan Mietek',
    INNE: 'Krótki tytuł',
  }[type]

  return (
    <div>
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-1">Tytuł</label>
        <input
          type="text"
          value={title}
          onChange={(e) => onTitle(e.target.value)}
          placeholder={titlePlaceholder}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
        />
      </div>

      {supportsFile && (
        <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <p className="text-sm font-medium text-amber-900 mb-2">📎 Lub wgraj plik (PDF / DOCX / TXT / MD)</p>
          <input
            type="file"
            accept=".pdf,.docx,.txt,.md"
            disabled={uploading}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) handleFileUpload(f)
            }}
            className="text-sm"
          />
          {fileErr && <p className="text-xs text-red-700 mt-2">{fileErr}</p>}
          {uploading && <p className="text-xs text-amber-700 mt-2">Parsuję plik i wysyłam do Edge…</p>}
          <p className="text-xs text-amber-700 mt-1">
            Po wgraniu pomijasz textarea poniżej — Cloud parsuje plik na text.
          </p>
        </div>
      )}

      {type === 'KONTAKT' && (
        <div className="mb-4 grid grid-cols-2 gap-3">
          <input
            type="text"
            value={contactMetadata.role}
            onChange={(e) => onContactMetadata({ ...contactMetadata, role: e.target.value })}
            placeholder="Rola (hydraulik / sąsiad / administrator)"
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
          <input
            type="text"
            value={contactMetadata.phone}
            onChange={(e) => onContactMetadata({ ...contactMetadata, phone: e.target.value })}
            placeholder="Telefon"
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
          <input
            type="email"
            value={contactMetadata.email}
            onChange={(e) => onContactMetadata({ ...contactMetadata, email: e.target.value })}
            placeholder="Email"
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
          <input
            type="text"
            value={contactMetadata.hours}
            onChange={(e) => onContactMetadata({ ...contactMetadata, hours: e.target.value })}
            placeholder="Godziny (np. pon-pt 8-16)"
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Treść</label>
        <textarea
          value={content}
          onChange={(e) => onContent(e.target.value)}
          placeholder={placeholder}
          rows={12}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
        />
        <p className="text-xs text-gray-500 mt-1">
          {content.length} znaków • LLM otrzyma w embeddingu jako ~{Math.ceil(content.length / 800)} fragmentów (chunk).
        </p>
      </div>
    </div>
  )
}
