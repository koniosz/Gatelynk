/**
 * Settings tab — 5 sub-kart: Sieć / Chmura / Firmware / Bezpieczeństwo / Konserwacja.
 *
 * Z handoff doc sek. 5:
 *   • Sieć: tryb statyczny/DHCP, IP/maska/bramka/DNS
 *   • Chmura: status połączenia + endpoint + token (masked)
 *   • Firmware: aktualna wersja + check for updates + manual upload .img
 *   • Bezpieczeństwo: 2FA toggle, LAN-only, SSH, API rotation
 *   • Konserwacja: restart nocny, backup, auto-update; bottom: Restart edge
 *     (danger), Factory reset (danger)
 *
 * Większość ustawień obecnie read-only / stub — działania destrukcyjne
 * (Restart, Factory reset) wymagają auth challenge (sek. 9 doc), więc na razie
 * tylko confirm modal + toast. Pełna implementacja Settings backend = E-6 lub
 * osobna faza gdy realny use case.
 */
import { useEffect, useState } from 'react'
import {
  Network as NetworkIcon, Cloud, Cpu, ShieldCheck, Wrench,
  Check, AlertTriangle, RotateCw, Power, Trash2,
  Download, Upload, KeyRound, ChevronDown, ChevronRight, X as XIcon,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useSystemInfo } from '../lib/useMetrics'
import { api } from '../lib/api'
import { useTranslation } from '../i18n'

type SubtabId = 'network' | 'cloud' | 'firmware' | 'security' | 'maintenance'

interface Subtab {
  id: SubtabId
  labelKey: string
  icon: LucideIcon
}

const SUBTABS: Subtab[] = [
  { id: 'network',     labelKey: 'settings.tabs.network',     icon: NetworkIcon },
  { id: 'cloud',       labelKey: 'settings.tabs.cloud',       icon: Cloud },
  { id: 'firmware',    labelKey: 'settings.tabs.firmware',    icon: Cpu },
  { id: 'security',    labelKey: 'settings.tabs.security',    icon: ShieldCheck },
  { id: 'maintenance', labelKey: 'settings.tabs.maintenance', icon: Wrench },
]

export function SettingsPage() {
  const [active, setActive] = useState<SubtabId>('network')
  const { t } = useTranslation()

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: 'var(--ink)', margin: 0 }}>
          {t('settings.title')}
        </h1>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
          {t('settings.subtitle')}
        </p>
      </div>

      {/* Sub-tabs bar */}
      <div style={{
        display: 'flex',
        gap: 4,
        marginBottom: 24,
        borderBottom: '1px solid var(--border)',
      }}>
        {SUBTABS.map((tab) => {
          const Icon = tab.icon
          const isActive = active === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => setActive(tab.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '10px 16px',
                background: 'transparent',
                border: 'none',
                borderBottom: '2px solid',
                borderColor: isActive ? 'var(--blue)' : 'transparent',
                color: isActive ? 'var(--blue)' : 'var(--muted)',
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
                marginBottom: -1,
                transition: 'color 80ms, border-color 80ms',
              }}
            >
              <Icon size={14} strokeWidth={1.8} />
              {t(tab.labelKey)}
            </button>
          )
        })}
      </div>

      {active === 'network'     && <NetworkPanel />}
      {active === 'cloud'       && <CloudPanel />}
      {active === 'firmware'    && <FirmwarePanel />}
      {active === 'security'    && <SecurityPanel />}
      {active === 'maintenance' && <MaintenancePanel />}
    </div>
  )
}

// ── Subpanels ──────────────────────────────────────────────────────────────

function NetworkPanel() {
  const { data } = useSystemInfo()
  const { t } = useTranslation()
  return (
    <Section title={t('settings.network.section.title')} hint={t('settings.network.section.hint')}>
      <KV label={t('settings.network.mode')}>
        <Pill color="green">{t('settings.network.dhcp')}</Pill>
      </KV>
      <KV label={t('settings.network.ip')}>
        <span className="mono">{data?.ip ?? '—'}</span>
      </KV>
      <KV label={t('settings.network.mac')}>
        <span className="mono">{data?.mac ?? '—'}</span>
      </KV>
      <KV label={t('settings.network.hostname')}>
        <span className="mono">{data?.hostname ?? '—'}</span>
      </KV>
      <KV label={t('settings.network.link')}>
        <span style={{ color: 'var(--green)' }}>
          ↑↓ {data?.lan.linkMbps ?? '—'} Mbps · {data?.lan.state}
        </span>
      </KV>
      <Hint>{t('settings.network.footer')}</Hint>
    </Section>
  )
}

