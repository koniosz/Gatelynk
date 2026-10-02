import SwiftUI

// MARK: - GateLynk β — Glass Depth Premium
//
// PRODUKCYJNA apka mieszkańca w designie Glass Depth Premium
// (docs/design/glass-depth-2026-06-10) — decyzja właściciela 2026-07-07:
// osobna pozycja App Store (bundle com.gatelynk.app.glass) OBOK głównej.
// Warstwa danych (APIClient/AuthManager/Models/EdgeAssistantClient/
// AppDelegate) + warstwa rozmów (VoIPManager/CallManager/IntercomCallView,
// WebRTC SPM) współdzielone z targetem GateLynk.
//
// Design jest dark-only — wymuszamy .preferredColorScheme(.dark).

@main
struct GateLynkGlassApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    @State private var auth = AuthManager()
    @State private var toast = GlassToastCenter()
    // Domofon (2026-07-07): Glass linkuje WebRTC i kompiluje VoIPManager/
    // CallManager/IntercomCallView. Ekran rozmowy jako nakładka w ZStacku
    // (wzorzec z GateLynkApp — fullScreenCover na poziomie Scene bywa
    // cicho nieprezentowany). Incoming: VoIP push → AppDelegate.setupVoIP →
    // CallManager.reportIncomingCall (CallKit z nazwą stacji).
    @State private var call = CallManager.shared

    var body: some Scene {
        WindowGroup {
            #if GATELYNK_BLACK && DEBUG
            if BlackPreviewMode.enabled {
                BlackPreview()
                    .preferredColorScheme(.dark)
            } else {
                residentApplication
            }
            #else
            residentApplication
            #endif
        }
    }

    private var residentApplication: some View {
            ZStack {
                Group {
                    if auth.isRestoring {
                        GlassSplashView()
                    } else if auth.isLoggedIn {
                        // `.id(residentId)` — przełączenie nieruchomości tworzy
                        // GlassHomeView od nowa (deck, kafle i dane nowego
                        // budynku ładują się od zera, otwarte sheety znikają).
                        GlassHomeView()
                            .id(auth.currentResidentId)
                    } else {
                        GlassLoginView()
                    }
                }
                .environment(auth)
                .environment(toast)
                .task { await auth.restoreSession() }

                if call.activeSession != nil {
                    IntercomCallView(call: call)
                        .transition(.opacity)
                        .zIndex(100)
                }
            }
            .animation(.easeInOut(duration: 0.2), value: call.activeSession != nil)
            .preferredColorScheme(.dark)
    }
}

// MARK: - Splash (podczas restore sesji)
//
// 2026-07-17: przeniesiony 1:1 design splasha z apki GateLynk Beta
// (SplashView w GateLynkApp.swift) — ciemny brand-gradient, wektorowy znak
// w glassowym kaflu z pulsującym niebieskim glow, wordmark tekstem
// i 3 pulsujące kropki zamiast systemowego spinnera. Splash jest
// brand-stały (stałe hexy darkClassic), niezależny od pory dnia.

struct GlassSplashView: View {

    /// Steruje pulsowaniem logo (scale + glow). Włączane w onAppear.
    @State private var pulse = false
    /// Fade-in całości przy pierwszym renderze (elegancki entrance).
    @State private var appeared = false

    private let bgTop = Color(hex: 0x06080F)
    private let bgMid = Color(hex: 0x0B1020)
    private let bgBottom = Color(hex: 0x16203A)
    /// Brand royal blue, rozjaśniony pod ciemne tło.
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
                // ── Logo w glassowym kaflu
                ZStack {
                    RoundedRectangle(cornerRadius: 30, style: .continuous)
                        .fill(Color.white.opacity(0.05))
                        .overlay(
                            RoundedRectangle(cornerRadius: 30, style: .continuous)
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

                    // Ten sam znak co login i ikona apki — spójność brandu.
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
                GlassSplashLoadingDots(color: brandBlue)
                    .padding(.top, 4)
            }
            .opacity(appeared ? 1 : 0)
            .offset(y: appeared ? 0 : 10)
            .animation(.easeOut(duration: 0.5), value: appeared)
        }
        .onAppear {
            appeared = true
            pulse = true
        }
    }
}

/// Trzy kropki z falującym opacity/scale — lekki, ostylowany wskaźnik
/// ładowania w akcencie brandu (kopia SplashLoadingDots z targetu GateLynk,
/// który nie jest kompilowany w Glass).
struct GlassSplashLoadingDots: View {
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
