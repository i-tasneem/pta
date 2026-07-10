import React from 'react';

// Instrument-class segmentation: Indices / Stocks / Commodities. Counts show
// how many setups live in each segment so an empty tab is never a surprise.
export const CLASSES = [
  { id: 'ALL', label: 'All' },
  { id: 'INDEX', label: 'Indices' },
  { id: 'STOCK', label: 'Stocks' },
  { id: 'MCX', label: 'Commodities' }
];

export const CLASS_BADGE = {
  INDEX: { label: 'Index', cls: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
  STOCK: { label: 'Stock', cls: 'bg-violet-500/15 text-violet-300 border-violet-500/30' },
  MCX: { label: 'MCX', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' }
};

export default function ClassTabs({ value, onChange, counts = {} }) {
  return (
    <div className="flex gap-1 mb-4 overflow-x-auto">
      {CLASSES.map((c) => {
        const n = c.id === 'ALL'
          ? Object.values(counts).reduce((s, v) => s + v, 0)
          : (counts[c.id] || 0);
        return (
          <button key={c.id} onClick={() => onChange(c.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition whitespace-nowrap ${
              value === c.id ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}>
            {c.label}{n > 0 && <span className="ml-1.5 opacity-70">{n}</span>}
          </button>
        );
      })}
    </div>
  );
}