function CloudPanel() {
  const { data, refresh } = useSystemInfo()
  const { t } = useTranslation()
  const connected = data?.cloud === 'connected'
  const activated = data?.activated === true

  return (
    <Section title={t('settings.cloud.section.title')} hint={t('settings.cloud.section.hint')}>
      {activated ? (
        <ActivatedView
          data={data}
          connected={connected}
          onDeactivated={refresh}
        />
      ) : (
        <ActivationForm onActivated={refresh} />
      )}

      {/* Cloud URL override — zawsze widoczne (collapsed) bo przydatne PRZED
          aktywacją (staging) i PO aktywacji (zmiana wskazania). */}
      <CloudUrlAdvanced />

      <Hint>{t('settings.cloud.footer')}</Hint>
    </Section>
  )
}

function ActivatedView({ data, connected, onDeactivated }: {
  data: ReturnType<typeof useSystemInfo>['data']
  connected: boolean
  onDeactivated: () => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const handleDeactivate = async () => {
    if (!confirm(t('settings.cloud.deactivate.confirm'))) return
    setBusy(true)
    try {
      await api.deactivate()
      setToast(t('settings.cloud.deactivate.success'))
      onDeactivated()
    } catch (err: any) {
      setToast(`✗ ${err.message}`)
    } finally {
      setBusy(false)
      setTimeout(() => setToast(null), 4000)
    }
  }

  return (
    <>
      <KV label={t('settings.cloud.status')}>
        <Pill color={connected ? 'green' : 'red'}>
          {connected ? <Check size={12} /> : <AlertTriangle size={12} />}
          {connected ? t('common.connected') : t('common.disconnected')}
        </Pill>
      </KV>
      <KV label={t('settings.cloud.endpoint')}>
        <span className="mono">wss://api.gatelynk.com/api/edge/tunnel</span>
      </KV>
      <KV label={t('settings.cloud.building')}>
        <span className="mono">{data?.buildingId ?? '—'}</span>
      </KV>
      <KV label={t('settings.cloud.device')}>
        <span className="mono" style={{ fontSize: 11 }}>{data?.deviceId ?? '—'}</span>
      </KV>
      <KV label={t('settings.cloud.token')}>
        <span className="mono" style={{ color: 'var(--muted)' }}>{t('settings.cloud.token.set')}</span>
      </KV>

      {/* Deactivate — wisi tuż pod KV, bo to akcja per-aktywacja. Jest danger
          ale nie aż tak jak factory reset (zachowuje devices, plates, cache —
          tylko czyści token). */}
      <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
        <button
          className="btn btn-danger"
          onClick={handleDeactivate}
          disabled={busy}
        >
          {busy ? <RotateCw size={14} className="spin" /> : <XIcon size={14} />}
          {t('settings.cloud.deactivate.btn')}
        </button>
      </div>

      {toast && (
        <div style={{
          marginTop: 12,
          padding: 8,
          background: toast.startsWith('✗') ? 'var(--red-50)' : 'var(--green-50)',
          color: toast.startsWith('✗') ? 'var(--red)' : 'var(--green)',
          border: `1px solid ${toast.startsWith('✗') ? 'var(--red)' : 'var(--green)'}`,
          borderRadius: 'var(--r-2)',
          fontSize: 12,
        }}>
          {toast}
        </div>
      )}
    </>
  )
}

function ActivationForm({ onActivated }: { onActivated: () => void }) {
  const { t } = useTranslation()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)

  // Wczytuj cloudUrl wczesnie — wyświetlamy go obok pola code, żeby user
  // od razu widział do jakiej domeny activate poleci. Jeśli to nie produkcyjny
  // `api.gatelynk.com` — pokazujemy warning + przycisk fix-it w jednym kliknięciu.
  const [cloudUrl, setCloudUrl] = useState<string | null>(null)
  const [fixingUrl, setFixingUrl] = useState(false)
  useEffect(() => {
    let cancelled = false
    api.getActivationConfig()
      .then((cfg) => { if (!cancelled) setCloudUrl(cfg.cloudUrl) })
      .catch(() => { /* ignore — non-critical */ })
    return () => { cancelled = true }
  }, [])

  const PROD_URL = 'https://api.gatelynk.com'
  const cloudUrlWrong = cloudUrl !== null && cloudUrl !== PROD_URL

  const handleFixCloudUrl = async () => {
    setFixingUrl(true)
    try {
      await api.setCloudUrl(PROD_URL)
      setCloudUrl(PROD_URL)
    } catch (err: any) {
      setResult({ ok: false, msg: `Cloud URL: ${err.message}` })
    } finally {
      setFixingUrl(false)
    }
  }

  const trimmed = code.trim()
  const canSubmit = trimmed.length >= 3 && !busy

  const handleActivate = async () => {
    if (!canSubmit) return
    setBusy(true)
    setResult(null)
    try {
      const res = await api.activate(trimmed)
      if (res.success) {
        setResult({ ok: true, msg: t('settings.cloud.activate.success') })
        // Delay refresh tick — Edge potrzebuje ~1s na zapis tokenu + reconnect tunelu.
        setTimeout(onActivated, 1500)
      } else {
        setResult({ ok: false, msg: `${t('settings.cloud.activate.fail')}: ${res.error ?? '—'}` })
      }
    } catch (err: any) {
      setResult({ ok: false, msg: `${t('settings.cloud.activate.fail')}: ${err.message}` })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{
      padding: 16,
      background: 'var(--amber-50)',
      border: '1px solid var(--amber)',
      borderRadius: 'var(--r-2)',
      marginBottom: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <AlertTriangle size={16} style={{ color: 'var(--amber)' }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--amber)' }}>
          {t('settings.cloud.activate.notActivated')}
        </span>
      </div>

      <h4 style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', margin: '8px 0 6px' }}>
        {t('settings.cloud.activate.title')}
      </h4>
      <p style={{ fontSize: 12, color: 'var(--ink-2)', margin: '0 0 12px 0', lineHeight: 1.5 }}>
        {t('settings.cloud.activate.intro')}
      </p>

      {/* Inline Cloud URL info — pokazujemy zawsze, bo to jest niewidzialny
          source of failure (POST do złej domeny → 404). Jeśli URL nie pasuje
          do produkcji — one-click fix-it. */}
      {cloudUrl && (
        <div style={{
          padding: '8px 10px',
          background: cloudUrlWrong ? 'var(--red-50, rgba(239,68,68,0.08))' : 'var(--surface)',
          border: `1px solid ${cloudUrlWrong ? 'var(--red)' : 'var(--border)'}`,
          borderRadius: 'var(--r-2)',
          fontSize: 11,
          marginBottom: 10,
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        }}>
          <span style={{ color: 'var(--muted)' }}>Cloud:</span>
          <span className="mono" style={{ color: cloudUrlWrong ? 'var(--red)' : 'var(--ink)' }}>
            {cloudUrl}
          </span>
          {cloudUrlWrong && (
            <>
              <span style={{ color: 'var(--red)' }}>← niepoprawny dla produkcji</span>
              <button
                className="btn"
                onClick={handleFixCloudUrl}
                disabled={fixingUrl}
                style={{ padding: '2px 8px', fontSize: 11, marginLeft: 'auto' }}
              >
                {fixingUrl ? <RotateCw size={12} className="spin" /> : null}
                Ustaw {PROD_URL}
              </button>
            </>
          )}
        </div>
      )}

      <label style={{
        display: 'block',
        fontSize: 11, fontWeight: 500,
        color: 'var(--muted)',
        marginBottom: 4,
      }}>
        {t('settings.cloud.activate.codeLabel')}
      </label>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={t('settings.cloud.activate.codePlaceholder')}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          style={{
            flex: 1,
            padding: '8px 12px',
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            color: 'var(--ink)',
            borderRadius: 'var(--r-2)',
            fontFamily: '"IBM Plex Mono", monospace',
            fontSize: 14,
            letterSpacing: 1.2,
            textTransform: 'uppercase',
          }}
          onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) handleActivate() }}
        />
        <button
          className="btn btn-primary"
          onClick={handleActivate}
          disabled={!canSubmit}
        >
          {busy ? <RotateCw size={14} className="spin" /> : <KeyRound size={14} />}
          {busy ? t('settings.cloud.activate.busy') : t('settings.cloud.activate.btn')}
        </button>
      </div>

      <p style={{ fontSize: 11, color: 'var(--muted)', margin: '8px 0 0 0', lineHeight: 1.4 }}>
        {t('settings.cloud.activate.helpText')}
      </p>

      {result && (
        <div style={{
          marginTop: 12,
          padding: 8,
          background: result.ok ? 'var(--green-50)' : 'var(--red-50)',
          color: result.ok ? 'var(--green)' : 'var(--red)',
          border: `1px solid ${result.ok ? 'var(--green)' : 'var(--red)'}`,
          borderRadius: 'var(--r-2)',
          fontSize: 12,
        }}>
          {result.ok ? '✓ ' : '✗ '}{result.msg}
        </div>
      )}
    </div>
  )
}

