# Handoff: Aplikacja Gatelynk — interfejs mieszkańca

## Overview
This package contains the design for **Gatelynk**, a mobile app for residents of a gated/private residential community (osiedle). The user opens the gate (entry + exit), manages guests, vehicles, parcels, tickets, and payments, and gets community updates — all from a single phone screen.

The handoff covers the resident-side mobile UI (iOS-style frame at 393×852). It does not cover admin/back-office screens.

## About the Design Files
The files in this bundle are **design references created in HTML/JSX** — high-fidelity prototypes showing the intended look and behavior. They are **not production code to copy directly**.

The implementer's job is to **recreate these designs in the target codebase's environment** (React Native, Flutter, native iOS/Android, or React web — whatever your Claude Code project uses) following that project's existing patterns, component library, navigation system, and state management. Treat the JSX as a visual spec, not a drop-in module.

If your codebase already has a design system (buttons, cards, sheets, icons), use it. The tokens here are a guide for color/spacing/typography intent — map them to your existing tokens where possible.

## Fidelity
**High-fidelity (hifi).** Pixel-level intent: final spacing, colors, type weights, radii, shadows, and interactions are all decided. Match it closely.

## How to use this package with Claude Code

1. **Drop this folder into your repo** (e.g. `docs/design/gatelynk-resident/`).
2. **Open the HTML prototype** in a browser to interact with the design — toggle the Tweaks panel (top-right) to see variants of Home and the gate-open interaction.
3. **Point Claude Code at this README first**, then `source/` for the JSX implementation, then the prototype HTML for live behavior. A good kickoff prompt:
   > "Read `docs/design/gatelynk-resident/README.md` and the source under `source/`. The HTML at the root is a working prototype — open it to see interactions. Implement these screens in our app using our existing component library and routing. Start with the Home (Glass Premium variant) and the gate-open Hold interaction."
4. **Pick the variants you want** — there are 6 Home layouts (v1–v6) and 3 gate interactions (Tap / Hold / Slide). The shipped prototype defaults to **Home v3 (Glass Premium)** and **Hold**. Pick one of each, drop the rest.

## Tech in the prototype (so you can read the source)
- React 18 + Babel inline JSX (one HTML file, multiple `<script type="text/babel">` blocks)
- No build tooling, no router, no state library — `useState` for everything, tab switching via a single `activeTab` string in `app.jsx`
- Design tokens in `source/styles/tokens.css` as CSS variables, dark + light themes via `[data-theme]`
- Icons are inline SVG components in `source/components/icons.jsx`

This is deliberately bare so the design intent is unambiguous. **None of this architecture should leak into your production app.**

## Screens

### 1. Home (default tab)
Six variants exist. **Ship v3 (Glass Premium)** unless you have a reason to pick another.

**v3 — Glass Premium** (`source/screens/home-v3.jsx`)
- Full-bleed photo of the building at the top (hero, ~360px tall). Gradient overlay fading to bg color at the bottom for legibility.
- Address pill + weather pill overlaid on photo (top).
- **Primary "Otwórz" button** — full-width purple gradient card, ~64px tall, opens the gate sheet. Sits slightly lifted over the photo bottom edge.
- **3 quick-action tiles** below: Pojazdy / Goście / Płatności. Each tile is a small card (~80px tall): icon (centered, 22–28px) + label (12px). Payments tile shows a red `!` badge if there's an outstanding balance.
- **AI bar** — pill-shaped input "Zapytaj Gatelynk AI…" with a sparkle icon. Tapping opens an AI sheet.
- **Status card** — "Mój dom" with Tedee/Nuki lock state + open/close.
- **Activity feed** — recent gate openings, parcels, tickets.

Other variants in `source/screens/home-v1.jsx`…`home-v6.jsx`:
- v1 Refined Classic — denser cleanup of the original
- v2 Big Action — gate button is the centerpiece
- v4 Minimal — line-heavy, lots of white space
- v5 Smart Dashboard — smart-home tile grid
- v6 Activity Feed — timeline-first

### 2. Gate open (modal, full-screen)
`source/screens/gate.jsx`. Triggered from the "Otwórz" button. Three interaction variants:
- **Tap** — one big button, single press, immediate confirmation.
- **Hold** — circular button, hold for 3s (progress ring fills). Default.
- **Slide** — slide-to-confirm thumb across a track.

All three show: direction (entry/exit), gate name, success state, then auto-close after ~2s.

### 3. Goście (Guests) — bottom tab
`source/screens/secondary.jsx` → `GuestsScreen`. List of upcoming + past guests with QR-code passes you can share.

### 4. Zgłoszenia (Tickets) — bottom tab
`source/screens/secondary.jsx` → `TicketsScreen`. List of resident-submitted tickets with status pills.

### 5. Przesyłki (Parcels) — bottom tab
`source/screens/secondary.jsx` → `ParcelsScreen`. Parcel locker pickups with codes.

### 6. Pojazdy (Vehicles)
`source/screens/vehicles.jsx`. Registered plates with auto-recognition toggle. Accessed from the Home tile or from More.

