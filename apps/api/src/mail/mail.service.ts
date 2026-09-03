import { Injectable } from '@nestjs/common'
import { Resend } from 'resend'

const COURIER_LABELS: Record<string, string> = {
  DHL: 'DHL',
  INPOST: 'InPost',
  ALLEGRO: 'Allegro',
  OTHER: 'Inne',
}

@Injectable()
export class MailService {
  private resend: Resend | null = null
  private from: string
  /** Bazowy URL portalu gościa — `${portalBaseUrl}/g/<token>`. Override przez
   *  `GUEST_PORTAL_BASE_URL` (przydatne w dev: localhost:3002). */
  private portalBaseUrl: string

  constructor() {
    const apiKey = process.env.RESEND_API_KEY
    this.from = process.env.MAIL_FROM ?? 'GateLynk <noreply@gatelynk.com>'
    this.portalBaseUrl = (
      process.env.GUEST_PORTAL_BASE_URL ?? 'https://gatelynk.com'
    ).replace(/\/+$/, '')

    if (apiKey && apiKey !== 're_your_api_key') {
      this.resend = new Resend(apiKey)
    } else {
      console.warn('[MailService] RESEND_API_KEY not configured — email sending disabled')
    }
  }

  /** Public helper — zwraca URL portalu gościa dla danego tokenu. Używany
   *  m.in. przez ResidentService przy tworzeniu SMS-a (deep link do iMessage).
   *
   *  2026-05-11: zmienione z `/g/` na `/i/` (Guest Invite v2 — nowy
   *  pixel-perfect portal). Stara ścieżka `/g/<token>` zostaje jako 308
   *  permanent redirect, więc istniejące linki SMS dalej działają. */
  buildGuestPortalUrl(token: string): string {
    return `${this.portalBaseUrl}/i/${token}`
  }

  // ── Parcel received ───────────────────────────────────────────────────────
  async sendParcelReceived(
    to: string,
    data: {
      trackingNumber: string
      courier: string
      unitNumber: string
      buildingName: string
      receivedAt: Date
    },
  ): Promise<void> {
    if (!this.resend) return

    const courierLabel = COURIER_LABELS[data.courier] ?? data.courier
    const dateStr = new Date(data.receivedAt).toLocaleString('pl-PL', {
      timeZone: 'Europe/Warsaw',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })

    const html = `
<!DOCTYPE html>
<html lang="pl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
        <!-- Header -->
        <tr>
          <td style="background:#2563eb;padding:28px 32px;text-align:center">
            <div style="font-size:36px">📦</div>
            <h1 style="color:#ffffff;margin:8px 0 0;font-size:22px;font-weight:700">Nowa przesyłka w depozycie</h1>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:32px">
            <p style="color:#374151;font-size:16px;margin:0 0 24px">Szanowny Mieszkańcu,</p>
            <p style="color:#374151;font-size:15px;margin:0 0 24px">
              Twoja przesyłka została przyjęta do depozytu w lobby budynku <strong>${data.buildingName}</strong>.
            </p>
            <!-- Details box -->
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f7ff;border-radius:8px;overflow:hidden;margin-bottom:24px">
              <tr><td style="padding:20px">
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="color:#6b7280;font-size:13px;padding-bottom:8px">Numer śledzenia</td>
                    <td style="color:#111827;font-size:15px;font-weight:600;text-align:right;padding-bottom:8px">${data.trackingNumber}</td>
                  </tr>
                  <tr>
                    <td style="color:#6b7280;font-size:13px;padding-bottom:8px">Kurier</td>
                    <td style="color:#111827;font-size:15px;font-weight:600;text-align:right;padding-bottom:8px">${courierLabel}</td>
                  </tr>
                  <tr>
                    <td style="color:#6b7280;font-size:13px;padding-bottom:8px">Lokal</td>
                    <td style="color:#111827;font-size:15px;font-weight:600;text-align:right;padding-bottom:8px">${data.unitNumber}</td>
                  </tr>
                  <tr>
                    <td style="color:#6b7280;font-size:13px">Data przyjęcia</td>
                    <td style="color:#111827;font-size:15px;font-weight:600;text-align:right">${dateStr}</td>
                  </tr>
                </table>
              </td></tr>
            </table>
            <p style="color:#374151;font-size:14px;margin:0 0 8px">
              Możesz odebrać przesyłkę w recepcji / lobby budynku w godzinach pracy konsjerża.
            </p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#f9fafb;padding:16px 32px;text-align:center;border-top:1px solid #e5e7eb">
            <p style="color:#9ca3af;font-size:12px;margin:0">GateLynk — System zarządzania budynkiem</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`

    try {
      await this.resend.emails.send({
        from: this.from,
        to: [to],
        subject: `📦 Nowa przesyłka — ${courierLabel} ${data.trackingNumber}`,
        html,
      })
    } catch (err) {
      console.error('[MailService] sendParcelReceived error:', err)
    }
  }

