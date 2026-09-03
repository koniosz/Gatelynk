// Vehicles & Guests — car management + guest invites with gate access

const COLOR_OPTIONS = [
  { name: 'Czarny',    hex: '#1A1A1A' },
  { name: 'Biały',     hex: '#F5F5F5' },
  { name: 'Srebrny',   hex: '#C9CCD1' },
  { name: 'Szary',     hex: '#7A7E85' },
  { name: 'Granatowy', hex: '#1E2A4A' },
  { name: 'Niebieski', hex: '#3B6FE0' },
  { name: 'Czerwony',  hex: '#D43F3F' },
  { name: 'Zielony',   hex: '#3F7A52' },
  { name: 'Żółty',     hex: '#E8C547' },
  { name: 'Pomarańczowy', hex: '#E08F3B' },
  { name: 'Brązowy',   hex: '#6B4A2B' },
  { name: 'Inny',      hex: 'transparent', isOther: true },
];
const colorHex = (name) => (COLOR_OPTIONS.find(c => c.name === name)?.hex) || '#7A7E85';

// =====================================================
// VEHICLES SCREEN
// =====================================================
const VehiclesScreen = ({ data, onBack }) => {
  const [vehicles, setVehicles] = React.useState(data.vehicles || []);
  const [editing, setEditing] = React.useState(null); // null | 'new' | vehicle id

  if (editing) {
    const initial = editing === 'new' ? null : vehicles.find(v => v.id === editing);
    return (
      <VehicleEditor
        initial={initial}
        onCancel={() => setEditing(null)}
        onDelete={() => { setVehicles(vehicles.filter(v => v.id !== editing)); setEditing(null); }}
        onSave={(v) => {
          if (editing === 'new') setVehicles([...vehicles, { ...v, id: 'v' + Date.now() }]);
          else setVehicles(vehicles.map(x => x.id === editing ? { ...x, ...v } : x));
          setEditing(null);
        }}
      />
    );
  }

  return (
    <div className="screen scroll-area" style={{ paddingBottom: 110 }}>
      <StatusBar />
      <ScreenHeader title="Pojazdy" onBack={onBack}/>

      <div style={{ padding: '0 16px' }}>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 16, padding: '0 4px' }}>
          Pojazdy zarejestrowane w aplikacji są rozpoznawane przez kamery przy bramach (ANPR) i otwierają je automatycznie.
        </div>

        {vehicles.length === 0 && (
          <div style={{
            padding: '40px 20px', textAlign: 'center',
            background: 'var(--bg-2)', border: '1px dashed var(--border-default)',
            borderRadius: 'var(--r-xl)',
          }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--bg-3)', margin: '0 auto 12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <IconCar size={26} color="var(--text-secondary)"/>
            </div>
            <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--text-primary)' }}>Brak pojazdów</div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>Dodaj swój pierwszy samochód</div>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {vehicles.map(v => <VehicleCard key={v.id} v={v} onEdit={() => setEditing(v.id)}/>)}
        </div>

        <button onClick={() => setEditing('new')} style={{
          width: '100%', marginTop: 14,
          background: 'var(--bg-2)',
          border: '1px dashed var(--border-default)',
          borderRadius: 'var(--r-xl)',
          padding: '16px',
          color: 'var(--text-primary)',
          fontSize: 14, fontWeight: 600, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        }}>
          <IconPlus size={18}/>
          Dodaj pojazd
        </button>
      </div>
    </div>
  );
};

