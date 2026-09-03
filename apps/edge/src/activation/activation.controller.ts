import { Controller, Get, Post, Body, Logger } from '@nestjs/common'
import { ActivationService } from './activation.service'
import { UiAuthService } from '../ui-auth/ui-auth.service'

@Controller('activation')
export class ActivationController {
  private readonly logger = new Logger(ActivationController.name)

  constructor(
    private activation: ActivationService,
    private uiAuth: UiAuthService,
  ) {}

  @Get('status')
  status() {
    return {
      activated: this.activation.isActivated(),
      deviceId: this.activation.getDeviceId(),
      buildingId: this.activation.getBuildingId(),
    }
  }

  // ── Settings: read & update configuration ─────────────────────────────────
  @Get('config')
  getConfig() {
    return {
      cloudUrl: this.activation.getCloudUrl(),
      activated: this.activation.isActivated(),
      deviceId: this.activation.getDeviceId(),
      buildingId: this.activation.getBuildingId(),
    }
  }

  @Post('config')
  updateConfig(@Body() body: { cloudUrl?: string }) {
    const url = body.cloudUrl?.trim()
    if (!url) return { success: false, error: 'Missing URL' }
    try {
      new URL(url) // validate format
    } catch {
      return { success: false, error: 'Invalid URL format' }
    }
    this.activation.setCloudUrl(url)
    return { success: true, cloudUrl: this.activation.getCloudUrl() }
  }

  /**
   * PR-2: opcjonalne pole `pin` — instalator może ustawić PIN Edge UI
   * w tym samym kroku co parowanie kodem (ekran aktywacji). PIN jest
   * ustawiany TYLKO gdy jeszcze nie istnieje (pierwsza konfiguracja) i
   * tylko po udanej aktywacji. Zmiana istniejącego PIN-u wyłącznie przez
   * POST /auth/pin (za sesją).
   */
  @Post('activate')
  async activate(@Body() body: { code: string; pin?: string }) {
    const result = await this.activation.activate(body.code)
    if (result.success && body.pin && !this.uiAuth.isPinSet()) {
      try {
        this.uiAuth.setPin(body.pin)
        this.logger.log('PIN Edge UI ustawiony podczas aktywacji')
      } catch (err: any) {
        // Aktywacja się powiodła — nie wywalamy jej przez zły PIN, tylko
        // raportujemy w odpowiedzi (UI może pokazać warning).
        this.logger.warn(`PIN przy aktywacji odrzucony: ${err.message}`)
        return { ...result, pinWarning: err.message as string }
      }
    }
    return result
  }

  @Post('deactivate')
  deactivate() {
    this.activation.deactivate()
    return { success: true }
  }
}
