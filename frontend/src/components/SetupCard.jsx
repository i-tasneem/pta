import React from 'react';
import { Card, Badge } from './ui';
import { fmtPrice } from '../lib/format';

export const ARCHETYPE_LABELS = {
  WALL_CAPITULATION_BREAK: 'Wall Capitulation Break',
  WALL_ABSORPTION_FADE: 'Wall Absorption Fade',
  WRITER_MIGRATION_CONTINUATION: 'Writer Migration Continuation',
  BASIS_FLOW_DIVERGENCE_REVERSAL: 'Basis–Flow Divergence Reversal',
  EXPIRY_PIN: 'Expiry Pin'
};

const STAGES = ['FORMING', 'STRENGTHENING', 'READY', 'TRIGGERED', 'ACTIVE'];

// Compact source label for an exit level: keep it short when many levels agree.
function fmtSource(side) {
  if (!side) return '';
  if (side.fallback) return 'OI wall';
  const m = side.members || [];
  if (m.length <= 2) return m.join(' + ');
  return `${m[0]} +${m.length - 1} more`;
}

function StageRail({ stage }) {
  const idx = STAGES.indexOf(stage);
  return (
    <div className="flex items-center gap-1 mt-2">
      {STAGES.map((s, i) => {
        const done = idx >= 0 && i <= idx;
        const current = i === idx;
        return (
          <div key={s} className={`flex-1 h-1.5 rounded-full ${done ? (current ? 'bg-sky-400' : 'bg-sky-600/60') : 'bg-slate-800'}`} />
        );
      })}
    </div>
  );
}

export default function SetupCard({ s }) {
  const isCE = s.direction === 'CE';
  const triggered = s.stage === 'TRIGGERED' || s.stage === 'ACTIVE';
  return (
    <Card className={triggered ? 'border-emerald-500/40' : ''}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-slate-100">{s.instrument}</span>
            <Badge cls={isCE
              ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
              : 'bg-rose-500/20 text-rose-300 border-rose-500/40'}>
              {isCE ? '▲ CALL' : '▼ PUT'}
            </Badge>
            <Badge cls="bg-slate-500/15 text-slate-300 border-slate-500/30">{s.stage}</Badge>
          </div>
          <div className="text-xs text-slate-400 mt-1">{ARCHETYPE_LABELS[s.archetype] || s.archetype}</div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold text-sky-300">{Math.round(s.score)}</div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500">Score</div>
        </div>
      </div>

      <StageRail stage={s.stage} />

      <div className="mt-2 text-sm text-slate-300">{s.thesis}</div>

      {s.confidence && (
        <div className="mt-2 text-xs text-slate-400">
          Confidence <span className="font-semibold text-slate-200">{s.confidence.value}%</span>
          <span className="text-slate-600"> ({s.confidence.basis}{s.confidence.samples ? `, ${s.confidence.samples} samples` : ''})</span>
        </div>
      )}

      {s.plan && (
        <div className="grid grid-cols-4 gap-2 mt-3 text-center">
          <div className="rounded-lg bg-slate-800/50 py-1.5">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">Strike · {s.plan.moneyness}</div>
            <div className="text-xs font-semibold text-slate-200">{fmtPrice(s.plan.strike)}{isCE ? ' CE' : ' PE'}</div>
          </div>
          <div className="rounded-lg bg-slate-800/50 py-1.5">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">LTP ₹</div>
            <div className="text-xs font-semibold text-sky-300">{fmtPrice(s.plan.currentPremium ?? s.plan.entryPremium)}</div>
          </div>
          <div className="rounded-lg bg-slate-800/50 py-1.5">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">SL ₹</div>
            <div className="text-xs font-semibold text-rose-300">{fmtPrice(s.plan.stopPremium)}</div>
          </div>
          <div className="rounded-lg bg-slate-800/50 py-1.5">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">Tgt ₹</div>
            <div className="text-xs font-semibold text-emerald-300">{fmtPrice(s.plan.targetPremium)}</div>
          </div>
        </div>
      )}
      {s.plan && (
        <div className="text-[11px] text-slate-500 mt-1">
          Entry ₹{fmtPrice(s.plan.entryPremium)} · R:R {s.plan.rr} · risk {s.plan.riskInPremiumATR} premium-ATR · pinned strike
          {s.plan.valid === false && <span className="text-amber-400"> · below threshold</span>}
        </div>
      )}
      {s.exitLevels && (
        <div className="mt-1.5 grid grid-cols-2 gap-2 text-[11px]">
          <div className="text-slate-500">
            <span className="text-rose-300 font-medium">SL</span> @ {fmtPrice(s.exitLevels.stop.underlying)}
            <span className="text-slate-600"> · {fmtSource(s.exitLevels.stop)}</span>
          </div>
          <div className="text-slate-500">
            <span className="text-emerald-300 font-medium">Tgt</span> @ {fmtPrice(s.exitLevels.target.underlying)}
            <span className="text-slate-600"> · {fmtSource(s.exitLevels.target)}</span>
          </div>
        </div>
      )}

      {s.ladder && s.ladder.length > 0 && (
        <div className="mt-2">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Strike ladder ({isCE ? 'CE' : 'PE'})</div>
          <div className="flex gap-1 overflow-x-auto">
            {s.ladder.map((k) => {
              const pinned = s.plan && k.strike === s.plan.strike;
              return (
                <div key={k.strike}
                  className={`flex-1 min-w-[56px] rounded-md px-1.5 py-1 text-center text-[10px] border ${
                    pinned ? 'border-sky-500/60 bg-sky-500/10' : 'border-slate-800 bg-slate-800/40'}`}>
                  <div className="text-slate-500">{k.label}{pinned ? ' ●' : ''}</div>
                  <div className="text-slate-300 font-medium">{fmtPrice(k.strike)}</div>
                  <div className="text-slate-400">₹{fmtPrice(k.premium)}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {s.reasons && s.reasons.length > 0 && (
        <div className="mt-3 pt-3 border-t border-slate-800">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Why</div>
          <ul className="text-xs text-slate-400 space-y-0.5">
            {s.reasons.slice(0, 6).map((r, i) => <li key={i}>• {r}</li>)}
          </ul>
        </div>
      )}
    </Card>
  );
}
