'use client'
/**
 * IntegratorAiEngineCard (FAZA 8.g — 2026-06-03).
 *
 * Konfiguracja AI Engine per budynek. AI Engine to zewnętrzny YOLO/Vision
 * service (typowo MacBook M1 w LAN-ie) z którym Edge gada przez HTTP.
 * Dotąd URL siedział w `process.env.YOLO_URL` — teraz pełnowartościowy
 * device, edytowalny z UI.
 *
 * Endpointy:
 *   GET   /integrator/buildings/:id/ai-engine
 *   PATCH /integrator/buildings/:id/ai-engine     { url, healthPath?, model?, enabled? }
 *   POST  /integrator/buildings/:id/ai-engine/test
 *
 * UX:
 *   1. Pole URL (np. http://192.168.1.109:8080) z walidacją.
 *   2. Pole healthPath (default /health).
 *   3. Select model (yolov8n / yolov8s / yolov8m / yolov11n / custom).
 *   4. Toggle "Włączony".
 *   5. Button "Testuj połączenie" → POST /test → frontend polluje GET co 2s
 *      przez 30s żeby zobaczyć fresh lastTest result.
 *   6. Last test widoczny jako "Ostatni test: X temu, OK 47ms".
 *   7. Save button → PATCH + auto-test.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { integratorApi } from '@/lib/integrator-api'

interface LastTest {
  at: string
  ok: boolean | null
  ms: number | null
  error: string | null
  statusCode: number | null
}

interface AiEngineConfig {
  configured: boolean
  buildingId: number
  url: string | null
  healthPath: string
  model: string
  enabled: boolean
  lastTest: LastTest | null
  // FAZA 8.h.7 (2026-06-08) — LLM (Ollama) summarizer
  llmUrl: string | null
  llmModel: string
  llmEnabled: boolean
  llmLastTest: LastTest | null
  llmAvailableModels: string[]
  createdAt?: string
  updatedAt?: string
}

const MODEL_PRESETS = ['yolov8n', 'yolov8s', 'yolov8m', 'yolov11n'] as const
// FAZA 8.h.7+ — popularne modele Ollama. Dropdown w UI, można też wpisać własny.
// Kolejność: dedykowane PL na górze (Bielik/PLLuM), potem Qwen3 (MoE, lepszy PL niż 2.5),
// multilingual flagship (Aya), dopiero potem general-purpose. Klient widzi
// rekomendacje od najlepszych dla polskiego output.
// Weryfikacja URL Ollama 2026-06-08:
//   ✓ SpeakLeash/bielik-11b-v2.3-instruct (Bielik, dedykowany PL)
//   ✓ qwen3, qwen3:30b-a3b (Qwen3, dobry PL)
//   ✓ aya-expanse (Cohere multilingual)
//   ✗ bielik:11b — nie ma w official library
//   ✗ pllum — nie ma w Ollama registry (jest tylko na HuggingFace)
const LLM_MODEL_PRESETS = [
  // 🇵🇱 Dedykowane polskiemu — najlepsze dla 1-zdaniowych PL summary.
  // UWAGA: Ollama wymaga jawnego tagu kwantyzacji `:Q4_K_M` (default Q4_K_M
  // dla tego modelu) — bez taga `ollama pull` zwraca "manifest unknown".
  'SpeakLeash/bielik-11b-v2.3-instruct:Q4_K_M',
  // 🆕 Qwen3 — MoE, znacząco lepszy PL niż qwen2.5
  'qwen3:30b-a3b',
  'qwen3:14b',
  'qwen3:32b',
  // 🌍 Multilingual flagship (Cohere) — dobry PL
  'aya-expanse:8b',
  'aya:35b',
  // 📦 General purpose (gorszy polski, ale szybsze/lżejsze)
  'qwen2.5:14b',
  'qwen2.5:7b',
  'qwen2.5:3b',
  'llama3.2:3b',
  'llama3.1:8b',
  'mistral:7b',
  'gemma2:9b',
  'phi3.5:3.8b',
] as const

interface Props {
  buildingId: number
}

export function IntegratorAiEngineCard({ buildingId }: Props) {
  const [data, setData] = useState<AiEngineConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)

  // Form state (lokalny, sync z `data` przy load)
  const [url, setUrl] = useState('')
  const [healthPath, setHealthPath] = useState('/health')
  const [model, setModel] = useState('yolov8n')
  const [customModel, setCustomModel] = useState('')
  const [enabled, setEnabled] = useState(true)
  // FAZA 8.h.7 — LLM form state
  const [llmUrl, setLlmUrl] = useState('')
  const [llmModel, setLlmModel] = useState('qwen2.5:14b')
  const [llmCustomModel, setLlmCustomModel] = useState('')
  const [llmEnabled, setLlmEnabled] = useState(true)
  // FAZA 8.h.8 — test LLM state
  const [llmTesting, setLlmTesting] = useState(false)
  const [llmTestMsg, setLlmTestMsg] = useState<string | null>(null)
  const llmPollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  // Polling refs
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollStopAt = useRef<number>(0)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await integratorApi.get(`/integrator/buildings/${buildingId}/ai-engine`)
      const payload = res.data as AiEngineConfig
      setData(payload)
      if (payload.configured) {
        setUrl(payload.url ?? '')
        setHealthPath(payload.healthPath ?? '/health')
        const m = payload.model ?? 'yolov8n'
        if ((MODEL_PRESETS as readonly string[]).includes(m)) {
          setModel(m)
          setCustomModel('')
        } else {
          setModel('__custom__')
          setCustomModel(m)
        }
        setEnabled(payload.enabled)
        // FAZA 8.h.7 — LLM fields
        setLlmUrl(payload.llmUrl ?? '')
        const lm = payload.llmModel ?? 'qwen2.5:14b'
        if ((LLM_MODEL_PRESETS as readonly string[]).includes(lm)) {
          setLlmModel(lm)
          setLlmCustomModel('')
        } else {
          setLlmModel('__custom__')
          setLlmCustomModel(lm)
        }
        setLlmEnabled(payload.llmEnabled !== false)
      }
    } catch (err: any) {
      if (!silent) {
        setError(err?.response?.data?.message ?? 'Błąd ładowania konfiguracji')
      }
    } finally {
      if (!silent) setLoading(false)
    }
  }, [buildingId])

  useEffect(() => {
    load()
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current)
      if (llmPollTimer.current) clearInterval(llmPollTimer.current)
    }
  }, [load])

  // FAZA 8.h.8 — wywołuje LLM_TEST przez Cloud, polluje GET aż llmLastTest.at != initial.
  const handleTestLlm = async () => {
    setLlmTestMsg(null)
    setLlmTesting(true)
    const initialAt = data?.llmLastTest?.at ?? null
    try {
      await integratorApi.post(`/integrator/buildings/${buildingId}/ai-engine/test-llm`, {
        urlOverride: llmUrl.trim() || undefined,
      })
      setLlmTestMsg('Testowanie LLM… (max 30s)')
      if (llmPollTimer.current) clearInterval(llmPollTimer.current)
      const stopAt = Date.now() + 30_000
      llmPollTimer.current = setInterval(async () => {
        if (Date.now() > stopAt) {
          if (llmPollTimer.current) { clearInterval(llmPollTimer.current); llmPollTimer.current = null }
          setLlmTesting(false)
          setLlmTestMsg('Timeout — sprawdź czy Edge online i Ollama działa')
          return
        }
        try {
          const res = await integratorApi.get(`/integrator/buildings/${buildingId}/ai-engine`)
          const fresh = res.data as AiEngineConfig
          if (fresh.llmLastTest && fresh.llmLastTest.at !== initialAt) {
            setData(fresh)
            if (llmPollTimer.current) { clearInterval(llmPollTimer.current); llmPollTimer.current = null }
            setLlmTesting(false)
            setLlmTestMsg(
              fresh.llmLastTest.ok
                ? `✓ OK ${fresh.llmLastTest.ms ?? '?'}ms — znaleziono ${fresh.llmAvailableModels.length} model(i)`
                : `✗ FAIL: ${fresh.llmLastTest.error ?? 'unknown'}`
            )
          }
        } catch { /* silent retry */ }
      }, 2_000)
    } catch (err: any) {
      setLlmTesting(false)
      setLlmTestMsg(err?.response?.data?.message ?? 'Błąd wysłania testu')
    }
  }

  const stopPolling = () => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current)
      pollTimer.current = null
    }
    setTesting(false)
  }

  const startPolling = (initialAt: string | null | undefined) => {
    if (pollTimer.current) clearInterval(pollTimer.current)
    pollStopAt.current = Date.now() + 30_000  // 30s max
    setTesting(true)
    pollTimer.current = setInterval(async () => {
      if (Date.now() > pollStopAt.current) {
        stopPolling()
        return
      }
      try {
        const res = await integratorApi.get(`/integrator/buildings/${buildingId}/ai-engine`)
        const fresh = res.data as AiEngineConfig
        setData(fresh)
        if (fresh.lastTest && fresh.lastTest.at !== initialAt) {
          stopPolling()
        }
      } catch {
        // silent — będziemy próbować dalej
      }
    }, 2_000)
  }

  const validateUrl = (s: string): string | null => {
    if (!s) return 'URL nie może być pusty'
    try {
      const u = new URL(s)
      if (!['http:', 'https:'].includes(u.protocol)) {
        return 'Wymagany protokół http:// lub https://'
      }
    } catch {
      return 'Nieprawidłowy format URL (np. http://192.168.1.109:8080)'
    }
    return null
  }

  const resolvedModel = model === '__custom__' ? customModel.trim() : model
  const resolvedLlmModel = llmModel === '__custom__' ? llmCustomModel.trim() : llmModel

  const handleSave = async () => {
    setError(null)
    setOk(null)
    const urlErr = validateUrl(url.trim())
    if (urlErr) { setError(urlErr); return }
    if (model === '__custom__' && !customModel.trim()) {
      setError('Wpisz nazwę modelu YOLO (np. yolov8m-custom)')
      return
    }
    if (llmModel === '__custom__' && !llmCustomModel.trim()) {
      setError('Wpisz nazwę modelu LLM (np. qwen2.5:32b)')
      return
    }
    // LLM URL — opcjonalny. Jeśli wpisany, musi być valid.
    const llmTrim = llmUrl.trim()
    if (llmTrim) {
      const llmErr = validateUrl(llmTrim)
      if (llmErr) { setError(`LLM URL: ${llmErr}`); return }
    }
    setSaving(true)
    try {
      await integratorApi.patch(`/integrator/buildings/${buildingId}/ai-engine`, {
        url: url.trim(),
        healthPath: healthPath.trim() || '/health',
        model: resolvedModel,
        enabled,
        // FAZA 8.h.7 — LLM (Ollama summarizer)
        llmUrl: llmTrim || null,
        llmModel: resolvedLlmModel,
        llmEnabled,
      })
      setOk('Konfiguracja zapisana — Edge zostanie zaktualizowany przez tunel.')
      await load(true)
      setTimeout(() => setOk(null), 4000)
    } catch (err: any) {
      setError(err?.response?.data?.message ?? 'Błąd zapisu')
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setError(null)
    setOk(null)
    setTesting(true)
    const initialAt = data?.lastTest?.at ?? null
    try {
      // Test bieżącego configu (bez override). Jeśli formularz ma niezapisane
      // zmiany, sugerujemy zapisać najpierw.
      await integratorApi.post(`/integrator/buildings/${buildingId}/ai-engine/test`, {})
      setOk('Test wysłany do Edge — czekamy na wynik…')
      startPolling(initialAt)
      // safety: po 30s wyłączymy spinner nawet bez wyniku.
      setTimeout(() => {
        if (pollTimer.current) stopPolling()
      }, 30_000)
    } catch (err: any) {
      setTesting(false)
      setError(err?.response?.data?.message ?? 'Błąd wysłania testu')
    }
  }

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="text-sm text-gray-400">Ładowanie konfiguracji AI Engine…</div>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-gray-800 flex items-center gap-2">
            🤖 AI Engine
            {!data?.configured && (
              <span className="text-[10px] font-normal text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
                Nieskonfigurowany
              </span>
            )}
            {data?.configured && data.enabled && (
              <span className="text-[10px] font-normal text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
                Aktywny
              </span>
            )}
            {data?.configured && !data.enabled && (
              <span className="text-[10px] font-normal text-gray-600 bg-gray-100 border border-gray-200 px-1.5 py-0.5 rounded">
                Wyłączony
              </span>
            )}
          </h2>
          <p className="text-xs text-gray-500 mt-1 max-w-2xl">
            Zewnętrzny silnik wizji (YOLO + EasyOCR) używany przez Edge do
            detekcji osób, marek kurierów, upadków i innych anomalii. Wymaga
            URL-a usługi w LAN (np. MacBook M1 z <code>yolo-vision</code>).
            Wyłączenie blokuje funkcje zależne (Vision dashboard, Wykrywanie
            upadków, Brand detection, OCR tablic).
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          {data?.lastTest && (
            <span
              className={
                'text-xs px-2 py-0.5 rounded border ' +
                (data.lastTest.ok
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : 'bg-rose-50 text-rose-700 border-rose-200')
              }
              title={data.lastTest.error ?? ''}
            >
              {data.lastTest.ok
                ? `OK ${data.lastTest.ms ?? '?'}ms`
                : `FAIL: ${data.lastTest.error ?? 'nieznany błąd'}`}
            </span>
          )}
          {data?.lastTest?.at && (
            <span className="text-[11px] text-gray-400">
              {formatLastTest(data.lastTest.at)}
            </span>
          )}
        </div>
      </div>

      <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            URL silnika
          </label>
          <input
            type="text"
            placeholder="http://192.168.1.109:8080"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={saving || testing}
            className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:bg-gray-50"
          />
          <p className="text-[11px] text-gray-400 mt-1">
            Bez końcowego <code>/</code>. Edge nie widzi sieci Internet — tylko LAN.
          </p>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Ścieżka health-check
          </label>
          <input
            type="text"
            placeholder="/health"
            value={healthPath}
            onChange={(e) => setHealthPath(e.target.value)}
            disabled={saving || testing}
            className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:bg-gray-50"
          />
          <p className="text-[11px] text-gray-400 mt-1">
            HTTP GET <code>{url || 'http://...'}{healthPath || '/health'}</code> przy
            "Testuj połączenie".
          </p>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Model
          </label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={saving || testing}
            className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:bg-gray-50"
          >
            {MODEL_PRESETS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
            <option value="__custom__">Inny (własna nazwa)…</option>
          </select>
          {model === '__custom__' && (
            <input
              type="text"
              placeholder="np. yolov8m-custom"
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              disabled={saving || testing}
              className="mt-2 w-full text-sm px-3 py-2 border border-gray-200 rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:bg-gray-50"
            />
          )}
          <p className="text-[11px] text-gray-400 mt-1">
            Informacyjnie — Edge nie weryfikuje, jaki model rzeczywiście działa po stronie usługi.
          </p>
        </div>

        <div className="flex items-end">
          <label className="inline-flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              disabled={saving || testing}
              className="w-4 h-4 accent-blue-600"
            />
            <span className="text-sm text-gray-800">Włączony</span>
          </label>
          <p className="text-[11px] text-gray-400 ml-3">
            Wyłączenie pozostawia konfigurację, ale Vision cycle skipuje detekcje.
          </p>
        </div>
      </div>

      {/* FAZA 8.h.7 (2026-06-08) — LLM Summarizer (Ollama) sekcja */}
      <div className="px-4 py-3 border-t border-gray-100 bg-gradient-to-br from-purple-50/40 to-pink-50/30">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-semibold text-sm text-purple-900 flex items-center gap-2">
            🧠 LLM Summarizer (Ollama)
          </h3>
          {data?.llmLastTest && (
            <div className="text-[11px] text-gray-500">
              Ostatni test:{' '}
              <span className={data.llmLastTest.ok ? 'text-emerald-600 font-medium' : 'text-rose-600 font-medium'}>
                {data.llmLastTest.ok ? `✓ OK ${data.llmLastTest.ms ?? '?'}ms` : `✗ ${data.llmLastTest.error ?? 'FAIL'}`}
              </span>
            </div>
          )}
        </div>
        <p className="text-[11px] text-gray-500 mb-3">
          Generuje krótkie opisy „co kamera wykryła" dla notable frames (1 zdanie PL).
          Niezależny od YOLO — można mieć YOLO ON + LLM OFF (np. oszczędność CPU).
        </p>
        <div className="grid grid-cols-12 gap-3">
          <div className="col-span-7">
            <label className="text-[11px] uppercase tracking-wide text-gray-500 font-medium">URL Ollama</label>
            <input
              type="text"
              placeholder="http://192.168.1.109:11434"
              value={llmUrl}
              onChange={(e) => setLlmUrl(e.target.value)}
              disabled={saving || testing}
              className="mt-1 w-full text-sm px-3 py-2 border border-gray-200 rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-purple-200 disabled:bg-gray-50"
            />
            <p className="text-[11px] text-gray-400 mt-1">
              Domyślny port Ollama: 11434. Puste pole = wyczyść (Edge fallback do env var).
            </p>
          </div>
          <div className="col-span-3">
            <label className="text-[11px] uppercase tracking-wide text-gray-500 font-medium">Model</label>
            <select
              value={llmModel}
              onChange={(e) => setLlmModel(e.target.value)}
              disabled={saving || testing}
              className="mt-1 w-full text-sm px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-200 disabled:bg-gray-50"
            >
              {/* Preset: ✓ gdy zainstalowane, ⚠ gdy trzeba pobrać */}
              {LLM_MODEL_PRESETS.map((m) => {
                const installed = data?.llmAvailableModels?.includes(m)
                const indicator = data?.llmAvailableModels?.length
                  ? (installed ? '✓ ' : '⚠ ')
                  : ''
                return (
                  <option key={m} value={m}>{indicator}{m}</option>
                )
              })}
              {/* Dodatkowo: zainstalowane modele które NIE są w presetach */}
              {data?.llmAvailableModels?.filter((m) => !(LLM_MODEL_PRESETS as readonly string[]).includes(m)).map((m) => (
                <option key={m} value={m}>✓ {m} (zainstalowane)</option>
              ))}
              <option value="__custom__">Inny…</option>
            </select>
            {llmModel === '__custom__' && (
              <input
                type="text"
                placeholder="np. qwen2.5:32b"
                value={llmCustomModel}
                onChange={(e) => setLlmCustomModel(e.target.value)}
                disabled={saving || testing}
                className="mt-2 w-full text-sm px-3 py-2 border border-gray-200 rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-purple-200 disabled:bg-gray-50"
              />
            )}
            <p className="text-[11px] text-gray-400 mt-1">
              {data?.llmAvailableModels?.length
                ? <>✓ = zainstalowane, ⚠ = trzeba pobrać (<code>ollama pull</code>)</>
                : <>Lista typowych. Kliknij „Sprawdź zainstalowane" żeby zobaczyć co masz pulled.</>}
            </p>
          </div>
          <div className="col-span-2 flex items-end pb-3">
            <label className="inline-flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={llmEnabled}
                onChange={(e) => setLlmEnabled(e.target.checked)}
                disabled={saving || testing}
                className="w-4 h-4 accent-purple-600"
              />
              <span className="text-sm text-gray-800">Włączony</span>
            </label>
          </div>
        </div>

        {/* FAZA 8.h.8 — "Sprawdź zainstalowane" + lista installed */}
        <div className="mt-3 flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={handleTestLlm}
            disabled={llmTesting || saving || testing}
            className="text-xs px-3 py-1.5 rounded-lg bg-purple-100 border border-purple-200 text-purple-800 hover:bg-purple-200 disabled:opacity-50 flex items-center gap-1.5"
          >
            {llmTesting ? <>⏳ Testuję LLM…</> : <>🔍 Sprawdź zainstalowane modele</>}
          </button>
          {llmTestMsg && (
            <span className={
              'text-xs ' +
              (llmTestMsg.startsWith('✓') ? 'text-emerald-700'
                : llmTestMsg.startsWith('✗') ? 'text-rose-700'
                : 'text-gray-500')
            }>
              {llmTestMsg}
            </span>
          )}
        </div>
        {data?.llmAvailableModels && data.llmAvailableModels.length > 0 && (
          <div className="mt-3 p-3 bg-white/60 border border-purple-100 rounded-lg">
            <div className="text-[11px] uppercase tracking-wide text-gray-500 font-medium mb-2">
              Zainstalowane w Ollama ({data.llmAvailableModels.length}) — klik = wybierz
            </div>
            <div className="flex flex-wrap gap-1.5">
              {data.llmAvailableModels.map((m) => {
                const isActive = (llmModel === '__custom__' ? llmCustomModel : llmModel) === m
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      if ((LLM_MODEL_PRESETS as readonly string[]).includes(m)) {
                        setLlmModel(m)
                        setLlmCustomModel('')
                      } else {
                        setLlmModel('__custom__')
                        setLlmCustomModel(m)
                      }
                    }}
                    className={
                      'text-xs px-2 py-1 rounded font-mono border ' +
                      (isActive
                        ? 'bg-purple-600 text-white border-purple-700'
                        : 'bg-purple-50 text-purple-900 border-purple-200 hover:bg-purple-100')
                    }
                  >
                    {m}
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="mx-4 mb-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs px-3 py-2 rounded">
          {error}
        </div>
      )}
      {ok && (
        <div className="mx-4 mb-3 bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs px-3 py-2 rounded">
          {ok}
        </div>
      )}

      <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between gap-3">
        <div className="text-[11px] text-gray-400">
          {data?.configured ? (
            <>Zmiany są wysyłane do Edge przez tunel (z fallback-iem outbox gdy offline).</>
          ) : (
            <>Po pierwszym zapisie zostanie wysłany pierwszy <code>AI_ENGINE_CONFIG_UPDATE</code>.</>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleTest}
            disabled={saving || testing || !data?.configured}
            className="text-sm px-3 py-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {testing ? (
              <>
                <span className="inline-block w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                Testuję…
              </>
            ) : (
              <>🔍 Testuj połączenie</>
            )}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || testing}
            className="text-sm px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Zapisywanie…' : (data?.configured ? 'Zapisz zmiany' : 'Utwórz konfigurację')}
          </button>
        </div>
      </div>
    </div>
  )
}

function formatLastTest(iso: string): string {
  const d = new Date(iso)
  const diffSec = Math.floor((Date.now() - d.getTime()) / 1000)
  if (diffSec < 0)     return 'za chwilę'
  if (diffSec < 5)     return 'przed chwilą'
  if (diffSec < 60)    return `${diffSec} sek temu`
  if (diffSec < 3600)  return `${Math.floor(diffSec / 60)} min temu`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} h temu`
  return d.toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}