const VehicleCard = ({ v, onEdit }) => (
  <button onClick={onEdit} style={{
    width: '100%',
    background: 'var(--bg-2)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--r-xl)',
    padding: 14,
    display: 'flex', alignItems: 'center', gap: 14,
    cursor: 'pointer',
  }}>
    <div style={{
      width: 52, height: 52, borderRadius: 'var(--r-md)',
      background: colorHex(v.color),
      border: v.color === 'Biały' ? '1px solid var(--border-default)' : 'none',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0,
    }}>
      <IconCar size={26} color={['Biały','Srebrny','Żółty'].includes(v.color) ? '#1A1A1A' : '#fff'}/>
    </div>
    <div style={{ flex: 1, textAlign: 'left' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
          {v.make} {v.model}
        </div>
        {v.primary && <span style={{
          display: 'inline-block', padding: '3px 7px',
          background: 'rgba(167,139,250,0.18)',
          color: 'var(--accent-200)',
          borderRadius: 'var(--r-full)',
          fontSize: 10, fontWeight: 700, letterSpacing: '0.05em',
        }}>GŁÓWNY</span>}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>
        {v.color} · {v.year}
      </div>
      <div style={{
        display: 'inline-block', marginTop: 6,
        padding: '3px 8px',
        background: '#1A1F2E',
        border: '2px solid #FBC02D',
        borderRadius: 4,
        fontFamily: 'Geist Mono, monospace',
        fontSize: 12, fontWeight: 700,
        color: '#FBC02D',
        letterSpacing: '0.05em',
      }}>{v.plate}</div>
    </div>
    <IconChevronRight size={16} color="var(--text-tertiary)"/>
  </button>
);

const VehicleEditor = ({ initial, onSave, onCancel, onDelete }) => {
  const [make, setMake] = React.useState(initial?.make || '');
  const [model, setModel] = React.useState(initial?.model || '');
  const [year, setYear] = React.useState(initial?.year || '');
  const [color, setColor] = React.useState(initial?.color || 'Czarny');
  const [plate, setPlate] = React.useState(initial?.plate || '');
  const valid = make && model && plate;

  return (
    <div className="screen scroll-area" style={{ paddingBottom: 120 }}>
      <StatusBar />
      <ScreenHeader title={initial ? 'Edytuj pojazd' : 'Nowy pojazd'} onBack={onCancel}/>

      <div style={{ padding: '0 16px' }}>
        {/* Live preview */}
        <div style={{
          background: 'var(--bg-2)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--r-xl)',
          padding: '20px',
          textAlign: 'center',
          marginBottom: 20,
        }}>
          <div style={{
            width: 88, height: 88, borderRadius: 'var(--r-lg)',
            background: colorHex(color),
            border: color === 'Biały' ? '1px solid var(--border-default)' : 'none',
            margin: '0 auto 14px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'background 0.2s',
          }}>
            <IconCar size={44} color={['Biały','Srebrny','Żółty'].includes(color) ? '#1A1A1A' : '#fff'}/>
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
            {make || 'Marka'} {model || 'Model'}
          </div>
          <div style={{
            display: 'inline-block', marginTop: 10,
            padding: '4px 12px',
            background: '#1A1F2E',
            border: '2px solid #FBC02D',
            borderRadius: 4,
            fontFamily: 'Geist Mono, monospace',
            fontSize: 14, fontWeight: 700,
            color: '#FBC02D',
            letterSpacing: '0.08em',
          }}>{plate || 'WX 00000'}</div>
        </div>

        <SectionHeader title="Marka i model"/>
        <Card padding={4}>
          <FormRow label="Marka" value={make} onChange={setMake} placeholder="np. Volkswagen"/>
          <FormRow label="Model" value={model} onChange={setModel} placeholder="np. Passat"/>
          <FormRow label="Rok" value={year} onChange={setYear} placeholder="2024" type="number" last/>
        </Card>

        <SectionHeader title="Kolor"/>
        <div style={{
          background: 'var(--bg-2)', border: '1px solid var(--border-default)',
          borderRadius: 'var(--r-xl)', padding: 12,
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8 }}>
            {COLOR_OPTIONS.map(c => (
              <button key={c.name} onClick={() => setColor(c.name)} style={{
                aspectRatio: '1', borderRadius: '50%',
                background: c.isOther ? 'conic-gradient(from 0deg, #ff5252, #ffd740, #69f0ae, #40c4ff, #b388ff, #ff5252)' : c.hex,
                border: color === c.name ? '3px solid var(--accent-300)' : (c.name === 'Biały' ? '2px solid var(--border-default)' : '2px solid transparent'),
                cursor: 'pointer', padding: 0,
                outline: color === c.name ? '2px solid var(--accent-glow)' : 'none',
                outlineOffset: 2,
              }} title={c.name}/>
            ))}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 10, textAlign: 'center' }}>{color}</div>
        </div>

        <SectionHeader title="Numer rejestracyjny"/>
        <Card padding={14}>
          <input
            value={plate}
            onChange={(e) => setPlate(e.target.value.toUpperCase())}
            placeholder="WI 12345"
            maxLength={9}
            style={{
              width: '100%', boxSizing: 'border-box',
              background: '#1A1F2E',
              border: '2px solid #FBC02D',
              borderRadius: 6,
              padding: '10px 14px',
              fontFamily: 'Geist Mono, monospace',
              fontSize: 22, fontWeight: 700,
              color: '#FBC02D',
              letterSpacing: '0.1em',
              textAlign: 'center',
              outline: 'none',
            }}
          />
          <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 8, textAlign: 'center' }}>
            Wpisz numer dokładnie tak, jak na tablicy. Spacje nie są wymagane.
          </div>
        </Card>

        {/* Save / delete */}
        <button onClick={() => valid && onSave({ make, model, year: Number(year) || undefined, color, plate })} disabled={!valid} style={{
          width: '100%', marginTop: 18,
          background: valid ? 'linear-gradient(135deg, var(--accent-400), var(--accent-300))' : 'var(--bg-3)',
          border: 'none', borderRadius: 'var(--r-xl)',
          padding: '16px', color: '#fff',
          fontSize: 15, fontWeight: 700, cursor: valid ? 'pointer' : 'default',
          opacity: valid ? 1 : 0.5,
          boxShadow: valid ? '0 8px 24px var(--accent-glow)' : 'none',
        }}>
          {initial ? 'Zapisz zmiany' : 'Dodaj pojazd'}
        </button>

        {initial && (
          <button onClick={onDelete} style={{
            width: '100%', marginTop: 10,
            background: 'transparent', border: 'none',
            color: 'var(--danger)',
            fontSize: 13.5, fontWeight: 600, cursor: 'pointer',
            padding: 12,
          }}>Usuń pojazd</button>
        )}
      </div>
    </div>
  );
};

