'use client'

import { useState } from 'react'
import type { AxiosInstance } from 'axios'

/**
 * Karta „Stacja domofonowa Akuvox" — przycisk eksportu listy mieszkańców do
 * `UserData.tgz` (import na domofonie) + opcjonalnie pełna ściąga konfiguracji
 * stacji pod aplikację (showConfig, panel Integratora).
 *
 * `api` = instancja axios (buildingAdminApi / integratorApi), `exportUrl` =
 * ścieżka endpointu zwracającego .tgz (np. /building-admin/buildings/9/akuvox-userdata.tgz).
 */
export function AkuvoxStationCard({
  api,
  exportUrl,
  showConfig = false,
  edgeIp = '192.168.1.127',
}: {
  api: AxiosInstance
  exportUrl: string
  showConfig?: boolean
  edgeIp?: string
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState(false)

  async function download() {
    setBusy(true)
    setErr(null)
    setOk(false)
    try {
      const res = await api.get(exportUrl, { responseType: 'blob' })
      const url = URL.createObjectURL(res.data as Blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'UserData.tgz'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      setOk(true)
    } catch (e: any) {
      setErr(e?.response?.data?.message || e?.message || 'Nie udało się wyeksportować listy')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-slate-800 dark:text-slate-100">
            🚪 Stacja domofonowa Akuvox
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Eksportuj listę mieszkańców do importu na domofonie (lista nazwisk +
            dzwonienie do konkretnego lokalu).
          </p>
        </div>
        <button
          onClick={download}
          disabled={busy}
          className="shrink-0 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {busy ? 'Generuję…' : 'Eksportuj listę (.tgz)'}
        </button>
      </div>

      {err && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{err}</p>}
      {ok && (
        <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">
          Pobrano <code>UserData.tgz</code> — zaimportuj na domofonie: <em>Directory → User → Import</em>.
        </p>
      )}

      <div className="mt-3 rounded-lg bg-slate-50 p-3 text-xs text-slate-500 dark:bg-slate-900/40 dark:text-slate-400">
        Import na domofonie: <strong>Directory → User → Import</strong> → wybierz pobrany{' '}
        <code>UserData.tgz</code>. Każdy lokal = jeden kontakt, numer wybierania = id lokalu
        (gość dotyka nazwiska, nie widzi numeru).
      </div>

      {showConfig && (
        <details className="mt-4 rounded-lg border border-slate-200 p-3 dark:border-slate-700" open>
          <summary className="cursor-pointer text-sm font-semibold text-slate-700 dark:text-slate-200">
            ⚙️ Pełna konfiguracja stacji Akuvox pod aplikację (E18C)
          </summary>
          <div className="mt-3 space-y-3 text-sm text-slate-600 dark:text-slate-300">
            <ConfigStep n={1} title="Konto SIP — rejestracja do mostka">
              <em>Account → Basic → SIP Account</em>: Account = Account1, <strong>Account Enabled ✓</strong>,
              Register Name / Username = <code>door</code>, Password = <code>door</code>.
            </ConfigStep>
            <ConfigStep n={2} title="Serwer SIP — port 5062 (NIE 5060!)">
              <em>Account → Basic → Preferred SIP Server</em>: Server Address = <code>{edgeIp}</code>,{' '}
              <strong>Sip Server Port = <code>5062</code></strong> (mostek GateLynk; status konta → „Registered").
            </ConfigStep>
            <ConfigStep n={3} title="Direct IP — dla fizycznego przycisku">
              <em>Intercom → Basic → Direct IP</em>: Enabled ✓, port 5060. Fizyczny przycisk dzwoni
              direct-IP do <code>{edgeIp}</code> = „dzwoń do wszystkich".
            </ConfigStep>
            <ConfigStep n={4} title="Lista mieszkańców — import">
              <em>Directory → User → Import</em> → wgraj <code>UserData.tgz</code> (przycisk wyżej).
              Pole <strong>Phone = id lokalu</strong> (numer wybierania → mostek → mieszkańcy tego lokalu).
            </ConfigStep>
            <ConfigStep n={5} title="Wyświetlanie listy gościowi">
              <em>Intercom → Basic → Tenants List</em>: „Show Tenants of Local Group" ✓ +
              „Click Tenants to Dial Out" ✓.
            </ConfigStep>
            <ConfigStep n={6} title="Otwieranie + PIN (jeśli używane)">
              Action URL klawiatury → <code>http://{edgeIp}:4000/akuvox/event</code> (walidacja PIN
              offline). OpenDoor: High Security Mode → endpoint <code>/fcgi/OpenDoor?action=OpenDoor&DoorNum=N</code>,
              digest API hasło <code>admin</code> (nie web-hasło).
            </ConfigStep>
            <p className="rounded bg-amber-50 p-2 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
              Wymaga działającego mostka na Edge: Janus (SIP↔WebRTC, :5060) + proxy SIP
              (rejestrator, :5062) + patch macOS connect() w janus_sip.c. Audio 2-way + dzwonienie
              punktowe potwierdzone na E18C.
            </p>
          </div>
        </details>
      )}
    </div>
  )
}

function ConfigStep({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
        {n}
      </span>
      <div>
        <div className="font-medium text-slate-700 dark:text-slate-200">{title}</div>
        <div className="mt-0.5 text-xs leading-relaxed">{children}</div>
      </div>
    </div>
  )
}
