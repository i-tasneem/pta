import React from 'react';
import { scoreBarColor } from '../lib/format';

export function Badge({ children, cls = 'bg-slate-500/15 text-slate-400 border-slate-500/30' }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[11px] font-medium whitespace-nowrap ${cls}`}>
      {children}
    </span>
  );
}

export function Stat({ label, value, valueCls = 'text-slate-200' }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`text-sm font-semibold truncate ${valueCls}`}>{value}</div>
    </div>
  );
}

export function ScoreBar({ score, label }) {
  const s = Math.max(0, Math.min(100, score || 0));
  return (
    <div>
      {label && (
        <div className="flex justify-between text-[11px] text-slate-400 mb-0.5">
          <span>{label}</span>
          <span className="font-semibold text-slate-300">{s.toFixed(0)}</span>
        </div>
      )}
      <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${scoreBarColor(s)}`} style={{ width: `${s}%` }} />
      </div>
    </div>
  );
}

export function Card({ children, className = '' }) {
  return (
    <div className={`bg-slate-900/70 border border-slate-800 rounded-xl p-4 ${className}`}>
      {children}
    </div>
  );
}

export function SectionTitle({ children, sub }) {
  return (
    <div className="mb-3">
      <h2 className="text-sm font-semibold text-slate-200">{children}</h2>
      {sub && <p className="text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

export function Empty({ title, hint }) {
  return (
    <div className="text-center py-12">
      <div className="text-slate-400 text-sm font-medium">{title}</div>
      {hint && <div className="text-slate-600 text-xs mt-1">{hint}</div>}
    </div>
  );
}