const FormRow = ({ label, value, onChange, placeholder, type = 'text', last }) => (
  <div style={{
    padding: '12px 14px',
    borderBottom: last ? 'none' : '1px solid var(--border-subtle)',
    display: 'flex', alignItems: 'center', gap: 12,
  }}>
    <div style={{ width: 70, fontSize: 12.5, color: 'var(--text-secondary)', fontWeight: 500 }}>{label}</div>
    <input
      type={type} value={value} onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        flex: 1, background: 'transparent', border: 'none',
        fontSize: 14, color: 'var(--text-primary)',
        fontFamily: 'inherit', outline: 'none',
        textAlign: 'right',
      }}
    />
  </div>
);

// =====================================================
// GUESTS SCREEN — list of invitations + create new
// =====================================================
const GuestsScreen = ({ data, onBack }) => {
  const [guests, setGuests] = React.useState(data.guests || []);
  const [view, setView] = React.useState('list'); // list | new | view:id

  if (view === 'new' || (typeof view === 'string' && view.startsWith('view:'))) {
    const editing = view === 'new' ? null : guests.find(g => g.id === view.slice(5));
    return (
      <GuestInvite
        myVehicles={data.vehicles || []}
        initial={editing}
        onCancel={() => setView('list')}
        onSave={(g) => {
          if (view === 'new') setGuests([{ ...g, id: 'g' + Date.now(), status: 'upcoming' }, ...guests]);
          else setGuests(guests.map(x => x.id === editing.id ? { ...x, ...g } : x));
          setView('list');
        }}
        onRevoke={() => { setGuests(guests.filter(g => g.id !== editing.id)); setView('list'); }}
      />
    );
  }

  const grouped = {
    active:   guests.filter(g => g.status === 'active'),
    upcoming: guests.filter(g => g.status === 'upcoming'),
    expired:  guests.filter(g => g.status === 'expired'),
  };

  return (
    <div className="screen scroll-area" style={{ paddingBottom: 110 }}>
      <StatusBar />
      <ScreenHeader title="Goście" onBack={onBack}/>

      <div style={{ padding: '0 16px' }}>
        <button onClick={() => setView('new')} style={{
          width: '100%',
          background: 'linear-gradient(135deg, var(--accent-400), var(--accent-300))',
          border: 'none', borderRadius: 'var(--r-xl)',
          padding: '16px', color: '#fff',
          fontSize: 15, fontWeight: 700, cursor: 'pointer',
          boxShadow: '0 8px 24px var(--accent-glow)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          marginBottom: 16,
        }}>
          <IconPlus size={18} strokeWidth={2.4}/>
          Zaproś gościa
        </button>

        {grouped.active.length > 0 && (
          <>
            <SectionHeader title="Teraz aktywne" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {grouped.active.map(g => <GuestCard key={g.id} g={g} onClick={() => setView('view:' + g.id)}/>)}
            </div>
          </>
        )}

        {grouped.upcoming.length > 0 && (
          <>
            <SectionHeader title="Nadchodzące" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {grouped.upcoming.map(g => <GuestCard key={g.id} g={g} onClick={() => setView('view:' + g.id)}/>)}
            </div>
          </>
        )}

        {grouped.expired.length > 0 && (
          <>
            <SectionHeader title="Historia" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {grouped.expired.map(g => <GuestCard key={g.id} g={g} onClick={() => setView('view:' + g.id)} muted/>)}
            </div>
          </>
        )}

        {guests.length === 0 && (
          <div style={{
            padding: '40px 20px', textAlign: 'center',
            background: 'var(--bg-2)', border: '1px dashed var(--border-default)',
            borderRadius: 'var(--r-xl)',
          }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--bg-3)', margin: '0 auto 12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <IconUsers size={26} color="var(--text-secondary)"/>
            </div>
            <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--text-primary)' }}>Brak zaproszeń</div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>Zaproś pierwszego gościa</div>
          </div>
        )}
      </div>
    </div>
  );
};

