'use client'
/**
 * EmailChangeModal (Sesja 6) — żądanie zmiany emaila z weryfikacją.
 *
 * Flow:
 *   1. User wpisuje nowy email + bieżące hasło
 *   2. POST /integrator/me/email-change/request
 *   3. Backend wysyła Resend email na NOWY adres z linkiem
 *   4. User otwiera mail → klik → /integrator/verify-email?token=X
 *   5. Verify page POST-uje token → swap email + clear pending
 *
 * Modal pokazuje sukces („Sprawdź skrzynkę…") z TTL informacją.
 */
import { useEffect, useState } from 'react'
import {
  X, Mail, Lock, Save, AlertTriangle, CheckCircle2,
} from 'lucide-react'
import { integratorApi } from '@/lib/integrator-api'
import { Spinner } from '@/components/integrator/property/shared/Spinner'

interface Props {
  open: boolean
  onClose: () => void
  currentEmail: string
}

export function EmailChangeModal({ open, onClose, currentEmail }: Props) {
  const [newEmail, setNewEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<{ verifyExpiresAt: string; emailSent: boolean } | null>(null)

  useEffect(() => {
    if (!open) {
      setNewEmail(''); setPassword(''); setError(null); setSuccess(null); setSubmitting(false)
    }
  }, [open])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const r = await integratorApi.post<{ verifyExpiresAt: string; emailSent: boolean }>(
        '/integrator/me/email-change/request',
        { newEmail: newEmail.trim(), currentPassword: password },
      )
      setSuccess(r.data)
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Błąd żądania zmiany'
      setError(msg)
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-ink/40 backdrop-blur-sm flex items-center justify-center p-6"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-surface border border-border rounded-r3 w-full max-w-md overflow-hidden"
      >
        <header className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <Mail size={18} strokeWidth={1.8} className="text-brand" />
            <h2 className="text-[14px] font-semibold text-ink">Zmiana adresu email</h2>
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-ink p-1 rounded-r1 hover:bg-surface-2"
          >
            <X size={16} />
          </button>
        </header>

        <div className="p-5">
          {success ? (
            <div className="text-center py-4">
              <CheckCircle2 size={40} strokeWidth={1.5} className="text-success mx-auto mb-3" />
              <h3 className="text-[14px] font-semibold text-ink mb-1">Sprawdź skrzynkę pocztową</h3>
              <p className="text-[12px] text-muted leading-relaxed mb-3">
                Wysłaliśmy link weryfikacyjny na <strong>{newEmail}</strong>.
                Kliknij w niego aby zatwierdzić zmianę.
              </p>
              <p className="text-[11px] text-muted-2">
                Link wygaśnie:{' '}
                <strong className="text-ink-2">
                  {new Date(success.verifyExpiresAt).toLocaleString('pl-PL')}
                </strong>
              </p>
              {!success.emailSent && (
                <div className="mt-4 bg-warn-50 border border-warn/30 rounded-r2 p-3 text-[11px] text-warn">
                  ⚠ Email-sender niedostępny — sprawdź ustawienia Resend w Cloud lub spróbuj później.
                </div>
              )}
              <button
                onClick={onClose}
                className="mt-5 inline-flex items-center gap-2 text-[13px] text-brand hover:text-brand-600 font-medium"
              >
                Zamknij
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-[11px] font-medium text-muted mb-1.5">Obecny email</label>
                <input
                  value={currentEmail}
                  disabled
                  className="w-full border border-border rounded-r2 px-3 py-1.5 text-[13px] bg-surface-2 text-muted"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-muted mb-1.5">Nowy email</label>
                <div className="relative">
                  <Mail size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-2 pointer-events-none" />
                  <input
                    type="email"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    placeholder="nowy@firma.pl"
                    required
                    autoComplete="off"
                    className="w-full pl-8 pr-3 py-1.5 border border-border rounded-r2 text-[13px] bg-surface text-ink focus:outline-none focus:border-brand placeholder:text-muted-2"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-muted mb-1.5">
                  Bieżące hasło <span className="text-muted-2">(potwierdzenie)</span>
                </label>
                <div className="relative">
                  <Lock size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-2 pointer-events-none" />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="current-password"
                    className="w-full pl-8 pr-3 py-1.5 border border-border rounded-r2 text-[13px] bg-surface text-ink focus:outline-none focus:border-brand"
                  />
                </div>
              </div>

              <div className="bg-surface-2 rounded-r2 p-3 border border-border text-[11px] text-muted leading-relaxed">
                Wyślemy link weryfikacyjny na <strong>nowy adres</strong>. Po kliknięciu w niego
                email konta zostanie zmieniony — zachowaj dostęp do skrzynki przez 24 godziny.
              </div>

              {error && (
                <div className="bg-danger-50 border border-danger/30 rounded-r2 p-3 flex items-center gap-2 text-[12px] text-danger">
                  <AlertTriangle size={14} />
                  {error}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={submitting}
                  className="text-[13px] text-muted hover:text-ink px-4 py-2 rounded-r2 hover:bg-surface-2 transition-colors"
                >
                  Anuluj
                </button>
                <button
                  type="submit"
                  disabled={submitting || !newEmail || !password}
                  className="inline-flex items-center gap-2 bg-brand text-white text-[13px] font-medium px-4 py-2 rounded-r2 hover:bg-brand-600 disabled:opacity-50 transition-colors"
                >
                  {submitting ? <Spinner size={13} className="text-white" /> : <Save size={13} />}
                  {submitting ? 'Wysyłanie…' : 'Wyślij link weryfikacyjny'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