### 7. Więcej / Profil — bottom tab
`source/screens/secondary.jsx` → `ProfileScreen`. Account, payments, vehicles, theme toggle (dark/light).

## Bottom tab bar
5 tabs, ~96px tall including safe-area:
**Dom · Goście · Zgłoszenia · Przesyłki · Więcej**
Active tab: filled icon + accent color. Inactive: stroke icon + tertiary text. See `source/components/ui.jsx` → `TabBar`.

## Design Tokens
The canonical token file is `source/styles/tokens.css`. It defines both dark and light themes on `[data-theme]`. The headlines:

### Colors (dark theme — primary)
- **Backgrounds (layered):** `--bg-0` #06080F · `--bg-1` #0B1020 (app) · `--bg-2` #131A2E (card) · `--bg-3` #1B2440 (elevated) · `--bg-4` #232E55 (hover)
- **Text:** `--text-primary` #F4F6FB · `--text-secondary` #B7C0D8 · `--text-tertiary` #7C8AAA · `--text-disabled` #4F5A77
- **Accent (soft violet — primary brand):** `--accent-300` #A78BFA · `--accent-400` #8B6BF0 · `--accent-500` #7050E0 · glow rgba(167,139,250,0.35)
- **Semantic:** success #34D399 · warning #FBBF24 · danger #F87171 · info #60A5FA

### Colors (light theme)
- Surfaces: #EEF1F8 → #F6F8FC → #FFFFFF
- Text: #0B1020 / #475069 / #6E7891
- Accent: #7050E0 (deeper for contrast)

### Typography
- **Family:** Geist (with system fallbacks: SF Pro, Inter, system-ui)
- Letter-spacing on screen root: `-0.01em`
- Display sizes are inline in each screen file — there's no formal scale; common values: 32/28/22/17/15/13/11

### Radius
`--r-sm` 8 · `--r-md` 12 · `--r-lg` 16 · `--r-xl` 20 · `--r-2xl` 24 · `--r-3xl` 32 · `--r-full` 999

### Shadows
- `--shadow-sm` 0 1px 2px rgba(0,0,0,.30)
- `--shadow-md` 0 8px 24px rgba(0,0,0,.35)
- `--shadow-lg` 0 20px 50px rgba(0,0,0,.45)
- `--shadow-glow` 0 0 40px var(--accent-glow)

### Spacing
No formal scale — inline padding/margin/gap values. Common: 4, 8, 10, 12, 14, 16, 20, 24.

## Icons
All icons are inline SVG in `source/components/icons.jsx`, 24×24 viewBox, stroke-based (1.8px) except `IconCar` which is filled (front-view car silhouette with windshield, grille, and two headlights). Replace with your icon system (Lucide, SF Symbols, Material Symbols) where possible — match the stroke weight and visual style.

## Assets
- **Hero photo of the building** — embedded as a base64 data URL in the HTML and mapped to a CSS class `.building-hero`. Replace with the real property photo at integration time.
- No other raster assets. Everything else is SVG/CSS.

## Interactions
- **Gate open** — see screen 2 above. The "Hold" variant uses a 3-second progress ring; release before 3s cancels.
- **Tab switching** — single `activeTab` state in `app.jsx`. No transitions between tabs in the prototype; your app should use its native navigator (React Navigation, SwiftUI NavigationStack, etc.).
- **Sheet open** — bottom sheets for AI and gate confirmation use simple opacity/transform animations on mount.
- **Theme** — toggled from Profile screen. Sets `data-theme="light"` or `"dark"` on the screen root.

## State
Trivial — all `useState`:
- `activeTab: 'home' | 'guests' | 'tickets' | 'parcels' | 'vehicles' | 'more'`
- `gateOpen: null | 'entry' | 'exit'`
- Each screen owns its own local state (sheets, filters, form input)

Your real app will need: auth/session, gate-control API, guest CRUD, parcel locker integration, payments, push notifications, AI chat backend. None of that is modeled here.

## Files in this bundle
```
README.md                       ← you are here
Gatelynk Prototype.html         ← live, interactive prototype (open in browser)
source/
  app.jsx                       ← root composition + tab routing + Tweaks panel
  styles/tokens.css             ← design tokens (dark + light)
  components/
    icons.jsx                   ← inline SVG icon set
    ui.jsx                      ← StatusBar, TabBar, Card, Pill, SectionHeader, etc.
  screens/
    home-v1.jsx … home-v6.jsx   ← six Home variants (ship v3)
    gate.jsx                    ← gate-open modal (Tap / Hold / Slide)
    secondary.jsx               ← Guests, Tickets, Parcels, Profile screens
    vehicles.jsx                ← Vehicles screen
  data/                         ← mock data fixtures used across screens
```

## Notes for the implementer
- The prototype is in Polish (pl). If your app is multilingual, treat all Polish strings as the `pl` reference and run them through your i18n pipeline.
- "Gatelynk AI" is an aspirational chat surface — wire it to whatever LLM endpoint your backend exposes (or stub it for now).
- The 3 gate variants exist because the user wanted to compare; pick one for production rather than shipping all three.
