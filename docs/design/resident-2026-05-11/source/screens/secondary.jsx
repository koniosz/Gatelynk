// Secondary screens: Notifications, Tickets, Parcels, Payments, Profile

const NotificationsScreen = ({ data, onBack }) => {
  const [filter, setFilter] = React.useState('all');
  const filtered = data.notifications.filter(n => filter === 'all' || n.kind === filter);
  return (
    <div className="screen scroll-area" style={{ paddingBottom: 110 }}>
      <StatusBar />
      <ScreenHeader title="Powiadomienia" onBack={onBack} action={<button style={{...miniIconBtn()}}><IconCheck size={16}/></button>}/>
      <div style={{ padding: '0 16px 12px', display: 'flex', gap: 8, overflowX: 'auto' }}>
        {[
          { id: 'all', label: 'Wszystkie' },
          { id: 'announce', label: 'Ogłoszenia' },
          { id: 'system', label: 'System' },
          { id: 'payment', label: 'Płatności' },
        ].map(c => (
          <button key={c.id} onClick={() => setFilter(c.id)} style={{
            padding: '7px 14px', borderRadius: 'var(--r-full)',
            background: filter === c.id ? 'var(--accent-300)' : 'var(--bg-2)',
            color: filter === c.id ? '#fff' : 'var(--text-secondary)',
            border: filter === c.id ? 'none' : '1px solid var(--border-subtle)',
            fontSize: 12.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
          }}>{c.label}</button>
        ))}
      </div>
      <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {filtered.map((n, i) => {
          const I = n.icon;
          return (
            <Card key={i} padding={14} style={{ borderColor: n.unread ? 'var(--accent-300)' : 'var(--border-subtle)' }}>
              <div style={{ display: 'flex', gap: 12 }}>
                <div style={{
                  width: 38, height: 38, borderRadius: '50%',
                  background: `${n.color}26`, color: n.color,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}><I size={18}/></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{n.title}</div>
                    {n.unread && <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent-300)', marginTop: 5 }}/>}
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.4 }}>{n.body}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 6 }}>{n.time}</div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
};

const TicketsScreen = ({ data, onBack }) => {
  const [tab, setTab] = React.useState('open');
  return (
    <div className="screen scroll-area" style={{ paddingBottom: 110 }}>
      <StatusBar />
      <ScreenHeader title="Zgłoszenia" onBack={onBack}/>
      <div style={{ padding: '0 16px 12px' }}>
        <div style={{ display: 'flex', background: 'var(--bg-2)', borderRadius: 'var(--r-md)', padding: 4, gap: 4 }}>
          {[
            { id: 'open', label: 'Otwarte', count: 2 },
            { id: 'closed', label: 'Zamknięte', count: 5 },
          ].map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              flex: 1, padding: '8px 12px', borderRadius: 'var(--r-sm)',
              background: tab === t.id ? 'var(--bg-4)' : 'transparent',
              border: 'none', color: tab === t.id ? 'var(--text-primary)' : 'var(--text-tertiary)',
              fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}>{t.label} <span style={{ opacity: 0.6 }}>({t.count})</span></button>
          ))}
        </div>
      </div>
      <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {data.tickets.filter(t => t.status === tab || (tab === 'open' && t.status !== 'closed')).map((t, i) => (
          <Card key={i} padding={14}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <Pill color={t.priority === 'high' ? 'danger' : t.priority === 'med' ? 'warning' : 'neutral'}>
                {t.priority === 'high' ? 'Pilne' : t.priority === 'med' ? 'Średnie' : 'Niskie'}
              </Pill>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>#{t.id}</span>
            </div>
            <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--text-primary)' }}>{t.title}</div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>{t.location}</div>
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: t.status === 'closed' ? 'var(--success)' : t.status === 'in-progress' ? 'var(--warning)' : 'var(--info)' }}/>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 500 }}>{t.statusLabel}</span>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-tertiary)' }}>{t.time}</span>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
};

