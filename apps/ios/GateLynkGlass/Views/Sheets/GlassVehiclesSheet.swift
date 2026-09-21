import SwiftUI
import PhotosUI

// MARK: - Sheet Pojazdy
//
// Lista pojazdów mieszkańca (z GET /resident/me → Resident.vehicles).
// Polskie tablice w stylu .plate (czarne tło, żółta ramka, mono).
// Dotknięcie wiersza → edycja/usuwanie (PATCH/DELETE /resident/vehicles/:id).
// Dodawanie pojazdu (2026-07-15) — pełny formularz z approval flow:
// POST /resident/vehicles → PENDING, admin zatwierdza w panelu.

struct GlassVehiclesSheet: View {
    let vehicles: [Vehicle]
    let onComingSoon: (GlassUpcomingFeature) -> Void
    /// Odświeżenie listy po edycji/usunięciu (GlassHomeView.loadAll).
    var onReload: () async -> Void = {}
    let onClose: () -> Void

    @Environment(GlassToastCenter.self) private var toast
    @State private var editing: Vehicle?
    /// Widok szczegółów pojazdu (2026-07-16) — tap na wiersz; edycja
    /// dostępna przyciskiem w środku (styl apki producenta auta).
    @State private var detail: Vehicle?
    /// Formularz dodawania pojazdu (2026-07-15).
    @State private var adding = false
    /// Świeża lista z GET /resident/vehicles (2026-07-16) — statusy
    /// zmieniają się po stronie admina (zatwierdzenie), a cache
    /// z /resident/me bywa nieaktualny, gdy apka długo żyje.
    @State private var fresh: [Vehicle]?

    // 2026-08-19 (feedback Konrada): kafelki po 2 w rzędzie zamiast pełnych
    // wierszy — czytelniejsze przy >2 pojazdach. Usuwanie/edycja przez
    // przytrzymanie kafelka (context menu) albo w szczegółach.
    @State private var confirmDelete: Vehicle?

    private let gridColumns = [
        GridItem(.flexible(), spacing: 10),
        GridItem(.flexible(), spacing: 10),
    ]

    var body: some View {
        VStack(spacing: 9) {
            GlassSheetHeader(kicker: "Pojazdy", title: "Twoje samochody", onClose: onClose)

            if displayVehicles.isEmpty {
                GlassSheetEmptyState(
                    icon: "car",
                    text: "Nie masz jeszcze zarejestrowanych pojazdów."
                )
            } else {
                ScrollView(showsIndicators: false) {
                    LazyVGrid(columns: gridColumns, spacing: 10) {
                        ForEach(displayVehicles) { v in
                            tile(v)
                        }
                    }
                }
                .scrollBounceBehavior(.basedOnSize)
            }

            Text("Dotknij pojazd, aby zobaczyć status wjazdu i historię przejazdów. Edycja i usuwanie: menu ⋯.")
                .font(.system(size: 11.5))
                .foregroundStyle(.white.opacity(0.6))
                .multilineTextAlignment(.center)
                .padding(.vertical, 4)

            // 2026-07-15: dodawanie pojazdu DZIAŁA (parity z główną apką —
            // POST /resident/vehicles → status PENDING do zatwierdzenia).
            // Wcześniej zapowiedź WKRÓTCE.
            GlassButton(title: "+ Dodaj pojazd") {
                adding = true
            }
        }
        .task { await refreshLocal() }
        .sheet(item: $detail) { v in
            GlassVehicleDetailSheet(
                vehicle: v,
                onEdit: {
                    // Zamiana sheetów: zamknij szczegóły, po animacji otwórz edycję.
                    detail = nil
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { editing = v }
                },
                onDelete: {
                    let ok = await deleteVehicle(v)
                    if ok { detail = nil }
                    return ok
                }
            )
            .glassNestedSheet()
        }
        .sheet(item: $editing) { v in
            GlassVehicleEditSheet(vehicle: v) {
                await refreshLocal()
                await onReload()
            }
            .environment(toast)
            .glassNestedSheet()
        }
        .sheet(isPresented: $adding) {
            GlassVehicleAddSheet {
                await refreshLocal()
                await onReload()
            }
            .environment(toast)
            .glassNestedSheet()
        }
    }

    /// Cache z rodzica jako fallback, świeży fetch gdy dostępny.
    private var displayVehicles: [Vehicle] { fresh ?? vehicles }

    /// Dociąga aktualne statusy przy każdym otwarciu karty i po mutacjach.
    private func refreshLocal() async {
        if let v: [Vehicle] = try? await APIClient.shared.get("/resident/vehicles") {
            fresh = v
        }
    }

    /// DELETE /resident/vehicles/:id — pojazd znika z rejestru i z białej
    /// listy LPR przy bramie (backend robi sync przy usunięciu).
    /// Zwraca sukces — komponent swipe cofa animację przy błędzie.
    private func deleteVehicle(_ v: Vehicle) async -> Bool {
        do {
            let _: EmptyResponse = try await APIClient.shared.delete("/resident/vehicles/\(v.id)")
            await refreshLocal()
            await onReload()
            toast.show("Pojazd \(v.licensePlate) usunięty")
            return true
        } catch {
            toast.show("Nie udało się usunąć pojazdu", error: true)
            return false
        }
    }

    // MARK: Kafelek pojazdu (2026-08-19) — 2 w rzędzie, styl apek OEM

