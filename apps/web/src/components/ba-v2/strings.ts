// i18n strings dla nowego panelu BA v2.
// Przeniesione z handoff-u (source/strings.js). PL jest defaultem, EN tylko
// dla parytetu — w MVP przełącznik w topbarze działa na całym shell-u, ale
// nie ma jeszcze pełnego pokrycia (tabele jeszcze hardkoduja niektóre PL etykiety).
export type Lang = "pl" | "en";

export interface BaStrings {
  panelTitle: string;
  breadcrumb: string;
  role: string;
  nav: { properties: string; devices: string; residents: string; reports: string; settings: string };
  backToProps: string;
  livePill: string;
  search: string;
  tabs: {
    overview: string;
    residents: string;
    units: string;
    vehicles: string;
    guests: string;
    issues: string;
    payments: string;
    notifications: string;
    security: string;
    devices: string;
    courierVisits: string;
    lprReads: string;
    situations: string;
    knowledge: string;
  };
  overview: {
    greeting: (firstName: string) => string;
    askPlaceholder: string;
    prompts: string[];
    typing: string;
  };
  concierge: {
    title: string;
    online: string;
    placeholder: string;
    suggestions: { icon: string; text: string }[];
    foot: string;
    hello: string;
    helloDesc: string;
  };
}

export const STRINGS: Record<Lang, BaStrings> = {
  pl: {
    panelTitle: "Panel Administratora",
    breadcrumb: "Zarządzanie budynkiem",
    role: "Building Administrator",
    nav: {
      properties: "Obiekty",
      devices: "Urządzenia",
      residents: "Mieszkańcy",
      reports: "Raporty",
      settings: "Ustawienia",
    },
    backToProps: "Obiekty",
    livePill: "Online",
    search: "Szukaj mieszkańca, pojazdu, lokalu…",
    tabs: {
      overview: "Przegląd",
      residents: "Mieszkańcy",
      units: "Lokale",
      vehicles: "Pojazdy",
      guests: "Goście",
      issues: "Zgłoszenia",
      payments: "Płatności",
      notifications: "Powiadomienia",
      security: "Bezpieczeństwo",
      devices: "Urządzenia",
      courierVisits: "Wizyty kurierów",
      lprReads: "Odczyty tablic",
      situations: "Zdarzenia",
      knowledge: "Baza wiedzy",
    },
    overview: {
      greeting: (firstName: string) => `Cześć, ${firstName}`,
      askPlaceholder: "Zapytaj o cokolwiek dotyczącego osiedla…",
      prompts: ["Kto ma zaległości?", "Polecisz elektryka?", "Kiedy wywóz gabarytów?"],
      typing: "Concierge pisze…",
    },
    concierge: {
      title: "AI Concierge",
      online: "online",
      placeholder: "Zapytaj o cokolwiek z osiedla...",
      suggestions: [
        { icon: "AlertTriangle", text: "Szukam serwisanta pieca gazowego" },
        { icon: "Users", text: "Możesz polecić ogrodnika i elektryka?" },
        { icon: "Clock", text: "Kiedy będzie wywóz wielkich gabarytów?" },
        { icon: "CreditCard", text: "Kto ma zaległości w opłatach?" },
        { icon: "CarFront", text: "Czy dziś przyjeżdżał kurier?" },
        { icon: "Home", text: "Pokaż harmonogram wywozu śmieci" },
      ],
      foot: "Odpowiedzi generowane na podstawie danych osiedla",
      hello: "Cześć! Co chcesz wiedzieć o swoim osiedlu?",
      helloDesc:
        "Mam dostęp do mieszkańców, lokali, pojazdów, opłat, zgłoszeń i ostatniej aktywności na bramach.",
    },
  },
  en: {
    panelTitle: "Admin Panel",
    breadcrumb: "Building management",
    role: "Building Administrator",
    nav: {
      properties: "Properties",
      devices: "Devices",
      residents: "Residents",
      reports: "Reports",
      settings: "Settings",
    },
    backToProps: "Properties",
    livePill: "Online",
    search: "Search resident, unit, vehicle...",
    tabs: {
      overview: "Overview",
      residents: "Residents",
      units: "Units",
      vehicles: "Vehicles",
      guests: "Guests",
      issues: "Tickets",
      payments: "Payments",
      notifications: "Notifications",
      security: "Security",
      devices: "Devices",
      courierVisits: "Courier visits",
      lprReads: "Plate reads",
      situations: "Situations",
      knowledge: "Knowledge base",
    },
    overview: {
      greeting: (firstName: string) => `Hi, ${firstName}`,
      askPlaceholder: "Ask anything about the property…",
      prompts: ["Who has overdue payments?", "Recommend an electrician?", "Next bulky waste pickup?"],
      typing: "Concierge is typing…",
    },
    concierge: {
      title: "AI Concierge",
      online: "online",
      placeholder: "Ask anything about the property…",
      suggestions: [
        { icon: "AlertTriangle", text: "I'm looking for a gas furnace technician" },
        { icon: "Users", text: "Can you recommend a gardener and electrician?" },
        { icon: "Clock", text: "When is the next bulky waste pickup?" },
        { icon: "CreditCard", text: "Who has overdue payments?" },
        { icon: "CarFront", text: "Did the courier come today?" },
        { icon: "Home", text: "Show the trash collection schedule" },
      ],
      foot: "Answers grounded in property data",
      hello: "Hi! What do you want to know about the property?",
      helloDesc: "I have access to residents, units, vehicles, payments, tickets, and recent gate activity.",
    },
  },
};