  // ── Parcel reminder ───────────────────────────────────────────────────────
  async sendParcelReminder(
    to: string,
    data: {
      trackingNumber: string
      courier: string
      unitNumber: string
      daysWaiting: number
      receivedAt: Date
    },
  ): Promise<void> {
    if (!this.resend) return

    const courierLabel = COURIER_LABELS[data.courier] ?? data.courier
    const receivedStr = new Date(data.receivedAt).toLocaleString('pl-PL', {
      timeZone: 'Europe/Warsaw',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })

    const daysText =
      data.daysWaiting === 0
        ? 'dzisiaj'
        : data.daysWaiting === 1
          ? '1 dzień'
          : `${data.daysWaiting} dni`

    const subjectDays =
      data.daysWaiting === 0 ? 'przyjęta dzisiaj' : `czeka od ${daysText}`

    const html = `
<!DOCTYPE html>
<html lang="pl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
        <!-- Header -->
        <tr>
          <td style="background:#d97706;padding:28px 32px;text-align:center">
            <div style="font-size:36px">🔔</div>
            <h1 style="color:#ffffff;margin:8px 0 0;font-size:22px;font-weight:700">Przypomnienie o przesyłce</h1>
            ${data.daysWaiting > 0 ? `<p style="color:#fef3c7;margin:6px 0 0;font-size:14px">Czeka na Ciebie od ${daysText}</p>` : ''}
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:32px">
            <p style="color:#374151;font-size:16px;margin:0 0 24px">Szanowny Mieszkańcu,</p>
            <p style="color:#374151;font-size:15px;margin:0 0 24px">
              Przypominamy, że Twoja przesyłka <strong>${data.daysWaiting > 0 ? `czeka już od ${daysText}` : 'czeka na odbiór'}</strong> w lobby budynku.
            </p>
            <!-- Details box -->
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border-radius:8px;overflow:hidden;border:1px solid #fde68a;margin-bottom:24px">
              <tr><td style="padding:20px">
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="color:#6b7280;font-size:13px;padding-bottom:8px">Numer śledzenia</td>
                    <td style="color:#111827;font-size:15px;font-weight:600;text-align:right;padding-bottom:8px">${data.trackingNumber}</td>
                  </tr>
                  <tr>
                    <td style="color:#6b7280;font-size:13px;padding-bottom:8px">Kurier</td>
                    <td style="color:#111827;font-size:15px;font-weight:600;text-align:right;padding-bottom:8px">${courierLabel}</td>
                  </tr>
                  <tr>
                    <td style="color:#6b7280;font-size:13px;padding-bottom:8px">Lokal</td>
                    <td style="color:#111827;font-size:15px;font-weight:600;text-align:right;padding-bottom:8px">${data.unitNumber}</td>
                  </tr>
                  <tr>
                    <td style="color:#6b7280;font-size:13px">Data przyjęcia</td>
                    <td style="color:#111827;font-size:15px;font-weight:600;text-align:right">${receivedStr}</td>
                  </tr>
                </table>
              </td></tr>
            </table>
            <p style="color:#374151;font-size:14px;margin:0 0 8px">
              Możesz odebrać przesyłkę w recepcji / lobby budynku w godzinach pracy konsjerża.
            </p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#f9fafb;padding:16px 32px;text-align:center;border-top:1px solid #e5e7eb">
            <p style="color:#9ca3af;font-size:12px;margin:0">GateLynk — System zarządzania budynkiem</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`

    try {
      await this.resend.emails.send({
        from: this.from,
        to: [to],
        subject: `🔔 Przypomnienie: Przesyłka ${subjectDays} — ${data.trackingNumber}`,
        html,
      })
    } catch (err) {
      console.error('[MailService] sendParcelReminder error:', err)
    }
  }