const ParcelsScreen = ({ data, onBack }) => (
  <div className="screen scroll-area" style={{ paddingBottom: 110 }}>
    <StatusBar />
    <ScreenHeader title="Przesyłki" onBack={onBack}/>
    <div style={{ padding: '0 16px 16px' }}>
      <Card padding={16} style={{ background: 'linear-gradient(135deg, var(--accent-700), var(--accent-500))', border: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <IconParcel size={24} color="#fff"/>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)' }}>Oczekujące</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: '#fff', letterSpacing: '-0.02em' }}>2 paczki</div>
          </div>
        </div>
      </Card>
    </div>
    <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {data.parcels.map((p, i) => (
        <Card key={i} padding={14}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <Pill color={p.status === 'waiting' ? 'warning' : p.status === 'delivered' ? 'success' : 'info'}>
              {p.statusLabel}
            </Pill>
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{p.time}</span>
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{p.title}</div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>{p.carrier} · {p.tracking}</div>
          {p.locker && (
            <div style={{ marginTop: 10, padding: 10, background: 'var(--bg-3)', borderRadius: 'var(--r-md)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <IconBox size={16} color="var(--accent-300)"/>
              <span style={{ fontSize: 12.5, color: 'var(--text-primary)', fontWeight: 500 }}>Schowek #{p.locker} · kod {p.code}</span>
            </div>
          )}
        </Card>
      ))}
    </div>
  </div>
);

const PaymentsScreen = ({ data, onBack }) => (
  <div className="screen scroll-area" style={{ paddingBottom: 110 }}>
    <StatusBar />
    <ScreenHeader title="Płatności" onBack={onBack}/>
    <div style={{ padding: '0 16px 16px' }}>
      <div style={{
        background: 'linear-gradient(135deg, rgba(248,113,113,0.18), rgba(248,113,113,0.05))',
        border: '1px solid rgba(248,113,113,0.3)',
        borderRadius: 'var(--r-2xl)', padding: 18,
      }}>
        <Pill color="danger">Do zapłaty</Pill>
        <div style={{ fontSize: 32, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.025em', marginTop: 10 }}>834,00 zł</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 4 }}>Czynsz · maj 2026 · termin 10. maja</div>
        <button style={{
          marginTop: 14, width: '100%',
          background: 'var(--danger)', color: '#fff', border: 'none',
          padding: '12px', borderRadius: 'var(--r-md)',
          fontSize: 14, fontWeight: 600, cursor: 'pointer',
        }}>Zapłać Blikiem</button>
      </div>
    </div>
    <div style={{ padding: '0 16px' }}>
      <SectionHeader title="Historia"/>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {data.payments.map((p, i) => (
          <Card key={i} padding={14} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 'var(--r-md)',
              background: p.paid ? 'var(--success-bg)' : 'var(--warning-bg)',
              color: p.paid ? 'var(--success)' : 'var(--warning)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{p.paid ? <IconCheck size={18}/> : <IconClock size={18}/>}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>{p.title}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{p.date}</div>
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{p.amount}</div>
          </Card>
        ))}
      </div>
    </div>
  </div>
);

const ProfileScreen = ({ data, onBack, theme, onTheme, onOpenVehicles, onOpenGuests }) => (
  <div className="screen scroll-area" style={{ paddingBottom: 110 }}>
    <StatusBar />
    <ScreenHeader title="Profil" onBack={onBack}/>
    <div style={{ padding: '0 16px' }}>
      <Card padding={16} style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'url(assets/avatar.svg) center/cover', border: '2px solid var(--border-default)' }}/>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>{data.user.name}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{data.user.estate}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{data.user.address}</div>
        </div>
      </Card>

      <SectionHeader title="Mieszkanie" />
      <Card padding={4}>
        <ProfileRow icon={IconMapPin} label="Adres" value="Niewinna 1, Wilanów"/>
        <ProfileRow icon={IconKey} label="Klucze cyfrowe" value="3 aktywne"/>
        <ProfileRow icon={IconUsers} label="Domownicy" value="2 osoby"/>
        <ProfileRow icon={IconCar} label="Pojazdy" value={`${data.vehicles?.length || 0} ${data.vehicles?.length === 1 ? 'pojazd' : 'pojazdy'}`} onClick={onOpenVehicles}/>
        <ProfileRow icon={IconUsers} label="Goście" value={`${data.guests?.filter(g => g.status !== 'expired').length || 0} aktywne`} onClick={onOpenGuests} last/>
      </Card>

      <SectionHeader title="Aplikacja" />
      <Card padding={4}>
        <ProfileRow icon={theme === 'light' ? IconSun : IconMoon} label="Motyw" value={theme === 'light' ? 'Jasny' : 'Ciemny'} onClick={() => onTheme?.(theme === 'light' ? 'dark' : 'light')}/>
        <ProfileRow icon={IconBell} label="Powiadomienia" value="Włączone"/>
        <ProfileRow icon={IconShield} label="Bezpieczeństwo" value="Face ID"/>
        <ProfileRow icon={IconSettings} label="Ustawienia" last/>
      </Card>
    </div>
  </div>
);

const ProfileRow = ({ icon: I, label, value, onClick, last }) => (
  <div onClick={onClick} style={{
    padding: '14px', display: 'flex', alignItems: 'center', gap: 12,
    borderBottom: last ? 'none' : '1px solid var(--border-subtle)',
    cursor: onClick ? 'pointer' : 'default',
  }}>
    <I size={18} color="var(--text-secondary)"/>
    <div style={{ flex: 1, fontSize: 14, color: 'var(--text-primary)', fontWeight: 500 }}>{label}</div>
    {value && <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>{value}</div>}
    <IconChevronRight size={16} color="var(--text-tertiary)"/>
  </div>
);

const ScreenHeader = ({ title, onBack, action }) => (
  <div style={{
    paddingTop: 60, padding: '60px 16px 14px',
    display: 'flex', alignItems: 'center', gap: 12,
  }}>
    {onBack && <button onClick={onBack} style={{...miniIconBtn()}}><IconChevronLeft size={18}/></button>}
    <div style={{ flex: 1, fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>{title}</div>
    {action}
  </div>
);

Object.assign(window, {
  NotificationsScreen, TicketsScreen, ParcelsScreen, PaymentsScreen, ProfileScreen, ScreenHeader,
});