    private func tile(_ v: Vehicle) -> some View {
        Button {
            detail = v
        } label: {
            VStack(spacing: 0) {
                // Mini-hero: zdjęcie pojazdu albo ikona na radialnym spocie.
                ZStack {
                    if let img = GlassVehiclePhotoField.decode(v.photo) {
                        Image(uiImage: img)
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                    } else {
                        RadialGradient(
                            colors: [GlassColor.accentBlue.opacity(0.32), Color(hex: 0x0B1020)],
                            center: .center, startRadius: 6, endRadius: 110
                        )
                        Image(systemName: "car.side.fill")
                            .font(.system(size: 38))
                            .foregroundStyle(.white.opacity(0.85))
                            .shadow(color: .black.opacity(0.55), radius: 8, y: 4)
                    }
                }
                .frame(height: 84)
                .frame(maxWidth: .infinity)
                .clipped()

                VStack(spacing: 6) {
                    Text(v.displayName)
                        .font(.system(size: 13.5, weight: .semibold))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                    GlassPlateBadge(plate: v.licensePlate)
                    // Status dostępu z danych (V01) — widać go bez otwierania.
                    HStack(spacing: 4) {
                        Circle().fill(statusColor(v.effectiveStatus)).frame(width: 6, height: 6)
                        Text(Self.accessStatusShort(v.effectiveStatus))
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(statusColor(v.effectiveStatus))
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 9)
                .frame(maxWidth: .infinity)
            }
            .background {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color.white.opacity(0.06))
            }
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.13), lineWidth: 1)
            }
            .opacity(v.effectiveStatus == .approved ? 1 : 0.85)
            .shadow(color: .black.opacity(0.3), radius: 10, y: 5)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(v.displayName), tablica \(v.licensePlate). \(Self.accessStatusShort(v.effectiveStatus)).")
        .accessibilityHint("Otwiera szczegóły pojazdu")
        .overlay(alignment: .topTrailing) {
            // Jawne, nazwane akcje — przytrzymanie kafla zostaje skrótem (N01).
            Menu {
                Button { detail = v } label: { Label("Szczegóły i historia", systemImage: "list.bullet.rectangle") }
                Button { editing = v } label: { Label("Edytuj dane", systemImage: "pencil") }
                Button(role: .destructive) { confirmDelete = v } label: { Label("Usuń pojazd", systemImage: "trash") }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 30, height: 30)
                    .background { Circle().fill(Color.black.opacity(0.45)) }
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Akcje: \(v.licensePlate)")
        }
        .contextMenu {
            Button { editing = v } label: { Label("Edytuj dane", systemImage: "pencil") }
            Button(role: .destructive) { confirmDelete = v } label: {
                Label("Usuń pojazd", systemImage: "trash")
            }
        }
        .confirmationDialog(
            "Czy na pewno chcesz usunąć pojazd \(confirmDelete?.licensePlate ?? "")?",
            isPresented: Binding(
                get: { confirmDelete?.id == v.id },
                set: { if !$0 { confirmDelete = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Usuń", role: .destructive) {
                let target = v
                confirmDelete = nil
                Task { _ = await deleteVehicle(target) }
            }
            Button("Anuluj", role: .cancel) { confirmDelete = nil }
        } message: {
            Text("Pojazd zniknie z rejestru, a automatyczny wjazd dla tej tablicy zostanie wyłączony. Tej operacji nie można cofnąć.")
        }
    }

    /// Krótki status DOSTĘPU wynikający ze statusu pojazdu w rejestrze:
    /// zatwierdzony = tablica na liście uprawnionych kamer LPR.
    static func accessStatusShort(_ s: VehicleStatus) -> String {
        switch s {
        case .approved: return "Automatyczny wjazd włączony"
        case .pending:  return "Czeka na zatwierdzenie"
        case .rejected: return "Odrzucony"
        default:        return "\(s.label) — bez automatycznego wjazdu"
        }
    }

    private func statusColor(_ s: VehicleStatus) -> Color {
        switch s {
        case .approved: return GlassColor.successLight
        case .pending:  return GlassColor.orbAmber1
        default:        return GlassColor.dangerSoft
        }
    }
}

// MARK: - Edycja / usuwanie pojazdu (PATCH/DELETE /resident/vehicles/:id)

private struct GlassVehicleEditSheet: View {
    let vehicle: Vehicle
    let onChange: () async -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(GlassToastCenter.self) private var toast

    @State private var make: String
    @State private var model: String
    @State private var color: String
    @State private var plate: String
    @State private var saving = false
    @State private var deleting = false
    @State private var confirmDelete = false
    @State private var error: String?
    /// Nowo wybrane zdjęcie (nil = bez zmian) / flaga usunięcia istniejącego.
    @State private var photoData: Data?
    @State private var photoRemoved = false

    init(vehicle: Vehicle, onChange: @escaping () async -> Void) {
        self.vehicle = vehicle
        self.onChange = onChange
        _make = State(initialValue: vehicle.make)
        _model = State(initialValue: vehicle.model ?? "")
        _color = State(initialValue: vehicle.color)
        _plate = State(initialValue: vehicle.licensePlate)
    }

    private var plateChanged: Bool {
        plate.trimmingCharacters(in: .whitespaces).uppercased() != vehicle.licensePlate
    }