function CloudUrlAdvanced() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Lazy fetch — pierwsze otwarcie accordion ładuje current cloudUrl. Bez tego
  // panel ładuje się od razu i wszystkie sub-tabs robią network call nawet
  // jeśli user nigdy nie wejdzie w Advanced.
  useEffect(() => {
    if (!open || loaded) return
    let cancelled = false
    api.getActivationConfig()
      .then((cfg) => { if (!cancelled) { setUrl(cfg.cloudUrl); setLoaded(true) } })
      .catch((err) => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [open, loaded])

  const handleApply = async () => {
    if (!url.trim()) return
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const res = await api.setCloudUrl(url.trim())
      if (res.success) {
        setSaved(true)
        setTimeout(() => setSaved(false), 3000)
      } else {
        setError(res.error ?? 'unknown error')
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{
      marginTop: 16,
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-2)',
      overflow: 'hidden',
    }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: '100%',
          padding: '10px 12px',
          background: 'transparent',
          border: 'none',
          color: 'var(--ink-2)',
          fontSize: 12,
          fontWeight: 500,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          textAlign: 'left',
        }}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {t('settings.cloud.advanced.title')}
      </button>
      {open && (
        <div style={{ padding: '8px 12px 12px 12px', borderTop: '1px solid var(--border)' }}>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 500, color: 'var(--muted)', marginBottom: 4 }}>
            {t('settings.cloud.advanced.cloudUrl')}
          </label>
          <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t('settings.cloud.advanced.cloudUrl.placeholder')}
              disabled={!loaded}
              style={{
                flex: 1,
                padding: '6px 10px',
                border: '1px solid var(--border)',
                background: 'var(--surface)',
                color: 'var(--ink)',
                borderRadius: 'var(--r-2)',
                fontFamily: '"IBM Plex Mono", monospace',
                fontSize: 12,
              }}
            />
            <button
              className="btn"
              onClick={handleApply}
              disabled={!loaded || busy || !url.trim()}
            >
              {busy && <RotateCw size={12} className="spin" />}
              {t('settings.cloud.advanced.cloudUrl.apply')}
            </button>
          </div>
          <div style={{ fontSize: 10, color: 'var(--muted)', lineHeight: 1.4 }}>
            {t('settings.cloud.advanced.cloudUrl.help')}
          </div>
          {saved && (
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--green)' }}>
              ✓ {t('settings.cloud.advanced.cloudUrl.saved')}
            </div>
          )}
          {error && (
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--red)' }}>
              ✗ {error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function FirmwarePanel() {
  const { data } = useSystemInfo()
  const { t } = useTranslation()
  const [checking, setChecking] = useState(false)
  const [checkResult, setCheckResult] = useState<{ hasUpdate: boolean; latest?: string } | null>(null)

  const handleCheck = async () => {
    setChecking(true)
    try {
      const res = await api.firmwareCheck()
      setCheckResult({ hasUpdate: res.hasUpdate, latest: res.latest })
    } catch (err: any) {
      setCheckResult({ hasUpdate: false, latest: data?.firmware ?? '?' })
    } finally {
      setChecking(false)
    }
  }

  return (
    <Section title={t('settings.firmware.section.title')} hint={t('settings.firmware.section.hint')}>
      <KV label={t('settings.firmware.version')}>
        <span className="mono">{data?.firmware ?? '—'}</span>
      </KV>
      <KV label={t('settings.firmware.build')}>
        <span className="mono" style={{ color: 'var(--muted)' }}>{t('settings.firmware.build.dev')}</span>
      </KV>
      <KV label={t('settings.firmware.lastUpdate')}>
        <span style={{ color: 'var(--muted)' }}>—</span>
      </KV>

      <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
        <button className="btn" onClick={handleCheck} disabled={checking}>
          {checking ? <RotateCw size={14} className="spin" /> : <RotateCw size={14} />}
          {checking ? t('settings.firmware.checking') : t('settings.firmware.check')}
        </button>
        <button className="btn" disabled>
          <Download size={14} />
          {t('settings.firmware.upload')}
        </button>
      </div>

      {checkResult && (
        <div style={{
          marginTop: 12, padding: 10,
          background: checkResult.hasUpdate ? 'var(--amber-50)' : 'var(--green-50)',
          border: `1px solid ${checkResult.hasUpdate ? 'var(--amber)' : 'var(--green)'}`,
          borderRadius: 'var(--r-2)',
          fontSize: 12,
          color: checkResult.hasUpdate ? 'var(--amber)' : 'var(--green)',
        }}>
          {checkResult.hasUpdate
            ? t('settings.firmware.hasUpdate', { ver: checkResult.latest ?? '?' })
            : t('settings.firmware.upToDate')}
        </div>
      )}

      <Hint>{t('settings.firmware.footer')}</Hint>
    </Section>
  )
}

function SecurityPanel() {
  const { t } = useTranslation()
  const [twoFa, setTwoFa] = useState(false)
  const [lanOnly, setLanOnly] = useState(true)
  const [sshEnabled, setSshEnabled] = useState(false)
  return (
    <Section title={t('settings.security.section.title')} hint={t('settings.security.section.hint')}>
      <ToggleRow
        label={t('settings.security.2fa.label')}
        description={t('settings.security.2fa.desc')}
        checked={twoFa}
        onChange={() => setTwoFa(!twoFa)}
      />
      <ToggleRow
        label={t('settings.security.lanOnly.label')}
        description={t('settings.security.lanOnly.desc')}
        checked={lanOnly}
        onChange={() => setLanOnly(!lanOnly)}
      />
      <ToggleRow
        label={t('settings.security.ssh.label')}
        description={t('settings.security.ssh.desc')}
        checked={sshEnabled}
        onChange={() => setSshEnabled(!sshEnabled)}
      />
      <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
              {t('settings.security.rotate.title')}
            </div>
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 0 0' }}>
              {t('settings.security.rotate.desc')}
            </p>
          </div>
          <button className="btn" disabled title="TODO">
            <RotateCw size={14} />
            {t('settings.security.rotate.btn')}
          </button>
        </div>
      </div>
      <Hint>{t('settings.security.footer')}</Hint>
    </Section>
  )
}

function MaintenancePanel() {
  const { t } = useTranslation()
  const [autoUpdate, setAutoUpdate] = useState(false)
  const [nightlyRestart, setNightlyRestart] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [showFactoryReset, setShowFactoryReset] = useState(false)
  const [showRestore, setShowRestore] = useState(false)

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3500)
  }

  const handleRestart = async () => {
    if (!confirm(t('settings.restart.confirm'))) return
    try {
      const res = await api.restartSystem()
      showToast(t('settings.restart.toast', { n: res.delaySeconds }))
    } catch (err: any) {
      showToast(`✗ ${err.message}`)
    }
  }

  const [backupScope, setBackupScope] = useState<'none' | '7d' | '30d'>('none')
  const [backupBusy, setBackupBusy] = useState(false)

  const handleBackup = async () => {
    if (backupBusy) return
    setBackupBusy(true)
    try {
      // Window.location.href triggeruje download bo backend wysyła
      // Content-Disposition: attachment. NIE używamy fetch+blob bo dla
      // 3 GB blob-a w pamięci to overkill — przeglądarka stream-uje directly.
      const url = `/api/system/backup${backupScope !== 'none' ? `?snapshots=${backupScope}` : ''}`
      window.location.href = url
      // Naive timeout — większy backup może iść 30s+, ale browser pokaże
      // progress download-u w swojej pasku statusu. Resetujemy busy po 2s.
      setTimeout(() => setBackupBusy(false), 2000)
    } catch (err: any) {
      showToast(`✗ ${err.message}`)
      setBackupBusy(false)
    }
  }

  return (
    <Section title={t('settings.maintenance.section.title')} hint={t('settings.maintenance.section.hint')}>
      <ToggleRow
        label={t('settings.maintenance.nightly.label')}
        description={t('settings.maintenance.nightly.desc')}
        checked={nightlyRestart}
        onChange={() => setNightlyRestart(!nightlyRestart)}
      />
      <ToggleRow
        label={t('settings.maintenance.autoUpdate.label')}
        description={t('settings.maintenance.autoUpdate.desc')}
        checked={autoUpdate}
        onChange={() => setAutoUpdate(!autoUpdate)}
      />

      {/* Backup section */}
      <div style={{
        marginTop: 16,
        padding: 12,
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-2)',
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>
          {t('settings.backup.title')}
        </div>
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 10px 0', lineHeight: 1.4 }}>
          {t('settings.backup.hint')}
        </p>

        <label style={{
          display: 'block', fontSize: 11, fontWeight: 500,
          color: 'var(--muted)', marginBottom: 4,
        }}>
          {t('settings.backup.scope.label')}
        </label>
        <select
          value={backupScope}
          onChange={(e) => setBackupScope(e.target.value as 'none' | '7d' | '30d')}
          style={{
            width: '100%', padding: '8px 10px',
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            color: 'var(--ink)',
            borderRadius: 'var(--r-2)',
            fontSize: 12,
            marginBottom: 10,
          }}
        >
          <option value="none">{t('settings.backup.scope.config')}</option>
          <option value="7d">{t('settings.backup.scope.7d')}</option>
          <option value="30d">{t('settings.backup.scope.30d')}</option>
        </select>

        <button className="btn btn-primary" onClick={handleBackup} disabled={backupBusy}>
          {backupBusy ? <RotateCw size={14} className="spin" /> : <Download size={14} />}
          {backupBusy ? t('settings.backup.downloading') : t('settings.backup.download')}
        </button>

        <div style={{
          marginTop: 10,
          padding: 8,
          background: 'var(--amber-50)',
          border: '1px solid var(--amber)',
          borderRadius: 'var(--r-1)',
          fontSize: 11,
          color: 'var(--amber)',
          lineHeight: 1.4,
        }}>
          {t('settings.backup.security')}
        </div>
      </div>

      {/* Restore section */}
      <div style={{
        marginTop: 12,
        padding: 12,
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-2)',
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>
          {t('settings.restore.title')}
        </div>
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 10px 0', lineHeight: 1.4 }}>
          {t('settings.restore.hint')}
        </p>

        <button className="btn" onClick={() => setShowRestore(true)}>
          <Upload size={14} />
          {t('settings.restore.cta')}
        </button>

        <div style={{
          marginTop: 10,
          padding: 8,
          background: 'var(--amber-50)',
          border: '1px solid var(--amber)',
          borderRadius: 'var(--r-1)',
          fontSize: 11,
          color: 'var(--amber)',
          lineHeight: 1.4,
        }}>
          {t('settings.restore.warning')}
        </div>
      </div>

      {/* Akcje destrukcyjne */}
      <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
        <h4 style={{
          fontSize: 11, fontWeight: 700, color: 'var(--red)',
          textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 12,
        }}>
          {t('settings.danger.zone')}
        </h4>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-danger" onClick={handleRestart}>
            <Power size={14} />
            {t('settings.danger.restart')}
          </button>
          <button className="btn btn-danger" onClick={() => setShowFactoryReset(true)}>
            <Trash2 size={14} />
            {t('settings.danger.factoryReset')}
          </button>
        </div>
      </div>

      {showFactoryReset && (
        <FactoryResetModal onClose={() => setShowFactoryReset(false)} />
      )}

      {showRestore && (
        <RestoreModal onClose={() => setShowRestore(false)} />
      )}

      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--ink)', color: 'var(--surface)',
          padding: '10px 16px', borderRadius: 'var(--r-3)',
          fontSize: 13, boxShadow: 'var(--shadow-2)', zIndex: 100,
        }}>
          {toast}
        </div>
      )}
    </Section>
  )
}

