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

            Text("Dotknij kafelek, aby zobaczyć szczegóły i pełną historię przejazdów. Przytrzymaj, aby edytować lub usunąć.")
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
                    if v.effectiveStatus != .approved {
                        Text(v.effectiveStatus.label)
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(statusColor(v.effectiveStatus))
                            .lineLimit(1)
                    } else if !subtitle(v).isEmpty {
                        Text(subtitle(v))
                            .font(.system(size: 10))
                            .foregroundStyle(.white.opacity(0.55))
                            .lineLimit(1)
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
            .opacity(v.effectiveStatus == .approved ? 1 : 0.75)
            .shadow(color: .black.opacity(0.3), radius: 10, y: 5)
        }
        .buttonStyle(.plain)
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
            Text("Pojazd zniknie z rejestru i z białej listy przy bramie. Tej operacji nie można cofnąć.")
        }
    }

    private func subtitle(_ v: Vehicle) -> String {
        var parts: [String] = []
        if !v.color.isEmpty { parts.append(v.color) }
        if let kind = v.kind, kind != .resident { parts.append(kind.label) }
        return parts.joined(separator: " · ")
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

// MARK: - Szczegóły pojazdu (2026-07-16) — styl apki producenta samochodu
//
// Hero ze zdjęciem pojazdu (gradient dołem), duża nazwa na środku, tablica
// + status, karta „Rozpoznawanie przy bramie" (ANPR), ostatnia aktywność
// z access-events (fail-silent) i siatka danych. Edycja — przyciskiem.

private struct GlassVehicleDetailSheet: View {
    let vehicle: Vehicle
    let onEdit: () -> Void

    @Environment(\.dismiss) private var dismiss

    /// Zdarzenia LPR tego pojazdu (najnowsze pierwsze) — karta „ostatni
    /// przejazd" + sekcja historii na dole.
    @State private var events: [AccessEvent] = []
    /// Push o przejeździe (2026-08-21) — optimistic PATCH z rollbackiem.
    @State private var notifyPassage = false
    @State private var notifySyncing = false
    private var lastEvent: AccessEvent? { events.first }

    var body: some View {
        VStack(spacing: 14) {
            GlassSheetHeader(kicker: "Pojazd", title: vehicle.displayName, onClose: { dismiss() })

            ScrollView(showsIndicators: false) {
                VStack(spacing: 16) {
                    hero

                    // Nazwa + identyfikacja — wycentrowane jak w apkach OEM.
                    VStack(spacing: 8) {
                        Text(vehicle.displayName)
                            .font(.system(size: 25, weight: .bold))
                            .tracking(-0.5)
                            .foregroundStyle(.white)
                            .multilineTextAlignment(.center)
                        HStack(spacing: 10) {
                            GlassPlateBadge(plate: vehicle.licensePlate)
                            if !vehicle.color.isEmpty {
                                Text(vehicle.color.capitalized)
                                    .font(.system(size: 12.5))
                                    .foregroundStyle(.white.opacity(0.65))
                            }
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 2)

                    anprStatusCard

                    notifyCard

                    if let ev = lastEvent {
                        lastActivityCard(ev)
                    }

                    infoGrid

                    if events.count > 0 {
                        historySection
                    }
                }
                .padding(.bottom, 8)
            }
            .scrollBounceBehavior(.basedOnSize)

            GlassButton(title: "Edytuj dane pojazdu", style: .ghost) {
                onEdit()
            }
        }
        .task {
            notifyPassage = vehicle.notifyOnUse ?? false
            await loadLastEvent()
        }
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
                Text("Push ze zdjęciem z kamery przy każdym wjeździe i wyjeździe.")
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

    // MARK: Hero — zdjęcie z gradientem albo elegancki placeholder

    private var hero: some View {
        ZStack(alignment: .bottom) {
            if let img = GlassVehiclePhotoField.decode(vehicle.photo) {
                Image(uiImage: img)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(height: 190)
                    .frame(maxWidth: .infinity)
                    .clipped()
            } else {
                // Placeholder — radialny spotlight + duża ikona auta.
                ZStack {
                    RadialGradient(
                        colors: [GlassColor.accentBlue.opacity(0.35), Color(hex: 0x0B1020)],
                        center: .center, startRadius: 10, endRadius: 220
                    )
                    Image(systemName: "car.side.fill")
                        .font(.system(size: 74))
                        .foregroundStyle(.white.opacity(0.85))
                        .shadow(color: .black.opacity(0.6), radius: 14, y: 8)
                }
                .frame(height: 190)
                .frame(maxWidth: .infinity)
            }

            // Gradient dołem — głębia jak w apkach OEM.
            LinearGradient(
                colors: [.clear, Color(hex: 0x0A0E1E).opacity(0.75)],
                startPoint: .center, endPoint: .bottom
            )
            .allowsHitTesting(false)
        }
        .frame(height: 190)
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.4), radius: 18, y: 10)
    }

    // MARK: Karta statusu ANPR

    private var anprStatusCard: some View {
        let (icon, tint, title, subtitle): (String, Color, String, String) = {
            switch vehicle.effectiveStatus {
            case .approved:
                return ("checkmark.shield.fill", GlassColor.successLight,
                        "Rozpoznawanie aktywne",
                        "Tablica na białej liście — szlaban otwiera się automatycznie.")
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
                        "Tablica nie jest rozpoznawana przy bramie.")
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

    private func lastActivityCard(_ ev: AccessEvent) -> some View {
        HStack(spacing: 13) {
            Image(systemName: ev.gateOpened ? "arrow.up.forward.circle.fill" : "exclamationmark.circle.fill")
                .font(.system(size: 22))
                .foregroundStyle(ev.gateOpened ? GlassColor.accentLight : GlassColor.dangerSoft)
                .frame(width: 40, height: 40)
                .background {
                    Circle().fill((ev.gateOpened ? GlassColor.accentBlue : GlassColor.danger).opacity(0.14))
                }
            VStack(alignment: .leading, spacing: 3) {
                Text(ev.gateOpened ? "Ostatni przejazd" : "Ostatnia próba wjazdu")
                    .font(.system(size: 14.5, weight: .semibold))
                    .foregroundStyle(.white)
                HStack(spacing: 5) {
                    Text(GlassFormat.relative.localizedString(for: ev.date, relativeTo: Date()))
                    if let label = ev.accessPointLabel {
                        Text("·")
                        Text(label)
                    }
                }
                .font(.system(size: 11.5))
                .foregroundStyle(.white.opacity(0.6))
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .glassCard()
    }

    // MARK: Siatka danych

    private var infoGrid: some View {
        let items: [(String, String)] = {
            var out: [(String, String)] = [
                ("Marka", vehicle.make),
                ("Model", vehicle.model?.isEmpty == false ? vehicle.model! : "—"),
                ("Kolor", vehicle.color.isEmpty ? "—" : vehicle.color.capitalized),
                ("Typ", (vehicle.kind ?? .resident).label),
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

    /// Tytuł wiersza historii: kierunek z kamery albo typ zdarzenia.
    /// Dane zawierają OBA formaty kierunku: 'IN'/'OUT' (nowe eventy) i
    /// surowe 'forward'/'reverse' z Edge (starsze / backfill 2026-05).
    private func historyTitle(_ ev: AccessEvent) -> String {
        if ev.type == "LPR_NO_MATCH" { return "Odmowa — tablica nierozpoznana" }
        switch ev.direction {
        case "IN", "forward":  return "Wjazd"
        case "OUT", "reverse": return "Wyjazd"
        default:    return ev.gateOpened ? "Przejazd" : "Rozpoznanie bez otwarcia"
        }
    }

    /// Czy zdarzenie to wyjazd (dla ikony strzałki) — oba formaty kierunku.
    private func isExit(_ ev: AccessEvent) -> Bool {
        ev.direction == "OUT" || ev.direction == "reverse"
    }

    private static let historyDate: DateFormatter = {
        let df = DateFormatter()
        df.locale = Locale(identifier: "pl_PL")
        // Sama godzina — datę niesie nagłówek dnia (grupowanie 2026-08-19).
        df.dateFormat = "HH:mm"
        return df
    }()

    private func historyRow(_ ev: AccessEvent) -> some View {
        HStack(spacing: 10) {
            Image(systemName: ev.gateOpened
                  ? (isExit(ev) ? "arrow.up.right" : "arrow.down.left")
                  : "xmark")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(ev.gateOpened ? GlassColor.successLight : GlassColor.dangerSoft)
                .frame(width: 26, height: 26)
                .background {
                    Circle().fill(
                        (ev.gateOpened ? GlassColor.success : GlassColor.danger).opacity(0.14)
                    )
                }
            VStack(alignment: .leading, spacing: 1) {
                Text(historyTitle(ev))
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(.white.opacity(0.9))
                if let label = ev.accessPointLabel {
                    Text(label)
                        .font(.system(size: 10.5))
                        .foregroundStyle(.white.opacity(0.5))
                }
            }
            Spacer(minLength: 6)
            Text(Self.historyDate.string(from: ev.date))
                .font(.system(size: 10.5).monospacedDigit())
                .foregroundStyle(.white.opacity(0.5))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background {
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .fill(Color.white.opacity(0.055))
        }
    }
}