  // ── Reservation confirmed ─────────────────────────────────────────────────
  async sendReservationConfirmed(
    to: string,
    data: {
      unitName: string
      startAt: Date
      endAt: Date
      isPaid: boolean
      pricePaid: number | null
    },
  ): Promise<void> {
    if (!this.resend) return

    const fmt = (d: Date) =>
      d.toLocaleString('pl-PL', {
        timeZone: 'Europe/Warsaw',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })

    const priceRow = data.isPaid && data.pricePaid != null
      ? `<tr>
          <td style="color:#6b7280;font-size:13px;padding-bottom:8px">Koszt</td>
          <td style="color:#111827;font-size:15px;font-weight:600;text-align:right;padding-bottom:8px">${data.pricePaid.toFixed(2)} zł</td>
        </tr>`
      : ''

    const html = `
<!DOCTYPE html>
<html lang="pl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
        <tr>
          <td style="background:#2563eb;padding:28px 32px;text-align:center">
            <div style="font-size:36px">📅</div>
            <h1 style="color:#ffffff;margin:8px 0 0;font-size:22px;font-weight:700">Rezerwacja potwierdzona</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:32px">
            <p style="color:#374151;font-size:16px;margin:0 0 24px">Szanowny Mieszkańcu,</p>
            <p style="color:#374151;font-size:15px;margin:0 0 24px">
              Twoja rezerwacja została <strong>potwierdzona</strong>.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f7ff;border-radius:8px;overflow:hidden;margin-bottom:24px">
              <tr><td style="padding:20px">
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="color:#6b7280;font-size:13px;padding-bottom:8px">Obiekt</td>
                    <td style="color:#111827;font-size:15px;font-weight:600;text-align:right;padding-bottom:8px">${data.unitName}</td>
                  </tr>
                  <tr>
                    <td style="color:#6b7280;font-size:13px;padding-bottom:8px">Rozpoczęcie</td>
                    <td style="color:#111827;font-size:15px;font-weight:600;text-align:right;padding-bottom:8px">${fmt(data.startAt)}</td>
                  </tr>
                  <tr>
                    <td style="color:#6b7280;font-size:13px;padding-bottom:8px">Zakończenie</td>
                    <td style="color:#111827;font-size:15px;font-weight:600;text-align:right;padding-bottom:8px">${fmt(data.endAt)}</td>
                  </tr>
                  ${priceRow}
                </table>
              </td></tr>
            </table>
            ${data.isPaid ? '<p style="color:#6b7280;font-size:13px;margin:0">Płatność realizowana jest na miejscu w recepcji.</p>' : ''}
          </td>
        </tr>
        <tr>
          <td style="background:#f9fafb;padding:16px 32px;text-align:center;border-top:1px solid #e5e7eb">
            <p style="color:#9ca3af;font-size:12px;margin:0">GateLynk — System zarządzania budynkiem</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`

    try {
      await this.resend.emails.send({
        from: this.from,
        to: [to],
        subject: `📅 Rezerwacja potwierdzona — ${data.unitName}`,
        html,
      })
    } catch (err) {
      console.error('[MailService] sendReservationConfirmed error:', err)
    }
  }

  // ── Reservation cancelled ─────────────────────────────────────────────────
  async sendReservationCancelled(
    to: string,
    data: {
      unitName: string
      startAt: Date
      endAt: Date
    },
  ): Promise<void> {
    if (!this.resend) return

    const fmt = (d: Date) =>
      d.toLocaleString('pl-PL', {
        timeZone: 'Europe/Warsaw',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })

    const html = `
<!DOCTYPE html>
<html lang="pl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
        <tr>
          <td style="background:#dc2626;padding:28px 32px;text-align:center">
            <div style="font-size:36px">❌</div>
            <h1 style="color:#ffffff;margin:8px 0 0;font-size:22px;font-weight:700">Rezerwacja anulowana</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:32px">
            <p style="color:#374151;font-size:16px;margin:0 0 24px">Szanowny Mieszkańcu,</p>
            <p style="color:#374151;font-size:15px;margin:0 0 24px">
              Twoja rezerwacja została <strong>anulowana</strong>.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#fef2f2;border-radius:8px;overflow:hidden;border:1px solid #fecaca;margin-bottom:24px">
              <tr><td style="padding:20px">
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="color:#6b7280;font-size:13px;padding-bottom:8px">Obiekt</td>
                    <td style="color:#111827;font-size:15px;font-weight:600;text-align:right;padding-bottom:8px">${data.unitName}</td>
                  </tr>
                  <tr>
                    <td style="color:#6b7280;font-size:13px;padding-bottom:8px">Rozpoczęcie</td>
                    <td style="color:#111827;font-size:15px;font-weight:600;text-align:right;padding-bottom:8px">${fmt(data.startAt)}</td>
                  </tr>
                  <tr>
                    <td style="color:#6b7280;font-size:13px">Zakończenie</td>
                    <td style="color:#111827;font-size:15px;font-weight:600;text-align:right">${fmt(data.endAt)}</td>
                  </tr>
                </table>
              </td></tr>
            </table>
            <p style="color:#374151;font-size:14px;margin:0">
              W razie pytań prosimy o kontakt z recepcją.
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#f9fafb;padding:16px 32px;text-align:center;border-top:1px solid #e5e7eb">
            <p style="color:#9ca3af;font-size:12px;margin:0">GateLynk — System zarządzania budynkiem</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`

    try {
      await this.resend.emails.send({
        from: this.from,
        to: [to],
        subject: `❌ Rezerwacja anulowana — ${data.unitName}`,
        html,
      })
    } catch (err) {
      console.error('[MailService] sendReservationCancelled error:', err)
    }
  }