const GuestCard = ({ g, onClick, muted }) => {
  const statusColor = g.status === 'active' ? 'var(--success)' : g.status === 'upcoming' ? 'var(--accent-300)' : 'var(--text-tertiary)';
  const statusLabel = g.status === 'active' ? 'Aktywny teraz' : g.status === 'upcoming' ? 'Nadchodzący' : 'Wygasł';

  return (
    <button onClick={onClick} style={{
      width: '100%',
      background: 'var(--bg-2)',
      border: '1px solid var(--border-default)',
      borderRadius: 'var(--r-xl)',
      padding: 14,
      display: 'flex', alignItems: 'center', gap: 12,
      cursor: 'pointer', opacity: muted ? 0.6 : 1,
    }}>
      <div style={{
        width: 44, height: 44, borderRadius: 'var(--r-md)',
        background: colorHex(g.vehicle?.color || 'Szary'),
        border: g.vehicle?.color === 'Biały' ? '1px solid var(--border-default)' : 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <IconCar size={22} color={['Biały','Srebrny','Żółty'].includes(g.vehicle?.color) ? '#1A1A1A' : '#fff'}/>
      </div>
      <div style={{ flex: 1, textAlign: 'left' }}>
        <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>{g.name}</div>
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 2, fontFamily: 'Geist Mono, monospace' }}>
          {g.vehicle?.plate} · {fmtTimeRange(g.from, g.to)}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 5 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor }}/>
          <span style={{ fontSize: 11, color: statusColor, fontWeight: 600 }}>{statusLabel}</span>
        </div>
      </div>
      <IconChevronRight size={16} color="var(--text-tertiary)"/>
    </button>
  );
};

const fmtTimeRange = (from, to) => {
  if (!from || !to) return '';
  const f = new Date(from), t = new Date(to);
  const d = f.toLocaleDateString('pl-PL', { day: '2-digit', month: 'short' });
  const tf = f.toTimeString().slice(0,5);
  const tt = t.toTimeString().slice(0,5);
  return `${d}, ${tf}–${tt}`;
};