function FactoryResetModal({ onClose }: { onClose: () => void }) {
  const { data } = useSystemInfo()
  const { t } = useTranslation()
  const [confirmText, setConfirmText] = useState('')
  const expected = data?.hostname ?? 'edge'
  const matches = confirmText === expected

  // Confirm prompt with hostname interpolation — split at {hostname} placeholder
  // for mono styling of the hostname itself.
  const promptTemplate = t('settings.factory.confirmPrompt', { hostname: '__HOST__' })
  const [promptBefore, promptAfter] = promptTemplate.split('__HOST__')

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 200,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{ padding: 24, maxWidth: 480, width: '90%' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <AlertTriangle size={20} style={{ color: 'var(--red)' }} />
          <h3 style={{ fontSize: 16, fontWeight: 600, color: 'var(--ink)', margin: 0 }}>
            {t('settings.factory.title')}
          </h3>
        </div>
        <p style={{ fontSize: 13, color: 'var(--ink-2)', margin: 0, marginBottom: 12 }}>
          {t('settings.factory.intro')}{' '}
          <strong style={{ color: 'var(--red)' }}>{t('settings.factory.irreversible')}</strong>
          {t('settings.factory.willDelete')}
        </p>
        <ul style={{ fontSize: 12, color: 'var(--muted)', marginTop: 0, marginBottom: 16, paddingLeft: 20 }}>
          <li>{t('settings.factory.item.devices')}</li>
          <li>{t('settings.factory.item.token')}</li>
          <li>{t('settings.factory.item.cache')}</li>
          <li>{t('settings.factory.item.logs')}</li>
        </ul>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 0, marginBottom: 8 }}>
          {promptBefore}
          <span className="mono" style={{ color: 'var(--ink)' }}>{expected}</span>
          {promptAfter}
        </p>
        <input
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={expected}
          style={{
            width: '100%', padding: '8px 12px',
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            color: 'var(--ink)',
            borderRadius: 'var(--r-2)',
            fontFamily: '"IBM Plex Mono", monospace',
            fontSize: 13,
            marginBottom: 16,
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button
            className="btn btn-danger"
            disabled={!matches}
            onClick={async () => {
              try {
                await api.factoryReset(confirmText)
                alert(t('settings.factory.started'))
                onClose()
              } catch (err: any) {
                alert(`${t('settings.factory.error')}: ${err.message}`)
              }
            }}
          >
            <Trash2 size={14} />
            {t('settings.factory.cta')}
          </button>
        </div>
      </div>
    </div>
  )
}

