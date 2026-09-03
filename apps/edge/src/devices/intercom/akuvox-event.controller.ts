import { All, Body, Controller, Headers, Logger, Query, Req } from '@nestjs/common'
import type { Request } from 'express'
import { IntercomPinService } from './intercom-pin.service'

/**
 * Akuvox Action URL receiver — Faza 2D.
 *
 * Akuvox E18 (firmware 18.30.x) nie ma publicznego API do wepchnięcia
 * dynamicznych PIN-ów bez admin credenciali. Obejście: konfigurujemy
 * Action URL na zdarzenie „Press public key” / „Open door by code” →
 * Akuvox wystrzela request do Edge zawierający wpisany kod
 * (placeholder `$code_value` w UI) i MAC urządzenia (`$mac`).
 *
 * Akceptujemy zarówno GET (z query) jak i POST (z form-encoded body)
 * + JSON, bo różne firmware i różne typy eventów używają różnych
 * formatów. Robimy fuzzy-matching po typowych nazwach pól, żeby nie
 * łamać się przy następnym update'cie firmware.
 *
 * Bezpieczeństwo:
 *   - Edge HTTP nasłuchuje tylko na lokalnym LAN (LAN-only firewall),
 *     więc atak wymaga już-skompromitowanej sieci.
 *   - PIN i tak waliduje się lokalnie w `IntercomPinService` — same
 *     przyjście request-u nie otwiera niczego.
 */
@Controller('akuvox')
export class AkuvoxEventController {
  private readonly logger = new Logger(AkuvoxEventController.name)

  constructor(private readonly pinService: IntercomPinService) {}

  /**
   * `All('event')` zamiast osobnych `@Get/@Post` — Akuvox bywa
   * konfigurowane na różne metody w zależności od preferencji
   * instalatora (GET działa „z palca” w przeglądarce, POST jest
   * defaultem dla niektórych firmware).
   */
  @All('event')
  async event(
    @Query() query: Record<string, string>,
    @Body() body: any,
    @Headers() headers: Record<string, string>,
    @Req() req: Request,
  ): Promise<{ ok: boolean; matched: boolean; opened: boolean; reason?: string }> {
    // Łączymy źródła w jeden bag — caller mógł wysłać jako query, body,
    // form-data albo JSON. `parseBag` znajdzie pole pod znanymi nazwami.
    const bag: Record<string, string> = { ...query }
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      for (const [k, v] of Object.entries(body)) {
        if (typeof v === 'string' || typeof v === 'number') bag[k] = String(v)
      }
    }

    const pin = this.pickField(bag, [
      'code', 'code_value', 'codevalue', 'public_key', 'publickey',
      'key', 'pin', 'password', 'door_code', 'doorcode',
    ])
    const mac = this.pickField(bag, ['mac', 'mac_addr', 'macaddr', 'device_mac'])
    const intercomDeviceId = this.pickField(bag, [
      'device_id', 'deviceid', 'sn', 'serial', 'serial_number',
    ])
    const rawEvent = this.pickField(bag, ['event', 'event_type', 'action', 'type'])

    const remoteAddr = (req.socket?.remoteAddress ?? '').replace('::ffff:', '')
    this.logger.debug(
      `Akuvox event from ${remoteAddr} — event=${rawEvent ?? '?'} ` +
      `mac=${mac ?? '?'} pin=${pin ? `len=${pin.length}` : 'absent'}`,
    )

    if (!pin) {
      // Niektóre eventy (Door Opened, Door Closed) nie mają kodu —
      // logujemy i wracamy 200 (Akuvox sprawdza status code i alarmuje
      // przy 4xx/5xx zwracając w UI „server error").
      return { ok: true, matched: false, opened: false, reason: 'NO_CODE' }
    }

    const result = await this.pinService.handleKeypadEvent({
      pin,
      mac: mac ?? undefined,
      intercomDeviceId: intercomDeviceId ?? undefined,
      rawEvent: rawEvent ?? undefined,
    })
    return { ok: true, ...result }
  }

  /** Bierze pierwszy niepusty string spod aliasów (case-insensitive). */
  private pickField(bag: Record<string, string>, names: string[]): string | undefined {
    const lc: Record<string, string> = {}
    for (const [k, v] of Object.entries(bag)) {
      if (typeof v === 'string' && v.length > 0) lc[k.toLowerCase()] = v
    }
    for (const n of names) {
      const v = lc[n.toLowerCase()]
      if (v) return v
    }
    return undefined
  }
}
