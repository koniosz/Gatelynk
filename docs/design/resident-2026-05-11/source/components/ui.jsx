// Shared UI primitives for Gatelynk

const StatusBar = ({ time = '19:38', light = false }) => (
  <div style={{
    position: 'absolute', top: 0, left: 0, right: 0, height: 54,
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '14px 32px 0', zIndex: 10,
    color: light ? 'rgba(255,255,255,0.95)' : 'var(--text-primary)',
    fontSize: 17, fontWeight: 600, fontFamily: 'var(--font-display)',
    pointerEvents: 'none',
  }}>
    <span>{time}</span>
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <IconWifi size={17} strokeWidth={2.2} />
      <IconBattery size={22} strokeWidth={1.8} />
    </div>
  </div>
);

// Bottom tab bar — 5 tabs
const TabBar = ({ active, onChange, lang = 'pl' }) => {
  const labels = lang === 'pl'
    ? { home: 'Dom', guests: 'Goście', tickets: 'Zgłoszenia', parcels: 'Przesyłki', more: 'Więcej' }
    : { home: 'Home', guests: 'Guests', tickets: 'Tickets', parcels: 'Parcels', more: 'More' };
  const tabs = [
    { id: 'home', icon: IconHome, label: labels.home },
    { id: 'guests', icon: IconUsers, label: labels.guests },
    { id: 'tickets', icon: IconChat, label: labels.tickets },
    { id: 'parcels', icon: IconBox, label: labels.parcels },
    { id: 'more', icon: IconMore, label: labels.more },
  ];
  return (
    <div style={{
      position: 'absolute', bottom: 0, left: 0, right: 0,
      height: 96, paddingBottom: 24, paddingTop: 8,
      background: 'var(--bg-2)',
      borderTop: '1px solid var(--border-subtle)',
      display: 'flex', justifyContent: 'space-around', alignItems: 'flex-start',
      zIndex: 5,
      backdropFilter: 'blur(20px)',
    }}>
      {tabs.map(t => {
        const isActive = active === t.id;
        const C = t.icon;
        return (
          <button key={t.id}
            onClick={() => onChange?.(t.id)}
            style={{
              background: 'none', border: 'none', padding: '8px 4px',
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              gap: 4, cursor: 'pointer', flex: 1,
              color: isActive ? 'var(--accent-300)' : 'var(--text-tertiary)',
              transition: 'color 0.2s',
            }}>
            <C size={24} strokeWidth={isActive ? 2.2 : 1.8} />
            <span style={{ fontSize: 10.5, fontWeight: isActive ? 600 : 500, letterSpacing: '-0.01em' }}>
              {t.label}
            </span>
          </button>
        );
      })}
    </div>
  );
};

// Reusable card
const Card = ({ children, style = {}, onClick, padding = 16, elevated = false, ...rest }) => (
  <div onClick={onClick}
    style={{
      background: elevated ? 'var(--bg-3)' : 'var(--bg-2)',
      borderRadius: 'var(--r-xl)',
      border: '1px solid var(--border-subtle)',
      padding,
      cursor: onClick ? 'pointer' : 'default',
      transition: 'transform 0.15s, background 0.2s',
      ...style,
    }}
    {...rest}
  >{children}</div>
);

// Status pill
const Pill = ({ children, color = 'success', size = 'sm' }) => {
  const colors = {
    success: { bg: 'var(--success-bg)', fg: 'var(--success)' },
    warning: { bg: 'var(--warning-bg)', fg: 'var(--warning)' },
    danger:  { bg: 'var(--danger-bg)', fg: 'var(--danger)' },
    info:    { bg: 'var(--info-bg)', fg: 'var(--info)' },
    neutral: { bg: 'var(--bg-4)', fg: 'var(--text-secondary)' },
  };
  const c = colors[color] || colors.neutral;
  const sizes = { sm: { p: '4px 8px', fs: 11 }, md: { p: '6px 10px', fs: 12 } };
  const s = sizes[size];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: s.p, borderRadius: 'var(--r-full)',
      background: c.bg, color: c.fg,
      fontSize: s.fs, fontWeight: 600, letterSpacing: '0.02em',
    }}>{children}</span>
  );
};

// Section header
const SectionHeader = ({ title, action, actionLabel }) => (
  <div style={{
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 12, padding: '0 4px',
  }}>
    <h2 style={{
      margin: 0, fontSize: 16, fontWeight: 600,
      color: 'var(--text-primary)', letterSpacing: '-0.015em',
    }}>{title}</h2>
    {action && (
      <button onClick={action} style={{
        background: 'none', border: 'none', padding: 4,
        color: 'var(--accent-300)', fontSize: 13, fontWeight: 500,
        cursor: 'pointer',
      }}>{actionLabel}</button>
    )}
  </div>
);

// Activity item
const ActivityItem = ({ icon: I = IconMegaphone, title, subtitle, time, onClick, iconColor }) => (
  <div onClick={onClick} style={{
    display: 'flex', gap: 12, alignItems: 'flex-start',
    padding: '12px 14px', cursor: onClick ? 'pointer' : 'default',
  }}>
    <div style={{
      width: 38, height: 38, borderRadius: 'var(--r-full)',
      background: iconColor ? `${iconColor}26` : 'var(--icon-orange-bg)',
      color: iconColor || 'var(--icon-orange)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0,
    }}><I size={20} strokeWidth={2} /></div>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{
        fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)',
        lineHeight: 1.3, marginBottom: 3,
        overflow: 'hidden', textOverflow: 'ellipsis',
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
      }}>{title}</div>
      {subtitle && <div style={{
        fontSize: 12, color: 'var(--text-tertiary)',
        lineHeight: 1.3,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{subtitle}</div>}
    </div>
    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', whiteSpace: 'nowrap', marginTop: 2 }}>
      {time}
    </div>
  </div>
);

// FAB
const FAB = ({ onClick, icon: I = IconPlus, style = {} }) => (
  <button onClick={onClick} style={{
    position: 'absolute', right: 18, bottom: 116,
    width: 56, height: 56, borderRadius: 'var(--r-full)',
    background: 'var(--accent-300)',
    color: '#fff', border: 'none',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 8px 24px var(--accent-glow)',
    cursor: 'pointer', zIndex: 4, ...style,
  }}><I size={24} strokeWidth={2.2} /></button>
);

Object.assign(window, {
  StatusBar, TabBar, Card, Pill, SectionHeader, ActivityItem, FAB,
});
