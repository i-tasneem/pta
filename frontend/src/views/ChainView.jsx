import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, Empty, Stat, Badge } from '../components/ui';
import { fmtOI, fmtPrice, fmtTime } from '../lib/format';

// Smart option chain: OI-weighted view around ATM with liquidity cues.
export default function ChainView({ instruments, selected, onSelect }) {
  const [chain, setChain] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setLoading(true);
    const load = () => api.chain(selected)
      .then(d => { if (!cancelled) { setChain(d); setLoading(false); } })
      .catch(() => { if (!cancelled) { setChain(null); setLoading(false); } });
    load();
    const interval = setInterval(load, 10000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [selected]);

  const hasData = chain && chain.strikes.length > 0;

  return (
    <div>
      <div className="flex gap-1 mb-4 overflow-x-auto pb-1">
        {instruments.map(i => (
          <button key={i.instrument} onClick={() => onSelect(i.instrument)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition ${
              selected === i.instrument
                ? 'bg-sky-600 text-white'
                : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}>
            {i.instrument}
          </button>
        ))}
      </div>

      {!hasData ? (
        <Empty title={loading ? 'Loading chain…' : 'No option chain data'}
          hint="Populates while the OI feed is live" />
      ) : (
        <>
          {/* Chain summary */}
          <Card className="mb-4">
            <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
              <Stat label="Spot" value={fmtPrice(chain.spotLtp)} />
              <Stat label="ATM" value={fmtPrice(chain.atmStrike)} valueCls="text-sky-300" />
              <Stat label="Max Pain" value={chain.maxPain ? fmtPrice(chain.maxPain) : '--'} valueCls="text-amber-300" />
              <Stat label="PCR" value={chain.pcr.toFixed(3)}
                valueCls={chain.pcr > 1 ? 'text-emerald-400' : 'text-rose-400'} />
              <Stat label="Total CE OI" value={fmtOI(chain.totalCeOi)} valueCls="text-rose-300" />
              <Stat label="Total PE OI" value={fmtOI(chain.totalPeOi)} valueCls="text-emerald-300" />
            </div>
            <div className="flex gap-2 mt-2 text-[11px] text-slate-500">
              {chain.expiry && <span>Expiry {chain.expiry}</span>}
              {chain.timestamp > 0 && <span>· Updated {fmtTime(chain.timestamp)}</span>}
            </div>
          </Card>

          <ChainTable chain={chain} />
        </>
      )}
    </div>
  );
}

function ChainTable({ chain }) {
  const atmIdx = chain.strikes.findIndex(s => s.strike >= chain.atmStrike);
  const start = Math.max(0, atmIdx - 10);
  const window = chain.strikes.slice(start, start + 21);
  const maxOi = Math.max(...window.map(s => Math.max(s.ce?.oi || 0, s.pe?.oi || 0)), 1);

  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full text-xs min-w-[560px]">
        <thead>
          <tr className="text-slate-500 uppercase tracking-wider text-[10px] border-b border-slate-800">
            <th className="py-2 px-2 text-right font-medium">CE OI</th>
            <th className="py-2 px-2 text-right font-medium">CE LTP</th>
            <th className="py-2 px-2 text-right font-medium">CE Vol</th>
            <th className="py-2 px-3 text-center font-medium">Strike</th>
            <th className="py-2 px-2 text-left font-medium">PE Vol</th>
            <th className="py-2 px-2 text-left font-medium">PE LTP</th>
            <th className="py-2 px-2 text-left font-medium">PE OI</th>
          </tr>
        </thead>
        <tbody>
          {window.map(s => {
            const isATM = s.strike === chain.atmStrike;
            const isMaxPain = s.strike === chain.maxPain;
            const itm = s.strike < chain.spotLtp;
            return (
              <tr key={s.strike}
                className={`border-b border-slate-800/50 ${isATM ? 'bg-sky-500/10' : ''}`}>
                <td className={`py-1.5 px-2 text-right relative ${itm ? 'bg-rose-500/5' : ''}`}>
                  <div className="absolute inset-y-1 right-0 bg-rose-500/20 rounded-l"
                    style={{ width: `${((s.ce?.oi || 0) / maxOi) * 100}%` }} />
                  <span className="relative text-rose-300">{fmtOI(s.ce?.oi)}</span>
                </td>
                <td className="py-1.5 px-2 text-right text-slate-300">{s.ce?.ltp ? fmtPrice(s.ce.ltp) : '--'}</td>
                <td className="py-1.5 px-2 text-right text-slate-500">{fmtOI(s.ce?.volume)}</td>
                <td className={`py-1.5 px-3 text-center font-semibold ${
                  isATM ? 'text-sky-300' : isMaxPain ? 'text-amber-300' : 'text-slate-200'}`}>
                  {fmtPrice(s.strike)}
                  {isATM && <Badge cls="ml-1 bg-sky-500/20 text-sky-300 border-sky-500/40">ATM</Badge>}
                  {isMaxPain && <span className="ml-1 text-amber-300">◆</span>}
                </td>
                <td className="py-1.5 px-2 text-left text-slate-500">{fmtOI(s.pe?.volume)}</td>
                <td className="py-1.5 px-2 text-left text-slate-300">{s.pe?.ltp ? fmtPrice(s.pe.ltp) : '--'}</td>
                <td className={`py-1.5 px-2 text-left relative ${!itm ? 'bg-emerald-500/5' : ''}`}>
                  <div className="absolute inset-y-1 left-0 bg-emerald-500/20 rounded-r"
                    style={{ width: `${((s.pe?.oi || 0) / maxOi) * 100}%` }} />
                  <span className="relative text-emerald-300">{fmtOI(s.pe?.oi)}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
