import { sanitizePushText, pushThreadId, warsawTime } from './push-text'

describe('push-text', () => {
  it('usuwa emoji i piktogramy z tytułów i treści', () => {
    expect(sanitizePushText('🚗 Twój pojazd wjechał')).toBe('Twój pojazd wjechał')
    expect(sanitizePushText('🔔 Awaria windy')).toBe('Awaria windy')
    expect(sanitizePushText('🗑️ Dziś odbiór: papier — wystaw kubły.')).toBe('Dziś odbiór: papier — wystaw kubły.')
    expect(sanitizePushText('Dzień dobry 👋 Twój dzień')).toBe('Dzień dobry Twój dzień')
    expect(sanitizePushText('✅ Pojazd zatwierdzony')).toBe('Pojazd zatwierdzony')
    expect(sanitizePushText('⏱ Przekroczony czas')).toBe('Przekroczony czas')
  })

  it('nie psuje polskich znaków, cyfr ani interpunkcji', () => {
    expect(sanitizePushText('WE1MH70 — wjazd o 17:22. Żółć, ąę!')).toBe('WE1MH70 — wjazd o 17:22. Żółć, ąę!')
  })

  it('czyści wiodące myślniki i podwójne spacje po usunięciu emoji', () => {
    expect(sanitizePushText('📦  — Nowa przesyłka')).toBe('Nowa przesyłka')
    expect(sanitizePushText('')).toBe('')
    expect(sanitizePushText(undefined)).toBe('')
  })

  it('grupuje wątki po rodzaju zdarzenia', () => {
    expect(pushThreadId({ kind: 'VEHICLE_ENTRY' })).toBe('vehicles')
    expect(pushThreadId({ kind: 'GUEST_APPROVAL' })).toBe('guests')
    expect(pushThreadId({ type: 'parcel' })).toBe('parcels')
    expect(pushThreadId({ type: 'ticket_reply' })).toBe('tickets')
    expect(pushThreadId({ type: 'notification' })).toBe('announcements')
    expect(pushThreadId({ type: 'morning-brief' })).toBe('daily')
    expect(pushThreadId(undefined)).toBeUndefined()
  })

  it('formatuje godzinę w czasie osiedla', () => {
    expect(warsawTime(Date.UTC(2026, 8, 29, 15, 22))).toBe('17:22')
  })
})
