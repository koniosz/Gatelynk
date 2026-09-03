// Home v3 — Glass / Premium  (revised)
// Single "Otwórz" button → action sheet:
//   wjazd / wyjazd → inline slider-to-open
//   brama pożarowa → "are you sure" confirmation
//   mój dom        → status panel (zamknięte/otwarte) + open/close (Tedee / Nuki)

const HomeV3 = ({ data, onOpenGate, onOpenGuests, showHero = true, showPayments = true }) => {
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [aiOpen, setAiOpen] = React.useState(false);
  const [aiSeed, setAiSeed] = React.useState('');
  const [aiDraft, setAiDraft] = React.useState('');

  const openAi = (seed = '') => { setAiSeed(seed); setAiOpen(true); };

  const HERO_H = 360;

  return (
    <div className="screen scroll-area" style={{
      paddingBottom: 110,
      background: 'var(--bg-1)',
    }}>
      <StatusBar />

      {/* HERO — full-bleed building photo */}
      {showHero && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: HERO_H,
          overflow: 'hidden', pointerEvents: 'none',
        }}>
          <div style={{
            position: 'absolute', inset: 0,
            background: `url(assets/building-photo.jpg) center 35% / cover no-repeat`,
          }}/>
          {/* top gradient — readability for status bar + greeting */}
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, height: 180,
            background: 'linear-gradient(180deg, rgba(15,18,24,0.55) 0%, rgba(15,18,24,0.20) 60%, rgba(15,18,24,0) 100%)',
          }}/>
          {/* bottom gradient — fade to bg */}
          <div style={{
            position: 'absolute', bottom: 0, left: 0, right: 0, height: 200,
            background: 'linear-gradient(180deg, rgba(15,18,24,0) 0%, rgba(15,18,24,0.55) 55%, var(--bg-1) 100%)',
          }}/>
        </div>
      )}

      {/* Greeting + bell — over photo */}
      <div style={{
        position: 'relative',
        padding: '58px 20px 0',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
      }}>
        <div>
          <div style={{
            fontSize: 11, color: 'rgba(255,255,255,0.78)',
            fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase',
            textShadow: '0 1px 8px rgba(0,0,0,0.4)',
          }}>
            {data.user.estate}
          </div>
          <div style={{
            fontSize: 26, fontWeight: 600, color: '#fff',
            letterSpacing: '-0.02em', marginTop: 4,
            textShadow: '0 1px 12px rgba(0,0,0,0.35)',
          }}>
            Cześć, {data.user.firstName}
          </div>
        </div>
        <button style={{
          width: 40, height: 40, borderRadius: '50%',
          background: 'rgba(255,255,255,0.14)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid rgba(255,255,255,0.18)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          position: 'relative', cursor: 'pointer',
        }}>
          <IconBell size={18} color="#fff"/>
          <span style={{
            position:'absolute', top:8, right:8, width:8, height:8,
            borderRadius:'50%', background:'var(--icon-orange)',
            border: '2px solid rgba(20,22,28,0.6)',
          }}/>
        </button>
      </div>

      {/* PRIMARY ACTION — single hero card "Otwórz", lifted off photo */}
      <div style={{ position: 'relative', padding: `${HERO_H - 220}px 20px 0` }}>
        <button onClick={() => setSheetOpen(true)} style={{
          width: '100%',
          background: 'linear-gradient(135deg, var(--accent-300), var(--accent-400))',
          border: 'none',
          borderRadius: 22,
          padding: '22px 22px',
          color: '#fff',
          display: 'flex', alignItems: 'center', gap: 16, cursor: 'pointer',
          boxShadow: '0 18px 42px var(--accent-glow), 0 2px 0 rgba(255,255,255,0.12) inset',
        }}>
          <div style={{
            width: 54, height: 54, borderRadius: '50%',
            background: 'rgba(255,255,255,0.20)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}><IconUnlock size={24} color="#fff" strokeWidth={2.2}/></div>
          <div style={{ flex: 1, textAlign: 'left' }}>
            <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>Otwórz</div>
            <div style={{
              fontSize: 12, color: 'rgba(255,255,255,0.78)',
              marginTop: 3, fontWeight: 500,
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#7BE2A3' }}/>
              Brama · Drzwi · Mój dom
            </div>
          </div>
          <IconChevronRight size={20} color="rgba(255,255,255,0.85)"/>
        </button>
      </div>

      {/* Quick tiles — Pojazdy / Goście / Płatności */}
      <div style={{ padding: '14px 20px 0', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        {[
          { icon: IconCar, label: 'Pojazdy', size: 28, onClick: () => onOpenGuests && onOpenGuests('vehicles') },
          { icon: IconUsers, label: 'Goście', size: 22, onClick: () => onOpenGuests && onOpenGuests() },
          { icon: IconCard, label: 'Płatności', size: 22, badge: '!', danger: true },
        ].map((a, i) => {
          const I = a.icon;
          return (
            <button key={i} onClick={a.onClick} style={{
              background: 'var(--bg-2)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--r-lg)',
              padding: '14px 6px', cursor: 'pointer', position: 'relative',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
              color: 'var(--text-primary)',
              boxShadow: 'var(--shadow-sm)',
            }}>
              <div style={{ height: 30, display: 'flex', alignItems: 'center' }}>
                <I size={a.size} color={a.danger ? 'var(--danger)' : 'var(--accent-400)'} strokeWidth={1.8}/>
              </div>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 500 }}>{a.label}</span>
              {a.badge && <span style={{
                position:'absolute', top:8, right:10, minWidth:16, height:16, padding:'0 5px',
                borderRadius:'var(--r-full)',
                background: a.danger ? 'var(--danger)' : 'var(--accent-400)',
                color:'#fff', fontSize:10, fontWeight:700,
                display:'flex', alignItems:'center', justifyContent:'center',
              }}>{a.badge}</span>}
            </button>
          );
        })}
      </div>

      {/* AI bar — clean, no chip clutter */}
      <div style={{ position: 'relative', padding: '14px 20px 0' }}>
        <div style={{
          width: '100%',
          background: 'var(--bg-2)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--r-full)',
          padding: '7px 7px 7px 16px',
          display: 'flex', alignItems: 'center', gap: 10,
          boxShadow: 'var(--shadow-sm)',
        }}>
          <AiSparkle size={18}/>
          <input
            value={aiDraft}
            onChange={(e) => setAiDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && aiDraft.trim()) {
                openAi(aiDraft.trim());
                setAiDraft('');
              }
            }}
            placeholder="Zapytaj Gatelynk AI…"
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none',
              fontSize: 14, color: 'var(--text-primary)', fontFamily: 'inherit',
              padding: '6px 0',
            }}
          />
          {aiDraft.trim() ? (
            <button onClick={() => { openAi(aiDraft.trim()); setAiDraft(''); }} style={{
              width: 32, height: 32, borderRadius: '50%',
              background: 'linear-gradient(135deg, var(--accent-300), var(--accent-400))',
              border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}><IconArrowRight size={14} color="#fff"/></button>
          ) : (
            <button onClick={() => openAi('')} style={{
              padding: '5px 11px', borderRadius: 'var(--r-full)', marginRight: 4,
              background: 'transparent', border: 'none',
              color: 'var(--text-tertiary)',
              fontSize: 12, fontWeight: 500, cursor: 'pointer',
            }}>Zapytaj</button>
          )}
        </div>
      </div>

      {/* Activity — minimal */}
      <div style={{ position: 'relative', padding: '26px 20px 0' }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0 2px', marginBottom: 10,
        }}>
          <div style={{
            fontSize: 13, color: 'var(--text-primary)',
            fontWeight: 600, letterSpacing: '-0.01em',
          }}>Ostatnia aktywność</div>
          <button style={{
            background: 'none', border: 'none',
            color: 'var(--text-tertiary)', fontSize: 12, fontWeight: 500, cursor: 'pointer',
          }}>Wszystkie</button>
        </div>
        <div style={{
          background: 'var(--bg-2)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--r-xl)',
          padding: '4px 14px',
          boxShadow: 'var(--shadow-sm)',
        }}>
          {data.activity.slice(0, 3).map((a, i) => {
            const I = a.icon || IconMegaphone;
            return (
              <div key={i} style={{
                display: 'flex', gap: 12, alignItems: 'center',
                padding: '12px 0',
                borderTop: i ? '1px solid var(--border-subtle)' : 'none',
              }}>
                <div style={{
                  width: 30, height: 30, borderRadius: '50%',
                  background: a.iconColor ? `${a.iconColor}1f` : 'var(--icon-orange-bg)',
                  color: a.iconColor || 'var(--icon-orange)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}><I size={15} strokeWidth={2}/></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 13, fontWeight: 500, color: 'var(--text-primary)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{(a.title || '').toLowerCase().replace(/^./, c => c.toUpperCase())}</div>
                </div>
                <div style={{
                  fontSize: 11.5, color: 'var(--text-tertiary)',
                  whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
                }}>{a.time}</div>
              </div>
            );
          })}
        </div>
      </div>

      {sheetOpen && <GateActionSheet onClose={() => setSheetOpen(false)}/>}
      {aiOpen && <AiAssistantSheet seed={aiSeed} onClose={() => setAiOpen(false)}/>}
    </div>
  );
};