  // ── Parcel issued ─────────────────────────────────────────────────────────
  async sendParcelIssued(
    to: string,
    data: {
      trackingNumber: string
      courier: string
      unitNumber: string
      issuedAt: Date
    },
  ): Promise<void> {
    if (!this.resend) return

    const courierLabel = COURIER_LABELS[data.courier] ?? data.courier
    const dateStr = new Date(data.issuedAt).toLocaleString('pl-PL', {
      timeZone: 'Europe/Warsaw',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })

    const html = `
<!DOCTYPE html>
<html lang="pl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
        <!-- Header -->
        <tr>
          <td style="background:#16a34a;padding:28px 32px;text-align:center">
            <div style="font-size:36px">✅</div>
            <h1 style="color:#ffffff;margin:8px 0 0;font-size:22px;font-weight:700">Przesyłka wydana</h1>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:32px">
            <p style="color:#374151;font-size:16px;margin:0 0 24px">Szanowny Mieszkańcu,</p>
            <p style="color:#374151;font-size:15px;margin:0 0 24px">
              Twoja przesyłka została wydana z depozytu lobby.
            </p>
            <!-- Details box -->
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border-radius:8px;overflow:hidden;margin-bottom:24px">
              <tr><td style="padding:20px">
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="color:#6b7280;font-size:13px;padding-bottom:8px">Numer śledzenia</td>
                    <td style="color:#111827;font-size:15px;font-weight:600;text-align:right;padding-bottom:8px">${data.trackingNumber}</td>
                  </tr>
                  <tr>
                    <td style="color:#6b7280;font-size:13px;padding-bottom:8px">Kurier</td>
                    <td style="color:#111827;font-size:15px;font-weight:600;text-align:right;padding-bottom:8px">${courierLabel}</td>
                  </tr>
                  <tr>
                    <td style="color:#6b7280;font-size:13px;padding-bottom:8px">Lokal</td>
                    <td style="color:#111827;font-size:15px;font-weight:600;text-align:right;padding-bottom:8px">${data.unitNumber}</td>
                  </tr>
                  <tr>
                    <td style="color:#6b7280;font-size:13px">Data wydania</td>
                    <td style="color:#111827;font-size:15px;font-weight:600;text-align:right">${dateStr}</td>
                  </tr>
                </table>
              </td></tr>
            </table>
            <p style="color:#374151;font-size:14px;margin:0">
              Dziękujemy za korzystanie z systemu depozytowego GateLynk.
            </p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#f9fafb;padding:16px 32px;text-align:center;border-top:1px solid #e5e7eb">
            <p style="color:#9ca3af;font-size:12px;margin:0">GateLynk — System zarządzania budynkiem</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`

    try {
      await this.resend.emails.send({
        from: this.from,
        to: [to],
        subject: `✅ Przesyłka wydana — ${courierLabel} ${data.trackingNumber}`,
        html,
      })
    } catch (err) {
      console.error('[MailService] sendParcelIssued error:', err)
    }
  }

