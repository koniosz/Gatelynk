// Gatelynk Icon set — single-stroke, 24x24 viewBox
// All icons accept size + color props.

const Icon = ({ children, size = 24, color = 'currentColor', strokeWidth = 1.8, fill = 'none', style = {} }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill={fill}
    stroke={color}
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ display: 'block', flexShrink: 0, ...style }}
  >{children}</svg>
);

const IconHome = (p) => <Icon {...p}><path d="M3 11.5L12 4l9 7.5"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/></Icon>;
const IconBell = (p) => <Icon {...p}><path d="M6 8a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 18a2 2 0 0 0 4 0"/></Icon>;
const IconChat = (p) => <Icon {...p}><path d="M21 12c0 4-4 7-9 7-1.4 0-2.7-.2-3.9-.6L3 20l1.4-4.2C3.5 14.6 3 13.3 3 12c0-4 4-7 9-7s9 3 9 7Z"/></Icon>;
const IconBox = (p) => <Icon {...p}><path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5v-9Z"/><path d="M3 7.5 12 12l9-4.5"/><path d="M12 12v9"/></Icon>;
const IconMore = (p) => <Icon {...p}><circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/></Icon>;

const IconLock = (p) => <Icon {...p}><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></Icon>;
const IconUnlock = (p) => <Icon {...p}><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.3-2.3"/></Icon>;
const IconKey = (p) => <Icon {...p}><circle cx="8" cy="15" r="4"/><path d="M11 13l8-8"/><path d="M16 8l3 3"/></Icon>;
const IconCard = (p) => <Icon {...p}><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 11h18"/><path d="M7 16h4"/></Icon>;
const IconMegaphone = (p) => <Icon {...p}><path d="M3 11v3a1 1 0 0 0 1 1h2l8 5V5L6 10H4a1 1 0 0 0-1 1Z"/><path d="M18 8a5 5 0 0 1 0 8"/></Icon>;
const IconChevronRight = (p) => <Icon {...p}><path d="M9 6l6 6-6 6"/></Icon>;
const IconChevronLeft = (p) => <Icon {...p}><path d="M15 6l-6 6 6 6"/></Icon>;
const IconChevronDown = (p) => <Icon {...p}><path d="M6 9l6 6 6-6"/></Icon>;
const IconPlus = (p) => <Icon {...p}><path d="M12 5v14M5 12h14"/></Icon>;
const IconCar = ({ size = 24, color = 'currentColor', style = {} }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} style={style} aria-hidden="true">
    <path fill={color} fillRule="evenodd" d="M3 11Q3 9 4.5 8L5.6 7.6Q6.6 4 9.5 4L14.5 4Q17.4 4 18.4 7.6L19.5 8Q21 9 21 11L21 18Q21 19.2 19.8 19.2L18.5 19.2Q17.3 19.2 17.3 18L17.3 17L6.7 17L6.7 18Q6.7 19.2 5.5 19.2L4.2 19.2Q3 19.2 3 18ZM8.3 7.2L9.6 5.3Q9.9 5 10.4 5L13.6 5Q14.1 5 14.4 5.3L15.7 7.2ZM7.5 13L16.5 13Q17 13 17 13.5L17 14.5Q17 15 16.5 15L7.5 15Q7 15 7 14.5L7 13.5Q7 13 7.5 13ZM6.2 10.5A1.4 1.4 0 1 0 9 10.5A1.4 1.4 0 1 0 6.2 10.5ZM15 10.5A1.4 1.4 0 1 0 17.8 10.5A1.4 1.4 0 1 0 15 10.5Z"/>
  </svg>
);
const IconArrowRight = (p) => <Icon {...p}><path d="M5 12h14M13 6l6 6-6 6"/></Icon>;
const IconArrowLeft = (p) => <Icon {...p}><path d="M19 12H5M11 6l-6 6 6 6"/></Icon>;
const IconUsers = (p) => <Icon {...p}><circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3 3-5 6-5s6 2 6 5"/><circle cx="17" cy="9" r="2.8"/><path d="M14 19c0-2 2-4 5-4s4 1.5 4 3"/></Icon>;
const IconQR = (p) => <Icon {...p}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3M21 14v3M14 21h7M17 17v4"/></Icon>;
const IconWarning = (p) => <Icon {...p}><path d="M12 4l10 17H2L12 4Z"/><path d="M12 10v5"/><circle cx="12" cy="18" r="1" fill="currentColor"/></Icon>;
const IconCheck = (p) => <Icon {...p}><path d="M5 12l5 5L20 7"/></Icon>;
const IconClock = (p) => <Icon {...p}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></Icon>;
const IconMoon = (p) => <Icon {...p}><path d="M20 14a8 8 0 1 1-9-10 6 6 0 0 0 9 10Z"/></Icon>;
const IconSun = (p) => <Icon {...p}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/></Icon>;
const IconCamera = (p) => <Icon {...p}><path d="M4 8h3l2-2h6l2 2h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="3.5"/></Icon>;
const IconWifi = (p) => <Icon {...p}><path d="M2 8.5a16 16 0 0 1 20 0"/><path d="M5 12a12 12 0 0 1 14 0"/><path d="M8.5 15.5a7 7 0 0 1 7 0"/><circle cx="12" cy="19" r="1" fill="currentColor"/></Icon>;
const IconBattery = (p) => <Icon {...p}><rect x="2" y="7" width="18" height="10" rx="2"/><rect x="4" y="9" width="12" height="6" rx="0.5" fill="currentColor" stroke="none"/><path d="M22 10v4"/></Icon>;
const IconSettings = (p) => <Icon {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></Icon>;
const IconShield = (p) => <Icon {...p}><path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3Z"/></Icon>;
const IconWrench = (p) => <Icon {...p}><path d="M14.7 6.3a4 4 0 1 0 4.6 5.4l-3-3 1.5-1.5 3 3a4 4 0 0 0-5.4-4.6L13 7 7 13l-3 3a2 2 0 0 0 2.8 2.8l3-3 6-6 1-.6Z"/></Icon>;
const IconLightbulb = (p) => <Icon {...p}><path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10.5c.5.5 1 1.5 1 2.5h6c0-1 .5-2 1-2.5A6 6 0 0 0 12 3Z"/></Icon>;
const IconThermo = (p) => <Icon {...p}><path d="M12 14V5a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0Z"/><circle cx="14" cy="17" r="1.5" fill="currentColor"/></Icon>;
const IconShare = (p) => <Icon {...p}><path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/></Icon>;
const IconClose = (p) => <Icon {...p}><path d="M6 6l12 12M18 6L6 18"/></Icon>;
const IconSearch = (p) => <Icon {...p}><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></Icon>;
const IconFilter = (p) => <Icon {...p}><path d="M3 5h18M6 12h12M10 19h4"/></Icon>;
const IconMapPin = (p) => <Icon {...p}><path d="M12 21s-7-7-7-12a7 7 0 0 1 14 0c0 5-7 12-7 12Z"/><circle cx="12" cy="9" r="2.5"/></Icon>;
const IconChartUp = (p) => <Icon {...p}><path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/></Icon>;
const IconParcel = (p) => <Icon {...p}><rect x="4" y="8" width="16" height="12" rx="1"/><path d="M4 12h16"/><path d="M9 8V5h6v3"/></Icon>;
const IconRefresh = (p) => <Icon {...p}><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 21v-5h5"/></Icon>;
const IconStar = (p) => <Icon {...p}><path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.8 6.6 19.5l1.2-6L3.3 9.3l6.1-.7L12 3Z"/></Icon>;
const IconFace = (p) => <Icon {...p}><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 9v1.5M16 9v1.5"/><path d="M9 15c1 1 2 1.5 3 1.5s2-.5 3-1.5"/></Icon>;
const IconHeart = (p) => <Icon {...p}><path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10Z"/></Icon>;

Object.assign(window, {
  Icon,
  IconHome, IconBell, IconChat, IconBox, IconMore,
  IconLock, IconUnlock, IconKey, IconCard, IconMegaphone,
  IconChevronRight, IconChevronLeft, IconChevronDown,
  IconPlus, IconCar, IconArrowRight, IconArrowLeft,
  IconUsers, IconQR, IconWarning, IconCheck, IconClock,
  IconMoon, IconSun, IconCamera, IconWifi, IconBattery,
  IconSettings, IconShield, IconWrench, IconLightbulb,
  IconThermo, IconShare, IconClose, IconSearch, IconFilter,
  IconMapPin, IconChartUp, IconParcel, IconRefresh,
  IconStar, IconHeart, IconFace,
});
