import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import { UiAuthService } from './ui-auth.service'
import { SESSION_COOKIE, sessionTokenFromRequest } from './ui-auth.middleware'

/**
 * PR-2 (2026-07) — endpointy logowania PIN do Edge UI.
 *
 *   GET  /auth/status  — { enabled, pinSet, authenticated } (dla SPA/diagnostyki)
 *   GET  /auth/login   — samodzielna strona logowania (inline HTML, dark,
 *                        w stylu Edge UI; obsługuje też first-run „ustaw PIN")
 *   POST /auth/login   — { pin } → HttpOnly cookie sesji (TTL 8 h)
 *   POST /auth/logout  — kasuje sesję + cookie
 *   POST /auth/pin     — { pin, currentPin? } — zmiana PIN-u (wymaga ważnej
 *                        sesji + currentPin); pierwsze ustawienie (brak PIN-u)
 *                        jest otwarte (tryb bootstrap — middleware i tak
 *                        wszystko przepuszcza dopóki PIN nie istnieje)
 *
 * Ścieżki /auth/* są na allowliście middleware — ochronę zmiany PIN-u
 * egzekwuje ten kontroler samodzielnie.
 */
@Controller('auth')
export class UiAuthController {
  private readonly logger = new Logger(UiAuthController.name)

  constructor(private auth: UiAuthService) {}

  @Get('status')
  status(@Req() req: Request) {
    return {
      enabled: this.auth.isEnabled(),
      pinSet: this.auth.isPinSet(),
      authenticated: this.auth.validateSession(sessionTokenFromRequest(req)),
    }
  }

