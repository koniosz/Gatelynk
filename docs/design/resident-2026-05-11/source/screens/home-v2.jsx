// Home v2 — Big Action Focus
// Single dominant gate-control card. Everything else compressed.
// "I came home, open the gate" is the only thing that matters.

const HomeV2 = ({ data, onOpenGate, showHero = true, showPayments = true }) => {
  return (
    <div className="screen scroll-area" style={{ paddingBottom: 110 }}>
      <StatusBar />

      {/* Compact top bar */}
      <div style={{
        padding: '60px 20px 12px',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: '50%',
          background: 'url(assets/avatar.svg) center/cover',
          border: '1.5px solid var(--border-default)',
        }}/>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>
            Witaj
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
            {data.user.firstName}
          </div>
        </div>
        <button style={{
          width: 40, height: 40, borderRadius: 'var(--r-md)',
          background: 'var(--bg-2)', border: '1px solid var(--border-subtle)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-primary)', cursor: 'pointer', position: 'relative',
        }}>
          <IconBell size={18}/>
          <span style={{
            position: 'absolute', top: 8, right: 8,
            width: 8, height: 8, borderRadius: '50%',
            background: 'var(--icon-orange)', border: '2px solid var(--bg-2)',
          }}/>
        </button>
      </div>

      {/* Hero gate card */}
      <div style={{ padding: '8px 16px 0' }}>
        <div style={{
          position: 'relative',
          background: showHero
            ? `linear-gradient(180deg, rgba(11,16,32,0) 0%, rgba(11,16,32,0.55) 50%, rgba(11,16,32,0.95) 100%), url(assets/villa.svg) center/cover`
            : `linear-gradient(160deg, var(--accent-700) 0%, var(--bg-3) 100%)`,
          borderRadius: 'var(--r-3xl)',
          padding: 20,
          minHeight: 320,
          display: 'flex', flexDirection: 'column',
          border: '1px solid var(--border-subtle)',
          overflow: 'hidden',
        }}>
          {/* Top: estate + status */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', display: 'flex', alignItems: 'center', gap: 5 }}>
                <IconMapPin size={12} strokeWidth={2}/>
                {data.user.estate}
              </div>
              <div style={{ fontSize: 14, color: '#fff', fontWeight: 500, marginTop: 4, opacity: 0.85 }}>
                {data.user.address}
              </div>
            </div>
            <Pill color="success">● Online</Pill>
          </div>

          <div style={{ flex: 1 }}/>

          {/* Two big gate actions */}
          <div style={{ display: 'flex', gap: 10 }}>
            <BigGateBtn label="Wjazd" onClick={() => onOpenGate?.('entry')}/>
            <BigGateBtn label="Wyjazd" onClick={() => onOpenGate?.('exit')}/>
          </div>
        </div>
      </div>

      {/* Quick actions */}
      <div style={{ padding: '16px 16px 0', display: 'flex', gap: 10 }}>
        <QuickAction icon={IconUsers} label="Goście"/>
        <QuickAction icon={IconQR} label="Kod QR"/>
        <QuickAction icon={IconWrench} label="Zgłoś"/>
        <QuickAction icon={IconParcel} label="Paczki" badge={2}/>
      </div>

      {/* Payments compact row */}
      {showPayments && (
        <div style={{ padding: '20px 16px 0' }}>
          <Card padding={14} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 38, height: 38, borderRadius: 'var(--r-md)',
              background: 'var(--danger-bg)', color: 'var(--danger)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}><IconCard size={18}/></div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Czynsz · maj</div>
              <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
                834,00 zł
              </div>
            </div>
            <button style={{
              background: 'var(--danger)', color: '#fff', border: 'none',
              padding: '8px 12px', borderRadius: 'var(--r-md)',
              fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
            }}>Zapłać</button>
          </Card>
        </div>
      )}

      {/* Activity */}
      <div style={{ padding: '20px 16px 0' }}>
        <SectionHeader title="Aktywność" actionLabel="Wszystkie →" action={() => {}}/>
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

const BigGateBtn = ({ label, onClick }) => (
  <button onClick={onClick} style={{
    flex: 1,
    background: 'rgba(255,255,255,0.10)',
    backdropFilter: 'blur(20px)',
    border: '1px solid rgba(255,255,255,0.2)',
    borderRadius: 'var(--r-xl)',
    padding: '16px 12px',
    color: '#fff',
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12,
    cursor: 'pointer',
  }}>
    <div style={{
      width: 36, height: 36, borderRadius: '50%',
      background: 'var(--accent-300)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}><IconUnlock size={18} color="#fff" strokeWidth={2.2}/></div>
    <div style={{ textAlign: 'left' }}>
      <div style={{ fontSize: 11, opacity: 0.7, fontWeight: 500 }}>Otwórz</div>
      <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.02em' }}>{label}</div>
    </div>
  </button>
);

window.HomeV2 = HomeV2;
window.BigGateBtn = BigGateBtn;
