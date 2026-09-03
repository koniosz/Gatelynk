// Mock data for the prototype
const MOCK_DATA = {
  user: {
    name: 'Konrad Szychta',
    firstName: 'Konrad',
    estate: 'Osiedle Villa Natura',
    address: '1, Niewinna, Kępa Zawadowska, Wilanów',
  },
  activity: [
    { icon: IconMegaphone, title: 'PRZERWA W DOSTAWIE PRĄDU 20.05.2026', subtitle: 'Przerwa spowodowana koniecznym pracami...', time: '6 g. temu' },
    { icon: IconMegaphone, title: 'PRZERWA W DOSTAWIE WODY', subtitle: 'W dniu 29.04.2026 od 8:00 do 15:00.', time: '6 g. temu' },
    { icon: IconMegaphone, title: 'HELLO', subtitle: 'Siema', time: '6 g. temu' },
  ],
  notifications: [
    { kind: 'announce', icon: IconMegaphone, color: '#F59E0B', title: 'Przerwa w dostawie prądu', body: 'Planowana przerwa 20.05.2026 w godz. 9:00–13:00. Konieczne prace konserwacyjne.', time: '6 g. temu', unread: true },
    { kind: 'announce', icon: IconMegaphone, color: '#F59E0B', title: 'Przerwa w dostawie wody', body: 'W dniu 29.04.2026 od 8:00 do 15:00 nastąpi przerwa w dostawie wody.', time: 'wczoraj', unread: true },
    { kind: 'system', icon: IconShield, color: '#34D399', title: 'Alarm uzbrojony', body: 'System alarmowy został pomyślnie uzbrojony.', time: '2 dni temu', unread: false },
    { kind: 'payment', icon: IconCard, color: '#F87171', title: 'Czynsz — przypomnienie', body: 'Termin płatności za maj zbliża się: 10 maja, kwota 834,00 zł.', time: '3 dni temu', unread: false },
    { kind: 'announce', icon: IconUsers, color: '#60A5FA', title: 'Zebranie wspólnoty', body: 'Walne zebranie odbędzie się 15.05.2026 o 18:00 w sali wspólnej.', time: 'tydzień temu', unread: false },
  ],
  tickets: [
    { id: 'GTL-1042', priority: 'high', title: 'Przepalona żarówka — klatka B', location: 'Klatka B, parter', status: 'open', statusLabel: 'Oczekuje na przyjęcie', time: '2 g. temu' },
    { id: 'GTL-1041', priority: 'med', title: 'Cieknący kran w łazience', location: 'Mieszkanie nr 1', status: 'in-progress', statusLabel: 'W trakcie naprawy', time: 'wczoraj' },
    { id: 'GTL-1038', priority: 'low', title: 'Skrzypiące drzwi do garażu', location: 'Garaż podziemny', status: 'closed', statusLabel: 'Rozwiązane', time: '5 dni temu' },
    { id: 'GTL-1035', priority: 'med', title: 'Pęknięty chodnik', location: 'Wjazd główny', status: 'closed', statusLabel: 'Rozwiązane', time: 'tydzień temu' },
  ],
  parcels: [
    { status: 'waiting', statusLabel: 'Oczekuje', title: 'Paczka InPost', carrier: 'InPost', tracking: '8841...4423', locker: '14', code: '4823', time: '1 g. temu' },
    { status: 'waiting', statusLabel: 'Oczekuje', title: 'Allegro · Buty sportowe', carrier: 'DPD', tracking: 'PL...9931', locker: '07', code: '1290', time: 'wczoraj' },
    { status: 'delivered', statusLabel: 'Odebrana', title: 'Książka — Empik', carrier: 'Poczta Polska', tracking: 'RR...0021', time: '3 dni temu' },
    { status: 'in-transit', statusLabel: 'W drodze', title: 'IKEA · Lampa biurkowa', carrier: 'DHL', tracking: 'JD...5511', time: '2 dni' },
  ],
  payments: [
    { paid: false, title: 'Czynsz · maj 2026', date: 'termin 10.05', amount: '834,00 zł' },
    { paid: true, title: 'Czynsz · kwiecień 2026', date: 'opłacono 09.04', amount: '834,00 zł' },
    { paid: true, title: 'Fundusz remontowy · Q1', date: 'opłacono 02.03', amount: '450,00 zł' },
    { paid: true, title: 'Czynsz · marzec 2026', date: 'opłacono 08.03', amount: '834,00 zł' },
    { paid: true, title: 'Czynsz · luty 2026', date: 'opłacono 09.02', amount: '834,00 zł' },
  ],
  vehicles: [
    { id: 'v1', make: 'Volkswagen', model: 'Passat', year: 2022, color: 'Czarny', plate: 'WI 12345', primary: true },
    { id: 'v2', make: 'Toyota',     model: 'Yaris',  year: 2024, color: 'Biały',  plate: 'WI 67890', primary: false },
  ],
  guests: [
    {
      id: 'g1', name: 'Magda Nowak', phone: '+48 600 123 456',
      vehicle: { make: 'BMW', model: 'X3', color: 'Granatowy', plate: 'WW 11122' },
      gates: ['entry', 'exit'],
      from: '2026-05-04T18:00', to: '2026-05-04T23:00',
      status: 'upcoming',
    },
    {
      id: 'g2', name: 'Ekipa remontowa · Marek',
      vehicle: { make: 'Renault', model: 'Master', color: 'Biały', plate: 'WI 55299' },
      gates: ['entry', 'exit'],
      from: '2026-04-29T07:00', to: '2026-04-29T17:00',
      status: 'active',
    },
    {
      id: 'g3', name: 'Rodzice', phone: '+48 605 998 100',
      vehicle: { make: 'Audi', model: 'A4', color: 'Srebrny', plate: 'KR 7821B' },
      gates: ['entry', 'exit'],
      from: '2026-04-25T14:00', to: '2026-04-25T22:00',
      status: 'expired',
    },
  ],
};
window.MOCK_DATA = MOCK_DATA;
