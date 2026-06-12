import React, { useState } from 'react';
import SignalCard from '../components/SignalCard';
import { Empty } from '../components/ui';

const TABS = [
  { id: 'triggered', label: 'Triggered', fn: s => s.status === 'TRIGGERED' },
  { id: 'watching',  label: 'Watching',  fn: s => s.status !== 'TRIGGERED' && s.status !== 'EXIT' && s.status !== 'ABORTED' },
  { id: 'closed',    label: 'Closed',    fn: s => s.status === 'EXIT' || s.status === 'ABORTED' }
];

export default function SignalsView({ signals }) {
  const [tab, setTab] = useState('triggered');
  const active = TABS.find(t => t.id === tab);
  const filtered = signals.filter(active.fn);

  return (
    <div>
      <div className="flex gap-1 mb-4">
        {TABS.map(t => {
          const count = signals.filter(t.fn).length;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                tab === t.id ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}>
              {t.label}{count > 0 && <span className="ml-1.5 opacity-70">{count}</span>}
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <Empty title={`No ${active.label.toLowerCase()} signals`}
          hint="Signals appear when setups pass all six validation gates" />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {filtered.map(s => <SignalCard key={s.id} signal={s} />)}
        </div>
      )}
    </div>
  );
}
