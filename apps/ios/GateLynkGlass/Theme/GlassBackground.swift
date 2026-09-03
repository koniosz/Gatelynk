import SwiftUI

// MARK: - Tło 3-warstwowe (README → "Tło (3 warstwy animacji)")
//
// 1. Zdjęcie budynku (asset `BuildingPhoto`) z Ken Burns 26s alternate.
// 2. Fluid aurora — TimelineView+Canvas, 5 orbów na ścieżkach Lissajous,
//    blend .screen, oddychanie ±18%, hue +4°/s, ~30fps. (Wersja bez
//    przyciągania do kursora — na telefonie nie ma kursora.)
// 3. Cząsteczki — 14 świetlnych drobinek unoszących się ku górze, w tym
//    samym Canvas (deterministyczne pseudo-losowo z indeksu).
//
// Pora dnia: nakładki gradientowe + słońce (dzień/wieczór) + ciepłe światła
// okien (noc), przejścia 1.2s.

struct GlassBackground: View {
    let tod: GlassTimeOfDay

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var kenBurns = false

    var body: some View {
        ZStack {
            GlassColor.scene

            // 1. Zdjęcie budynku + Ken Burns
            GeometryReader { geo in
                buildingPhoto(in: geo.size)
            }

            // Przyciemnienie bazowe (bg-dim)
            LinearGradient(
                stops: [
                    .init(color: dimColor.opacity(0.50), location: 0),
                    .init(color: dimColor.opacity(0.12), location: 0.28),
                    .init(color: dimColor.opacity(0.55), location: 0.68),
                    .init(color: dimColor.opacity(0.94), location: 1),
                ],
                startPoint: .top, endPoint: .bottom
            )

            // Nakładki pory dnia
            todOverlays

            // Słońce (dzień / wieczór)
            sun

            // Światła okien (noc)
            nightLights

            // 2+3. Aurora + cząsteczki
            if !reduceMotion {
                GlassAuroraCanvas()
            }
        }
        .ignoresSafeArea()
        .animation(.easeInOut(duration: 1.2), value: tod)
    }

    private var dimColor: Color { Color(red: 8/255, green: 10/255, blue: 20/255) }

    // MARK: Zdjęcie

