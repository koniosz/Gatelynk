// Home v1 — Refined Classic
// Cleanup of original screen: same components, better hierarchy, breathing room.
// Hero photo collapsed, status moved up, gate buttons primary.

const HomeV1 = ({ data, onOpenGate, showHero = true, showPayments = true }) => {
  return (
    <div className="screen scroll-area" style={{ paddingBottom: 110 }}>
      <StatusBar />

      {/* Hero */}
      {showHero && (
        <div style={{
          position: 'relative', height: 220, overflow: 'hidden',
          background: 'linear-gradient(180deg, transparent 30%, var(--bg-1) 100%), url(assets/villa.svg) center/cover',
        }}>
          <div style={{
            position: 'absolute', top: 60, right: 20,
            display: 'flex', flexDirection: 'column', gap: 12,
          }}>
            <button style={iconBtnStyle()}>
              <IconBell size={20} strokeWidth={2} color="#fff"/>
              <span style={{
                position:'absolute', top:6, right:6, width:8, height:8,
                borderRadius:'50%', background:'var(--icon-orange)',
              }}/>
            </button>
          </div>
        </div>
      )}

      {/* Identity card overlapping */}
      <div style={{
        margin: showHero ? '-60px 16px 0' : '64px 16px 0',
        background: 'var(--bg-2)',
        borderRadius: 'var(--r-2xl)',
        padding: 16,
        border: '1px solid var(--border-subtle)',
        boxShadow: 'var(--shadow-md)',
        position: 'relative', zIndex: 2,
      }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <div style={{ position: 'relative' }}>
            <div style={{
              width: 56, height: 56, borderRadius: '50%',
              background: 'url(assets/avatar.svg) center/cover',
              border: '2px solid var(--bg-3)',
            }}/>
            <div style={{
              position: 'absolute', bottom: -2, right: -2,
              width: 22, height: 22, borderRadius: '50%',
              background: 'var(--accent-300)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: '3px solid var(--bg-2)',
            }}><IconCamera size={11} color="#fff" strokeWidth={2.5}/></div>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
              {data.user.name}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 2 }}>
              {data.user.estate}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 1 }}>
              {data.user.address}
            </div>
          </div>
        </div>
        <div style={{
          marginTop: 12, paddingTop: 12,
          borderTop: '1px solid var(--border-subtle)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--success)' }}/>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>System: OK</span>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-tertiary)' }}>
            ostatnia synchronizacja 2 min temu
          </span>
        </div>
      </div>

      {/* Primary gate actions */}
      <div style={{ padding: '20px 16px 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <button onClick={() => onOpenGate?.('entry')} style={gateBtnStyle()}>
          <IconLock size={20}/>
          <span style={{ flex: 1, textAlign: 'left' }}>Otwórz Wjazd</span>
          <IconChevronRight size={18} color="var(--text-tertiary)"/>
        </button>
        <button onClick={() => onOpenGate?.('exit')} style={gateBtnStyle()}>
          <IconLock size={20}/>
          <span style={{ flex: 1, textAlign: 'left' }}>Otwórz Wyjazd</span>
          <IconChevronRight size={18} color="var(--text-tertiary)"/>
        </button>
      </div>

      {/* Quick actions row */}
      <div style={{ padding: '16px 16px 0', display: 'flex', gap: 10 }}>
        <QuickAction icon={IconUsers} label="Goście"/>
        <QuickAction icon={IconQR} label="Kod QR"/>
        <QuickAction icon={IconWrench} label="Zgłoś"/>
        <QuickAction icon={IconParcel} label="Paczki" badge={2}/>
      </div>

      {/* Payments */}
      {showPayments && (
        <div style={{ padding: '20px 16px 0' }}>
          <div style={{
            background: 'linear-gradient(135deg, rgba(248,113,113,0.18), rgba(248,113,113,0.08))',
            border: '1px solid rgba(248,113,113,0.25)',
            borderRadius: 'var(--r-xl)',
            padding: 16,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <IconCard size={16} color="var(--danger)"/>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Czynsz · maj 2026</span>
              <Pill color="danger">Do zapłaty</Pill>
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 4 }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.025em' }}>
                834,00 zł
              </div>
              <button style={{
                background: 'var(--danger)', color: '#fff', border: 'none',
                padding: '8px 14px', borderRadius: 'var(--r-md)',
                fontSize: 13, fontWeight: 600, cursor: 'pointer',
              }}>Zapłać</button>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 6 }}>
              Termin: 10. dnia miesiąca · pozostało 11 dni
            </div>
          </div>
        </div>
      )}

      {/* Activity feed */}
      <div style={{ padding: '24px 16px 0' }}>
        <SectionHeader title="Ostatnia aktywność" actionLabel="Wszystkie →" action={() => {}}/>
        <Card padding={4} style={{ overflow: 'hidden' }}>
          {data.activity.map((a, i) => (
            <React.Fragment key={i}>
              <ActivityItem {...a}/>
              {i < data.activity.length - 1 && (
                <div style={{ height: 1, background: 'var(--border-subtle)', margin: '0 14px' }}/>
              )}
            </React.Fragment>
          ))}
        </Card>
      </div>
    </div>
  );
};

const QuickAction = ({ icon: I, label, badge }) => (
  <button style={{
    flex: 1, background: 'var(--bg-2)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-lg)',
    padding: '12px 6px',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
    cursor: 'pointer', position: 'relative',
    color: 'var(--text-primary)',
  }}>
    <I size={20} strokeWidth={1.8} color="var(--accent-300)"/>
    <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-secondary)' }}>{label}</span>
    {badge && <span style={{
      position: 'absolute', top: 6, right: 10,
      minWidth: 16, height: 16, padding: '0 4px',
      borderRadius: 'var(--r-full)', background: 'var(--accent-300)',
      color: '#fff', fontSize: 10, fontWeight: 700,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>{badge}</span>}
  </button>
);

const iconBtnStyle = () => ({
  width: 40, height: 40, borderRadius: '50%',
  background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(20px)',
  border: '1px solid rgba(255,255,255,0.15)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer', position: 'relative',
});

const gateBtnStyle = () => ({
  background: 'var(--bg-2)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-xl)',
  padding: '16px 18px',
  display: 'flex', alignItems: 'center', gap: 14,
  fontSize: 15, fontWeight: 600, color: 'var(--text-primary)',
  cursor: 'pointer', width: '100%',
});

window.HomeV1 = HomeV1;
window.QuickAction = QuickAction;
window.gateBtnStyle = gateBtnStyle;
window.iconBtnStyle = iconBtnStyle;