function RestoreModal({ onClose }: { onClose: () => void }) {
  const { data } = useSystemInfo()
  const { t } = useTranslation()
  const [confirmText, setConfirmText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const expected = data?.hostname ?? 'edge'
  const hostnameMatches = confirmText === expected
  const fileOk = !!file && (file.name.endsWith('.tar.gz') || file.name.endsWith('.tgz'))
  const canSubmit = hostnameMatches && fileOk && !busy

  const promptTemplate = t('settings.restore.confirmPrompt', { hostname: '__HOST__' })
  const [promptBefore, promptAfter] = promptTemplate.split('__HOST__')

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    setFile(f ?? null)
    setError(null)
  }

  const formatBytes = (n: number) => {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
  }

  const handleSubmit = async () => {
    if (!file || !hostnameMatches) return
    setBusy(true)
    setError(null)
    setProgress({ loaded: 0, total: file.size })
    try {
      await api.restoreUpload(confirmText, file, (loaded, total) => {
        setProgress({ loaded, total })
      })
      alert(t('settings.restore.success'))
      onClose()
    } catch (err: any) {
      setError(err?.message ?? String(err))
      setBusy(false)
    }
  }

  const pctDone = progress ? Math.round((progress.loaded / progress.total) * 100) : 0

  return (
    <div
      onClick={busy ? undefined : onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 200,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{ padding: 24, maxWidth: 520, width: '90%' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <Upload size={20} style={{ color: 'var(--amber)' }} />
          <h3 style={{ fontSize: 16, fontWeight: 600, color: 'var(--ink)', margin: 0 }}>
            {t('settings.restore.modalTitle')}
          </h3>
        </div>
        <p style={{ fontSize: 13, color: 'var(--ink-2)', margin: 0, marginBottom: 12 }}>
          {t('settings.restore.intro')}{' '}
          <strong style={{ color: 'var(--amber)' }}>{t('settings.restore.willOverwrite')}</strong>
        </p>

        {/* File picker */}
        <label style={{
          display: 'block', fontSize: 11, fontWeight: 500,
          color: 'var(--muted)', marginBottom: 4,
        }}>
          {t('settings.restore.filePicker')}
        </label>
        <input
          type="file"
          accept=".tar.gz,.tgz,application/gzip,application/x-gzip,application/x-tar"
          onChange={handleFileChange}
          disabled={busy}
          style={{
            width: '100%', padding: '8px 10px',
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            color: 'var(--ink)',
            borderRadius: 'var(--r-2)',
            fontSize: 12,
            marginBottom: 4,
          }}
        />
        {file && (
          <div style={{ fontSize: 11, color: fileOk ? 'var(--muted)' : 'var(--red)', marginBottom: 12 }}>
            {file.name} — {formatBytes(file.size)}
            {!fileOk && ` — ${t('settings.restore.invalidFile')}`}
          </div>
        )}
        {!file && (
          <div style={{ height: 12 }} />
        )}

        {/* Hostname confirm */}
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 0, marginBottom: 8 }}>
          {promptBefore}
          <span className="mono" style={{ color: 'var(--ink)' }}>{expected}</span>
          {promptAfter}
        </p>
        <input
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={expected}
          disabled={busy}
          style={{
            width: '100%', padding: '8px 12px',
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            color: 'var(--ink)',
            borderRadius: 'var(--r-2)',
            fontFamily: '"IBM Plex Mono", monospace',
            fontSize: 13,
            marginBottom: 12,
          }}
        />

        {/* Upload progress */}
        {progress && busy && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
              {t('settings.restore.uploading')} — {formatBytes(progress.loaded)} / {formatBytes(progress.total)} ({pctDone}%)
            </div>
            <div style={{
              height: 6, width: '100%',
              background: 'var(--surface-2)',
              borderRadius: 3, overflow: 'hidden',
            }}>
              <div style={{
                height: '100%',
                width: `${pctDone}%`,
                background: 'var(--accent, #4f46e5)',
                transition: 'width 0.2s',
              }} />
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{
            marginBottom: 12, padding: 8,
            background: 'var(--red-50, rgba(239,68,68,0.1))',
            border: '1px solid var(--red)',
            borderRadius: 'var(--r-1)',
            fontSize: 12, color: 'var(--red)',
          }}>
            {error}
          </div>
        )}

        {/* Warning */}
        <div style={{
          marginBottom: 16, padding: 8,
          background: 'var(--amber-50)',
          border: '1px solid var(--amber)',
          borderRadius: 'var(--r-1)',
          fontSize: 11, color: 'var(--amber)',
          lineHeight: 1.4,
        }}>
          {t('settings.restore.warningModal')}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            {busy ? <RotateCw size={14} className="spin" /> : <Upload size={14} />}
            {busy ? t('settings.restore.uploading') : t('settings.restore.submit')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Shared primitives ──────────────────────────────────────────────────────

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ padding: 20, maxWidth: 720 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', margin: 0, marginBottom: 4 }}>
        {title}
      </h3>
      {hint && (
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0, marginBottom: 16 }}>
          {hint}
        </p>
      )}
      {children}
    </div>
  )
}