  // ── Guest invitation (Portal pivot) ───────────────────────────────────────
  /**
   * Wysyła gościowi email z linkiem do mikroportalu (`gatelynk.com/g/<token>`).
   * Portal to PWA z przyciskami otwierania bram — gość omija klawiaturę
   * domofonu (Akuvox UX problem) i kontaktowy beep „błędnego kodu".
   *
   * Idempotencja: ResidentService ustawia `emailSentAt` po sukcesie, więc
   * retry z portalu (np. „resend invitation") wyśle ponownie tylko jeśli
   * resident tego chce — tutaj tylko strzelamy do Resend.
   */
  async sendGuestInvitation(
    to: string,
    data: {
      guestName: string
      buildingName: string
      inviterName: string
      validFrom: Date
      validTo: Date
      pin: string
      urlToken: string
    },
  ): Promise<{ sent: boolean; reason?: string }> {
    if (!this.resend) {
      return { sent: false, reason: 'RESEND_NOT_CONFIGURED' }
    }

    const fmt = (d: Date) =>
      d.toLocaleString('pl-PL', {
        timeZone: 'Europe/Warsaw',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })

    const portalUrl = this.buildGuestPortalUrl(data.urlToken)

    const html = `
<!DOCTYPE html>
<html lang="pl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);padding:36px 32px;text-align:center">
            <div style="font-size:42px">🚪</div>
            <h1 style="color:#ffffff;margin:12px 0 4px;font-size:24px;font-weight:700">Zaproszenie do ${escapeHtml(data.buildingName)}</h1>
            <p style="color:rgba(255,255,255,0.9);margin:0;font-size:14px">od ${escapeHtml(data.inviterName)}</p>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:32px">
            <p style="color:#374151;font-size:16px;margin:0 0 20px">Cześć ${escapeHtml(data.guestName)}!</p>
            <p style="color:#374151;font-size:15px;line-height:1.55;margin:0 0 24px">
              ${escapeHtml(data.inviterName)} zaprasza Cię do <strong>${escapeHtml(data.buildingName)}</strong>.
              Otwórz link poniżej w telefonie i użyj przycisków, aby otworzyć bramę / wjazd —
              <strong>bez wpisywania kodu na klawiaturze</strong>.
            </p>

            <!-- CTA -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px">
              <tr><td align="center">
                <a href="${portalUrl}"
                   style="display:inline-block;background:#6366f1;color:#ffffff;text-decoration:none;
                          padding:16px 36px;border-radius:12px;font-size:16px;font-weight:600;
                          box-shadow:0 4px 12px rgba(99,102,241,0.35)">
                  Otwórz portal gościa
                </a>
              </td></tr>
            </table>

            <!-- Window -->
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:10px;overflow:hidden;margin-bottom:16px">
              <tr><td style="padding:18px 20px">
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="color:#6b7280;font-size:13px;padding-bottom:8px">Ważne od</td>
                    <td style="color:#111827;font-size:14px;font-weight:600;text-align:right;padding-bottom:8px">${fmt(data.validFrom)}</td>
                  </tr>
                  <tr>
                    <td style="color:#6b7280;font-size:13px">Ważne do</td>
                    <td style="color:#111827;font-size:14px;font-weight:600;text-align:right">${fmt(data.validTo)}</td>
                  </tr>
                </table>
              </td></tr>
            </table>

            <!-- PIN fallback -->
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#fef3c7;border-radius:10px;overflow:hidden;border:1px solid #fde68a;margin-bottom:24px">
              <tr><td style="padding:14px 20px">
                <p style="color:#92400e;font-size:13px;margin:0 0 4px">Awaryjnie — kod do klawiatury domofonu:</p>
                <p style="color:#78350f;font-size:22px;font-weight:700;letter-spacing:2px;margin:0;font-family:'SF Mono',Menlo,monospace">${data.pin}</p>
              </td></tr>
            </table>

            <p style="color:#6b7280;font-size:12px;line-height:1.5;margin:0">
              Link działa tylko w wyznaczonym oknie czasowym. Po jego upływie portal się wyłączy automatycznie.
              Nie udostępniaj linka osobom trzecim.
            </p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#f9fafb;padding:16px 32px;text-align:center;border-top:1px solid #e5e7eb">
            <p style="color:#9ca3af;font-size:12px;margin:0">GateLynk — Bezkontaktowy dostęp dla gości</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`

    try {
      await this.resend.emails.send({
        from: this.from,
        to: [to],
        subject: `🚪 ${data.inviterName} zaprasza Cię do ${data.buildingName}`,
        html,
      })
      return { sent: true }
    } catch (err: any) {
      console.error('[MailService] sendGuestInvitation error:', err)
      return { sent: false, reason: err?.message ?? 'SEND_FAILED' }
    }
  }
  // ── Przypomnienie o płatności (Panel Administratora, 2026-07-22) ─────────
  /**
   * E-mailowe przypomnienie o czynszu — wysyłane ręcznie przez admina z
   * drawera lokalu w zakładce Płatności. Treść zależy od salda: zaległość
   * (kwota na czerwono) vs zbliżający się termin.
   */
  async sendPaymentReminder(opts: {
    toEmail: string
    name: string
    unitNumber: string
    balance: number
    dueDay: number
  }): Promise<{ sent: boolean; reason?: string }> {
    if (!this.resend) {
      console.warn('[MailService] sendPaymentReminder skipped — Resend not configured')
      return { sent: false, reason: 'RESEND_NOT_CONFIGURED' }
    }

    const safeName = escapeHtml(opts.name)
    const safeUnit = escapeHtml(opts.unitNumber)
    const overdue = opts.balance < 0
    const amountStr = `${Math.abs(opts.balance).toFixed(2)} PLN`

    const html = `
<!DOCTYPE html>
<html lang="pl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
        <tr>
          <td style="background:linear-gradient(180deg,#0B1020 0%,#16203A 100%);padding:32px;text-align:center">
            <div style="font-size:38px">${overdue ? '💳' : '📅'}</div>
            <h1 style="color:#ffffff;margin:10px 0 0;font-size:22px;font-weight:700">Przypomnienie o płatności</h1>
            <p style="color:#7C8AAA;margin:8px 0 0;font-size:11px;letter-spacing:3px;font-weight:600">GATELYNK — LOKAL ${safeUnit.toUpperCase()}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:32px">
            <p style="color:#374151;font-size:16px;margin:0 0 20px">Dzień dobry ${safeName},</p>
            ${overdue
              ? `<p style="color:#374151;font-size:15px;line-height:1.55;margin:0 0 16px">
                   Na koncie lokalu <strong>${safeUnit}</strong> widnieje zaległość w opłatach:
                 </p>
                 <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px">
                   <tr><td align="center" style="background:#fdf1f0;border:1px solid #f3c9c6;border-radius:12px;padding:18px">
                     <span style="color:#c0312c;font-size:28px;font-weight:700">${amountStr}</span>
                     <div style="color:#8a6d6b;font-size:13px;margin-top:4px">kwota zaległości</div>
                   </td></tr>
                 </table>
                 <p style="color:#374151;font-size:15px;line-height:1.55;margin:0 0 8px">
                   Prosimy o uregulowanie należności. Termin płatności czynszu to
                   <strong>${opts.dueDay}. dzień każdego miesiąca</strong>.
                 </p>`
              : `<p style="color:#374151;font-size:15px;line-height:1.55;margin:0 0 16px">
                   Przypominamy, że zbliża się termin płatności czynszu za lokal <strong>${safeUnit}</strong> —
                   <strong>${opts.dueDay}. dzień miesiąca</strong>.
                 </p>
                 <p style="color:#374151;font-size:15px;line-height:1.55;margin:0 0 8px">
                   Bieżące saldo lokalu: <strong>${opts.balance.toFixed(2)} PLN</strong>. Dziękujemy za terminowe wpłaty!
                 </p>`}
            <p style="color:#6b7280;font-size:13px;line-height:1.55;margin:16px 0 0">
              Jeśli płatność została już wykonana, prosimy zignorować tę wiadomość —
              zaksięgowanie przelewu może potrwać 1–2 dni robocze.
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#f9fafb;padding:16px 32px;text-align:center;border-top:1px solid #e5e7eb">
            <p style="color:#9ca3af;font-size:12px;margin:0">GateLynk — wiadomość wysłana przez administratora budynku</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`

    try {
      await this.resend.emails.send({
        from: this.from,
        to: [opts.toEmail],
        subject: overdue
          ? `💳 Przypomnienie: zaległość ${amountStr} — lokal ${opts.unitNumber}`
          : `📅 Przypomnienie o terminie płatności — lokal ${opts.unitNumber}`,
        html,
      })
      return { sent: true }
    } catch (err: any) {
      console.error('[MailService] sendPaymentReminder error:', err)
      return { sent: false, reason: err?.message ?? 'SEND_FAILED' }
    }
  }