// =====================================================
// GUEST INVITE — multi-step form
// =====================================================
const GuestInvite = ({ myVehicles, initial, onSave, onCancel, onRevoke }) => {
  const [name, setName]   = React.useState(initial?.name   || '');
  const [phone, setPhone] = React.useState(initial?.phone  || '');
  const [vMake, setVMake]   = React.useState(initial?.vehicle?.make   || '');
  const [vModel, setVModel] = React.useState(initial?.vehicle?.model  || '');
  const [vColor, setVColor] = React.useState(initial?.vehicle?.color  || 'Czarny');
  const [vPlate, setVPlate] = React.useState(initial?.vehicle?.plate  || '');
  const [gates, setGates] = React.useState(initial?.gates || ['entry', 'exit']);
  const today = new Date().toISOString().slice(0,10);
  const nowH  = String(new Date().getHours()).padStart(2,'0')+':00';
  const [date, setDate] = React.useState(initial ? initial.from.slice(0,10) : today);
  const [fromTime, setFromTime] = React.useState(initial ? initial.from.slice(11,16) : nowH);
  const [toTime, setToTime]     = React.useState(initial ? initial.to.slice(11,16)   : '23:00');

  const valid = name && vPlate && gates.length > 0 && date && fromTime && toTime;

  const submit = () => {
    if (!valid) return;
    onSave({
      name, phone,
      vehicle: { make: vMake, model: vModel, color: vColor, plate: vPlate },
      gates,
      from: `${date}T${fromTime}`,
      to:   `${date}T${toTime}`,
    });
  };

  const useMyCar = (v) => {
    setVMake(v.make); setVModel(v.model); setVColor(v.color); setVPlate(v.plate);
  };

  return (
    <div className="screen scroll-area" style={{ paddingBottom: 120 }}>
      <StatusBar />
      <ScreenHeader title={initial ? 'Edytuj zaproszenie' : 'Zaproś gościa'} onBack={onCancel}/>

      <div style={{ padding: '0 16px' }}>
        {/* Guest */}
        <SectionHeader title="Gość"/>
        <Card padding={4}>
          <FormRow label="Imię" value={name} onChange={setName} placeholder="np. Magda Nowak"/>
          <FormRow label="Telefon" value={phone} onChange={setPhone} placeholder="opcjonalnie" last/>
        </Card>

        {/* Vehicle */}
        <SectionHeader title="Samochód gościa"/>
        {myVehicles.length > 0 && (
          <div style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '0 4px 8px', marginBottom: 4 }}>
            {myVehicles.map(v => (
              <button key={v.id} onClick={() => useMyCar(v)} style={{
                flexShrink: 0, padding: '6px 10px',
                background: 'rgba(167,139,250,0.10)',
                border: '1px solid rgba(167,139,250,0.30)',
                borderRadius: 'var(--r-full)',
                fontSize: 11.5, color: 'var(--accent-200)', fontWeight: 600, cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}>+ Mój: {v.make} {v.model}</button>
            ))}
          </div>
        )}
        <Card padding={4}>
          <FormRow label="Marka" value={vMake} onChange={setVMake} placeholder="np. BMW"/>
          <FormRow label="Model" value={vModel} onChange={setVModel} placeholder="np. X3" last/>
        </Card>

        <div style={{
          marginTop: 10,
          background: 'var(--bg-2)', border: '1px solid var(--border-default)',
          borderRadius: 'var(--r-xl)', padding: 12,
        }}>
          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', fontWeight: 500, marginBottom: 8, padding: '0 4px' }}>Kolor</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8 }}>
            {COLOR_OPTIONS.map(c => (
              <button key={c.name} onClick={() => setVColor(c.name)} style={{
                aspectRatio: '1', borderRadius: '50%',
                background: c.isOther ? 'conic-gradient(from 0deg, #ff5252, #ffd740, #69f0ae, #40c4ff, #b388ff, #ff5252)' : c.hex,
                border: vColor === c.name ? '3px solid var(--accent-300)' : (c.name === 'Biały' ? '2px solid var(--border-default)' : '2px solid transparent'),
                cursor: 'pointer', padding: 0,
              }} title={c.name}/>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 10 }}>
          <input
            value={vPlate}
            onChange={(e) => setVPlate(e.target.value.toUpperCase())}
            placeholder="WX 00000"
            maxLength={9}
            style={{
              width: '100%', boxSizing: 'border-box',
              background: '#1A1F2E',
              border: '2px solid #FBC02D',
              borderRadius: 6, padding: '12px 14px',
              fontFamily: 'Geist Mono, monospace',
              fontSize: 20, fontWeight: 700,
              color: '#FBC02D', letterSpacing: '0.1em', textAlign: 'center',
              outline: 'none',
            }}
          />
        </div>

        {/* Gates access */}
        <SectionHeader title="Dostęp do bram"/>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <GateToggle id="entry" icon={IconCar}        label="Wjazd"  sub="Brama główna · Niewinna 1" gates={gates} setGates={setGates}/>
          <GateToggle id="exit"  icon={IconArrowRight} label="Wyjazd" sub="Brama tylna"               gates={gates} setGates={setGates}/>
        </div>

        {/* Time range */}
        <SectionHeader title="Zakres czasowy"/>
        <Card padding={4}>
          <FormRow label="Data"    value={date}     onChange={setDate}     type="date"/>
          <FormRow label="Od"      value={fromTime} onChange={setFromTime} type="time"/>
          <FormRow label="Do"      value={toTime}   onChange={setToTime}   type="time" last/>
        </Card>

        {/* Quick presets */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8, padding: '0 4px' }}>
          {[
            { label: 'Najbliższe 2h',   apply: () => { setDate(today); const n=new Date(); setFromTime(n.toTimeString().slice(0,5)); const e=new Date(n.getTime()+2*3600e3); setToTime(e.toTimeString().slice(0,5)); } },
            { label: 'Cały dzień',      apply: () => { setDate(today); setFromTime('00:00'); setToTime('23:59'); } },
            { label: 'Wieczór 18–23',   apply: () => { setDate(today); setFromTime('18:00'); setToTime('23:00'); } },
          ].map((p, i) => (
            <button key={i} onClick={p.apply} style={{
              padding: '6px 10px',
              background: 'rgba(167,139,250,0.10)',
              border: '1px solid rgba(167,139,250,0.25)',
              borderRadius: 'var(--r-full)',
              fontSize: 11.5, color: 'var(--accent-200)', fontWeight: 600, cursor: 'pointer',
            }}>{p.label}</button>
          ))}
        </div>

        {/* Summary */}
        <div style={{
          marginTop: 18,
          background: 'rgba(52,211,153,0.08)',
          border: '1px solid rgba(52,211,153,0.25)',
          borderRadius: 'var(--r-xl)',
          padding: 14,
        }}>
          <div style={{ fontSize: 11, color: 'var(--success)', textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 700, marginBottom: 8 }}>
            Podsumowanie
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.6 }}>
            <strong>{name || 'Gość'}</strong> będzie mógł otwierać <strong>{gates.length === 2 ? 'wjazd i wyjazd' : (gates[0] === 'entry' ? 'wjazd' : 'wyjazd')}</strong> autem <strong>{vMake || 'samochodem'} {vModel}</strong> ({vPlate || 'numer'}) w dniu <strong>{date}</strong> w godz. <strong>{fromTime}–{toTime}</strong>. Brama otworzy się automatycznie po rozpoznaniu numeru rejestracyjnego.
          </div>
        </div>

        {/* CTAs */}
        <button onClick={submit} disabled={!valid} style={{
          width: '100%', marginTop: 18,
          background: valid ? 'linear-gradient(135deg, var(--accent-400), var(--accent-300))' : 'var(--bg-3)',
          border: 'none', borderRadius: 'var(--r-xl)',
          padding: '16px', color: '#fff',
          fontSize: 15, fontWeight: 700, cursor: valid ? 'pointer' : 'default',
          opacity: valid ? 1 : 0.5,
          boxShadow: valid ? '0 8px 24px var(--accent-glow)' : 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        }}>
          <IconShare size={16}/>
          {initial ? 'Zapisz zmiany' : 'Wyślij zaproszenie'}
        </button>

        {initial && (
          <button onClick={onRevoke} style={{
            width: '100%', marginTop: 10,
            background: 'transparent', border: 'none',
            color: 'var(--danger)',
            fontSize: 13.5, fontWeight: 600, cursor: 'pointer', padding: 12,
          }}>Cofnij dostęp</button>
        )}
      </div>
    </div>
  );
};

