// Shared formatters for the screener UI

export function fmtOI(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e7) return `${(v / 1e7).toFixed(2)} Cr`;
  if (Math.abs(v) >= 1e5) return `${(v / 1e5).toFixed(2)} L`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)} K`;
  return v.toFixed(0);
}

export function fmtPrice(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

export function fmtTime(ts) {
  if (!ts) return '--';
  return new Date(Number(ts)).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: false
  });
}

export const REGIME_STYLES = {
  BULLISH:        { label: 'Bullish',        cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
  BEARISH:        { label: 'Bearish',        cls: 'bg-rose-500/15 text-rose-400 border-rose-500/30' },
  BREAKOUT_SETUP: { label: 'Breakout Setup', cls: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
  REVERSAL_SETUP: { label: 'Reversal Setup', cls: 'bg-violet-500/15 text-violet-400 border-violet-500/30' },
  RANGE_BOUND:    { label: 'Range Bound',    cls: 'bg-sky-500/15 text-sky-400 border-sky-500/30' },
  CONSOLIDATING:  { label: 'Consolidating',  cls: 'bg-slate-500/15 text-slate-400 border-slate-500/30' },
  HIGH_VOLATILITY:{ label: 'High Volatility',cls: 'bg-orange-500/15 text-orange-400 border-orange-500/30' },
  LOW_VOLATILITY: { label: 'Low Volatility', cls: 'bg-slate-500/15 text-slate-400 border-slate-500/30' },
  UNKNOWN:        { label: 'Awaiting Data',  cls: 'bg-slate-500/15 text-slate-500 border-slate-500/30' }
};

export function regimeStyle(regime) {
  return REGIME_STYLES[regime] || REGIME_STYLES.UNKNOWN;
}

export function scoreColor(score) {
  if (score >= 85) return 'text-emerald-400';
  if (score >= 70) return 'text-lime-400';
  if (score >= 50) return 'text-amber-400';
  return 'text-slate-500';
}

export function scoreBarColor(score) {
  if (score >= 85) return 'bg-emerald-500';
  if (score >= 70) return 'bg-lime-500';
  if (score >= 50) return 'bg-amber-500';
  return 'bg-slate-600';
}

export const OI_PATTERN_LABELS = {
  FRESH_BUILDUP: { label: 'Fresh Build-Up', cls: 'text-emerald-400' },
  UNWINDING:     { label: 'Unwinding',      cls: 'text-rose-400' },
  NEUTRAL:       { label: 'Neutral',        cls: 'text-slate-400' }
};