// AI sparkle icon
const AiSparkle = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <defs>
      <linearGradient id="aisg" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#A78BFA"/><stop offset="1" stopColor="#7050E0"/>
      </linearGradient>
    </defs>
    <path d="M12 3l1.8 4.5L18 9l-4.2 1.5L12 15l-1.8-4.5L6 9l4.2-1.5L12 3Z" fill="url(#aisg)"/>
    <path d="M18.5 14l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9.9-2.3Z" fill="url(#aisg)" opacity="0.7"/>
  </svg>
);

// AI Assistant chat sheet
const AiAssistantSheet = ({ seed = '', onClose }) => {
  const [show, setShow] = React.useState(false);
  const [input, setInput] = React.useState(seed);
  const [messages, setMessages] = React.useState([]);
  const [thinking, setThinking] = React.useState(false);
  React.useEffect(() => { requestAnimationFrame(() => setShow(true)); }, []);
  React.useEffect(() => { if (seed) setTimeout(() => send(seed), 350); }, []);

  const close = () => { setShow(false); setTimeout(onClose, 220); };

  const send = (text) => {
    const q = (text ?? input).trim();
    if (!q) return;
    setMessages(m => [...m, { role: 'user', text: q }]);
    setInput('');
    setThinking(true);
    setTimeout(() => {
      setThinking(false);
      setMessages(m => [...m, { role: 'ai', text: mockReply(q) }]);
    }, 1100);
  };

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 60,
      background: show ? 'rgba(11,16,32,0.45)' : 'rgba(11,16,32,0)',
      transition: 'background 0.22s',
      display: 'flex', alignItems: 'flex-end',
    }} onClick={close}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: '100%', height: '92%',
        background: 'var(--bg-1)',
        borderTopLeftRadius: 28, borderTopRightRadius: 28,
        border: '1px solid var(--border-subtle)',
        display: 'flex', flexDirection: 'column',
        transform: show ? 'translateY(0)' : 'translateY(100%)',
        transition: 'transform 0.32s cubic-bezier(0.32, 0.72, 0, 1)',
        boxShadow: '0 -20px 60px rgba(15,23,42,0.20)',
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '12px 16px 14px',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <div style={{ width: 38, height: 5, borderRadius: 3, background: 'var(--border-default)', position: 'absolute', left: '50%', transform: 'translateX(-50%)', top: 8 }}/>
          <div style={{
            width: 38, height: 38, borderRadius: 'var(--r-md)',
            background: 'linear-gradient(135deg, var(--accent-300), var(--accent-500))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            marginTop: 6,
          }}>
            <AiSparkle size={22}/>
          </div>
          <div style={{ flex: 1, marginTop: 6 }}>
            <div style={{ fontSize: 15.5, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>Gatelynk AI</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>Asystent osiedlowy · zna Twoje konto</div>
          </div>
          <button onClick={close} style={{
            width: 32, height: 32, borderRadius: '50%',
            background: 'var(--bg-2)', border: '1px solid var(--border-subtle)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
            marginTop: 6,
          }}><IconClose size={14} color="var(--text-secondary)"/></button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {messages.length === 0 && !thinking && (
            <div style={{ padding: '8px 0' }}>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 14 }}>
                Cześć! Pomogę z czynszem, zgłoszeniami, paczkami, gośćmi i regulaminem osiedla. Spróbuj zapytać:
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[
                  { icon: '🗑️', q: 'Kiedy jest następny wywóz śmieci?' },
                  { icon: '💰', q: 'Ile mam do zapłaty w tym miesiącu?' },
                  { icon: '🔧', q: 'Cieknie mi kran — zgłoś usterkę' },
                  { icon: '👋', q: 'Zaproś gościa na jutro wieczorem' },
                  { icon: '📋', q: 'Czy mogę grillować na balkonie?' },
                ].map((s, i) => (
                  <button key={i} onClick={() => send(s.q)} style={{
                    background: 'var(--bg-2)', border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--r-lg)', padding: '12px 14px',
                    display: 'flex', alignItems: 'center', gap: 10,
                    cursor: 'pointer', textAlign: 'left',
                  }}>
                    <span style={{ fontSize: 18 }}>{s.icon}</span>
                    <span style={{ flex: 1, fontSize: 13.5, color: 'var(--text-primary)', fontWeight: 500 }}>{s.q}</span>
                    <IconChevronRight size={14} color="var(--text-tertiary)"/>
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
              <div style={{
                maxWidth: '85%',
                background: m.role === 'user' ? 'linear-gradient(135deg, var(--accent-300), var(--accent-400))' : 'var(--bg-2)',
                color: m.role === 'user' ? '#fff' : 'var(--text-primary)',
                border: m.role === 'user' ? 'none' : '1px solid var(--border-subtle)',
                borderRadius: 'var(--r-lg)',
                padding: '11px 14px',
                fontSize: 13.5, lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
              }}>{m.text}</div>
            </div>
          ))}
          {thinking && (
            <div style={{ display: 'flex' }}>
              <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-lg)', padding: '12px 14px', display: 'flex', gap: 4 }}>
                {[0,1,2].map(i => <span key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--text-tertiary)', animation: `bp 1s ${i*0.15}s infinite ease-in-out` }}/>)}
              </div>
            </div>
          )}
        </div>

        <div style={{ padding: 12, borderTop: '1px solid var(--border-subtle)', background: 'var(--bg-1)' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: 'var(--bg-2)', border: '1px solid var(--border-default)',
            borderRadius: 'var(--r-full)', padding: '6px 6px 6px 16px',
          }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
              placeholder="Napisz wiadomość…"
              style={{
                flex: 1, background: 'transparent', border: 'none', outline: 'none',
                fontSize: 14, color: 'var(--text-primary)', fontFamily: 'inherit',
              }}
            />
            <button onClick={() => send()} disabled={!input.trim()} style={{
              width: 36, height: 36, borderRadius: '50%',
              background: input.trim() ? 'linear-gradient(135deg, var(--accent-300), var(--accent-400))' : 'var(--bg-3)',
              border: 'none', cursor: input.trim() ? 'pointer' : 'default',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              opacity: input.trim() ? 1 : 0.5,
            }}><IconArrowRight size={16} color="#fff"/></button>
          </div>
        </div>

        <style>{`@keyframes bp { 0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); } 40% { opacity: 1; transform: scale(1); } }`}</style>
      </div>
    </div>
  );
};