const GateToggle = ({ id, icon: I, label, sub, gates, setGates }) => {
  const on = gates.includes(id);
  const toggle = () => setGates(on ? gates.filter(g => g !== id) : [...gates, id]);
  return (
    <button onClick={toggle} style={{
      width: '100%',
      background: on ? 'rgba(167,139,250,0.10)' : 'var(--bg-2)',
      border: `1px solid ${on ? 'rgba(167,139,250,0.40)' : 'var(--border-default)'}`,
      borderRadius: 'var(--r-xl)',
      padding: 14,
      display: 'flex', alignItems: 'center', gap: 12,
      cursor: 'pointer',
    }}>
      <div style={{
        width: 38, height: 38, borderRadius: '50%',
        background: on ? 'rgba(167,139,250,0.20)' : 'var(--bg-3)',
        color: on ? 'var(--accent-200)' : 'var(--text-secondary)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}><I size={18} strokeWidth={2}/></div>
      <div style={{ flex: 1, textAlign: 'left' }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{label}</div>
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 2 }}>{sub}</div>
      </div>
      <div style={{
        width: 22, height: 22, borderRadius: '50%',
        background: on ? 'var(--accent-300)' : 'transparent',
        border: `2px solid ${on ? 'var(--accent-300)' : 'var(--border-default)'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {on && <IconCheck size={12} color="#fff" strokeWidth={3}/>}
      </div>
    </button>
  );
};

window.VehiclesScreen = VehiclesScreen;
window.GuestsScreen = GuestsScreen;
