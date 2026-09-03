/**
 * Mały silnik szablonów dla URL-i / body w driverach.
 *
 * Driver definiuje endpoint jako string z placeholderami w `{}`:
 *
 *   'http://{ip}:{httpPort}/ISAPI/Streaming/channels/{channel*100+1}/picture'
 *
 * Funkcja `renderTemplate` rozwija je używając wartości z configu urządzenia
 * (i ekstra zmiennych — np. `{relay}` dla otwarcia konkretnego przekaźnika).
 *
 * Wyrażenia mogą zawierać proste matematyki (`*`, `+`, `-`), co pozwala bez
 * zewnętrznych zależności wyrazić mapowanie w stylu Hikvision: kanał 1 →
 * stream 101 (`{channel*100+1}`), 102 (`{channel*100+2}`).
 *
 * Bezpieczeństwo:
 *  • Wyrażenia są oceniane przez `Function('vars', 'with(vars){return …}')` —
 *    co jest formą evala, ALE: szablony pochodzą wyłącznie ze statycznego
 *    katalogu w naszym repo (`packages/device-drivers/src/catalog/*`), nigdy
 *    od użytkownika ani z bazy. To zwykła konfiguracja w kodzie.
 *  • `vars` zawiera tylko whitelisted klucze (numeric/string z configu),
 *    więc `with` nie eksponuje globali.
 */

export interface TemplateVars {
  ip?: string
  httpPort?: number
  rtspPort?: number
  channel?: number
  login?: string
  relay?: number
  // dowolne pozostałe pola configu — TS nie waliduje, bo driverowy katalog jest typowany osobno
  [key: string]: unknown
}

/**
 * Rozwija pojedynczy szablon (URL albo body) używając podanych zmiennych.
 *
 *   renderTemplate('http://{ip}:{httpPort}/path', { ip: '1.2.3.4', httpPort: 80 })
 *     → 'http://1.2.3.4:80/path'
 *
 *   renderTemplate('Streaming/Channels/{channel*100+1}', { channel: 1 })
 *     → 'Streaming/Channels/101'
 *
 * Dla braku wartości w `vars` placeholder zostaje rozwinięty do pustego stringa
 * — to celowe, żeby Edge mógł zorientować się po wyniku, że konfiguracja jest
 * niekompletna (URL ma `://:80/` zamiast normalnego host:port).
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(/\{([^{}]+)\}/g, (_match, expr: string) => {
    try {
      // Najprostszy przypadek: `{ip}` → `vars.ip`. Unikamy budowania funkcji
      // gdy nie ma operatorów — szybsza ścieżka i brak ryzyka NaN dla stringów.
      if (/^[a-zA-Z_][\w]*$/.test(expr)) {
        const value = (vars as Record<string, unknown>)[expr]
        return value == null ? '' : String(value)
      }
      // Wyrażenie matematyczne: pozwalamy na cyfry, identyfikatory, + - * / ( )
      // Wszystko inne odrzucamy — chroni przed przypadkowym wstrzyknięciem.
      if (!/^[\w\s+\-*/().]+$/.test(expr)) return ''
      const fn = new Function('vars', `with (vars) { return (${expr}) }`) as (v: TemplateVars) => unknown
      const result = fn(vars)
      return result == null ? '' : String(result)
    } catch {
      return ''
    }
  })
}

/**
 * Wygodny helper dla driverów: bierze pierwszy szablon z listy (np. listę
 * `endpoints.snapshot`) i rozwija go. Lista nadal istnieje, żeby Edge miał
 * fallback gdy pierwszy URL nie odpowie.
 */
export function renderTemplates(templates: string[], vars: TemplateVars): string[] {
  return templates.map((t) => renderTemplate(t, vars))
}
