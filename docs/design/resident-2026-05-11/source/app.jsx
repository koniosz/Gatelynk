// Top-level prototype app — composes everything

const { useState, useEffect } = React;

const HOME_VARIANTS = [
  { id: 'v1', label: 'Refined Classic', sub: 'Cleanup wersji obecnej', component: 'HomeV1' },
  { id: 'v2', label: 'Big Action', sub: 'Brama jako gwiazda', component: 'HomeV2' },
  { id: 'v3', label: 'Glass Premium', sub: 'Frosted glass + zdjęcia', component: 'HomeV3' },
  { id: 'v4', label: 'Minimal', sub: 'Linie, biel, kontrast', component: 'HomeV4' },
  { id: 'v5', label: 'Smart Dashboard', sub: 'Smart-home tiles', component: 'HomeV5' },
  { id: 'v6', label: 'Activity Feed', sub: 'Timeline-first', component: 'HomeV6' },
];

const GATE_VARIANTS = [
  { id: 'tap',   label: 'Tap', sub: 'Jeden naciśnięcie' },
  { id: 'hold',  label: 'Hold', sub: '3 sekundy przytrzymania' },
  { id: 'slide', label: 'Slide', sub: 'Przesuń do końca' },
];

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "homeVariant": "v3",
  "gateVariant": "hold",
  "theme": "light",
  "showHero": true,
  "showPayments": true
}/*EDITMODE-END*/;

const App = () => {
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [activeTab, setActiveTab] = useState('home');
  const [gateOpen, setGateOpen] = useState(null); // null | 'entry' | 'exit'

  const data = MOCK_DATA;
  const HomeComp = window[HOME_VARIANTS.find(v => v.id === tweaks.homeVariant)?.component] || HomeV2;

  const onOpenGate = (dir) => setGateOpen(dir);
  const onGateClose = () => setGateOpen(null);

  let body;
  if (activeTab === 'home') {
    body = <HomeComp data={data} onOpenGate={onOpenGate} onOpenGuests={() => setActiveTab('guests')} showHero={tweaks.showHero} showPayments={tweaks.showPayments}/>;
  } else if (activeTab === 'notif') {
    body = <NotificationsScreen data={data} onBack={() => setActiveTab('home')}/>;
  } else if (activeTab === 'tickets') {
    body = <TicketsScreen data={data} onBack={() => setActiveTab('home')}/>;
  } else if (activeTab === 'parcels') {
    body = <ParcelsScreen data={data} onBack={() => setActiveTab('home')}/>;
  } else if (activeTab === 'vehicles') {
    body = <VehiclesScreen data={data} onBack={() => setActiveTab('more')}/>;
  } else if (activeTab === 'guests') {
    body = <GuestsScreen data={data} onBack={() => setActiveTab('home')}/>;
  } else if (activeTab === 'more') {
    body = <ProfileScreen data={data} onBack={() => setActiveTab('home')} theme={tweaks.theme} onTheme={(t) => setTweak('theme', t)} onOpenVehicles={() => setActiveTab('vehicles')} onOpenGuests={() => setActiveTab('guests')}/>;
  }

  return (
    <div data-theme={tweaks.theme} style={{ width: '100%', height: '100%', position: 'relative' }}>
      {gateOpen ? (
        <GateScreen
          direction={gateOpen}
          variant={tweaks.gateVariant}
          onClose={onGateClose}
          onComplete={onGateClose}
        />
      ) : (
        <>
          {body}
          <TabBar active={activeTab} onChange={setActiveTab}/>
        </>
      )}

      {/* Tweaks panel */}
      <TweaksPanel title="Tweaks">
        <TweakSection label="Wariant ekranu Dom" />
        <TweakSelect
          label="Layout"
          value={tweaks.homeVariant}
          onChange={(v) => setTweak('homeVariant', v)}
          options={HOME_VARIANTS.map(v => ({ value: v.id, label: `${v.label} — ${v.sub}` }))}
        />
        <TweakSection label="Otwieranie bramy" />
        <TweakRadio
          label="Interakcja"
          value={tweaks.gateVariant}
          onChange={(v) => setTweak('gateVariant', v)}
          options={GATE_VARIANTS.map(v => ({ value: v.id, label: v.label }))}
        />
        <TweakSection label="Wygląd" />
        <TweakRadio
          label="Motyw"
          value={tweaks.theme}
          onChange={(v) => setTweak('theme', v)}
          options={[{ value: 'dark', label: 'Ciemny' }, { value: 'light', label: 'Jasny' }]}
        />
        <TweakToggle
          label="Zdjęcie osiedla"
          value={tweaks.showHero}
          onChange={(v) => setTweak('showHero', v)}
        />
        <TweakToggle
          label="Karta płatności"
          value={tweaks.showPayments}
          onChange={(v) => setTweak('showPayments', v)}
        />
        <TweakSection label="Test" />
        <TweakButton label="Otwórz wjazd (test)" onClick={() => setGateOpen('entry')}/>
      </TweaksPanel>
    </div>
  );
};

// Mount inside iOS frame
const root = ReactDOM.createRoot(document.getElementById('root'));
const Root = () => {
  // Read theme from the App's stored tweaks for correct frame chrome
  const stored = (() => {
    try { return JSON.parse(localStorage.getItem('__tweaks') || '{}'); } catch { return {}; }
  })();
  const theme = stored.theme || 'light';
  return (
    <IOSDevice dark={theme === 'dark'}>
      <App />
    </IOSDevice>
  );
};
root.render(<Root />);
