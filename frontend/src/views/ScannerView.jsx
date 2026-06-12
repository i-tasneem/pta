import React, { useMemo, useState } from 'react';
import InstrumentCard from '../components/InstrumentCard';
import { Empty } from '../components/ui';

const SORTS = {
  score:     { label: 'Score',     fn: (a, b) => b.score - a.score },
  liquidity: { label: 'Liquidity', fn: (a, b) => b.liquidityScore - a.liquidityScore },
  volume:    { label: 'Volume',    fn: (a, b) => b.volumeStrength - a.volumeStrength },
  pcr:       { label: 'PCR',       fn: (a, b) => b.pcr - a.pcr }
};

const FILTERS = {
  all:       { label: 'All',            fn: () => true },
  signals:   { label: 'With Signal',    fn: c => !!c.signal },
  high:      { label: 'High Potential', fn: c => c.opportunityState === 'HIGH_POTENTIAL' || c.score >= 70 },
  bullish:   { label: 'Bullish',        fn: c => c.regime === 'BULLISH' || c.direction === 'CE' },
  bearish:   { label: 'Bearish',        fn: c => c.regime === 'BEARISH' || c.direction === 'PE' },
  buildup:   { label: 'OI Build-Up',    fn: c => c.oiPattern === 'FRESH_BUILDUP' }
};

export default function ScannerView({ instruments, onAnalyze }) {
  const [sort, setSort] = useState('score');
  const [filter, setFilter] = useState('all');

  const cards = useMemo(() =>
    instruments.filter(FILTERS[filter].fn).sort(SORTS[sort].fn),
    [instruments, sort, filter]
  );

  return (
    <div>
      {/* Filter + sort controls */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="flex gap-1 overflow-x-auto">
          {Object.entries(FILTERS).map(([key, f]) => (
            <button key={key} onClick={() => setFilter(key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition ${
                filter === key
                  ? 'bg-sky-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}>
              {f.label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1.5 text-xs text-slate-500">
          Sort
          <select value={sort} onChange={e => setSort(e.target.value)}
            className="bg-slate-800 text-slate-300 rounded-lg px-2 py-1.5 text-xs border border-slate-700 outline-none">
            {Object.entries(SORTS).map(([key, s]) =>
              <option key={key} value={key}>{s.label}</option>
            )}
          </select>
        </div>
      </div>

      {cards.length === 0 ? (
        <Empty title="No instruments match this filter"
          hint="Data populates while the market feed is live" />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {cards.map(card => (
            <InstrumentCard key={card.instrument} card={card} onAnalyze={onAnalyze} />
          ))}
        </div>
      )}
    </div>
  );
}
