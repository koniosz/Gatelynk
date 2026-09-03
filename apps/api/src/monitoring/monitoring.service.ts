/**
 * Monitoring Edge AI (2026-07-30) — odbiór alertów od strażnika na Mac Mini
 * (launchd `com.gatelynk.aihealth`, skrypt check.sh co 5 min).
 *
 * Strażnik sprawdza z Edge: Ollama/Bielik (Mac Studio TS:11434 — łapie też
 * bind na 127.0.0.1, bo bije w adres tailnetowy), yolo-vision (:11500),
 * ai-prototype (localhost:8000) i Edge Node (:4000). Alert wysyła TYLKO przy
 * zmianie stanu (2× fail z rzędu → DOWN; pierwszy sukces po DOWN → UP), więc
 * tu wystarcza cienka warstwa: walidacja tokenu + dedupe + e-mail.
 *
 * Auth: statyczny token HMAC z JWT_SECRET (wzorzec jak phonebook `tokenFor()`)
 * — strażnik nie ma JWT, a endpoint nie zwraca żadnych danych.
 */
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common'
import { createHmac } from 'node:crypto'
import { MailService } from '../mail/mail.service'

export type MonitorStatus = 'DOWN' | 'UP'

const KNOWN_COMPONENTS = new Set([
  'ollama',
  'yolo-vision',
  'ai-prototype',
  'edge-node',
  'test',
])

@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name)
  /** Dedupe: ostatni zaalarmowany stan per komponent + czas. Strażnik i tak
   *  wysyła tylko przy zmianie, to jest pas bezpieczeństwa (np. po jego
   *  restarcie z czystym stanem). */
  private readonly lastAlert = new Map<string, { status: MonitorStatus; at: number }>()
  private static readonly DEDUPE_MS = 10 * 60 * 1000

  constructor(private readonly mail: MailService) {}

  /** Token strażnika — policz na prod: HMAC-SHA256(JWT_SECRET, 'ai-monitor'). */
  static tokenFor(): string {
    const secret = process.env.JWT_SECRET ?? ''
    return createHmac('sha256', secret).update('ai-monitor').digest('hex').slice(0, 32)
  }

  async handleAlert(opts: {
    token: string
    component: string
    status: MonitorStatus
    detail?: string
  }): Promise<{ ok: boolean; sent?: boolean; deduped?: boolean }> {
    if (!opts.token || opts.token !== MonitoringService.tokenFor()) {
      throw new UnauthorizedException()
    }
    const component = String(opts.component ?? '').slice(0, 40)
    if (!KNOWN_COMPONENTS.has(component)) {
      this.logger.warn(`ai-health-alert: nieznany komponent "${component}" — ignoruję`)
      return { ok: false }
    }
    const status: MonitorStatus = opts.status === 'UP' ? 'UP' : 'DOWN'

    const prev = this.lastAlert.get(component)
    if (prev && prev.status === status && Date.now() - prev.at < MonitoringService.DEDUPE_MS) {
      this.logger.log(`ai-health-alert ${component}=${status} — dedupe (ostatni alert ${Math.round((Date.now() - prev.at) / 1000)}s temu)`)
      return { ok: true, deduped: true }
    }
    this.lastAlert.set(component, { status, at: Date.now() })

    const toEmail = process.env.MONITOR_ALERT_EMAIL ?? 'garymuwaut@gmail.com'
    const labels: Record<string, string> = {
      ollama: 'Ollama/Bielik (Mac Studio)',
      'yolo-vision': 'Wizja AI — YOLO (Mac Studio)',
      'ai-prototype': 'Asystent AI (Edge :8000)',
      'edge-node': 'Edge Node (:4000)',
      test: 'Test monitoringu',
    }
    const result = await this.mail.sendMonitorAlert({
      toEmail,
      component: labels[component] ?? component,
      status,
      detail: opts.detail?.slice(0, 300),
    })
    this.logger.log(`ai-health-alert ${component}=${status} → mail sent=${result.sent}${result.error ? ` (${result.error})` : ''}`)
    return { ok: true, sent: result.sent }
  }
}