    var body: some View {
        VStack(spacing: 16) {
            GlassSheetHeader(kicker: "Pojazd", title: "Edytuj pojazd", onClose: { dismiss() })

            ScrollView(showsIndicators: false) {
                VStack(spacing: 18) {
                    vehicleHeaderCard

                    VStack(spacing: 14) {
                        GlassVehicleBrandField(make: $make)
                        field("Model", text: $model, placeholder: "opcjonalnie", icon: "tag.fill")
                        field("Kolor", text: $color, placeholder: "np. czarny", icon: "paintpalette.fill")
                        field("Tablica rejestracyjna", text: $plate, placeholder: "WA12345", icon: "number", plate: true)
                        GlassVehiclePhotoField(photoData: $photoData, removed: $photoRemoved, existing: vehicle.photo)
                    }

                    if plateChanged && vehicle.effectiveStatus == .approved {
                        infoBanner
                    }
                    if let error {
                        errorBanner(error)
                    }
                }
                .padding(.top, 2)
                .padding(.bottom, 6)
            }
            .scrollBounceBehavior(.basedOnSize)

            VStack(spacing: 10) {
                GlassButton(title: "Zapisz zmiany", busyText: "Zapisuję…", isBusy: saving) {
                    Task { await save() }
                }
                .disabled(saving || deleting || make.trimmingCharacters(in: .whitespaces).isEmpty
                          || plate.trimmingCharacters(in: .whitespaces).isEmpty)

                Button {
                    confirmDelete = true
                } label: {
                    HStack(spacing: 8) {
                        if deleting {
                            ProgressView().tint(GlassColor.dangerSoft).scaleEffect(0.8)
                        } else {
                            Image(systemName: "trash.fill").font(.system(size: 14, weight: .semibold))
                        }
                        Text(deleting ? "Usuwam…" : "Usuń pojazd")
                            .font(.system(size: 15, weight: .semibold))
                    }
                    .foregroundStyle(GlassColor.dangerSoft)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background {
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(GlassColor.danger.opacity(0.12))
                            .overlay {
                                RoundedRectangle(cornerRadius: 16, style: .continuous)
                                    .strokeBorder(GlassColor.dangerSoft.opacity(0.45), lineWidth: 1)
                            }
                    }
                }
                .buttonStyle(.plain)
                .disabled(saving || deleting)
            }
        }
        .confirmationDialog("Usunąć pojazd \(vehicle.licensePlate)?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Usuń pojazd", role: .destructive) { Task { await remove() } }
            Button("Anuluj", role: .cancel) {}
        } message: {
            Text("Pojazd zniknie z białej listy przy bramie. Tej operacji nie można cofnąć.")
        }
    }

    // Nagłówek: podgląd edytowanego auta (żeby było jasne, co edytujesz).
    private var vehicleHeaderCard: some View {
        HStack(spacing: 14) {
            GlassOrb(gradient: [GlassColor.accentBlue, GlassColor.orbViolet], systemName: "car.fill", size: 46)
            VStack(alignment: .leading, spacing: 6) {
                Text(vehicle.displayName)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                HStack(spacing: 8) {
                    GlassPlateBadge(plate: vehicle.licensePlate)
                    Text(vehicle.effectiveStatus.label)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(statusColor(vehicle.effectiveStatus))
                }
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .glassCard()
    }

    private func statusColor(_ s: VehicleStatus) -> Color {
        switch s {
        case .approved: return GlassColor.successLight
        case .pending:  return GlassColor.orbAmber1
        default:        return GlassColor.dangerSoft
        }
    }

    private var infoBanner: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 14))
                .foregroundStyle(GlassColor.orbAmber1)
            Text("Zmiana tablicy wymaga ponownego zatwierdzenia przez administratora — auto wróci do statusu oczekującego.")
                .font(.system(size: 12.5))
                .foregroundStyle(.white.opacity(0.85))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(13)
        .background {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(GlassColor.orbAmber1.opacity(0.12))
                .overlay {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(GlassColor.orbAmber1.opacity(0.35), lineWidth: 1)
                }
        }
    }

    private func errorBanner(_ msg: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "xmark.octagon.fill")
                .font(.system(size: 14))
                .foregroundStyle(GlassColor.dangerSoft)
            Text(msg)
                .font(.system(size: 12.5))
                .foregroundStyle(.white.opacity(0.85))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(13)
        .background {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(GlassColor.danger.opacity(0.12))
        }
    }

    private func field(_ label: String, text: Binding<String>, placeholder: String, icon: String, plate: Bool = false) -> some View {
        GlassVehicleField(label: label, text: text, placeholder: placeholder, icon: icon, plate: plate)
    }

    private struct PatchBody: Encodable {
        let make: String
        let model: String?
        let color: String
        let licensePlate: String
        /// Podwójny Optional: nil = klucz pominięty (bez zmian),
        /// .some(nil) = jawny null (usuń zdjęcie), .some(v) = nowe zdjęcie.
        let photo: String??

        enum CodingKeys: String, CodingKey { case make, model, color, licensePlate, photo }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(make, forKey: .make)
            try c.encode(model, forKey: .model)
            try c.encode(color, forKey: .color)
            try c.encode(licensePlate, forKey: .licensePlate)
            if let photo { try c.encode(photo, forKey: .photo) }
        }
    }

    /// Tri-state zdjęcia do PATCH: usunięte → jawny null, nowe → base64,
    /// bez zmian → klucz pominięty.
    private var photoPatch: String?? {
        if photoRemoved { return .some(nil) }
        if let d = photoData { return .some("data:image/jpeg;base64," + d.base64EncodedString()) }
        return nil
    }

    private func save() async {
        saving = true; error = nil
        do {
            let _: Vehicle = try await APIClient.shared.patch(
                "/resident/vehicles/\(vehicle.id)",
                body: PatchBody(
                    make: make.trimmingCharacters(in: .whitespaces),
                    model: model.trimmingCharacters(in: .whitespaces).isEmpty ? nil : model.trimmingCharacters(in: .whitespaces),
                    color: color.trimmingCharacters(in: .whitespaces),
                    licensePlate: plate.trimmingCharacters(in: .whitespaces).uppercased(),
                    photo: photoPatch
                )
            )
            toast.show(plateChanged ? "Zapisano — czeka na zatwierdzenie" : "Zapisano zmiany")
            dismiss()
            Task { await onChange() }
        } catch {
            self.error = (error as? URLError)?.localizedDescription ?? "Nie udało się zapisać. Spróbuj ponownie."
        }
        saving = false
    }

    private func remove() async {
        deleting = true; error = nil
        do {
            let _: EmptyResponse = try await APIClient.shared.delete("/resident/vehicles/\(vehicle.id)")
            await onChange()
            toast.show("Pojazd usunięty")
            dismiss()
        } catch {
            self.error = (error as? URLError)?.localizedDescription ?? "Nie udało się usunąć. Spróbuj ponownie."
        }
        deleting = false
    }
}

// MARK: - Wspólne pole formularza pojazdu (add + edit, 2026-07-15)