    @ViewBuilder
    private func buildingPhoto(in size: CGSize) -> some View {
        Image("BuildingPhoto")
            .resizable()
            .scaledToFill()
            .frame(width: size.width, height: size.height)
            .clipped()
            // Pora dnia: CSS brightness(.55)/.8 → przybliżenie czarną nakładką
            .overlay(Color.black.opacity(photoDim))
            .saturation(photoSaturation)
            .scaleEffect(kenBurns ? 1.08 : 1.0)
            .offset(y: kenBurns ? -12 : 0)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 26).repeatForever(autoreverses: true)) {
                    kenBurns = true
                }
            }
    }

    private var photoDim: Double {
        switch tod {
        case .day:     return 0
        case .evening: return 0.20
        case .night:   return 0.45
        }
    }

    private var photoSaturation: Double {
        switch tod {
        case .day:     return 1.0
        case .evening: return 1.1
        case .night:   return 0.8
        }
    }

    // MARK: Nakładki pory dnia

    private var todOverlays: some View {
        ZStack {
            // Dzień: ciepła nakładka u góry
            LinearGradient(
                stops: [
                    .init(color: Color(red: 1, green: 214/255, blue: 140/255).opacity(0.16), location: 0),
                    .init(color: Color(red: 1, green: 244/255, blue: 214/255).opacity(0.06), location: 0.35),
                    .init(color: .clear, location: 0.7),
                ],
                startPoint: .top, endPoint: .bottom
            )
            .opacity(tod == .day ? 1 : 0)

            // Wieczór: pomarańcz/róż → granat
            LinearGradient(
                stops: [
                    .init(color: Color(red: 1, green: 122/255, blue: 80/255).opacity(0.22), location: 0),
                    .init(color: Color(red: 192/255, green: 80/255, blue: 140/255).opacity(0.14), location: 0.45),
                    .init(color: Color(red: 30/255, green: 20/255, blue: 60/255).opacity(0.25), location: 1),
                ],
                startPoint: .top, endPoint: .bottom
            )
            .opacity(tod == .evening ? 1 : 0)

            // Noc: ciemnoniebieska
            LinearGradient(
                stops: [
                    .init(color: Color(red: 6/255, green: 10/255, blue: 30/255).opacity(0.55), location: 0),
                    .init(color: Color(red: 6/255, green: 10/255, blue: 28/255).opacity(0.40), location: 0.5),
                    .init(color: Color(red: 4/255, green: 6/255, blue: 18/255).opacity(0.55), location: 1),
                ],
                startPoint: .top, endPoint: .bottom
            )
            .opacity(tod == .night ? 1 : 0)
        }
        .allowsHitTesting(false)
    }

    // MARK: Słońce

    private var sun: some View {
        GeometryReader { geo in
            Circle()
                .fill(
                    RadialGradient(
                        colors: sunColors,
                        center: .center, startRadius: 0, endRadius: 60
                    )
                )
                .frame(width: 120, height: 120)
                .blur(radius: 4)
                .blendMode(.screen)
                .position(x: 94, y: tod == .evening ? 210 : 124)
                .opacity(sunOpacity)
                .modifier(GlassBreathing(active: !reduceMotion))
                .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
        }
        .allowsHitTesting(false)
    }

    private var sunColors: [Color] {
        if tod == .evening {
            return [
                Color(red: 1, green: 170/255, blue: 110/255).opacity(0.95),
                Color(red: 1, green: 110/255, blue: 80/255).opacity(0.4),
                .clear,
            ]
        }
        return [
            Color(red: 1, green: 236/255, blue: 170/255).opacity(0.95),
            Color(red: 1, green: 214/255, blue: 120/255).opacity(0.4),
            .clear,
        ]
    }

    private var sunOpacity: Double {
        switch tod {
        case .day:     return 0.9
        case .evening: return 0.55
        case .night:   return 0
        }
    }

    // MARK: Światła okien (noc)

    private var nightLights: some View {
        GeometryReader { geo in
            ZStack {
                ForEach(Array(Self.windowLights.enumerated()), id: \.offset) { idx, wl in
                    Ellipse()
                        .fill(
                            RadialGradient(
                                colors: [
                                    Color(red: 1, green: 196/255, blue: 110/255).opacity(0.85),
                                    Color(red: 1, green: 170/255, blue: 80/255).opacity(0.25),
                                    .clear,
                                ],
                                center: .center, startRadius: 0, endRadius: wl.w / 1.4
                            )
                        )
                        .frame(width: wl.w, height: wl.h)
                        .blur(radius: 3)
                        .blendMode(.screen)
                        .position(x: geo.size.width * wl.x, y: geo.size.height * wl.y)
                        .modifier(GlassFlicker(active: !reduceMotion, delay: wl.delay))
                }
            }
        }
        .opacity(tod == .night ? 1 : 0)
        .allowsHitTesting(false)
    }

    private struct WindowLight { let x: Double; let y: Double; let w: CGFloat; let h: CGFloat; let delay: Double }
    private static let windowLights: [WindowLight] = [
        .init(x: 0.18, y: 0.14, w: 26, h: 14, delay: 0),
        .init(x: 0.34, y: 0.11, w: 20, h: 12, delay: 1.4),
        .init(x: 0.58, y: 0.16, w: 24, h: 13, delay: 2.6),
        .init(x: 0.74, y: 0.12, w: 18, h: 11, delay: 0.8),
        .init(x: 0.26, y: 0.24, w: 22, h: 12, delay: 3.4),
        .init(x: 0.66, y: 0.26, w: 26, h: 14, delay: 1.9),
        .init(x: 0.46, y: 0.21, w: 18, h: 11, delay: 4.2),
    ]
}

// MARK: - "Oddychanie" słońca (9s ease-in-out)

private struct GlassBreathing: ViewModifier {
    let active: Bool
    @State private var scaled = false

    func body(content: Content) -> some View {
        content
            .scaleEffect(scaled ? 1.08 : 1.0)
            .onAppear {
                guard active else { return }
                withAnimation(.easeInOut(duration: 4.5).repeatForever(autoreverses: true)) {
                    scaled = true
                }
            }
    }
}

// MARK: - Flicker świateł okien

private struct GlassFlicker: ViewModifier {
    let active: Bool
    let delay: Double
    @State private var dimmed = false

    func body(content: Content) -> some View {
        content
            .opacity(dimmed ? 0.65 : 0.9)
            .onAppear {
                guard active else { return }
                withAnimation(.easeInOut(duration: 3).repeatForever(autoreverses: true).delay(delay)) {
                    dimmed = true
                }
            }
    }
}

// MARK: - Fluid aurora + cząsteczki (Canvas @ ~30fps)

