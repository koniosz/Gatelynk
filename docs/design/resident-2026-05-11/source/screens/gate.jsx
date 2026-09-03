// Full-screen gate opening flow — 3 interaction variants
// Variants: 'tap', 'hold', 'slide'

const GateScreen = ({ direction = 'entry', variant = 'hold', onClose, onComplete }) => {
  const [state, setState] = React.useState('idle'); // idle | opening | open | closing
  const [progress, setProgress] = React.useState(0);
  const holdRef = React.useRef(null);
  const slideRef = React.useRef(null);
  const [slideX, setSlideX] = React.useState(0);

  const targets = {
    entry: { label: 'Wjazd', sub: 'Brama główna · Niewinna 1', danger: false },
    exit:  { label: 'Wyjazd', sub: 'Brama tylna · Niewinna 1', danger: false },
    fire:  { label: 'Brama pożarowa', sub: 'Wyjście awaryjne', danger: true },
    home:  { label: 'Mój dom', sub: 'Drzwi wejściowe', danger: false },
  };
  const t = targets[direction] || targets.entry;
  const label = t.label;
  const sub = t.sub;
  const isDanger = t.danger;

  const trigger = () => {
    if (state !== 'idle') return;
    setState('opening');
    setTimeout(() => setState('open'), 1800);
    setTimeout(() => setState('closing'), 5000);
    setTimeout(() => onComplete?.(), 6500);
  };

  // Hold-to-open
  const startHold = () => {
    if (state !== 'idle') return;
    let p = 0;
    holdRef.current = setInterval(() => {
      p += 4;
      setProgress(p);
      if (p >= 100) {
        clearInterval(holdRef.current);
        trigger();
      }
    }, 30);
  };
  const cancelHold = () => {
    if (holdRef.current) clearInterval(holdRef.current);
    if (state === 'idle') setProgress(0);
  };

  // Slide-to-open
  const SLIDE_MAX = 220;
  const onSlideStart = (e) => {
    if (state !== 'idle') return;
    const startX = e.touches ? e.touches[0].clientX : e.clientX;
    const move = (ev) => {
      const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - startX;
      const clamped = Math.max(0, Math.min(SLIDE_MAX, x));
      setSlideX(clamped);
      if (clamped >= SLIDE_MAX - 4) {
        end();
        trigger();
      }
    };
    const end = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', end);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', end);
      if (slideX < SLIDE_MAX - 4) setSlideX(0);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    window.addEventListener('touchmove', move);
    window.addEventListener('touchend', end);
  };

  const statusText = {
    idle: variant === 'tap' ? 'Naciśnij, aby otworzyć' : variant === 'hold' ? 'Przytrzymaj, aby otworzyć' : 'Przesuń, aby otworzyć',
    opening: 'Otwieranie...',
    open: 'Brama otwarta',
    closing: 'Zamykanie...',
  }[state];

  const statusColor = state === 'open' ? 'var(--success)' : state === 'idle' ? 'var(--text-secondary)' : 'var(--accent-300)';

  return (
    <div className="screen" style={{
      background: state === 'open'
        ? 'radial-gradient(circle at center, rgba(52,211,153,0.18) 0%, var(--bg-1) 60%)'
        : state === 'opening' || state === 'closing'
        ? 'radial-gradient(circle at center, rgba(167,139,250,0.18) 0%, var(--bg-1) 60%)'
        : 'var(--bg-1)',
      transition: 'background 0.6s',
    }}>
      <StatusBar />

      {/* Close */}
      <button onClick={onClose} style={{
        position: 'absolute', top: 60, left: 16, zIndex: 5,
        width: 40, height: 40, borderRadius: '50%',
        background: 'var(--bg-2)', border: '1px solid var(--border-subtle)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-primary)', cursor: 'pointer',
      }}><IconClose size={18}/></button>

      {/* Direction label top */}
      <div style={{ position: 'absolute', top: 60, left: 0, right: 0, textAlign: 'center', zIndex: 4 }}>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 600 }}>
          Otwieranie · {label}
        </div>
      </div>

      {/* Center stage */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: '0 24px',
      }}>
        {/* Animated gate visual */}
        <GateVisual state={state} />

        {/* Status */}
        <div style={{ marginTop: 32, textAlign: 'center' }}>
          <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>{label}</div>
          <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginTop: 4 }}>{sub}</div>
          <div style={{
            marginTop: 18, display: 'inline-flex', alignItems: 'center', gap: 8,
            padding: '8px 14px', borderRadius: 'var(--r-full)',
            background: 'var(--bg-2)', border: '1px solid var(--border-subtle)',
          }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor,
              animation: state !== 'idle' && state !== 'open' ? 'pulse 1.2s infinite' : 'none' }}/>
            <span style={{ fontSize: 13, fontWeight: 500, color: statusColor }}>{statusText}</span>
          </div>
        </div>
      </div>

      {/* Bottom action */}
      <div style={{
        position: 'absolute', bottom: 60, left: 0, right: 0,
        padding: '0 24px',
      }}>
        {variant === 'tap' && (
          <button
            onClick={trigger}
            disabled={state !== 'idle'}
            style={{
              width: '100%', padding: '20px',
              background: state === 'idle'
                ? 'linear-gradient(180deg, var(--accent-300), var(--accent-500))'
                : 'var(--bg-3)',
              border: 'none', borderRadius: 'var(--r-2xl)',
              color: '#fff', fontSize: 17, fontWeight: 700, letterSpacing: '-0.01em',
              cursor: state === 'idle' ? 'pointer' : 'default',
              boxShadow: state === 'idle' ? '0 12px 30px var(--accent-glow)' : 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            }}>
            <IconUnlock size={20} strokeWidth={2.2}/>
            Otwórz {label.toLowerCase()}
          </button>
        )}

        {variant === 'hold' && (
          <button
            onMouseDown={startHold} onMouseUp={cancelHold} onMouseLeave={cancelHold}
            onTouchStart={startHold} onTouchEnd={cancelHold}
            disabled={state !== 'idle'}
            style={{
              width: '100%', padding: '20px',
              background: 'var(--bg-2)',
              border: '1px solid var(--border-default)',
              borderRadius: 'var(--r-2xl)',
              color: 'var(--text-primary)', fontSize: 16, fontWeight: 600,
              cursor: state === 'idle' ? 'pointer' : 'default',
              position: 'relative', overflow: 'hidden',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            }}>
            <div style={{
              position: 'absolute', top: 0, left: 0, bottom: 0,
              width: `${state === 'idle' ? progress : 100}%`,
              background: 'linear-gradient(90deg, var(--accent-400), var(--accent-300))',
              transition: progress === 0 ? 'width 0.3s' : 'none',
              opacity: 0.85,
            }}/>
            <span style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 10, color: progress > 50 ? '#fff' : 'var(--text-primary)' }}>
              <IconUnlock size={20}/>
              Przytrzymaj, aby otworzyć
            </span>
          </button>
        )}

        {variant === 'slide' && (
          <div ref={slideRef}
            style={{
              position: 'relative',
              width: '100%', height: 64,
              background: 'var(--bg-2)',
              border: '1px solid var(--border-default)',
              borderRadius: 'var(--r-full)',
              overflow: 'hidden',
              display: 'flex', alignItems: 'center',
            }}>
            <div style={{
              position: 'absolute', left: 0, top: 0, bottom: 0,
              width: slideX + 64,
              background: 'linear-gradient(90deg, var(--accent-400), var(--accent-300))',
              opacity: 0.8,
            }}/>
            <span style={{
              position: 'absolute', left: 0, right: 0, textAlign: 'center',
              fontSize: 14, fontWeight: 600, color: slideX > 80 ? '#fff' : 'var(--text-secondary)',
              pointerEvents: 'none',
            }}>→ Przesuń, aby otworzyć</span>
            <div
              onMouseDown={onSlideStart} onTouchStart={onSlideStart}
              style={{
                position: 'absolute', left: 4, top: 4,
                width: 56, height: 56, borderRadius: '50%',
                background: '#fff',
                transform: `translateX(${slideX}px)`,
                transition: slideX === 0 ? 'transform 0.3s' : 'none',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'grab', boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
              }}>
              <IconUnlock size={22} color="var(--accent-500)" strokeWidth={2.2}/>
            </div>
          </div>
        )}

        <div style={{ marginTop: 14, textAlign: 'center', fontSize: 11, color: 'var(--text-tertiary)' }}>
          🔒 Połączenie szyfrowane · Sygnał silny
        </div>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(1.4); }
        }
        @keyframes gate-open-l {
          from { transform: rotateY(0); } to { transform: rotateY(-75deg); }
        }
        @keyframes gate-open-r {
          from { transform: rotateY(0); } to { transform: rotateY(75deg); }
        }
        @keyframes ripple {
          0% { transform: scale(0.8); opacity: 0.6; }
          100% { transform: scale(2.2); opacity: 0; }
        }
      `}</style>
    </div>
  );
};

const GateVisual = ({ state }) => {
  const opening = state === 'opening' || state === 'open';
  const open = state === 'open';

  return (
    <div style={{
      width: 200, height: 200, position: 'relative',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      perspective: 800,
    }}>
      {/* Pulse rings when open */}
      {opening && [0, 0.4, 0.8].map((d, i) => (
        <div key={i} style={{
          position: 'absolute', width: 200, height: 200, borderRadius: '50%',
          border: '1.5px solid var(--accent-300)',
          animation: `ripple 1.6s ${d}s infinite ease-out`,
        }}/>
      ))}

      {/* Gate halves */}
      <div style={{
        position: 'absolute', width: 70, height: 130,
        background: 'linear-gradient(90deg, var(--bg-3), var(--bg-4))',
        border: '1px solid var(--border-default)',
        borderRadius: '6px 0 0 6px',
        right: '50%',
        transformOrigin: 'left center',
        transform: open ? 'rotateY(-75deg)' : 'rotateY(0)',
        transition: 'transform 1.2s cubic-bezier(0.65, 0, 0.35, 1)',
      }}>
        <GateBars />
      </div>
      <div style={{
        position: 'absolute', width: 70, height: 130,
        background: 'linear-gradient(90deg, var(--bg-4), var(--bg-3))',
        border: '1px solid var(--border-default)',
        borderRadius: '0 6px 6px 0',
        left: '50%',
        transformOrigin: 'right center',
        transform: open ? 'rotateY(75deg)' : 'rotateY(0)',
        transition: 'transform 1.2s cubic-bezier(0.65, 0, 0.35, 1)',
      }}>
        <GateBars />
      </div>

      {/* Lock icon overlay */}
      {state === 'idle' && (
        <div style={{
          position: 'absolute',
          width: 56, height: 56, borderRadius: '50%',
          background: 'var(--bg-2)',
          border: '1px solid var(--border-default)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--accent-300)', zIndex: 2,
        }}><IconLock size={26} strokeWidth={2}/></div>
      )}
      {state === 'open' && (
        <div style={{
          position: 'absolute',
          width: 56, height: 56, borderRadius: '50%',
          background: 'var(--success)', color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 2,
        }}><IconCheck size={28} strokeWidth={2.4}/></div>
      )}
    </div>
  );
};

const GateBars = () => (
  <div style={{
    width: '100%', height: '100%', padding: 6,
    display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
  }}>
    {[0,1,2,3,4].map(i => (
      <div key={i} style={{ height: 2, background: 'var(--border-strong)', borderRadius: 1 }}/>
    ))}
  </div>
);

window.GateScreen = GateScreen;
