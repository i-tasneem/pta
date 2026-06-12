import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, Empty, Stat, Badge, SectionTitle } from '../components/ui';
import { fmtPrice } from '../lib/format';

// Signal history + performance analytics from the archive.
export default function HistoryView() {
  const [history, setHistory] = useState([]);
  const [perf, setPerf] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.signalHistory(null, 100), api.performance()])
      .then(([h, p]) => { setHistory(h.signals || []); setPerf(p); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-4">
      {/* Performance summary */}
      <Card>
        <SectionTitle sub="Outcomes of archived signals">Performance</SectionTitle>
        {perf && perf.total > 0 ? (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Stat label="Signals" value={perf.total} />
            <Stat label="Win Rate" value={`${perf.winRate.toFixed(1)}%`}
              valueCls={perf.winRate >= 50 ? 'text-emerald-400' : 'text-rose-400'} />
            <Stat label="Wins / Losses" value={`${perf.wins} / ${perf.losses}`} />
            <Stat label="Avg P&L" value={`₹ ${perf.avgPnl.toFixed(2)}`}
              valueCls={perf.avgPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'} />
            <Stat label="Avg Hold" value={`${(perf.avgDurationMs / 60000).toFixed(1)} min`} />
          </div>
        ) : (
          <Empty title="No completed signal outcomes yet"
            hint="Performance stats build up as signals complete their lifecycle" />
        )}
      </Card>

      {/* Signal history table */}
      <Card className="p-0 overflow-x-auto">
        <div className="p-4 pb-0">
          <SectionTitle sub="Most recent archived signals with their generation context">
            Signal History
          </SectionTitle>
        </div>
        {loading ? (
          <Empty title="Loading…" />
        ) : history.length === 0 ? (
          <Empty title="No archived signals yet"
            hint="Every generated signal is archived here for review" />
        ) : (
          <table className="w-full text-xs min-w-[640px]">
            <thead>
              <tr className="text-slate-500 uppercase tracking-wider text-[10px] border-b border-slate-800">
                <th className="py-2 px-3 text-left font-medium">Time</th>
                <th className="py-2 px-3 text-left font-medium">Instrument</th>
                <th className="py-2 px-3 text-left font-medium">Type</th>
                <th className="py-2 px-3 text-left font-medium">Dir</th>
                <th className="py-2 px-3 text-right font-medium">Confidence</th>
                <th className="py-2 px-3 text-left font-medium">Outcome</th>
                <th className="py-2 px-3 text-left font-medium">Why</th>
              </tr>
            </thead>
            <tbody>
              {history.map(s => (
                <tr key={s.id} className="border-b border-slate-800/50">
                  <td className="py-2 px-3 text-slate-500 whitespace-nowrap">
                    {s.triggered_at ? new Date(s.triggered_at).toLocaleString('en-IN', {
                      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false
                    }) : '--'}
                  </td>
                  <td className="py-2 px-3 font-semibold text-slate-200">{s.instrument}</td>
                  <td className="py-2 px-3 text-slate-400">{s.type}</td>
                  <td className="py-2 px-3">
                    <Badge cls={s.direction === 'CE'
                      ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                      : 'bg-rose-500/15 text-rose-400 border-rose-500/30'}>
                      {s.direction}
                    </Badge>
                  </td>
                  <td className="py-2 px-3 text-right text-slate-300">{s.confidence ? `${s.confidence}%` : '--'}</td>
                  <td className="py-2 px-3">
                    {s.outcome ? (
                      <Badge cls={s.outcome === 'WIN' || s.outcome === 'TARGET'
                        ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                        : 'bg-rose-500/15 text-rose-400 border-rose-500/30'}>
                        {s.outcome}
                      </Badge>
                    ) : <span className="text-slate-600">--</span>}
                  </td>
                  <td className="py-2 px-3 text-slate-500 max-w-[200px] truncate">{s.reason || '--'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