  @Post('login')
  @HttpCode(200)
  login(
    @Body() body: { pin?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!this.auth.isEnabled()) {
      return { success: true, note: 'auth disabled (EDGE_UI_AUTH_ENABLED=false)' }
    }
    if (!this.auth.isPinSet()) {
      throw new BadRequestException('PIN nie jest jeszcze ustawiony — użyj POST /auth/pin')
    }
    const ip = (req.socket?.remoteAddress ?? 'unknown').replace('::ffff:', '')
    let token: string | null
    try {
      token = this.auth.login(body.pin ?? '', ip)
    } catch (err: any) {
      if (err?.message === 'THROTTLED') {
        throw new HttpException(
          'Zbyt wiele nieudanych prób — spróbuj za kilkanaście minut',
          HttpStatus.TOO_MANY_REQUESTS,
        )
      }
      throw err
    }
    if (!token) throw new UnauthorizedException('Nieprawidłowy PIN')

    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: this.auth.sessionTtlMs(),
      path: '/',
    })
    return { success: true }
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.auth.logout(sessionTokenFromRequest(req))
    res.clearCookie(SESSION_COOKIE, { path: '/' })
    return { success: true }
  }

  /** Ustawienie (first-run) lub zmiana PIN-u. */
  @Post('pin')
  @HttpCode(200)
  setPin(
    @Body() body: { pin?: string; currentPin?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const newPin = (body.pin ?? '').trim()
    if (this.auth.isPinSet()) {
      // Zmiana: wymaga sesji ORAZ znajomości aktualnego PIN-u
      if (!this.auth.validateSession(sessionTokenFromRequest(req))) {
        throw new UnauthorizedException('Wymagane zalogowanie do Edge UI')
      }
      if (!this.auth.verifyPin(body.currentPin ?? '')) {
        throw new UnauthorizedException('Nieprawidłowy aktualny PIN')
      }
    }
    try {
      this.auth.setPin(newPin)
    } catch (err: any) {
      throw new BadRequestException(err.message ?? 'Nieprawidłowy PIN')
    }
    // setPin czyści wszystkie sesje — od razu tworzymy świeżą, żeby
    // ustawiający nie został wylogowany w połowie flow
    const ip = (req.socket?.remoteAddress ?? 'unknown').replace('::ffff:', '')
    const token = this.auth.login(newPin, ip)
    if (token) {
      res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: this.auth.sessionTtlMs(),
        path: '/',
      })
    }
    return { success: true }
  }

  /**
   * Strona logowania — samodzielny HTML (inline CSS/JS, bez zależności od
   * assetów SPA które są za guardem). Dark style spójny z Edge UI.
   */
  @Get('login')
  loginPage(@Query('next') next: string | undefined, @Res() res: Response) {
    // Open-redirect guard: tylko lokalne ścieżki
    const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/ui'
    const pinSet = this.auth.isPinSet()
    const enabled = this.auth.isEnabled()
    res.type('html').send(this.renderLoginHtml(target, pinSet, enabled))
  }

  private renderLoginHtml(target: string, pinSet: boolean, enabled: boolean): string {
    const safeTarget = JSON.stringify(target)
    return `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GateLynk Edge — logowanie</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0f172a; color: #e2e8f0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  .card {
    width: 100%; max-width: 360px; margin: 16px;
    background: #1e293b; border: 1px solid #334155; border-radius: 16px;
    padding: 32px 28px; box-shadow: 0 20px 60px rgba(0,0,0,.4);
  }
  .logo { text-align: center; font-size: 34px; margin-bottom: 8px; }
  h1 { font-size: 18px; text-align: center; margin-bottom: 4px; }
  p.sub { font-size: 13px; color: #94a3b8; text-align: center; margin-bottom: 22px; }
  label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 6px; }
  input {
    width: 100%; padding: 12px 14px; font-size: 18px; letter-spacing: 4px; text-align: center;
    background: #0f172a; color: #f1f5f9; border: 1px solid #334155; border-radius: 10px;
    outline: none; margin-bottom: 14px;
  }
  input:focus { border-color: #3b82f6; }
  button {
    width: 100%; padding: 12px; font-size: 15px; font-weight: 600;
    background: #2563eb; color: #fff; border: 0; border-radius: 10px; cursor: pointer;
  }
  button:hover { background: #1d4ed8; }
  button:disabled { opacity: .5; cursor: default; }
  .err {
    display: none; background: rgba(239,68,68,.12); border: 1px solid rgba(239,68,68,.4);
    color: #fca5a5; font-size: 13px; border-radius: 10px; padding: 10px 12px; margin-bottom: 14px;
  }
  .note { font-size: 11px; color: #64748b; text-align: center; margin-top: 18px; }
</style>
</head>
<body>
  <div class="card">
    <div class="logo">🔐</div>
    <h1>GateLynk Edge</h1>
    ${!enabled
      ? `<p class="sub">Autoryzacja UI jest wyłączona (EDGE_UI_AUTH_ENABLED=false).</p>
         <button onclick="location.href=${safeTarget.replace(/"/g, '&quot;')}">Przejdź do panelu</button>`
      : pinSet
      ? `<p class="sub">Podaj PIN instalatora, aby wejść do panelu</p>
    <div class="err" id="err"></div>
    <form id="f">
      <label for="pin">PIN</label>
      <input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" autofocus>
      <button type="submit" id="btn">Zaloguj</button>
    </form>`
      : `<p class="sub">Pierwsze uruchomienie — ustaw PIN chroniący ten panel.<br>Zapisz go na karcie instalacyjnej obiektu.</p>
    <div class="err" id="err"></div>
    <form id="f" data-setup="1">
      <label for="pin">Nowy PIN (min. 4 znaki)</label>
      <input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="new-password" autofocus>
      <label for="pin2">Powtórz PIN</label>
      <input id="pin2" type="password" inputmode="numeric" autocomplete="new-password">
      <button type="submit" id="btn">Ustaw PIN i wejdź</button>
    </form>`}
    <p class="note">Reset PIN-u: plik <code>reset-ui-pin</code> w katalogu data Edge<br>albo env <code>EDGE_UI_PIN_RESET=1</code> + restart.</p>
  </div>
<script>
(function () {
  var f = document.getElementById('f');
  if (!f) return;
  var target = ${safeTarget};
  var err = document.getElementById('err');
  var btn = document.getElementById('btn');
  function showErr(msg) { err.textContent = msg; err.style.display = 'block'; }
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    err.style.display = 'none';
    var pin = document.getElementById('pin').value;
    var isSetup = f.getAttribute('data-setup') === '1';
    if (isSetup) {
      var pin2 = document.getElementById('pin2').value;
      if (pin !== pin2) { showErr('PIN-y nie są identyczne'); return; }
    }
    btn.disabled = true;
    fetch(isSetup ? '/auth/pin' : '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: pin }),
      credentials: 'same-origin',
    }).then(function (r) {
      if (r.ok) { location.href = target; return null; }
      return r.json().catch(function () { return {}; });
    }).then(function (body) {
      if (body) { showErr((body && body.message) || 'Błąd logowania'); btn.disabled = false; }
    }).catch(function () { showErr('Brak połączenia z Edge'); btn.disabled = false; });
  });
})();
</script>
</body>
</html>`
  }
}