const mockReply = (q) => {
  const lc = q.toLowerCase();
  if (lc.includes('śmiec') || lc.includes('wywóz')) return 'Następny wywóz odpadów zmieszanych: poniedziałek 12.05, ok. 7:30.\nSegregacja: środa 14.05.\nKontener przy bramie tylnej.';
  if (lc.includes('zapłat') || lc.includes('czynsz')) return 'Do zapłaty w maju 2026: 834,00 zł\nTermin: 10.05.2026 (za 5 dni)\n\nChcesz zapłacić teraz? Mogę uruchomić BLIK.';
  if (lc.includes('kran') || lc.includes('uster') || lc.includes('zgłoś')) return 'Utworzyłem szkic zgłoszenia:\n• Tytuł: Cieknący kran\n• Lokalizacja: Mieszkanie nr 1\n• Priorytet: Średni\n\nDodać zdjęcie i wysłać do administracji?';
  if (lc.includes('gość') || lc.includes('zapro')) return 'Otwieram kreator zaproszenia. Jakie dane gościa?\n(imię, telefon, samochód — opcjonalnie)';
  if (lc.includes('grill')) return 'Regulamin osiedla §14.3: Grillowanie na balkonach jest dopuszczone wyłącznie urządzeniami elektrycznymi. Otwarty ogień (węgiel, gaz) — tylko w wyznaczonej strefie BBQ przy placu zabaw.';
  return 'Nie do końca rozumiem. Możesz spróbować zapytać o czynsz, zgłoszenia, wywóz odpadów, gości albo regulamin osiedla.';
};

