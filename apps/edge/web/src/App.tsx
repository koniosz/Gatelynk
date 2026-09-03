/**
 * GateLynk Edge — App shell.
 *
 * Kompozycja: Sidebar (56px) | (Topbar 52px + content)
 *
 * Theme: dark by default (handoff doc sek. 5), persistowany w localStorage.
 *
 * Routing: Wouter `<Router base="/ui">` bo Express servuje SPA pod tym path-em
 * (`apps/edge/src/main.ts`: `app.use('/ui', express.static('web/dist'))`).
 */
import { Route, Switch, Router } from 'wouter'
import { useEffect, useState } from 'react'
import { Sidebar } from './components/shell/Sidebar'
import { Topbar } from './components/shell/Topbar'
import { SystemPage } from './pages/SystemPage'
import { AccessPage } from './pages/AccessPage'
import { LprReadsPage } from './pages/LprReadsPage'
import { MonitoringPage } from './pages/MonitoringPage'
import { LogsPage } from './pages/LogsPage'
import { SettingsPage } from './pages/SettingsPage'
import { WizardPage } from './pages/WizardPage'
import { AssistantFab } from './components/assistant/AssistantFab'
import { setEdgeTimezone } from './lib/edgeTime'

type Theme = 'light' | 'dark'

const THEME_KEY = 'gle.theme'

export function App() {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem(THEME_KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'dark'
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  // Strefa czasowa obiektu — pobierana RAZ przy starcie, żeby każda strona
  // (nie tylko Ustawienia, które i tak odpytują `/api/system`) formatowała
  // zdarzenia czasem obiektu. Błąd pobrania jest nieszkodliwy: `edgeTime`
  // ma sensowną wartość awaryjną.
  useEffect(() => {
    fetch('/api/system')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setEdgeTimezone(d?.timezone))
      .catch(() => {})
  }, [])

  return (
    <Router base="/ui">
      <div className="app-shell">
        <Sidebar />
        <div className="main">
          <Topbar theme={theme} onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} />
          <div className="tab-content">
            <Switch>
              <Route path="/"           component={SystemPage} />
              <Route path="/access"     component={AccessPage} />
              <Route path="/lpr"        component={LprReadsPage} />
              <Route path="/monitoring" component={MonitoringPage} />
              <Route path="/logs"       component={LogsPage} />
              <Route path="/settings"   component={SettingsPage} />
              <Route path="/wizard"     component={WizardPage} />
              <Route>
                <div className="card" style={{ padding: 48, textAlign: 'center' }}>
                  <h2 style={{ fontSize: 18, marginBottom: 8 }}>404</h2>
                  <p style={{ color: 'var(--muted)', fontSize: 13 }}>Strona nie istnieje.</p>
                </div>
              </Route>
            </Switch>
          </div>
        </div>
        {/* Floating AI Assistant — wisi nad wszystkimi stronami. Mount NA
            ZEWNĄTRZ Switch'a żeby przeżył nawigację między tabami i nie
            tracił otwartej rozmowy. */}
        <AssistantFab />
      </div>
    </Router>
  )
}
