import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Empty, Card, Badge } from '../components/ui';
import { fmtPrice, fmtTime } from '../lib/format';
import SetupCard, { ARCHETYPE_LABELS } from '../components/SetupCard';

const ACTIVE_STAGES = ['TRIGGERED', 'ACTIVE'];
const CLOSED_STATES = ['TARGET_HIT', 'STOPLOSS_HIT', 'INVALIDATED', 'EXPIRED'];

// Triggered/active trades (live from V2 setups) + closed history (from Postgres).
// `setups` arrives pre-filtered by class from App; the closed table applies the
// same class filter itself (its rows come from a different source). Shadow
// rows (stock/MCX validation classes) are included so the class tabs show
// them, marked with a SHADOW badge.
export default function SignalsView({ setups = [], klass = 'ALL', classOf = () => 'INDEX' }) {
  const [tab, setTab] = useState('active');
  const [closed, setClosed] = useState([]);

  useEffect(() => {
    if (tab !== 'closed') return;
    let cancelled = false;
    const load = () => api.v2Signals(200, true)
      .then((d) => { if (!cancelled) setClosed((d.signals || []).filter((s) => CLOSED_STATES.includes(s.state))); })
      .catch(() => {});
    load();
    const interval = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [tab]);

  const active = setups
    .filter((s) => ACTIVE_STAGES.includes(s.stage))
    .sort((a, b) => b.score - a.score);

  const closedFiltered = klass === 'ALL'
    ? closed
    : closed.filter((s) => classOf(s.symbol, null) === klass);

  return (
    <div>
      <div className="flex gap-1 mb-4">
        <button onClick={() => setTab('active')}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
            tab === 'active' ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}>
          Active{active.length > 0 && <span className="ml-1.5 opacity-70">{active.length}</span>}
        </button>
        <button onClick={() => setTab('closed')}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
            tab === 'closed' ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}>
          Closed
        </button>
      </div>

      {tab === 'active' ? (
        active.length === 0 ? (
          <Empty title="No active signals"
            hint="A setup appears here the moment it triggers — watch them build in the Setups tab" />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {active.map((s) => <SetupCard key={s.id} s={s} />)}
          </div>
        )
      ) : (
        closedFiltered.length === 0 ? (
          <Empty title="No closed signals yet" hint="Triggered signals show their outcome here once they exit" />
        ) : (
          <Card className="p-0 overflow-x-auto">
            <table className="w-full text-xs min-w-[640px]">
              <thead>
                <tr className="text-slate-500 uppercase tracking-wider text-[10px] border-b border-slate-800">
                  <th className="py-2 px-3 text-left font-medium">Time</th>
                  <th className="py-2 px-3 text-left font-medium">Instrument</th>
                  <th className="py-2 px-3 text-left font-medium">Strategy</th>
                  <th className="py-2 px-3 text-left font-medium">Dir</th>
                  <th className="py-2 px-3 text-right font-medium">Score</th>
                  <th className="py-2 px-3 text-left font-medium">Outcome</th>
                  <th className="py-2 px-3 text-right font-medium">P&L</th>
                </tr>
              </thead>
              <tbody>
                {closedFiltered.map((s) => {
                  const win = s.outcome === 'TARGET_HIT' || (s.pnl || 0) > 0;
                  return (
                    <tr key={s.id} className="border-b border-slate-800/50">
                      <td className="py-2 px-3 text-slate-500 whitespace-nowrap">{fmtTime(new Date(s.created_at).getTime())}</td>
                      <td className="py-2 px-3 font-semibold text-slate-200">
                        {s.symbol}
                        {s.shadow && (
                          <Badge cls="ml-1.5 bg-amber-500/15 text-amber-400 border-amber-500/30">SHADOW</Badge>
                        )}
                      </td>
                      <td className="py-2 px-3 text-slate-400">{ARCHETYPE_LABELS[s.strategy] || s.strategy}</td>
                      <td className="py-2 px-3">
                        <Badge cls={s.direction === 'CE'
                          ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                          : 'bg-rose-500/15 text-rose-400 border-rose-500/30'}>{s.direction}</Badge>
                      </td>
                      <td className="py-2 px-3 text-right text-slate-300">{s.score ? Math.round(s.score) : '--'}</td>
                      <td className="py-2 px-3">
                        <Badge cls={win
                          ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                          : 'bg-rose-500/15 text-rose-400 border-rose-500/30'}>{s.state}</Badge>
                      </td>
                      <td className={`py-2 px-3 text-right ${(s.pnl || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {s.pnl != null ? fmtPrice(s.pnl) : '--'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )
      )}
    </div>
  );
}
