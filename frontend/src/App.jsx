import React, { useEffect, useRef, useState } from 'react';
import { api } from './lib/api';
import { auth } from './lib/auth';
import AuthScreen from './views/AuthScreen';
import ScannerView from './views/ScannerView';
import SetupsView from './views/SetupsView';
import SignalsView from './views/SignalsView';
import AnalyticsView from './views/AnalyticsView';
import ChainView from './views/ChainView';
import HistoryView from './views/HistoryView';
import ClassTabs from './components/ClassTabs';

const WS_URL =
  window.location.protocol === 'https:'
    ? `wss://${window.location.host}`
    : `ws://${window.location.host}`;

const VIEWS = [
  { id: 'scanner',   label: 'Scanner',   icon: '◎' },
  { id: 'setups',    label: 'Setups',    icon: '◈' },
  { id: 'signals',   label: 'Signals',   icon: '⚡' },
  { id: 'analytics', label: 'Analytics', icon: '▤' },
  { id: 'chain',     label: 'Chain',     icon: '☰' },
  { id: 'history',   label: 'History',   icon: '◷' }
];

export default function App() {
  const [view, setView] = useState('scanner');
  const [instruments, setInstruments] = useState([]);
  const [v2setups, setV2Setups] = useState([]);
  const [selected, setSelected] = useState('NIFTY');
  const [wsConnected, setWsConnected] = useState(false);
  // Instrument-class segmentation (Indices / Stocks / Commodities)
  const [klass, setKlass] = useState('ALL');
  const [classBySymbol, setClassBySymbol] = useState({});
  const wsRef = useRef(null);

  // auth: 'checking' | 'required' | 'ready'  (ready = authed or auth disabled)
  const [authState, setAuthState] = useState('checking');
  const [user, setUser] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await auth.status();
        if (!s.enabled) { if (!cancelled) setAuthState('ready'); return; }
        const { user: me } = await auth.me();
        if (!cancelled) { setUser(me); setAuthState('ready'); }
      } catch {
        if (!cancelled) setAuthState('required');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const ready = authState === 'ready';

  useEffect(() => {
    if (!ready) return;
    const connect = () => {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => setWsConnected(true);
      ws.onclose = () => {
        setWsConnected(false);
        setTimeout(connect, 3000);
      };
      ws.onmessage = (event) => {
        try { handleWsMessage(JSON.parse(event.data)); } catch {}
      };
    };
    connect();

    // Universe (symbol -> class) rarely changes; fetch once per session.
    api.universe()
      .then((d) => {
        const map = {};
        for (const u of d.universe || []) map[u.symbol] = u.class;
        setClassBySymbol(map);
      })
      .catch(() => {});

    fetchData();
    const interval = setInterval(fetchData, 5000);

    return () => {
      wsRef.current?.close();
      wsRef.current = { close: () => {} }; // prevent reconnect after unmount
      clearInterval(interval);
    };
  }, [ready]);

  const doLogout = async () => {
    try { await auth.logout(); } catch {}
    setUser(null);
    setAuthState('required');
  };

  const fetchData = async () => {
    try {
      const [scr, v2] = await Promise.all([
        api.screener(),
        api.v2Setups()
      ]);
      setInstruments(scr.instruments || []);
      setV2Setups(v2.setups || []);
    } catch (err) {
      console.error('Fetch error:', err.message);
    }
  };

  const handleWsMessage = (msg) => {
    switch (msg.type) {
      case 'opportunity:trigger':
        playBeep();
        fetchData();
        break;
      case 'v2:transition':
        if (msg.data?.to === 'TRIGGERED') { playBeep(); fetchData(); }
        break;
      default:
        break;
    }
  };

  const playBeep = () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 800;
      gain.gain.value = 0.1;
      osc.start();
      osc.stop(ctx.currentTime + 0.2);
    } catch {}
  };

  const goAnalyze = (instrument) => {
    setSelected(instrument);
    setView('analytics');
  };

  const triggeredCount = v2setups.filter(s => s.stage === 'TRIGGERED' || s.stage === 'ACTIVE').length;

  const classOf = (symbol, row) => (row && row.instClass) || classBySymbol[symbol] || 'INDEX';
  const classCounts = v2setups.reduce((acc, s) => {
    const c = classOf(s.instrument, s);
    acc[c] = (acc[c] || 0) + 1;
    return acc;
  }, {});
  const filterByClass = (rows, symbolOf) => klass === 'ALL'
    ? rows
    : rows.filter((r) => classOf(symbolOf(r), r) === klass);

  if (authState === 'checking') {
    return <div className="min-h-screen bg-slate-950 text-slate-500 flex items-center justify-center text-sm">Loading…</div>;
  }
  if (authState === 'required') {
    return <AuthScreen onAuthed={(u) => { setUser(u); setAuthState('ready'); }} />;
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-slate-950/90 backdrop-blur border-b border-slate-800">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <h1 className="text-xl font-bold text-sky-400">PTA</h1>
            <span className="text-xs text-slate-500 hidden sm:inline">Options Intelligence Screener</span>
          </div>

          <div className="flex items-center gap-3">
            {/* Desktop nav */}
            <nav className="hidden md:flex gap-1">
              {VIEWS.map(v => (
                <button key={v.id} onClick={() => setView(v.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition relative ${
                    view === v.id
                      ? 'bg-sky-600 text-white'
                      : 'text-slate-400 hover:bg-slate-800'}`}>
                  {v.label}
                  {v.id === 'signals' && triggeredCount > 0 && (
                    <span className="absolute -top-1 -right-1 w-4 h-4 bg-emerald-500 text-white text-[9px] rounded-full flex items-center justify-center">
                      {triggeredCount}
                    </span>
                  )}
                </button>
              ))}
            </nav>

            <span className={`px-2 py-1 rounded-md text-[10px] font-semibold ${
              wsConnected
                ? 'bg-emerald-500/15 text-emerald-400'
                : 'bg-rose-500/15 text-rose-400'}`}>
              {wsConnected ? '● LIVE' : '○ OFFLINE'}
            </span>

            {user && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400 hidden sm:inline">{user.username}</span>
                <button onClick={doLogout}
                  className="px-2 py-1 rounded-md text-[10px] font-medium bg-slate-800 text-slate-400 hover:bg-slate-700 transition">
                  Logout
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-4 py-4 pb-20 md:pb-6">
        {(view === 'setups' || view === 'signals') && (
          <ClassTabs value={klass} onChange={setKlass} counts={classCounts} />
        )}
        {view === 'scanner' && <ScannerView instruments={instruments} onAnalyze={goAnalyze} />}
        {view === 'setups' && (
          <SetupsView setups={filterByClass(v2setups, (s) => s.instrument)} />
        )}
        {view === 'signals' && (
          <SignalsView setups={filterByClass(v2setups, (s) => s.instrument)}
            klass={klass} classOf={classOf} />
        )}
        {view === 'analytics' && (
          <AnalyticsView instruments={instruments} selected={selected} onSelect={setSelected} />
        )}
        {view === 'chain' && (
          <ChainView instruments={instruments} selected={selected} onSelect={setSelected} />
        )}
        {view === 'history' && <HistoryView />}
      </main>

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-20 bg-slate-950/95 backdrop-blur border-t border-slate-800">
        <div className="flex">
          {VIEWS.map(v => (
            <button key={v.id} onClick={() => setView(v.id)}
              className={`flex-1 py-2.5 flex flex-col items-center gap-0.5 text-[10px] font-medium transition relative ${
                view === v.id ? 'text-sky-400' : 'text-slate-500'}`}>
              <span className="text-base leading-none">{v.icon}</span>
              {v.label}
              {v.id === 'signals' && triggeredCount > 0 && (
                <span className="absolute top-1 right-1/4 w-3.5 h-3.5 bg-emerald-500 text-white text-[8px] rounded-full flex items-center justify-center">
                  {triggeredCount}
                </span>
              )}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