struct GlassAuroraCanvas: View {
    private struct Orb {
        let hue: Double; let r: Double; let a: Double
        let fx: Double; let fy: Double
        let px: Double; let py: Double
        let ox: Double; let oy: Double
    }

    // 1:1 z prototypu HTML (orbs array)
    private static let orbs: [Orb] = [
        .init(hue: 232, r: 0.50, a: 0.55, fx: 0.11, fy: 0.15, px: 0.0, py: 1.4, ox: 0.72, oy: 0.22),
        .init(hue: 282, r: 0.46, a: 0.45, fx: 0.07, fy: 0.12, px: 2.1, py: 0.6, ox: 0.22, oy: 0.78),
        .init(hue: 158, r: 0.34, a: 0.30, fx: 0.15, fy: 0.09, px: 4.0, py: 2.8, ox: 0.50, oy: 0.50),
        .init(hue: 332, r: 0.30, a: 0.26, fx: 0.05, fy: 0.17, px: 1.2, py: 5.1, ox: 0.82, oy: 0.82),
        .init(hue: 205, r: 0.26, a: 0.30, fx: 0.13, fy: 0.06, px: 3.3, py: 3.9, ox: 0.30, oy: 0.35),
    ]

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
            Canvas { ctx, size in
                let t = timeline.date.timeIntervalSinceReferenceDate
                ctx.blendMode = .screen

                for o in Self.orbs {
                    let bx = o.ox + 0.34 * sin(t * o.fx * 2 + o.px) + 0.12 * sin(t * o.fx * 5.3 + o.py)
                    let by = o.oy + 0.30 * cos(t * o.fy * 2 + o.py) + 0.10 * cos(t * o.fy * 4.1 + o.px)
                    let x = bx * size.width
                    let y = by * size.height
                    let breathe = 1 + 0.18 * sin(t * 0.4 + o.px * 2)
                    let rad = o.r * min(size.width, size.height) * 1.3 * breathe
                    // hue pełza +4°/s
                    var hue = (o.hue + t * 4).truncatingRemainder(dividingBy: 360) / 360
                    if hue < 0 { hue += 1 }

                    let gradient = Gradient(stops: [
                        .init(color: Color(hue: hue, saturation: 0.75, brightness: 0.95, opacity: o.a), location: 0),
                        .init(color: Color(hue: hue, saturation: 0.7, brightness: 0.8, opacity: o.a * 0.35), location: 0.5),
                        .init(color: Color(hue: hue, saturation: 0.65, brightness: 0.7, opacity: 0), location: 1),
                    ])
                    let rect = CGRect(x: x - rad, y: y - rad, width: rad * 2, height: rad * 2)
                    ctx.fill(
                        Path(ellipseIn: rect),
                        with: .radialGradient(
                            gradient,
                            center: CGPoint(x: x, y: y),
                            startRadius: 0, endRadius: rad
                        )
                    )
                }

                // Cząsteczki — 14 drobinek 2-6px, deterministyczne z indeksu
                for i in 0..<14 {
                    let seed = Double(i)
                    let duration = 14.0 + seed.truncatingRemainder(dividingBy: 7) * 2.3
                    let phase = seed * 4.7
                    let progress = ((t + phase) / duration).truncatingRemainder(dividingBy: 1)
                    let px = (0.04 + (seed * 0.073).truncatingRemainder(dividingBy: 0.92)) * size.width
                    let sway = sin(progress * .pi * 2 + seed) * 40 * ((seed.truncatingRemainder(dividingBy: 2)) - 0.5)
                    let py = size.height * (1.05 - progress * 1.1)
                    let dotSize = 2.0 + (seed * 1.31).truncatingRemainder(dividingBy: 4)
                    // krzywa opacity: szybki fade-in, długi fade-out
                    let alpha: Double = progress < 0.08
                        ? progress / 0.08 * 0.7
                        : max(0, 0.7 - (progress - 0.08) * 0.55)

                    let rect = CGRect(x: px + sway - dotSize / 2, y: py - dotSize / 2, width: dotSize, height: dotSize)
                    ctx.fill(
                        Path(ellipseIn: rect),
                        with: .radialGradient(
                            Gradient(colors: [
                                Color.white.opacity(alpha),
                                GlassColor.accentLight.opacity(0),
                            ]),
                            center: CGPoint(x: rect.midX, y: rect.midY),
                            startRadius: 0, endRadius: dotSize
                        )
                    )
                }
            }
            .opacity(0.85)
        }
        .allowsHitTesting(false)
    }
}
