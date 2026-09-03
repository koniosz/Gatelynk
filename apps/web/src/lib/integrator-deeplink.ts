/**
 * Helper do otwarcia Edge UI klienta przez Cloud deeplink (Sesja 4).
 *
 * Zamiast hardcoded `http://<IP>:4000/ui` w 4 miejscach (Sidebar, EdgesPage,
 * EdgeStatusSection, DeviceTreeSection), wszyscy wołają `openEdgeUI(...)`,
 * który:
 *   1. Otwiera od razu placeholder window (żeby nie być zablokowanym przez
 *      popup-blocker — popup MUSI być spawned w response na click event,
 *      nie po async fetch).
 *   2. Wywołuje POST /integrator/buildings/:id/edges/:eid/deeplink.
 *   3. Po otrzymaniu URL — przekierowuje placeholder na ten URL.
 *   4. Backend Cloud redirect-uje na http://<IP>:4000/ui z one-time tokenem.
 *
 * Failure modes:
 *   - 401 → redirect na login
 *   - 404 → toast „Edge nie istnieje"
 *   - 5xx / network → toast „Brak połączenia"
 */
import { integratorApi } from './integrator-api'

export interface DeeplinkResult {
  url: string
  expiresAt: string
}

/**
 * Spawn-uje nowe okno NA RAZ click event, potem async fetch, potem ustawia
 * `popup.location.href`. Tak Chrome/Safari nie blokują (popup z user-gesture).
 */
export async function openEdgeUI(buildingId: number | string, edgeId: string): Promise<void> {
  const popup = window.open('about:blank', '_blank', 'noopener,noreferrer')
  if (!popup) {
    alert('Pop-up zablokowany przez przeglądarkę. Zezwól na popupy z gatelynk.com i spróbuj ponownie.')
    return
  }

  // Pokazujemy „Łączenie…" placeholder
  popup.document.body.innerHTML = `
    <style>
      body { margin: 0; font-family: 'IBM Plex Sans', system-ui, sans-serif;
             display: flex; align-items: center; justify-content: center;
             height: 100vh; background: #f4f6f9; color: #5f6b7c; }
      div { text-align: center; }
      .spinner { display: inline-block; width: 20px; height: 20px;
                 border: 2px solid #dde2ea; border-top-color: #006fff;
                 border-radius: 50%; animation: s 0.8s linear infinite;
                 margin-bottom: 12px; }
      @keyframes s { to { transform: rotate(360deg); } }
    </style>
    <div>
      <div class="spinner"></div>
      <div>Łączenie z Edge…</div>
    </div>
  `

  try {
    const res = await integratorApi.get<DeeplinkResult>(
      `/integrator/buildings/${buildingId}/edges/${edgeId}/deeplink`,
    )
    popup.location.href = res.data.url
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status
    const msg = status === 404
      ? 'Edge nie istnieje lub nie należy do tego obiektu'
      : status === 401
        ? 'Sesja wygasła — zaloguj się ponownie w głównym oknie'
        : 'Brak połączenia z Cloud — sprawdź sieć i spróbuj ponownie'
    popup.document.body.innerHTML = `
      <div style="text-align:center; padding: 40px; font-family: 'IBM Plex Sans', system-ui;">
        <div style="font-size: 14px; color: #c52a2a; margin-bottom: 8px;">Nie udało się otworzyć</div>
        <div style="font-size: 12px; color: #5f6b7c;">${escapeHtml(msg)}</div>
      </div>
    `
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