/// Etykieta wersalikami + ikona + TextField w stylu Glass. `plate=true` →
/// monospaced/bold/wersaliki jak na rejestracji.
private struct GlassVehicleField: View {
    let label: String
    @Binding var text: String
    let placeholder: String
    let icon: String
    var plate = false

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(label.uppercased())
                .font(.system(size: 11, weight: .bold))
                .tracking(0.8)
                .foregroundStyle(.white.opacity(0.6))
            HStack(spacing: 11) {
                Image(systemName: icon)
                    .font(.system(size: 14))
                    .foregroundStyle(GlassColor.accentLight.opacity(0.8))
                    .frame(width: 20)
                TextField("", text: $text, prompt: Text(placeholder).foregroundColor(.white.opacity(0.35)))
                    .textInputAutocapitalization(plate ? .characters : .words)
                    .autocorrectionDisabled(plate)
                    .font(.system(size: 16, weight: plate ? .bold : .medium, design: plate ? .monospaced : .default))
                    .foregroundStyle(.white)
                    .tracking(plate ? 1.5 : 0)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 14)
            .background {
                RoundedRectangle(cornerRadius: 15, style: .continuous)
                    .fill(Color.white.opacity(0.09))
                    .overlay {
                        RoundedRectangle(cornerRadius: 15, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.20), lineWidth: 1)
                    }
            }
        }
    }
}

// MARK: - Sheet dodawania pojazdu (2026-07-15)
//
// POST /resident/vehicles — backend wymusza status PENDING dla ścieżki
// mieszkańca (Faza 1 approval flow); admin zatwierdza w panelu, dopiero
// wtedy tablica trafia na białą listę LPR przy bramie.

private struct GlassVehicleAddSheet: View {
    let onChange: () async -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(GlassToastCenter.self) private var toast

    @State private var make = ""
    @State private var model = ""
    @State private var color = ""
    @State private var plate = ""
    @State private var saving = false
    @State private var error: String?
    @State private var photoData: Data?
    @State private var photoRemoved = false   // nieużywane przy dodawaniu

    var body: some View {
        VStack(spacing: 16) {
            GlassSheetHeader(kicker: "Pojazd", title: "Dodaj pojazd", onClose: { dismiss() })

            ScrollView(showsIndicators: false) {
                VStack(spacing: 14) {
                    infoBanner

                    GlassVehicleBrandField(make: $make)
                    GlassVehicleField(label: "Model", text: $model, placeholder: "opcjonalnie", icon: "tag.fill")
                    GlassVehicleField(label: "Kolor", text: $color, placeholder: "np. czarny", icon: "paintpalette.fill")
                    GlassVehicleField(label: "Tablica rejestracyjna", text: $plate, placeholder: "WA12345", icon: "number", plate: true)
                    GlassVehiclePhotoField(photoData: $photoData, removed: $photoRemoved)

                    if let error {
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: "xmark.octagon.fill")
                                .font(.system(size: 14))
                                .foregroundStyle(GlassColor.dangerSoft)
                            Text(error)
                                .font(.system(size: 12.5))
                                .foregroundStyle(.white.opacity(0.85))
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(13)
                        .background {
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .fill(GlassColor.danger.opacity(0.12))
                        }
                    }
                }
                .padding(.top, 2)
                .padding(.bottom, 6)
            }
            .scrollBounceBehavior(.basedOnSize)

            GlassButton(title: "Zgłoś pojazd", busyText: "Zgłaszam…", isBusy: saving) {
                Task { await submit() }
            }
            .disabled(saving
                      || make.trimmingCharacters(in: .whitespaces).isEmpty
                      || color.trimmingCharacters(in: .whitespaces).isEmpty
                      || plate.trimmingCharacters(in: .whitespaces).isEmpty)
        }
    }

    /// Mieszkaniec musi wiedzieć, że auto nie działa od razu — czeka na admina.
    private var infoBanner: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "info.circle.fill")
                .font(.system(size: 14))
                .foregroundStyle(GlassColor.accentLight)
            Text("Nowy pojazd trafia do zatwierdzenia przez administratora osiedla. Po akceptacji tablica będzie rozpoznawana automatycznie przy bramie (ANPR).")
                .font(.system(size: 12.5))
                .foregroundStyle(.white.opacity(0.85))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(13)
        .background {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(GlassColor.accentBlue.opacity(0.14))
                .overlay {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(GlassColor.accentLight.opacity(0.35), lineWidth: 1)
                }
        }
    }

    private struct CreateBody: Encodable {
        let make: String
        let model: String?
        let color: String
        let licensePlate: String
        let photo: String?
    }

    private func submit() async {
        let trimmedMake = make.trimmingCharacters(in: .whitespaces)
        let trimmedModel = model.trimmingCharacters(in: .whitespaces)
        let trimmedColor = color.trimmingCharacters(in: .whitespaces)
        let trimmedPlate = plate.trimmingCharacters(in: .whitespaces).uppercased()
        guard !trimmedMake.isEmpty, !trimmedColor.isEmpty, !trimmedPlate.isEmpty else {
            error = "Uzupełnij markę, kolor i tablicę."
            return
        }
        saving = true
        error = nil
        do {
            let _: Vehicle = try await APIClient.shared.post(
                "/resident/vehicles",
                body: CreateBody(
                    make: trimmedMake,
                    model: trimmedModel.isEmpty ? nil : trimmedModel,
                    color: trimmedColor,
                    licensePlate: trimmedPlate,
                    photo: photoData.map { "data:image/jpeg;base64," + $0.base64EncodedString() }
                )
            )
            // Zamykamy od razu — pełny reload ekranu głównego leci w tle
            // (czekanie na niego trzymało spinner „Zgłaszam…" po uploadzie).
            toast.show("Pojazd \(trimmedPlate) zgłoszony — czeka na zatwierdzenie")
            dismiss()
            Task { await onChange() }
        } catch {
            // Backend zwraca 400 m.in. przy duplikacie tablicy w budynku.
            self.error = (error as? URLError)?.localizedDescription ?? String(describing: error)
        }
        saving = false
    }
}

// MARK: - Picker marki pojazdu (2026-07-16)

/// Słownik marek (rynek PL, alfabetycznie) — na dole menu „Inna marka…"
/// odsłania pole tekstowe na własną wartość.
private let glassCarBrands: [String] = [
    "Abarth", "Alfa Romeo", "Audi", "BMW", "BYD", "Chevrolet", "Chrysler",
    "Citroën", "Cupra", "Dacia", "Dodge", "DS", "Fiat", "Ford", "Honda",
    "Hyundai", "Jaguar", "Jeep", "Kia", "Land Rover", "Lexus", "Mazda",
    "Mercedes-Benz", "MG", "Mini", "Mitsubishi", "Nissan", "Opel", "Peugeot",
    "Polestar", "Porsche", "Renault", "Seat", "Škoda", "Smart", "SsangYong",
    "Subaru", "Suzuki", "Tesla", "Toyota", "Volkswagen", "Volvo",
]