  // ── Password reset (Panel Administratora, 2026-07-18) ────────────────────
  /**
   * Wysyła link resetu hasła. `resetUrl` zawiera plaintext token — w bazie
   * trzymamy tylko sha256, więc mail jest jedynym miejscem gdzie token żyje.
   * Ważność linku komunikujemy w treści (60 min — patrz BuildingAdminService).
   */
  async sendPasswordReset(opts: {
    toEmail: string
    name: string
    resetUrl: string
  }): Promise<{ sent: boolean; reason?: string }> {
    if (!this.resend) {
      console.warn('[MailService] sendPasswordReset skipped — Resend not configured')
      return { sent: false, reason: 'RESEND_NOT_CONFIGURED' }
    }

    const safeName = escapeHtml(opts.name)

    const html = `
<!DOCTYPE html>
<html lang="pl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
        <!-- Header — brandowy granat jak splash aplikacji -->
        <tr>
          <td style="background:linear-gradient(180deg,#0B1020 0%,#16203A 100%);padding:32px;text-align:center">
            <div style="font-size:38px">🔑</div>
            <h1 style="color:#ffffff;margin:10px 0 0;font-size:22px;font-weight:700">Reset hasła</h1>
            <p style="color:#7C8AAA;margin:8px 0 0;font-size:11px;letter-spacing:3px;font-weight:600">GATELYNK — PANEL ADMINISTRATORA</p>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:32px">
            <p style="color:#374151;font-size:16px;margin:0 0 20px">Cześć ${safeName},</p>
            <p style="color:#374151;font-size:15px;line-height:1.55;margin:0 0 24px">
              Otrzymaliśmy prośbę o zresetowanie hasła do Twojego konta w Panelu Administratora GateLynk.
              Kliknij przycisk poniżej, aby ustawić nowe hasło:
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px">
              <tr><td align="center">
                <a href="${opts.resetUrl}"
                   style="display:inline-block;background:#3B5BFF;color:#ffffff;text-decoration:none;
                          padding:15px 36px;border-radius:12px;font-size:16px;font-weight:600;
                          box-shadow:0 4px 12px rgba(59,91,255,0.35)">
                  Ustaw nowe hasło
                </a>
              </td></tr>
            </table>
            <p style="color:#6b7280;font-size:13px;line-height:1.55;margin:0 0 8px">
              Link jest ważny przez <strong>60 minut</strong> i działa jednorazowo.
            </p>
            <p style="color:#6b7280;font-size:13px;line-height:1.55;margin:0">
              Jeśli to nie Ty prosiłeś o reset — zignoruj tę wiadomość, Twoje hasło pozostanie bez zmian.
            </p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#f9fafb;padding:16px 32px;text-align:center;border-top:1px solid #e5e7eb">
            <p style="color:#9ca3af;font-size:12px;margin:0">GateLynk — Building Operating System</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`

    try {
      await this.resend.emails.send({
        from: this.from,
        to: [opts.toEmail],
        subject: '🔑 GateLynk — reset hasła do Panelu Administratora',
        html,
      })
      return { sent: true }
    } catch (err: any) {
      console.error('[MailService] sendPasswordReset error:', err)
      return { sent: false, reason: err?.message ?? 'SEND_FAILED' }
    }
  }

