// Home v6 — Feed-first / Activity-led
// Like a residential timeline. Gate is a sticky pill at the bottom.

const HomeV6 = ({ data, onOpenGate, showHero = true, showPayments = true }) => {
  const allItems = [
    ...(showPayments ? [{ kind: 'payment' }] : []),
    { kind: 'announce', a: data.activity[0] },
    { kind: 'announce', a: data.activity[1] },
    { kind: 'parcel' },
    { kind: 'announce', a: data.activity[2] },
    { kind: 'visitor' },
  ];

  return (
    <div className="screen scroll-area" style={{ paddingBottom: 180 }}>
      <StatusBar />

      {/* Header */}
      <div style={{ padding: '60px 20px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'url(assets/avatar.svg) center/cover' }}/>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>{data.user.firstName}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{data.user.estate} · System OK</div>
        </div>
        <button style={{ ...miniIconBtn(), position: 'relative' }}>
          <IconBell size={16}/>
          <span style={{ position:'absolute', top:6, right:6, width:7, height:7, borderRadius:'50%', background:'var(--icon-orange)' }}/>
        </button>
      </div>

      {/* Filter chips */}
      <div style={{ padding: '0 20px 14px', display: 'flex', gap: 8, overflowX: 'auto', scrollbarWidth: 'none' }}>
        {['Wszystko', 'Ogłoszenia', 'Płatności', 'Paczki', 'Goście'].map((c, i) => (
          <button key={i} style={{
            padding: '7px 14px', borderRadius: 'var(--r-full)',
            background: i === 0 ? 'var(--accent-300)' : 'var(--bg-2)',
            color: i === 0 ? '#fff' : 'var(--text-secondary)',
            border: i === 0 ? 'none' : '1px solid var(--border-subtle)',
            fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}>{c}</button>
        ))}
      </div>

      {/* Timeline */}
      <div style={{ padding: '0 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {allItems.map((item, i) => (
          <FeedCard key={i} item={item}/>
        ))}
      </div>

      {/* Sticky gate dock */}
      <div style={{
        position: 'absolute', bottom: 96, left: 0, right: 0,
        padding: '12px 16px',
        background: 'linear-gradient(180deg, transparent, var(--bg-1) 60%)',
        zIndex: 3,
      }}>
        <div style={{
          background: 'var(--bg-2)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--r-full)',
          padding: 6,
          display: 'flex', gap: 6,
          boxShadow: 'var(--shadow-md)',
        }}>
          <button onClick={() => onOpenGate?.('entry')} style={{
            flex: 1, background: 'var(--accent-300)', border: 'none',
            borderRadius: 'var(--r-full)',
            padding: '12px 14px',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            color: '#fff', fontSize: 13.5, fontWeight: 600, cursor: 'pointer',
          }}>
            <IconUnlock size={16} strokeWidth={2.2}/> Wjazd
          </button>
          <button onClick={() => onOpenGate?.('exit')} style={{
            flex: 1, background: 'transparent', border: 'none',
            borderRadius: 'var(--r-full)',
            padding: '12px 14px',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            color: 'var(--text-primary)', fontSize: 13.5, fontWeight: 600, cursor: 'pointer',
          }}>
            <IconUnlock size={16} strokeWidth={2.2}/> Wyjazd
          </button>
        </div>
      </div>
    </div>
  );
};

const FeedCard = ({ item }) => {
  if (item.kind === 'payment') {
    return (
      <Card padding={14} style={{ borderColor: 'rgba(248,113,113,0.25)', background: 'rgba(248,113,113,0.08)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <Pill color="danger">Płatność</Pill>
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>termin za 11 dni</span>
        </div>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>Czynsz za maj 2026</div>
        <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.02em', marginTop: 6 }}>834,00 zł</div>
        <button style={{
          marginTop: 10, width: '100%',
          background: 'var(--danger)', color: '#fff', border: 'none',
          padding: '10px 14px', borderRadius: 'var(--r-md)',
          fontSize: 13, fontWeight: 600, cursor: 'pointer',
        }}>Zapłać teraz</button>
      </Card>
    );
  }
  if (item.kind === 'parcel') {
    return (
      <Card padding={14}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <Pill color="info">Paczkomat</Pill>
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>1 g. temu</span>
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Paczka czeka w schowku #14</div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>InPost · numer 8841...4423</div>
      </Card>
    );
  }
  if (item.kind === 'visitor') {
    return (
      <Card padding={14}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <Pill color="warning">Gość</Pill>
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>jutro 14:00</span>
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Marta Nowak — wizyta zaplanowana</div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>Kod QR aktywny przez 4 godziny</div>
      </Card>
    );
  }
  const a = item.a;
  const I = a.icon;
  return (
    <Card padding={14}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <Pill color="warning">Ogłoszenie</Pill>
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{a.time}</span>
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div style={{
          width: 32, height: 32, borderRadius: '50%',
          background: 'var(--icon-orange-bg)', color: 'var(--icon-orange)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><I size={16}/></div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.3 }}>{a.title}</div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>{a.subtitle}</div>
        </div>
      </div>
    </Card>
  );
};

window.HomeV6 = HomeV6;
window.FeedCard = FeedCard;