// Action sheet — switches between modes based on what's expanded
const GateActionSheet = ({ onClose }) => {
  const [show, setShow] = React.useState(false);
  const [mode, setMode] = React.useState('list'); // list | confirm-fire | home
  // For wjazd/wyjazd: each has its own inline slider state
  React.useEffect(() => { requestAnimationFrame(() => setShow(true)); }, []);
  const close = () => { setShow(false); setTimeout(onClose, 220); };

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 50,
      background: show ? 'rgba(15,23,42,0.35)' : 'rgba(0,0,0,0)',
      backdropFilter: show ? 'blur(8px)' : 'blur(0)',
      WebkitBackdropFilter: show ? 'blur(8px)' : 'blur(0)',
      transition: 'background 0.22s, backdrop-filter 0.22s',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    }} onClick={close}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: '100%',
        background: 'rgba(255,255,255,0.96)',
        backdropFilter: 'blur(40px) saturate(160%)',
        WebkitBackdropFilter: 'blur(40px) saturate(160%)',
        borderTopLeftRadius: 28, borderTopRightRadius: 28,
        border: '1px solid var(--border-default)',
        padding: '12px 12px 32px',
        transform: show ? 'translateY(0)' : 'translateY(100%)',
        transition: 'transform 0.32s cubic-bezier(0.32, 0.72, 0, 1)',
        boxShadow: '0 -20px 60px rgba(0,0,0,0.5)',
      }}>
        <div style={{
          width: 38, height: 5, borderRadius: 3,
          background: 'var(--border-default)', margin: '6px auto 14px',
        }}/>

        {mode === 'list' && (
          <>
            <div style={{ padding: '0 8px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 600 }}>Dostęp</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.02em', marginTop: 2 }}>Co chcesz otworzyć?</div>
              </div>
              <button onClick={close} style={closeBtnStyle}><IconClose size={16}/></button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '0 4px' }}>
              <SliderRow icon={IconCar} label="Otwórz wjazd" sub="Brama główna · Niewinna 1"/>
              <SliderRow icon={IconArrowRight} label="Otwórz wyjazd" sub="Brama tylna"/>
              <button onClick={() => setMode('confirm-fire')} style={rowBtnStyle({ danger: true })}>
                <RowIcon I={IconWarning} danger/>
                <RowLabel label="Brama pożarowa" sub="Wyjście awaryjne · wymaga potwierdzenia"/>
                <IconChevronRight size={18} color="var(--danger)"/>
              </button>
              <button onClick={() => setMode('home')} style={rowBtnStyle({})}>
                <RowIcon I={IconHome}/>
                <RowLabel label="Mój dom" sub="Drzwi wejściowe · Tedee"/>
                <IconChevronRight size={18} color="var(--text-tertiary)"/>
              </button>
            </div>
          </>
        )}

        {mode === 'confirm-fire' && <FireConfirm onBack={() => setMode('list')} onClose={close}/>}
        {mode === 'home' && <HomeLockPanel onBack={() => setMode('list')} onClose={close}/>}
      </div>
    </div>
  );
};

