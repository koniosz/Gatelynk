import SwiftUI

@main
struct GateLynkApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    @State private var auth = AuthManager()
    // Faza C — domofon. CallManager steruje CallKit + WebRTC; gdy ma aktywną
    // sesję, pokazujemy pełnoekranowy IntercomCallView (po odebraniu z CallKit).
    @State private var call = CallManager.shared

    var body: some Scene {
        WindowGroup {
            // Ekran połączenia pokazujemy jako NAKŁADKĘ w ZStacku (nie przez
            // fullScreenCover, który na poziomie App/Scene po cichu nie prezentował
            // się — biały ekran mimo że audio i snapshoty grały). Warunek
            // `call.activeSession != nil` czytany WPROST w body → SwiftUI śledzi
            // zmianę i renderuje IntercomCallView na wierzchu jak każdą inną treść.
            ZStack {
                Group {
                    if auth.isRestoring {
                        SplashView()
                    } else if auth.isLoggedIn {
                        MainTabView()
                    } else {
                        LoginView()
                    }
                }
                .environment(auth)
                .task { await auth.restoreSession() }

                if call.activeSession != nil {
                    IntercomCallView(call: call)
                        .transition(.opacity)
                        .zIndex(100)
                }
            }
            .animation(.easeInOut(duration: 0.2), value: call.activeSession != nil)
        }
    }
}

// MARK: - SplashView
//
// Pokazywany podczas `auth.isRestoring` — restore JWT z keychain + GET /me.
//
// 2026-07-04 redesign: wcześniej bitmapa `GateLynkLogo` (granatowy tagline
// nieczytelny na czarnym tle w dark mode) + goły ProgressView na flat
// systemBackground. Teraz: ciemny gradient spójny z GLTokens darkClassic
// (bg0 #06080F → #16203A), wektorowe „G" (GateLynkBrandGShape z LoginView)
// w glassowym kaflu z niebieskim glow i delikatnym pulsowaniem, wordmark
// renderowany tekstem SwiftUI (biały „GateLynk" + kicker „BUILDING
// OPERATING SYSTEM" z letterspacingiem) oraz 3 pulsujące kropki zamiast
// systemowego spinnera. Kolor tła zsynchronizowany z colorsetem
// `LaunchBackground` (UILaunchScreen w Info.plist) — brak błysku koloru
// między systemowym launch screenem a splashem.

struct SplashView: View {

    /// Steruje pulsowaniem logo (scale + glow). Włączane w onAppear.
    @State private var pulse = false
    /// Fade-in całości przy pierwszym renderze (elegancki entrance).
    @State private var appeared = false

    // Paleta lokalna — celowo stałe hexy z darkClassic (GLColor.bg* czyta
    // AppTheme z UserDefaults, ale splash ma być brand-stały niezależnie
    // od wybranego motywu — jak launch screen).
    private let bgTop = Color(hex: 0x06080F)
    private let bgMid = Color(hex: 0x0B1020)
    private let bgBottom = Color(hex: 0x16203A)
    /// Brand royal blue, rozjaśniony pod ciemne tło (czytelniejszy niż #2E47E5).
    private let brandBlue = Color(hex: 0x3B5BFF)

    var body: some View {
        ZStack {
            // ── Tło: pionowy ciemny gradient + subtelna niebieska poświata
            LinearGradient(
                colors: [bgTop, bgMid, bgBottom],
                startPoint: .top,
                endPoint: .bottom,
            )
            .ignoresSafeArea()

            RadialGradient(
                colors: [brandBlue.opacity(0.14), .clear],
                center: .init(x: 0.5, y: 0.30),
                startRadius: 0,
                endRadius: 320,
            )
            .ignoresSafeArea()

            VStack(spacing: 28) {
                // ── Logo „G" w glassowym kaflu
                ZStack {
                    RoundedRectangle(cornerRadius: GLRadius.xl2, style: .continuous)
                        .fill(Color.white.opacity(0.05))
                        .overlay(
                            RoundedRectangle(cornerRadius: GLRadius.xl2, style: .continuous)
                                .strokeBorder(
                                    LinearGradient(
                                        colors: [Color.white.opacity(0.22), Color.white.opacity(0.04)],
                                        startPoint: .topLeading,
                                        endPoint: .bottomTrailing,
                                    ),
                                    lineWidth: 1,
                                ),
                        )
                        .frame(width: 116, height: 116)

                    // TEN SAM znak co login i ikona apki (asset GateLynkMark,
                    // wycięty z oficjalnego logo) — spójność brandu wszędzie.
                    Image("GateLynkMark")
                        .resizable()
                        .scaledToFit()
                        .frame(width: 64, height: 64)
                }
                .shadow(color: brandBlue.opacity(pulse ? 0.45 : 0.20), radius: pulse ? 34 : 22, y: 6)
                .scaleEffect(pulse ? 1.04 : 1.0)
                .animation(.easeInOut(duration: 1.4).repeatForever(autoreverses: true), value: pulse)

                // ── Wordmark tekstem (nie bitmapą — czytelny na ciemnym tle)
                VStack(spacing: 8) {
                    Text("GateLynk")
                        .font(.system(size: 30, weight: .heavy))
                        .foregroundStyle(Color(hex: 0xF4F6FB))
                    Text("BUILDING OPERATING SYSTEM")
                        .font(.system(size: 11, weight: .semibold))
                        .tracking(3.2)
                        .foregroundStyle(Color(hex: 0x7C8AAA))
                }

                // ── Progress: 3 pulsujące kropki zamiast gołego spinnera
                SplashLoadingDots(color: brandBlue)
                    .padding(.top, 4)
            }
            .opacity(appeared ? 1 : 0)
            .offset(y: appeared ? 0 : 10)
            .animation(.easeOut(duration: 0.5), value: appeared)
        }
        .preferredColorScheme(.dark)   // jasny status bar na ciemnym tle
        .onAppear {
            appeared = true
            pulse = true
        }
    }
}

/// Trzy kropki z falującym opacity/scale — lekki, ostylowany wskaźnik
/// ładowania w akcencie brandu (zamiast systemowego ProgressView).
struct SplashLoadingDots: View {
    let color: Color
    @State private var animating = false

    var body: some View {
        HStack(spacing: 8) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(color)
                    .frame(width: 7, height: 7)
                    .opacity(animating ? 1.0 : 0.25)
                    .scaleEffect(animating ? 1.0 : 0.7)
                    .animation(
                        .easeInOut(duration: 0.55)
                            .repeatForever(autoreverses: true)
                            .delay(Double(i) * 0.18),
                        value: animating,
                    )
            }
        }
        .onAppear { animating = true }
    }
}
