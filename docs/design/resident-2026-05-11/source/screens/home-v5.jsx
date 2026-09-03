// Home v5 — Smart Dashboard
// Density. Smart-home tiles, energy/temperature glance, gate as one of many controls.

const HomeV5 = ({ data, onOpenGate, showHero = true, showPayments = true }) => {
  return (
    <div className="screen scroll-area" style={{ paddingBottom: 110 }}>
      <StatusBar />

      {/* Header */}
      <div style={{ padding: '60px 16px 12px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'url(assets/avatar.svg) center/cover' }}/>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Dzień dobry</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{data.user.firstName}</div>
        </div>
        <button style={{ ...miniIconBtn() }}><IconBell size={16}/></button>
        <button style={{ ...miniIconBtn() }}><IconSettings size={16}/></button>
      </div>

      {/* Stats strip */}
      <div style={{
        margin: '0 16px',
        padding: '14px 16px',
        background: 'var(--bg-2)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--r-xl)',
        display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12,
      }}>
        <Stat label="Temp." value="21°" sub="dom" color="var(--accent-300)"/>
        <Stat label="Energia" value="2.4 kW" sub="dziś" color="var(--success)"/>
        <Stat label="Kamery" value="6" sub="aktywne" color="var(--info)"/>
      </div>

      {/* Smart tile grid */}
      <div style={{
        padding: '14px 16px 0',
        display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10,
      }}>
        <SmartTile big icon={IconLock} label="Wjazd" sub="Zamknięta" active onClick={() => onOpenGate?.('entry')}/>
        <SmartTile big icon={IconLock} label="Wyjazd" sub="Zamknięta" active onClick={() => onOpenGate?.('exit')}/>
        <SmartTile icon={IconLightbulb} label="Światło zewn." sub="3 włączone" />
        <SmartTile icon={IconShield} label="Alarm" sub="Uzbrojony" active />
        <SmartTile icon={IconCamera} label="Kamery" sub="Wszystko OK" />
        <SmartTile icon={IconParcel} label="Paczkomat" sub="2 oczekują" badge={2}/>
      </div>

      {/* Payments inline */}
      {showPayments && (
        <div style={{ padding: '16px 16px 0' }}>
          <Card padding={14} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 8, height: 38, borderRadius: 4, background: 'var(--danger)' }}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Czynsz · termin za 11 dni</div>
              <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>834,00 zł</div>
            </div>
            <button style={{
              background: 'var(--accent-300)', color: '#fff', border: 'none',
              padding: '8px 14px', borderRadius: 'var(--r-md)',
              fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
            }}>Zapłać</button>
          </Card>
        </div>
      )}

      {/* Activity dense */}
      <div style={{ padding: '16px 16px 0' }}>
        <SectionHeader title="Aktywność" actionLabel="→" action={() => {}}/>
        <Card padding={4}>
          {data.activity.slice(0, 3).map((a, i) => (
            <React.Fragment key={i}>
              <ActivityItem {...a}/>
              {i < 2 && <div style={{ height: 1, background: 'var(--border-subtle)', margin: '0 14px' }}/>}
            </React.Fragment>
          ))}
        </Card>
      </div>
    </div>
  );
};

const Stat = ({ label, value, sub, color }) => (
  <div>
    <div style={{ fontSize: 10, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>{label}</div>
    <div style={{ fontSize: 18, fontWeight: 700, color, letterSpacing: '-0.02em', marginTop: 4 }}>{value}</div>
    <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginTop: 1 }}>{sub}</div>
  </div>
);

const SmartTile = ({ icon: I, label, sub, active, big, badge, onClick }) => (
  <button onClick={onClick} style={{
    background: active ? 'linear-gradient(135deg, var(--accent-300), var(--accent-500))' : 'var(--bg-2)',
    border: active ? 'none' : '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-xl)',
    padding: big ? 16 : 14,
    minHeight: big ? 110 : 90,
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
    gap: big ? 14 : 8,
    cursor: 'pointer', position: 'relative',
    color: active ? '#fff' : 'var(--text-primary)',
    textAlign: 'left',
    boxShadow: active ? '0 8px 24px var(--accent-glow)' : 'none',
  }}>
    <div style={{
      width: big ? 36 : 30, height: big ? 36 : 30, borderRadius: '50%',
      background: active ? 'rgba(255,255,255,0.2)' : 'var(--bg-4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}><I size={big ? 18 : 16} color={active ? '#fff' : 'var(--accent-300)'} strokeWidth={2}/></div>
    <div>
      <div style={{ fontSize: big ? 15 : 13.5, fontWeight: 600, letterSpacing: '-0.01em' }}>{label}</div>
      <div style={{ fontSize: 11, opacity: active ? 0.85 : 0.6, marginTop: 2 }}>{sub}</div>
    </div>
    {badge && <span style={{
      position: 'absolute', top: 10, right: 10,
      minWidth: 18, height: 18, padding: '0 5px',
      borderRadius: 'var(--r-full)', background: 'var(--icon-orange)',
      color: '#fff', fontSize: 10, fontWeight: 700,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>{badge}</span>}
  </button>
);

const miniIconBtn = () => ({
  width: 36, height: 36, borderRadius: 'var(--r-md)',
  background: 'var(--bg-2)', border: '1px solid var(--border-subtle)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  color: 'var(--text-primary)', cursor: 'pointer',
});

window.HomeV5 = HomeV5;
window.SmartTile = SmartTile;
window.Stat = Stat;
window.miniIconBtn = miniIconBtn;