// Inline slide-to-open row (each has independent state)
const SliderRow = ({ icon: I, label, sub }) => {
  const [state, setState] = React.useState('idle'); // idle | opening | open
  const [x, setX] = React.useState(0);
  const trackRef = React.useRef(null);

  const start = (e) => {
    if (state !== 'idle') return;
    const rect = trackRef.current.getBoundingClientRect();
    const max = rect.width - 56 - 6;
    const startX = e.touches ? e.touches[0].clientX : e.clientX;
    let last = 0;
    const move = (ev) => {
      const dx = (ev.touches ? ev.touches[0].clientX : ev.clientX) - startX;
      last = Math.max(0, Math.min(max, dx));
      setX(last);
      if (last >= max - 4) { end(); fire(); }
    };
    const end = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', end);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', end);
      if (last < max - 4) setX(0);
    };
    const fire = () => {
      setState('opening');
      setX(max);
      setTimeout(() => setState('open'), 1400);
      setTimeout(() => { setState('idle'); setX(0); }, 4000);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    window.addEventListener('touchmove', move);
    window.addEventListener('touchend', end);
  };

  const isOpen = state === 'open';
  const isOpening = state === 'opening';

  return (
    <div style={{
      background: 'var(--bg-2)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--r-xl)',
      padding: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, padding: '2px 4px' }}>
        <RowIcon I={I}/>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>{label}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 2 }}>
            {isOpen ? '✓ Otwarta' : isOpening ? 'Otwieranie…' : sub}
          </div>
        </div>
      </div>
      <div ref={trackRef} style={{
        position: 'relative', height: 56,
        background: 'var(--bg-3)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--r-full)',
        overflow: 'hidden',
        display: 'flex', alignItems: 'center',
      }}>
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0,
          width: x + 56,
          background: isOpen
            ? 'linear-gradient(90deg, rgba(52,211,153,0.7), rgba(52,211,153,0.4))'
            : 'linear-gradient(90deg, var(--accent-400), var(--accent-300))',
          opacity: 0.85,
          transition: state !== 'idle' ? 'width 0.4s, background 0.3s' : 'none',
        }}/>
        <span style={{
          position: 'absolute', left: 0, right: 0, textAlign: 'center',
          fontSize: 13, fontWeight: 600,
          color: x > 60 || isOpen ? '#fff' : 'rgba(255,255,255,0.55)',
          pointerEvents: 'none', letterSpacing: '0.01em',
        }}>
          {isOpen ? 'Otwarta ✓' : isOpening ? 'Otwieranie…' : '→  Przesuń, aby otworzyć'}
        </span>
        <div onMouseDown={start} onTouchStart={start} style={{
          position: 'absolute', left: 4, top: 4,
          width: 48, height: 48, borderRadius: '50%',
          background: '#fff',
          transform: `translateX(${x}px)`,
          transition: state !== 'idle' && state !== 'open' ? 'transform 0.4s' : (x === 0 ? 'transform 0.3s' : 'none'),
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: state === 'idle' ? 'grab' : 'default',
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        }}>
          {isOpen ? <IconCheck size={20} color="var(--success)" strokeWidth={2.4}/> : <IconUnlock size={20} color="var(--accent-500)" strokeWidth={2.2}/>}
        </div>
      </div>
    </div>
  );
};

// Fire-gate confirmation
const FireConfirm = ({ onBack, onClose }) => {
  const [state, setState] = React.useState('confirm'); // confirm | opening | open
  const trigger = () => {
    setState('opening');
    setTimeout(() => setState('open'), 1500);
    setTimeout(() => onClose(), 3500);
  };
  return (
    <>
      <div style={{ padding: '0 8px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={onBack} style={closeBtnStyle}><IconChevronLeft size={16}/></button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: 'var(--danger)', textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 700 }}>Brama pożarowa</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginTop: 2 }}>Potwierdzenie wymagane</div>
        </div>
      </div>

      <div style={{ padding: '0 16px' }}>
        <div style={{
          background: 'rgba(248,113,113,0.10)',
          border: '1px solid rgba(248,113,113,0.30)',
          borderRadius: 'var(--r-xl)',
          padding: 18, textAlign: 'center',
        }}>
          <div style={{
            width: 64, height: 64, borderRadius: '50%',
            background: 'rgba(248,113,113,0.18)',
            color: 'var(--danger)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '4px auto 14px',
          }}>
            {state === 'open'
              ? <IconCheck size={30} strokeWidth={2.4}/>
              : <IconWarning size={30} strokeWidth={2}/>}
          </div>
          <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
            {state === 'open' ? 'Brama pożarowa otwarta' : state === 'opening' ? 'Otwieranie…' : 'Czy na pewno otworzyć bramę pożarową?'}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 8, lineHeight: 1.5, maxWidth: 280, marginLeft: 'auto', marginRight: 'auto' }}>
            {state === 'open'
              ? 'Powiadomiono ochronę i administrację osiedla.'
              : 'Brama pożarowa służy wyłącznie do ewakuacji. Otwarcie zostanie zarejestrowane i zgłoszone do administracji.'}
          </div>
        </div>

        {state === 'confirm' && (
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button onClick={onBack} style={{
              flex: 1, background: 'var(--bg-3)',
              border: '1px solid var(--border-default)',
              borderRadius: 'var(--r-xl)', padding: '14px',
              color: 'var(--text-primary)', fontSize: 14, fontWeight: 600, cursor: 'pointer',
            }}>Anuluj</button>
            <button onClick={trigger} style={{
              flex: 1.5, background: 'var(--danger)', border: 'none',
              borderRadius: 'var(--r-xl)', padding: '14px',
              color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer',
              boxShadow: '0 8px 24px rgba(248,113,113,0.35)',
            }}>Tak, otwórz bramę</button>
          </div>
        )}
      </div>
    </>
  );
};

// Home lock panel — Tedee/Nuki status + open/close, Face ID, inline history, auto-lock
const AUTOLOCK_OPTIONS = [
  { value: 0,    label: 'Wył.' },
  { value: 30,   label: '30 s' },
  { value: 60,   label: '1 min' },
  { value: 300,  label: '5 min' },
  { value: 600,  label: '10 min' },
];