  // ── Alert monitoringu Edge AI (2026-07-30) ────────────────────────────────
  /** Alert ze strażnika AI na Mac Mini (launchd com.gatelynk.aihealth) —
   *  wysyłany tylko przy ZMIANIE stanu komponentu (DOWN/UP), patrz
   *  MonitoringService. Czerwony = padło, zielony = wróciło. */
  async sendMonitorAlert(opts: {
    toEmail: string
    component: string
    status: 'DOWN' | 'UP'
    detail?: string
  }): Promise<{ sent: boolean; error?: string }> {
    if (!this.resend) {
      console.warn('[MailService] sendMonitorAlert skipped — Resend not configured')
      return { sent: false, error: 'RESEND_NOT_CONFIGURED' }
    }
    const down = opts.status === 'DOWN'
    const color = down ? '#dc2626' : '#059669'
    const title = down ? 'AWARIA' : 'PRZYWRÓCONO'
    const ts = new Date().toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })
    try {
      await this.resend.emails.send({
        from: this.from,
        to: [opts.toEmail],
        subject: `${down ? '🔴' : '🟢'} GateLynk Edge AI — ${title}: ${opts.component}`,
        html: `
          <div style="font-family: -apple-system, Segoe UI, sans-serif; max-width: 520px; margin: 0 auto; color: #1c2430;">
            <h2 style="margin: 16px 0 4px;">Monitoring Edge AI</h2>
            <div style="border-left: 4px solid ${color}; background: ${down ? '#fef2f2' : '#ecfdf5'}; padding: 14px 16px; border-radius: 8px; margin: 16px 0;">
              <div style="font-size: 13px; font-weight: 700; color: ${color};">${title}</div>
              <div style="font-size: 18px; font-weight: 700; margin-top: 4px;">${escapeHtml(opts.component)}</div>
              ${opts.detail ? `<div style="font-size: 13px; color: #4b5563; margin-top: 6px;">${escapeHtml(opts.detail)}</div>` : ''}
              <div style="font-size: 12px; color: #94a0b1; margin-top: 8px;">${ts}</div>
            </div>
            <p style="font-size: 12px; color: #94a0b1;">
              Strażnik sprawdza co 5 min z Mac Mini (Edge). Alert przychodzi tylko przy zmianie stanu.
            </p>
          </div>
        `,
      })
      return { sent: true }
    } catch (err: any) {
      console.error('[MailService] sendMonitorAlert error:', err)
      return { sent: false, error: err?.message ?? 'SEND_FAILED' }
    }
  }
}