private struct GlassVehicleBrandField: View {
    @Binding var make: String
    /// true = wybrano „Inna marka" → widoczne pole tekstowe.
    @State private var isOther: Bool

    init(make: Binding<String>) {
        _make = make
        // Edycja: marka spoza słownika (np. wpisana wcześniej ręcznie)
        // startuje w trybie „Inna marka" z prefill-em.
        let v = make.wrappedValue.trimmingCharacters(in: .whitespaces)
        _isOther = State(initialValue:
            !v.isEmpty && !glassCarBrands.contains { $0.caseInsensitiveCompare(v) == .orderedSame }
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("MARKA")
                .font(.system(size: 11, weight: .bold))
                .tracking(0.8)
                .foregroundStyle(.white.opacity(0.6))

            Menu {
                ForEach(glassCarBrands, id: \.self) { b in
                    Button {
                        make = b
                        isOther = false
                    } label: {
                        if !isOther && make.caseInsensitiveCompare(b) == .orderedSame {
                            Label(b, systemImage: "checkmark")
                        } else {
                            Text(b)
                        }
                    }
                }
                Divider()
                Button {
                    isOther = true
                    // Marka ze słownika nie ma sensu jako prefix własnej.
                    if glassCarBrands.contains(where: { $0.caseInsensitiveCompare(make) == .orderedSame }) {
                        make = ""
                    }
                } label: {
                    Label("Inna marka…", systemImage: "square.and.pencil")
                }
            } label: {
                HStack(spacing: 11) {
                    Image(systemName: "car.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(GlassColor.accentLight.opacity(0.8))
                        .frame(width: 20)
                    Text(isOther ? "Inna marka" : (make.isEmpty ? "Wybierz markę" : make))
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(make.isEmpty && !isOther ? .white.opacity(0.35) : .white)
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.5))
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 14)
                .background {
                    RoundedRectangle(cornerRadius: 15, style: .continuous)
                        .fill(Color.white.opacity(0.09))
                        .overlay {
                            RoundedRectangle(cornerRadius: 15, style: .continuous)
                                .strokeBorder(Color.white.opacity(0.20), lineWidth: 1)
                        }
                }
            }

            if isOther {
                TextField("", text: $make, prompt: Text("Wpisz markę").foregroundColor(.white.opacity(0.35)))
                    .textInputAutocapitalization(.words)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background {
                        RoundedRectangle(cornerRadius: 15, style: .continuous)
                            .fill(Color.white.opacity(0.09))
                            .overlay {
                                RoundedRectangle(cornerRadius: 15, style: .continuous)
                                    .strokeBorder(GlassColor.accentLight.opacity(0.35), lineWidth: 1)
                            }
                    }
            }
        }
    }
}

// MARK: - Zdjęcie pojazdu (opcjonalne, 2026-07-16)

/// PhotosPicker + podgląd + usunięcie. `existing` = zdjęcie z backendu przy
/// edycji (pokazywane, dopóki nie wybrano nowego / nie usunięto).
private struct GlassVehiclePhotoField: View {
    @Binding var photoData: Data?
    @Binding var removed: Bool
    var existing: String? = nil

    @State private var pickerItem: PhotosPickerItem?

    private var previewImage: UIImage? {
        if let photoData { return UIImage(data: photoData) }
        if removed { return nil }
        return Self.decode(existing)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("ZDJĘCIE POJAZDU (OPCJONALNIE)")
                .font(.system(size: 11, weight: .bold))
                .tracking(0.8)
                .foregroundStyle(.white.opacity(0.6))

            if let img = previewImage {
                ZStack(alignment: .topTrailing) {
                    Image(uiImage: img)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(height: 130)
                        .frame(maxWidth: .infinity)
                        .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))

                    Button {
                        pickerItem = nil
                        photoData = nil
                        removed = true
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 26, height: 26)
                            .background { Circle().fill(Color.black.opacity(0.55)) }
                    }
                    .buttonStyle(.plain)
                    .padding(7)
                }
            }

            PhotosPicker(selection: $pickerItem, matching: .images) {
                HStack(spacing: 8) {
                    Image(systemName: "camera.fill")
                        .font(.system(size: 13, weight: .semibold))
                    Text(previewImage == nil ? "Dodaj zdjęcie" : "Zmień zdjęcie")
                        .font(.system(size: 13, weight: .semibold))
                }
                .foregroundStyle(GlassColor.accentLight)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
                .background { Capsule().fill(Color.white.opacity(0.08)) }
                .overlay { Capsule().strokeBorder(GlassColor.accentLight.opacity(0.35), lineWidth: 1) }
            }
            .onChange(of: pickerItem) { _, item in
                Task { await load(item) }
            }
        }
    }

    /// Zdjęcie z galerii → LEKKA miniaturka: max 500px JPEG q0.5 (~40-70 KB,
    /// vs 300-500 KB przy 800px/0.7 — upload robił z „Zgłaszam…" kilka
    /// sekund na LTE). 500px w zupełności starcza na podgląd 130pt w liście.
    private func load(_ item: PhotosPickerItem?) async {
        guard let item,
              let data = try? await item.loadTransferable(type: Data.self),
              let ui = UIImage(data: data) else { return }
        let scale = min(500 / max(ui.size.width, ui.size.height), 1)
        let target = CGSize(width: ui.size.width * scale, height: ui.size.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1   // bez mnożnika @3x — target JUŻ jest w pikselach
        let resized = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            ui.draw(in: CGRect(origin: .zero, size: target))
        }
        if let jpeg = resized.jpegData(compressionQuality: 0.5) {
            photoData = jpeg
            removed = false
        }
    }

    /// „data:image/jpeg;base64,…" → UIImage (fail-silent). Używane też
    /// przez GlassVehicleDetailSheet (hero ze zdjęciem).
    static func decode(_ photo: String?) -> UIImage? {
        guard let photo,
              let b64 = photo.components(separatedBy: ",").last,
              let data = Data(base64Encoded: b64) else { return nil }
        return UIImage(data: data)
    }
}