const LOCK_HISTORY = [
  { t: '14:22', who: 'Konrad', action: 'Zamknięte', icon: IconLock },
  { t: '14:18', who: 'Konrad', action: 'Otwarte przez Face ID', icon: IconFace },
  { t: '08:45', who: 'Anna',   action: 'Otwarte przez aplikację', icon: IconUnlock },
];

const HomeLockPanel = ({ onBack, onClose }) => {
  const [locked, setLocked] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [view, setView] = React.useState('main'); // main | faceid | autolock
  const [autoLock, setAutoLock] = React.useState(60);
  const [lastEvent, setLastEvent] = React.useState({ text: 'Zamknięte przez Konrad · 14:22', via: 'app' });

  // Auto-lock countdown when door is unlocked
  const [countdown, setCountdown] = React.useState(0);
  React.useEffect(() => {
    if (locked || autoLock === 0) { setCountdown(0); return; }
    setCountdown(autoLock);
    const id = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) {
          clearInterval(id);
          setBusy(true);
          setTimeout(() => {
            setLocked(true);
            setBusy(false);
            setLastEvent({ text: 'Zamknięte automatycznie · teraz', via: 'auto' });
          }, 800);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [locked, autoLock]);

  // Tap Otwórz when locked → go to Face ID first; tap Zamknij when unlocked → close immediately
  const handlePrimary = () => {
    if (busy) return;
    if (locked) { setView('faceid'); }
    else {
      setBusy(true);
      setTimeout(() => {
        setLocked(true); setBusy(false);
        setLastEvent({ text: 'Zamknięte przez aplikację · teraz', via: 'app' });
      }, 1200);
    }
  };

  const onFaceIdSuccess = () => {
    setView('main');
    setBusy(true);
    setTimeout(() => {
      setLocked(false); setBusy(false);
      setLastEvent({ text: 'Otwarte przez Face ID · teraz', via: 'faceid' });
    }, 1000);
  };

  if (view === 'faceid') return <FaceIdView onSuccess={onFaceIdSuccess} onCancel={() => setView('main')}/>;
  if (view === 'autolock') return <AutoLockView value={autoLock} onChange={setAutoLock} onBack={() => setView('main')} options={AUTOLOCK_OPTIONS}/>;

  const fmt = (s) => {
    if (s >= 60) return `${Math.ceil(s/60)} min`;
    return `${s} s`;
  };

  return (
    <>
      <div style={{ padding: '0 8px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={onBack} style={closeBtnStyle}><IconChevronLeft size={16}/></button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 600 }}>Mój dom</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginTop: 2 }}>Drzwi wejściowe</div>
        </div>
        <button onClick={onClose} style={closeBtnStyle}><IconClose size={16}/></button>
      </div>

      <div style={{ padding: '0 16px' }}>
        <div style={{
          background: locked ? 'var(--bg-2)' : 'rgba(52,211,153,0.10)',
          border: `1px solid ${locked ? 'var(--border-subtle)' : 'rgba(52,211,153,0.30)'}`,
          borderRadius: 'var(--r-2xl)',
          padding: '24px 20px',
          textAlign: 'center',
          transition: 'all 0.3s',
        }}>
          {/* Status visual */}
          <div style={{
            width: 96, height: 96, borderRadius: '50%',
            background: locked
              ? 'radial-gradient(circle, rgba(167,139,250,0.25), rgba(167,139,250,0.05))'
              : 'radial-gradient(circle, rgba(52,211,153,0.30), rgba(52,211,153,0.05))',
            border: `2px solid ${locked ? 'rgba(167,139,250,0.45)' : 'rgba(52,211,153,0.55)'}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 16px',
            transition: 'all 0.4s',
            animation: busy ? 'pulse-soft 1s infinite' : 'none',
          }}>
            {busy
              ? <IconRefresh size={36} color={locked ? 'var(--accent-200)' : 'var(--success)'} strokeWidth={2}/>
              : locked
                ? <IconLock size={36} color="var(--accent-200)" strokeWidth={2}/>
                : <IconUnlock size={36} color="var(--success)" strokeWidth={2}/>}
          </div>

          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
            {busy ? (locked ? 'Otwieranie…' : 'Zamykanie…') : (locked ? 'Zamknięte' : 'Otwarte')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
            {lastEvent.text}
          </div>

          {/* Auto-lock countdown chip */}
          {!locked && !busy && countdown > 0 && (
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              marginTop: 10, padding: '5px 10px',
              background: 'rgba(52,211,153,0.15)',
              border: '1px solid rgba(52,211,153,0.30)',
              borderRadius: 'var(--r-full)',
              fontSize: 11.5, fontWeight: 600, color: 'var(--success)',
            }}>
              <IconClock size={12} strokeWidth={2.2}/>
              Auto-zamknięcie za {countdown >= 60 ? `${Math.floor(countdown/60)}:${String(countdown%60).padStart(2,'0')}` : `${countdown}s`}
            </div>
          )}

          {/* Device info row */}
          <div style={{
            marginTop: 18, padding: '12px 14px',
            background: 'var(--bg-2)',
            borderRadius: 'var(--r-md)',
            display: 'flex', alignItems: 'center', gap: 10,
            textAlign: 'left',
          }}>
            <div style={{
              width: 32, height: 32, borderRadius: 'var(--r-sm)',
              background: 'var(--bg-3)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 700, color: 'var(--accent-200)', letterSpacing: '0.05em',
            }}>Td</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>Tedee Pro</div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Bateria 87% · sygnał silny</div>
            </div>
            <Pill color="success">Online</Pill>
          </div>
        </div>

        {/* Action button */}
        <button onClick={handlePrimary} disabled={busy} style={{
          width: '100%', marginTop: 12,
          background: locked
            ? 'linear-gradient(135deg, var(--accent-400), var(--accent-300))'
            : 'var(--bg-3)',
          border: locked ? 'none' : '1px solid var(--border-default)',
          borderRadius: 'var(--r-xl)',
          padding: '16px',
          color: locked ? '#fff' : 'var(--text-primary)',
          fontSize: 15, fontWeight: 700,
          cursor: busy ? 'default' : 'pointer',
          letterSpacing: '-0.01em',
          boxShadow: locked ? '0 8px 24px var(--accent-glow)' : 'none',
          opacity: busy ? 0.7 : 1,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        }}>
          {locked ? <IconFace size={18} strokeWidth={2.2}/> : <IconLock size={18} strokeWidth={2.2}/>}
          {locked ? 'Otwórz przez Face ID' : 'Zamknij drzwi'}
        </button>

        {/* Auto-lock row */}
        <button onClick={() => setView('autolock')} style={{
          width: '100%', marginTop: 10,
          background: 'var(--bg-2)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--r-xl)',
          padding: '12px 14px',
          display: 'flex', alignItems: 'center', gap: 12,
          color: 'var(--text-primary)', cursor: 'pointer',
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: 'var(--r-md)',
            background: 'rgba(167,139,250,0.15)',
            color: 'var(--accent-200)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><IconClock size={16} strokeWidth={2}/></div>
          <div style={{ flex: 1, textAlign: 'left' }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>Auto-zamykanie</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 1 }}>
              {autoLock === 0 ? 'Wyłączone' : `Po ${fmt(autoLock)} od otwarcia`}
            </div>
          </div>
          <span style={{ fontSize: 12.5, color: 'var(--accent-200)', fontWeight: 600, marginRight: 4 }}>
            {AUTOLOCK_OPTIONS.find(o => o.value === autoLock)?.label}
          </span>
          <IconChevronRight size={16} color="var(--text-tertiary)"/>
        </button>

        {/* Inline history — last 3 */}
        <div style={{ marginTop: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 4px', marginBottom: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 600 }}>Ostatnia aktywność</div>
            <button style={{ background: 'none', border: 'none', color: 'var(--accent-200)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Wszystkie →</button>
          </div>
          <div style={{
            background: 'var(--bg-2)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--r-xl)',
            overflow: 'hidden',
          }}>
            {LOCK_HISTORY.map((h, i) => {
              const I = h.icon;
              return (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '11px 14px',
                  borderTop: i ? '1px solid var(--bg-3)' : 'none',
                }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: 'var(--r-sm)',
                    background: 'rgba(167,139,250,0.12)',
                    color: 'var(--accent-200)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}><I size={14} strokeWidth={2}/></div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{h.action}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 1 }}>{h.who}</div>
                  </div>
                  <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', fontWeight: 500 }}>{h.t}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes pulse-soft {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.7; transform: scale(0.96); }
        }
      `}</style>
    </>
  );
};

const SmallActionBtn = ({ icon: I, label }) => (
  <button style={{
    flex: 1, background: 'var(--bg-2)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-md)', padding: '10px 6px',
    color: 'var(--text-secondary)', cursor: 'pointer',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5,
  }}>
    <I size={16} strokeWidth={1.8}/>
    <span style={{ fontSize: 10.5, fontWeight: 500 }}>{label}</span>
  </button>
);

// Face ID overlay
const FaceIdView = ({ onSuccess, onCancel }) => {
  const [phase, setPhase] = React.useState('scanning'); // scanning | success
  React.useEffect(() => {
    const t = setTimeout(() => setPhase('success'), 1600);
    const t2 = setTimeout(() => onSuccess(), 2400);
    return () => { clearTimeout(t); clearTimeout(t2); };
  }, []);

  return (
    <div style={{ padding: '40px 16px 20px', textAlign: 'center', minHeight: 380 }}>
      <div style={{
        width: 120, height: 120, borderRadius: '50%',
        background: phase === 'success'
          ? 'radial-gradient(circle, rgba(52,211,153,0.30), rgba(52,211,153,0.05))'
          : 'radial-gradient(circle, rgba(167,139,250,0.30), rgba(167,139,250,0.05))',
        border: `2px solid ${phase === 'success' ? 'rgba(52,211,153,0.55)' : 'rgba(167,139,250,0.50)'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        margin: '0 auto 22px',
        position: 'relative',
        transition: 'all 0.4s',
      }}>
        {phase === 'scanning' && (
          <div style={{
            position: 'absolute', inset: 8, borderRadius: '50%',
            border: '2px solid transparent',
            borderTopColor: 'var(--accent-200)',
            borderRightColor: 'var(--accent-200)',
            animation: 'spin 1.4s linear infinite',
          }}/>
        )}
        {phase === 'success'
          ? <IconCheck size={50} color="var(--success)" strokeWidth={2.4}/>
          : <IconFace size={50} color="var(--accent-200)" strokeWidth={1.8}/>}
      </div>

      <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
        {phase === 'success' ? 'Rozpoznano' : 'Skanowanie twarzy…'}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 6, maxWidth: 260, marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.5 }}>
        {phase === 'success' ? 'Otwieranie drzwi…' : 'Spójrz w aparat aby otworzyć drzwi'}
      </div>

      {phase === 'scanning' && (
        <button onClick={onCancel} style={{
          marginTop: 32,
          background: 'var(--bg-3)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--r-xl)',
          padding: '12px 28px',
          color: 'var(--text-primary)',
          fontSize: 14, fontWeight: 600, cursor: 'pointer',
        }}>Anuluj</button>
      )}

      <div style={{ marginTop: 20, fontSize: 11.5, color: 'var(--text-tertiary)' }}>
        Lub <span style={{ color: 'var(--accent-200)', fontWeight: 600, cursor: 'pointer' }}>użyj kodu PIN</span>
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
};

// Auto-lock timer settings
const AutoLockView = ({ value, onChange, onBack, options }) => (
  <>
    <div style={{ padding: '0 8px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
      <button onClick={onBack} style={closeBtnStyle}><IconChevronLeft size={16}/></button>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 600 }}>Mój dom</div>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginTop: 2 }}>Auto-zamykanie</div>
      </div>
    </div>

    <div style={{ padding: '0 16px' }}>
      <div style={{
        background: 'rgba(167,139,250,0.10)',
        border: '1px solid rgba(167,139,250,0.25)',
        borderRadius: 'var(--r-xl)',
        padding: '14px 16px',
        display: 'flex', alignItems: 'center', gap: 12,
        marginBottom: 14,
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: 'var(--r-md)',
          background: 'rgba(167,139,250,0.20)',
          color: 'var(--accent-200)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}><IconShield size={18} strokeWidth={2}/></div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          Drzwi zostaną zamknięte automatycznie po wybranym czasie od otwarcia.
        </div>
      </div>

      <div style={{
        background: 'var(--bg-2)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--r-xl)',
        overflow: 'hidden',
      }}>
        {options.map((o, i) => {
          const selected = o.value === value;
          return (
            <button key={o.value} onClick={() => onChange(o.value)} style={{
              width: '100%',
              background: selected ? 'rgba(167,139,250,0.10)' : 'transparent',
              border: 'none',
              borderTop: i ? '1px solid var(--bg-3)' : 'none',
              padding: '14px 16px',
              display: 'flex', alignItems: 'center', gap: 12,
              color: 'var(--text-primary)', cursor: 'pointer',
              textAlign: 'left',
            }}>
              <div style={{
                width: 22, height: 22, borderRadius: '50%',
                border: `2px solid ${selected ? 'var(--accent-300)' : 'var(--border-default)'}`,
                background: selected ? 'var(--accent-300)' : 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                {selected && <IconCheck size={12} color="#fff" strokeWidth={3}/>}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14.5, fontWeight: 600 }}>{o.label}</div>
                {o.value === 0 && <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 1 }}>Drzwi pozostaną otwarte do ręcznego zamknięcia</div>}
                {o.value === 60 && <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 1 }}>Zalecane</div>}
              </div>
            </button>
          );
        })}
      </div>

      <button onClick={onBack} style={{
        width: '100%', marginTop: 14,
        background: 'linear-gradient(135deg, var(--accent-400), var(--accent-300))',
        border: 'none', borderRadius: 'var(--r-xl)',
        padding: '14px', color: '#fff',
        fontSize: 14.5, fontWeight: 700, cursor: 'pointer',
        boxShadow: '0 8px 24px var(--accent-glow)',
      }}>Zapisz</button>
    </div>
  </>
);

// Helpers
const RowIcon = ({ I, danger }) => (
  <div style={{
    width: 44, height: 44, borderRadius: '50%',
    background: danger ? 'rgba(248,113,113,0.20)' : 'rgba(167,139,250,0.18)',
    color: danger ? 'var(--danger)' : 'var(--accent-200)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  }}><I size={20} strokeWidth={2}/></div>
);

const RowLabel = ({ label, sub }) => (
  <div style={{ flex: 1, textAlign: 'left' }}>
    <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--text-primary)' }}>{label}</div>
    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>{sub}</div>
  </div>
);

const rowBtnStyle = ({ danger } = {}) => ({
  width: '100%',
  background: danger ? 'rgba(248,113,113,0.08)' : 'var(--bg-2)',
  border: `1px solid ${danger ? 'rgba(248,113,113,0.25)' : 'var(--border-default)'}`,
  borderRadius: 'var(--r-xl)',
  padding: '14px 16px',
  display: 'flex', alignItems: 'center', gap: 14,
  color: 'var(--text-primary)', cursor: 'pointer',
});

const closeBtnStyle = {
  width: 32, height: 32, borderRadius: '50%',
  background: 'var(--border-subtle)', border: 'none',
  color: 'var(--text-secondary)', cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};

window.HomeV3 = HomeV3;
window.GateActionSheet = GateActionSheet;
