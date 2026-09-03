import SwiftUI

// MARK: - GateLynk γ — Glass Depth Premium (handoff v5)
//
// TRZECI, alternatywny target aplikacji mieszkańca w designie „Glass Depth
// Premium" wg handoffu v5 (docs/design/glass-depth-v5-2026-07-02). Osobny
// target `GateLynkGamma`, bundle ID com.gatelynk.app.gamma — instaluje się
// OBOK głównej apki i wariantu β (GateLynkGlass), do porównania UX. Warstwa
// danych (APIClient/AuthManager/Models/EdgeAssistantClient/AppDelegate) jest
// współdzielona z targetem GateLynk.
//
// Design jest dark-only — wymuszamy .preferredColorScheme(.dark).

@main
struct GateLynkGammaApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    @State private var auth = AuthManager()
    @State private var toast = GammaToastCenter()

    var body: some Scene {
        WindowGroup {
            Group {
                if auth.isRestoring {
                    GammaSplashView()
                } else if auth.isLoggedIn {
                    GammaHomeView()
                } else {
                    GammaLoginView()
                }
            }
            .environment(auth)
            .environment(toast)
            .preferredColorScheme(.dark)
            .task { await auth.restoreSession() }
        }
    }
}

// MARK: - Splash (podczas restore sesji)

struct GammaSplashView: View {
    var body: some View {
        ZStack {
            GammaBackground(tod: .fromClock())

            VStack(spacing: 14) {
                Image("GateLynkMark")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 56, height: 56)
                Text("GateLynk")
                    .font(.system(size: 30, weight: .bold))
                    .tracking(-0.9)
                    .foregroundStyle(.white)
                Text("GLASS DEPTH · γ")
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(2.5)
                    .foregroundStyle(.white.opacity(0.6))
                ProgressView()
                    .tint(.white.opacity(0.7))
                    .padding(.top, 10)
            }
        }
    }
}
