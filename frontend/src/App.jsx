import React, { useState, useEffect } from 'react';
import SignalCard from './components/SignalCard';
import OpportunityList from './components/OpportunityList';
import RegimeMonitor from './components/RegimeMonitor';
import NotificationCenter from './components/NotificationCenter';

const API_URL = '';

const WS_URL =
  window.location.protocol === 'https:'
    ? `wss://${window.location.host}`
    : `ws://${window.location.host}`;

function App() {
  const [activeTab, setActiveTab] = useState('triggered');
  const [signals, setSignals] = useState([]);
  const [opportunities, setOpportunities] = useState([]);
  const [regimes, setRegimes] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [wsConnected, setWsConnected] = useState(false);

  useEffect(() => {
    const ws = new WebSocket(WS_URL);

    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      handleWsMessage(msg);
    };

    fetchData();

    const interval = setInterval(fetchData, 2000);

    return () => {
      ws.close();
      clearInterval(interval);
    };
  }, []);

  const fetchData = async () => {
    try {
      const [sigRes, oppRes] = await Promise.all([
        fetch(`${API_URL}/api/signals/active`),
        fetch(`${API_URL}/api/opportunities?limit=10`)
      ]);

      const sigData = await sigRes.json();
      const oppData = await oppRes.json();

      setSignals(sigData.signals || []);
      setOpportunities(oppData.opportunities || []);
    } catch (err) {
      console.error('Fetch error:', err);
    }
  };

  const handleWsMessage = (msg) => {
    switch (msg.type) {
      case 'opportunity:trigger':
        setSignals(prev => [msg.data, ...prev]);
        setNotifications(prev => [
          { ...msg.data, type: 'trigger', time: Date.now() },
          ...prev
        ].slice(0, 50));
        playBeep();
        break;

      case 'signal:state':
        setSignals(prev =>
          prev.map(s =>
            s.id === msg.data.signalId
              ? { ...s, status: msg.data.to }
              : s
          )
        );
        break;

      case 'regime:change':
        setRegimes(prev => [
          ...prev.filter(r => r.instrument !== msg.instrument),
          {
            instrument: msg.instrument,
            regime: msg.data.to,
            confidence: msg.data.confidence
          }
        ]);
        break;

      default:
        break;
    }
  };

  const playBeep = () => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.frequency.value = 800;
    gain.gain.value = 0.1;

    osc.start();
    osc.stop(ctx.currentTime + 0.2);
  };

  const tabs = [
    {
      id: 'triggered',
      label: 'Triggered Signals',
      count: signals.filter(s => s.status === 'TRIGGERED').length
    },
    {
      id: 'active',
      label: 'Active Signals',
      count: signals.filter(
        s =>
          s.status !== 'TRIGGERED' &&
          s.status !== 'EXIT' &&
          s.status !== 'ABORTED'
      ).length
    },
    {
      id: 'opportunities',
      label: 'Top Opportunities',
      count: opportunities.length
    },
    {
      id: 'completed',
      label: 'Completed',
      count: signals.filter(
        s => s.status === 'EXIT' || s.status === 'ABORTED'
      ).length
    }
  ];

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-emerald-400">PTA</h1>
          <p className="text-gray-400 text-sm">
            Personal Trading Assistant
          </p>
        </div>

        <div className="flex items-center gap-4">
          <div
            className={`px-3 py-1 rounded text-xs font-medium ${
              wsConnected
                ? 'bg-emerald-900 text-emerald-400'
                : 'bg-red-900 text-red-400'
            }`}
          >
            {wsConnected ? '● LIVE' : '○ OFFLINE'}
          </div>

          <RegimeMonitor regimes={regimes} />
        </div>
      </header>

      <div className="flex gap-2 mb-6 overflow-x-auto">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 rounded-lg font-medium text-sm transition ${
              activeTab === tab.id
                ? 'bg-emerald-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
            }`}
          >
            {tab.label}
            {tab.count > 0 && (
              <span className="ml-2 bg-gray-900 text-white px-2 py-0.5 rounded text-xs">
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          {activeTab === 'triggered' && (
            <div className="space-y-4">
              {signals.filter(s => s.status === 'TRIGGERED').length === 0 && (
                <div className="text-gray-500 text-center py-12">
                  No triggered signals yet
                </div>
              )}

              {signals
                .filter(s => s.status === 'TRIGGERED')
                .map(signal => (
                  <SignalCard key={signal.id} signal={signal} />
                ))}
            </div>
          )}

          {activeTab === 'active' && (
            <div className="space-y-4">
              {signals
                .filter(
                  s =>
                    s.status !== 'TRIGGERED' &&
                    s.status !== 'EXIT' &&
                    s.status !== 'ABORTED'
                )
                .map(signal => (
                  <SignalCard key={signal.id} signal={signal} />
                ))}
            </div>
          )}

          {activeTab === 'opportunities' && (
            <OpportunityList opportunities={opportunities} />
          )}

          {activeTab === 'completed' && (
            <div className="space-y-4">
              {signals
                .filter(
                  s => s.status === 'EXIT' || s.status === 'ABORTED'
                )
                .map(signal => (
                  <SignalCard key={signal.id} signal={signal} />
                ))}
            </div>
          )}
        </div>

        <div className="lg:col-span-1">
          <NotificationCenter notifications={notifications} />
        </div>
      </div>
    </div>
  );
}

export default App;