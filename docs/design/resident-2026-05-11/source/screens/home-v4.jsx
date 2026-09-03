// Home v4 — Minimal / Information-light
// Strip ruthlessly. White space. Thin lines. Dieter Rams meets gate.

const HomeV4 = ({ data, onOpenGate, showHero = true, showPayments = true }) => {
  return (
    <div className="screen scroll-area" style={{ paddingBottom: 110, background: 'var(--bg-1)' }}>
      <StatusBar />

      {/* Spare top */}
      <div style={{ padding: '60px 24px 0' }}>
        <div style={{
          fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 600,
          textTransform: 'uppercase', letterSpacing: '0.12em',
        }}>{data.user.estate}</div>
        <div style={{
          fontSize: 28, fontWeight: 700, color: 'var(--text-primary)',
          letterSpacing: '-0.03em', marginTop: 4,
        }}>{data.user.firstName}</div>
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginTop: 2 }}>
          {data.user.address}
        </div>
      </div>

      {/* Tiny status row */}
      <div style={{
        margin: '20px 24px 0',
        padding: '10px 0',
        display: 'flex', gap: 18,
        borderTop: '1px solid var(--border-subtle)',
        borderBottom: '1px solid var(--border-subtle)',
      }}>
        <StatusDot label="System" value="OK" color="var(--success)"/>
        <StatusDot label="Brama" value="Zamknięta" color="var(--text-secondary)"/>
        <StatusDot label="Goście" value="0" color="var(--text-secondary)"/>
      </div>

      {/* Two big text gates */}
      <div style={{ padding: '24px 24px 0', display: 'flex', flexDirection: 'column' }}>
        <MinimalGateRow label="Otwórz wjazd" sub="Brama główna" onClick={() => onOpenGate?.('entry')}/>
        <MinimalGateRow label="Otwórz wyjazd" sub="Brama tylna" onClick={() => onOpenGate?.('exit')}/>
      </div>

      {/* Quick actions inline */}
      <div style={{ padding: '24px 24px 0' }}>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 14 }}>Skróty</div>
        <div style={{ display: 'flex', gap: 0, borderTop: '1px solid var(--border-subtle)' }}>
          {[
            { icon: IconUsers, label: 'Goście' },
            { icon: IconQR, label: 'Kod' },
            { icon: IconParcel, label: 'Paczki' },
            { icon: IconWrench, label: 'Zgłoś' },
          ].map((a, i, arr) => {
            const I = a.icon;
            return (
              <button key={i} style={{
                flex: 1, padding: '14px 4px',
                background: 'none', border: 'none',
                borderBottom: '1px solid var(--border-subtle)',
                borderRight: i < arr.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                color: 'var(--text-primary)', cursor: 'pointer',
              }}>
                <I size={18} strokeWidth={1.6}/>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{a.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Payment row */}
      {showPayments && (
        <div style={{
          margin: '24px 24px 0',
          padding: '14px 0',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600 }}>Do zapłaty</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.02em', marginTop: 4 }}>834,00 zł</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 2 }}>Termin 10. maja</div>
          </div>
          <button style={{
            background: 'var(--accent-300)', color: '#fff', border: 'none',
            padding: '10px 18px', borderRadius: 'var(--r-full)',
            fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}>Zapłać</button>
        </div>
      )}

      {/* Activity — flat */}
      <div style={{ padding: '24px 24px 0' }}>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 14 }}>Ostatnia aktywność</div>
        {data.activity.slice(0, 3).map((a, i) => (
          <div key={i} style={{
            padding: '12px 0',
            borderTop: '1px solid var(--border-subtle)',
            display: 'flex', alignItems: 'flex-start', gap: 12,
          }}>
            <div style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', color: a.iconColor || 'var(--icon-orange)' }}>
              <a.icon size={18} strokeWidth={1.8}/>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>{a.title}</div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>{a.subtitle}</div>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{a.time}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

const StatusDot = ({ label, value, color }) => (
  <div style={{ flex: 1 }}>
    <div style={{ fontSize: 10, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600 }}>{label}</div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
      <div style={{ width: 6, height: 6, borderRadius: '50%', background: color }}/>
      <span style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>{value}</span>
    </div>
  </div>
);

const MinimalGateRow = ({ label, sub, onClick }) => (
  <button onClick={onClick} style={{
    background: 'none', border: 'none',
    padding: '20px 0',
    borderTop: '1px solid var(--border-subtle)',
    display: 'flex', alignItems: 'center', gap: 16, cursor: 'pointer',
    color: 'var(--text-primary)', textAlign: 'left',
  }}>
    <div style={{
      width: 44, height: 44, borderRadius: '50%',
      border: '1.5px solid var(--accent-300)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--accent-300)',
    }}><IconUnlock size={18} strokeWidth={1.8}/></div>
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.02em' }}>{label}</div>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>{sub}</div>
    </div>
    <IconChevronRight size={18} color="var(--text-tertiary)"/>
  </button>
);

window.HomeV4 = HomeV4;
window.MinimalGateRow = MinimalGateRow;
window.StatusDot = StatusDot;