// MARK: - Szczegóły pojazdu
//
// Audyt UX 2026-09-21 — kolejność: (1) mała miniatura + JEDNA nazwa i tablica,
// (2) zakres i status automatycznego wjazdu, (3) ostatnie zdarzenie: czas,
// miejsce, typ, WYNIK i powód (LprEventReading — uprawnienie ≠ wynik
// zdarzenia, a odczyt kamery nie dowodzi przejazdu ani bieżącej lokalizacji
// auta), (4) widoczna „Historia przejazdów", (5) dane pojazdu i powiadomienia,
// (6) jawne „Edytuj" + menu pozostałych działań. Parking: brak przypisań
// w modelu danych → sekcji nie ma (nie wymyślamy jej).

private struct GlassVehicleDetailSheet: View {
    let vehicle: Vehicle
    let onEdit: () -> Void
    /// Usunięcie pojazdu (potwierdzane tutaj; realizuje lista).
    var onDelete: () async -> Bool = { false }

    @Environment(\.dismiss) private var dismiss
    @State private var historyExpanded = false
    @State private var historyLoaded = false
    @State private var confirmDelete = false
    @State private var deleting = false

    /// Zdarzenia LPR tego pojazdu (najnowsze pierwsze) — karta „ostatni
    /// przejazd" + sekcja historii na dole.
    @State private var events: [AccessEvent] = []
    /// Push o przejeździe (2026-08-21) — optimistic PATCH z rollbackiem.
    @State private var notifyPassage = false
    @State private var notifySyncing = false
    private var lastEvent: AccessEvent? { events.first }

    var body: some View {
        VStack(spacing: 14) {
            GlassSheetHeader(kicker: "Pojazd", title: "Szczegóły pojazdu", onClose: { dismiss() })

            ScrollViewReader { proxy in
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 14) {
                        identityRow
                        anprStatusCard
                        lastEventSection
                        historyEntry(proxy)
                        if historyExpanded { historySection.id("history") }
                        sectionTitle("Dane pojazdu")
                        infoGrid
                        sectionTitle("Powiadomienia")
                        notifyCard
                    }
                    .padding(.bottom, 8)
                }
                .scrollBounceBehavior(.basedOnSize)
            }