/** Escape HTML — proste, bez zewnętrznych zależności. Używamy tylko w
 *  `sendGuestInvitation` bo gość dostarcza name/inviter — XSS-safe. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Sesja 6 Panel Integratora — extension MailService o weryfikację zmiany emaila.
 * Zdefiniowane jako method na prototypie żeby uniknąć modyfikacji constructora
 * i utrzymać czystą historię diffa.
 *
 * Wysyłany jest **na NOWY email** (target zmiany), żeby potwierdzić że user
 * faktycznie ma do niego dostęp. Stary email dostaje opcjonalną notyfikację
 * w przyszłej iteracji.
 */
declare module './mail.service' {
  interface MailService {
    sendEmailChangeVerification(opts: {
      toEmail: string
      integratorName: string
      verifyUrl: string
    }): Promise<{ sent: boolean; error?: string }>
  }
}

MailService.prototype.sendEmailChangeVerification = async function (
  this: MailService,
  opts: { toEmail: string; integratorName: string; verifyUrl: string },
): Promise<{ sent: boolean; error?: string }> {
  const resend = (this as unknown as { resend: Resend | null }).resend
  const from = (this as unknown as { from: string }).from
  if (!resend) {
    console.warn('[MailService] sendEmailChangeVerification skipped — Resend not configured')
    return { sent: false, error: 'email-sender-disabled' }
  }
  const safeName = escapeHtml(opts.integratorName)
  const safeUrl = escapeHtml(opts.verifyUrl)
  try {
    await resend.emails.send({
      from,
      to: opts.toEmail,
      subject: 'GateLynk — potwierdź zmianę adresu email',
      html: `
        <div style="font-family: 'IBM Plex Sans', Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #0c1320;">
          <h2 style="font-size: 18px; margin-bottom: 12px;">Cześć ${safeName},</h2>
          <p style="font-size: 14px; line-height: 1.5; color: #2d3748;">
            Otrzymujesz tego maila bo zażądano zmiany adresu email konta GateLynk Integrator na ten.
          </p>
          <p style="font-size: 14px; line-height: 1.5; color: #2d3748;">
            Aby zatwierdzić zmianę, kliknij w przycisk poniżej:
          </p>
          <div style="text-align: center; margin: 32px 0;">
            <a href="${safeUrl}"
               style="background: #006fff; color: white; padding: 12px 24px;
                      border-radius: 6px; text-decoration: none; font-weight: 600;
                      display: inline-block;">
              Potwierdź zmianę emaila
            </a>
          </div>
          <p style="font-size: 12px; color: #5f6b7c; line-height: 1.5;">
            Link wygaśnie za 24 godziny. Jeśli to nie ty zainicjowałeś zmianę,
            zignoruj tego maila — twoje konto pozostanie bez zmian.
          </p>
          <hr style="border: none; border-top: 1px solid #dde2ea; margin: 24px 0;">
          <p style="font-size: 11px; color: #94a0b1;">
            GateLynk — kontrola dostępu dla nieruchomości
          </p>
        </div>
      `,
    })
    return { sent: true }
  } catch (err: any) {
    console.error('[MailService] sendEmailChangeVerification error:', err)
    return { sent: false, error: err?.message ?? 'unknown' }
  }
}
