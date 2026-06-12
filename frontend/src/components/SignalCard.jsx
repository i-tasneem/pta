import React, { useState } from 'react';
import { Badge, Card } from './ui';

const STATUS_STYLES = {
  TRIGGERED: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  WATCH:     'bg-amber-500/15 text-amber-400 border-amber-500/30',
  HOLD:      'bg-sky-500/15 text-sky-400 border-sky-500/30',
  EXIT:      'bg-slate-500/15 text-slate-400 border-slate-500/30',
  ABORTED:   'bg-rose-500/15 text-rose-400 border-rose-500/30'
};

function GateRow({ name, result }) {
  if (!result || typeof result !== 'object') return null;
  const passed = result.passed === true || result.passed === 'true';
  return (
    <div className="flex items-start gap-2 text-xs py-1">
      <span className={passed ? 'text-emerald-400' : 'text-rose-400'}>{passed ? '✓' : '✗'}</span>
      <div>
        <span className="text-slate-300 font-medium">{name}</span>
        {result.reason && <span className="text-slate-500"> — {result.reason}</span>}
      </div>
    </div>
  );
}

const GATE_LABELS = {
  gate1: 'Regime Validation',
  gate2: 'Trend Alignment',
  gate3: 'Momentum Validation',
  gate4: 'Option Chain (OI)',
  gate5: 'Entry Trigger',
  gate6: 'Ranking Quality'
};

// Signal card with full WHY transparency: reason + gate breakdown + analyses.
export default function SignalCard({ signal }) {
  const [showWhy, setShowWhy] = useState(false);
  const isCE = signal.direction === 'CE';
  const details = signal.details || {};
  const gates = details.gateResults || {};
  const hasGates = Object.keys(gates).length > 0;

  const analyses = [
    ['Trend', details.trendAnalysis],
    ['OI', details.oiAnalysis],
    ['Volume', details.volumeAnalysis],
    ['Regime', details.regimeAnalysis],
    ['Liquidity', details.liquidityAnalysis]
  ].filter(([, a]) => a && Object.keys(a).length > 0);

  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-slate-100">{signal.instrument}</span>
            <Badge cls={isCE
              ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
              : 'bg-rose-500/20 text-rose-300 border-rose-500/40'}>
              {isCE ? '▲ CALL' : '▼ PUT'} · {signal.type}
            </Badge>
            <Badge cls={STATUS_STYLES[signal.status] || STATUS_STYLES.EXIT}>{signal.status}</Badge>
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {signal.triggeredAt && <span>Triggered {signal.triggeredAt} · </span>}
            Confidence <span className="text-slate-300 font-semibold">{signal.confidence}</span>
          </div>
        </div>
      </div>

      {/* Why (headline reason) */}
      <div className="mt-2 p-2 rounded-lg bg-slate-800/60 text-sm text-slate-300">
        <span className="text-slate-500 text-xs uppercase tracking-wider mr-2">Why</span>
        {signal.reason}
      </div>

      {/* Zones */}
      <div className="grid grid-cols-3 gap-2 mt-3 text-center">
        <div className="rounded-lg bg-slate-800/40 py-2">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">Entry</div>
          <div className="text-xs font-semibold text-sky-300">{signal.entry}</div>
        </div>
        <div className="rounded-lg bg-slate-800/40 py-2">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">Stop</div>
          <div className="text-xs font-semibold text-rose-300">{signal.stop}</div>
        </div>
        <div className="rounded-lg bg-slate-800/40 py-2">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">Target</div>
          <div className="text-xs font-semibold text-emerald-300">{signal.target}</div>
        </div>
      </div>

      {/* Full WHY breakdown */}
      {(hasGates || analyses.length > 0) && (
        <>
          <button
            onClick={() => setShowWhy(!showWhy)}
            className="w-full mt-3 py-1.5 text-xs font-medium rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 transition">
            {showWhy ? 'Hide breakdown' : 'Why was this generated?'}
          </button>

          {showWhy && (
            <div className="mt-3 space-y-3">
              {hasGates && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Validation Gates</div>
                  {Object.entries(GATE_LABELS).map(([key, label]) =>
                    <GateRow key={key} name={label} result={gates[key]} />
                  )}
                </div>
              )}

              {analyses.map(([name, analysis]) => (
                <div key={name}>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">{name} Analysis</div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
                    {Object.entries(analysis).map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-2">
                        <span className="text-slate-500">{k}</span>
                        <span className="text-slate-300 truncate">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  );
}