            HStack(spacing: 10) {
                GlassButton(title: "Edytuj", style: .ghost) { onEdit() }
                Menu {
                    Button { onEdit() } label: { Label("Edytuj dane pojazdu", systemImage: "pencil") }
                    Button(role: .destructive) { confirmDelete = true } label: {
                        Label("Usuń pojazd", systemImage: "trash")
                    }
                } label: {
                    HStack(spacing: 6) {
                        if deleting { ProgressView().tint(.white).scaleEffect(0.8) }
                        Text("Więcej").font(.system(size: 15, weight: .semibold))
                        Image(systemName: "ellipsis").font(.system(size: 13, weight: .bold))
                    }
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .background {
                        RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color.white.opacity(0.10))
                    }
                    .overlay {
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.18), lineWidth: 1)
                    }
                }
                .disabled(deleting)
                .accessibilityLabel("Więcej działań")
            }
        }
        .task {
            notifyPassage = vehicle.notifyOnUse ?? false
            await loadLastEvent()
            historyLoaded = true
        }
        .confirmationDialog("Usunąć pojazd \(vehicle.licensePlate)?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Usuń pojazd", role: .destructive) {
                Task {
                    deleting = true
                    _ = await onDelete()
                    deleting = false
                }
            }
            Button("Anuluj", role: .cancel) {}
        } message: {
            Text("Pojazd zniknie z rejestru, a automatyczny wjazd dla tej tablicy zostanie wyłączony. Tej operacji nie można cofnąć.")
        }
    }

    // MARK: (1) Identyfikacja — mała miniatura, jedna nazwa, tablica

    private var identityRow: some View {
        HStack(spacing: 14) {
            ZStack {
                if let img = GlassVehiclePhotoField.decode(vehicle.photo) {
                    Image(uiImage: img).resizable().aspectRatio(contentMode: .fill)
                } else {
                    RadialGradient(
                        colors: [GlassColor.accentBlue.opacity(0.35), Color(hex: 0x0B1020)],
                        center: .center, startRadius: 4, endRadius: 60
                    )
                    Image(systemName: "car.side.fill")
                        .font(.system(size: 28))
                        .foregroundStyle(.white.opacity(0.85))
                }
            }
            .frame(width: 92, height: 68)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
            }
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 7) {
                Text(vehicle.displayName)
                    .font(.system(size: 20, weight: .bold))
                    .tracking(-0.3)
                    .foregroundStyle(.white)
                    .lineLimit(2)
                    .minimumScaleFactor(0.8)
                GlassPlateBadge(plate: vehicle.licensePlate)
            }
            Spacer(minLength: 0)
        }
    }

    private func sectionTitle(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.system(size: 11.5, weight: .bold))
            .tracking(0.8)
            .foregroundStyle(.white.opacity(0.7))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 4)
            .accessibilityAddTraits(.isHeader)
    }

    // MARK: (3) Ostatnie zdarzenie — czas, miejsce, typ, wynik i powód

    @ViewBuilder
    private var lastEventSection: some View {
        sectionTitle("Ostatnie zdarzenie przy bramie")
        if let ev = lastEvent {
            lastActivityCard(ev)
        } else {
            Text(historyLoaded ? "Brak zarejestrowanych zdarzeń tego pojazdu." : "Ładowanie zdarzeń…")
                .font(.system(size: 13))
                .foregroundStyle(.white.opacity(0.7))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .glassCard()
        }
    }

    // MARK: (5) Widoczne wejście do historii (V03)

    private func historyEntry(_ proxy: ScrollViewProxy) -> some View {
        Button {
            withAnimation(.easeInOut(duration: 0.25)) { historyExpanded.toggle() }
            if historyExpanded {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    withAnimation { proxy.scrollTo("history", anchor: .top) }
                }
            }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "clock.arrow.circlepath")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(GlassColor.accentLight)
                    .frame(width: 26)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Historia przejazdów")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.white)
                    Text(historyLoaded
                         ? (events.isEmpty ? "Brak zarejestrowanych zdarzeń" : "Zdarzenia kamer: \(events.count)\(events.count >= 200 ? "+" : "")")
                         : "Ładowanie…")
                        .font(.system(size: 12))
                        .foregroundStyle(.white.opacity(0.7))
                }
                Spacer()
                Image(systemName: historyExpanded ? "chevron.up" : "chevron.down")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(.white.opacity(0.55))
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 56)
            .glassCard()
        }
        .buttonStyle(.plain)
        .disabled(events.isEmpty)
        .accessibilityHint(historyExpanded ? "Zwija historię" : "Rozwija historię przejazdów")
    }

    // MARK: Powiadomienia o przejazdach (2026-08-21)

    /// Opt-in na push przy każdym wjeździe/wyjeździe TEGO pojazdu — z kadrem
    /// z kamery LPR (jak powiadomienia o gościach). Optimistic toggle:
    /// PATCH /resident/vehicles/:id { notifyOnUse }, rollback przy błędzie.
    private var notifyCard: some View {
        HStack(spacing: 13) {
            Image(systemName: "bell.badge.fill")
                .font(.system(size: 19))
                .foregroundStyle(GlassColor.accentLight)
                .frame(width: 40, height: 40)
                .background { Circle().fill(GlassColor.accentBlue.opacity(0.14)) }
            VStack(alignment: .leading, spacing: 3) {
                Text("Powiadomienia o przejazdach")
                    .font(.system(size: 14.5, weight: .semibold))
                    .foregroundStyle(.white)
                Text("Powiadomienie ze zdjęciem z kamery przy każdym rozpoznaniu przy wjeździe i wyjeździe.")
                    .font(.system(size: 11.5))
                    .foregroundStyle(.white.opacity(0.6))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Toggle("", isOn: Binding(
                get: { notifyPassage },
                set: { newValue in Task { await setNotifyPassage(newValue) } }
            ))
            .labelsHidden()
            .tint(GlassColor.accentBlue)
            .disabled(notifySyncing)
        }
        .padding(14)
        .glassCard()
    }

    private struct NotifyPatchBody: Encodable { let notifyOnUse: Bool }

    private func setNotifyPassage(_ enabled: Bool) async {
        let previous = notifyPassage
        notifyPassage = enabled
        notifySyncing = true
        defer { notifySyncing = false }
        do {
            let _: Vehicle = try await APIClient.shared.patch(
                "/resident/vehicles/\(vehicle.id)",
                body: NotifyPatchBody(notifyOnUse: enabled)
            )
        } catch {
            notifyPassage = previous
        }
    }

    // MARK: Karta statusu ANPR

    private var anprStatusCard: some View {
        let (icon, tint, title, subtitle): (String, Color, String, String) = {
            switch vehicle.effectiveStatus {
            case .approved:
                return ("checkmark.shield.fill", GlassColor.successLight,
                        "Automatyczny wjazd jest włączony",
                        "Uprawnienia: \(Self.scopeLabel(vehicle)). Kamery rozpoznają tablicę i wysyłają polecenie otwarcia bramy.")
            case .pending:
                return ("clock.badge.exclamationmark.fill", GlassColor.orbAmber1,
                        "Oczekuje na zatwierdzenie",
                        "Administrator osiedla musi zaakceptować pojazd.")
            case .rejected:
                return ("xmark.shield.fill", GlassColor.dangerSoft,
                        "Pojazd odrzucony",
                        vehicle.rejectionReason.map { "Powód: \($0)" } ?? "Skontaktuj się z administracją.")
            default:
                return ("minus.circle.fill", GlassColor.dangerSoft,
                        vehicle.effectiveStatus.label,
                        "Automatyczny wjazd jest wyłączony dla tej tablicy.")
            }
        }()

        return HStack(spacing: 13) {
            Image(systemName: icon)
                .font(.system(size: 22))
                .foregroundStyle(tint)
                .frame(width: 40, height: 40)
                .background { Circle().fill(tint.opacity(0.14)) }
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 14.5, weight: .semibold))
                    .foregroundStyle(.white)
                Text(subtitle)
                    .font(.system(size: 11.5))
                    .foregroundStyle(.white.opacity(0.6))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .glassCard()
    }

    // MARK: Ostatnia aktywność przy bramie

    private func reading(_ ev: AccessEvent) -> LprEventReading {
        LprEventReading.read(type: ev.type, gateOpened: ev.gateOpened, reason: ev.reason, direction: ev.direction)
    }

    private func toneColor(_ tone: AccessEventTone) -> Color {
        switch tone {
        case .positive: return GlassColor.successLight
        case .neutral:  return Color.white.opacity(0.75)
        case .warning:  return GlassColor.orbAmber1
        case .negative: return GlassColor.dangerSoft
        }
    }

    private func toneIcon(_ tone: AccessEventTone) -> String {
        switch tone {
        case .positive: return "checkmark.circle.fill"
        case .neutral:  return "circle.dashed"
        case .warning:  return "exclamationmark.triangle.fill"
        case .negative: return "xmark.octagon.fill"
        }
    }

    private static let eventDate: DateFormatter = {
        let df = DateFormatter()
        df.locale = Locale(identifier: "pl_PL")
        df.dateFormat = "d MMM, HH:mm"
        return df
    }()

    /// Czas + miejsce + typ + WYNIK (+ powód). Kolor = wynik zdarzenia,
    /// niezależny od zielonej karty uprawnienia powyżej (V02).
    private func lastActivityCard(_ ev: AccessEvent) -> some View {
        let r = reading(ev)
        let color = toneColor(r.tone)
        return HStack(alignment: .top, spacing: 13) {
            Image(systemName: toneIcon(r.tone))
                .font(.system(size: 21))
                .foregroundStyle(color)
                .frame(width: 40, height: 40)
                .background { Circle().fill(color.opacity(0.14)) }
            VStack(alignment: .leading, spacing: 3) {
                Text(r.title)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                Text(r.detail)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(color)
                    .fixedSize(horizontal: false, vertical: true)
                Text([
                    Self.eventDate.string(from: ev.date)
                        + " (\(GlassFormat.relative.localizedString(for: ev.date, relativeTo: Date())))",
                    ev.accessPointLabel,
                ].compactMap { $0 }.joined(separator: " · "))
                    .font(.system(size: 12))
                    .foregroundStyle(.white.opacity(0.7))
                Text("Odczyt kamery nie potwierdza przejazdu ani tego, gdzie auto jest teraz.")
                    .font(.system(size: 11.5))
                    .foregroundStyle(.white.opacity(0.55))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 2)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .glassCard()
        .accessibilityElement(children: .combine)
    }

    static func scopeLabel(_ v: Vehicle) -> String {
        switch v.kind ?? .resident {
        case .resident: return "pojazd mieszkańca"
        default:        return (v.kind ?? .resident).label.lowercased()
        }
    }

    // MARK: Siatka danych

    private var infoGrid: some View {
        let items: [(String, String)] = {
            var out: [(String, String)] = [
                ("Marka", vehicle.make),
                ("Model", vehicle.model?.isEmpty == false ? vehicle.model! : "—"),
                ("Kolor", vehicle.color.isEmpty ? "—" : vehicle.color.capitalized),
                ("Uprawnienia", Self.scopeLabel(vehicle).capitalized),
            ]
            if let n = vehicle.notes, !n.isEmpty { out.append(("Notatka", n)) }
            return out
        }()

        return LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible())], spacing: 10) {
            ForEach(items, id: \.0) { item in
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.0.uppercased())
                        .font(.system(size: 10, weight: .bold))
                        .tracking(0.8)
                        .foregroundStyle(.white.opacity(0.5))
                    Text(item.1)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(.white.opacity(0.92))
                        .lineLimit(2)
                        .minimumScaleFactor(0.8)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Color.white.opacity(0.06))
                        .overlay {
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .strokeBorder(Color.white.opacity(0.12), lineWidth: 1)
                        }
                }
            }
        }
    }

    /// PEŁNA historia przejazdów tej tablicy (2026-08-19) — dedykowany
    /// endpoint /resident/vehicles/:id/history (access_events po tablicy,
    /// żyją dłużej niż 30-dniowy TTL lpr_reads). Fallback dla starszego
    /// backendu: filtr po ostatnich zdarzeniach budynku (jak dotąd).
    private func loadLastEvent() async {
        if let resp: AccessEventsResponse = try? await APIClient.shared.get(
            "/resident/vehicles/\(vehicle.id)/history?limit=200"
        ) {
            events = resp.events
            return
        }
        guard let resp: AccessEventsResponse = try? await APIClient.shared.get(
            "/resident/access-events?limit=300"
        ) else { return }
        events = resp.events.filter {
            $0.plate?.caseInsensitiveCompare(vehicle.licensePlate) == .orderedSame
        }
    }

    // MARK: Historia przejazdów (rozpoznania kamer LPR) — pełna, per dzień

    private static let historyDayLabel: DateFormatter = {
        let df = DateFormatter()
        df.locale = Locale(identifier: "pl_PL")
        df.dateFormat = "EEEE, d MMMM"
        return df
    }()

    /// Grupowanie po dniach (najnowszy dzień pierwszy) — czytelniejsze niż
    /// jeden długi strumień przy pełnej historii.
    private var eventsByDay: [(String, [AccessEvent])] {
        let grouped = Dictionary(grouping: events) {
            Calendar.current.startOfDay(for: $0.date)
        }
        return grouped.keys.sorted(by: >).map { day in
            (Self.historyDayLabel.string(from: day).capitalized, grouped[day] ?? [])
        }
    }

    private var historySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("HISTORIA PRZEJAZDÓW")
                .font(.system(size: 11, weight: .bold))
                .tracking(0.8)
                .foregroundStyle(.white.opacity(0.55))

            ForEach(eventsByDay, id: \.0) { day, dayEvents in
                VStack(alignment: .leading, spacing: 6) {
                    Text(day)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.45))
                        .padding(.top, 4)
                    ForEach(dayEvents) { ev in
                        historyRow(ev)
                    }
                }
            }

            if events.count >= 200 {
                Text("Pokazano 200 najnowszych rozpoznań.")
                    .font(.system(size: 10.5))
                    .foregroundStyle(.white.opacity(0.4))
            }
        }
    }

    private static let historyDate: DateFormatter = {
        let df = DateFormatter()
        df.locale = Locale(identifier: "pl_PL")
        // Sama godzina — datę niesie nagłówek dnia (grupowanie 2026-08-19).
        df.dateFormat = "HH:mm"
        return df
    }()

    /// Wiersz historii — ten sam odczyt co karta „ostatnie zdarzenie":
    /// typ + wynik + powód, kolor = wynik (nieznany ≠ czerwony, ≠ zielony).
    private func historyRow(_ ev: AccessEvent) -> some View {
        let r = reading(ev)
        let color = toneColor(r.tone)
        return HStack(alignment: .top, spacing: 10) {
            Image(systemName: toneIcon(r.tone))
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(color)
                .frame(width: 26, height: 26)
                .background { Circle().fill(color.opacity(0.14)) }
            VStack(alignment: .leading, spacing: 1) {
                Text(r.title)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.white.opacity(0.92))
                Text([r.detail, ev.accessPointLabel].compactMap { $0 }.joined(separator: " · "))
                    .font(.system(size: 11.5))
                    .foregroundStyle(.white.opacity(0.62))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 6)
            Text(Self.historyDate.string(from: ev.date))
                .font(.system(size: 11.5).monospacedDigit())
                .foregroundStyle(.white.opacity(0.6))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background {
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .fill(Color.white.opacity(0.055))
        }
        .accessibilityElement(children: .combine)
    }
}