function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '160px 1fr',
      gap: 16,
      padding: '8px 0',
      fontSize: 13,
      alignItems: 'center',
    }}>
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      <span style={{ color: 'var(--ink)' }}>{children}</span>
    </div>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      marginTop: 16,
      padding: 10,
      background: 'var(--surface-2)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-2)',
      fontSize: 11,
      color: 'var(--muted)',
    }}>
      ℹ {children}
    </div>
  )
}

function Pill({ color, children }: { color: 'green' | 'amber' | 'red' | 'blue'; children: React.ReactNode }) {
  const colors = {
    green: { bg: 'var(--green-50)', fg: 'var(--green)', border: 'var(--green)' },
    amber: { bg: 'var(--amber-50)', fg: 'var(--amber)', border: 'var(--amber)' },
    red:   { bg: 'var(--red-50)',   fg: 'var(--red)',   border: 'var(--red)' },
    blue:  { bg: 'var(--blue-50)',  fg: 'var(--blue)',  border: 'var(--blue)' },
  }[color]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '3px 8px',
      borderRadius: 999,
      fontSize: 11, fontWeight: 600,
      background: colors.bg,
      color: colors.fg,
      border: `1px solid ${colors.border}`,
    }}>
      {children}
    </span>
  )
}

function ToggleRow({ label, description, checked, onChange }: {
  label: string
  description: string
  checked: boolean
  onChange: () => void
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 12,
      padding: '10px 0',
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{label}</div>
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 0 0' }}>{description}</p>
      </div>
      <button
        onClick={onChange}
        role="switch"
        aria-checked={checked}
        style={{
          width: 40, height: 22, borderRadius: 11,
          background: checked ? 'var(--blue)' : 'var(--border-strong)',
          border: 'none', position: 'relative', cursor: 'pointer',
          transition: 'background 120ms',
          flexShrink: 0,
        }}
      >
        <span style={{
          position: 'absolute',
          top: 2,
          left: checked ? 20 : 2,
          width: 18, height: 18, borderRadius: '50%',
          background: 'white',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
          transition: 'left 120ms',
        }} />
      </button>
    </div>
  )
}
