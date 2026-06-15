import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, Badge, Empty, ScoreBar } from '../components/ui';
import { fmtPrice } from '../lib/format';
import Playbook from './Playbook';

const ARCHETYPE_LABELS = {
  WALL_CAPITULATION_BREAK: 'Wall Capitulation Break',
  WALL_ABSORPTION_FADE: 'Wall Absorption Fade',
  WRITER_MIGRATION_CONTINUATION: 'Writer Migration Continuation',
  BASIS_FLOW_DIVERGENCE_REVERSAL: 'Basis–Flow Divergence Reversal',
  EXPIRY_PIN: 'Expiry Pin'
};

const STAGES = ['FORMING', 'STRENGTHENING', 'READY', 'TRIGGERED', 'ACTIVE'];

function StageRail({ stage }) {
  const idx = STAGES.indexOf(stage);
  return (
    <div className="flex items-center gap-1 mt-2">
      {STAGES.map((s, i) => {
        const done = idx >= 0 && i <= idx;
        const current = i === idx;
        return (
          <React.Fragment key={s}>
            <div className={`flex-1 h-1.5 rounded-full ${done ? (current ? 'bg-sky-400' : 'bg-sky-600/60') : 'bg-slate-800'}`} />
          </React.Fragment>
        );
      })}
    </div>
  );
}

export default function SetupsView() {
  const [setups, setSetups] = useState([]);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = () => api.v2Setups()
      .then((d) => { if (!cancelled) { setEnabled(d.enabled !== false); setSetups(d.setups || []); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    load();
    const interval = setInterval(load, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  let body;
  if (!enabled) {
    body = <Empty title="V2 engine not enabled" hint="Engine build or Postgres unavailable on the server" />;
  } else if (loading && setups.length === 0) {
    body = <Empty title="Loading setups…" />;
  } else if (setups.length === 0) {
    body = <Empty title="No setups forming"
      hint="Positioning setups appear here as they build — a quiet tape is normal" />;
  } else {
    body = (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {setups.map((s) => {
        const isCE = s.direction === 'CE';
        const triggered = s.stage === 'TRIGGERED' || s.stage === 'ACTIVE';
        return (
          <Card key={s.id} className={triggered ? 'border-emerald-500/40' : ''}>
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
                  <div className="text-[10px] uppercase tracking-wider text-slate-500">Strike</div>
                  <div className="text-xs font-semibold text-slate-200">{fmtPrice(s.plan.strike)}{isCE ? ' CE' : ' PE'}</div>
                </div>
                <div className="rounded-lg bg-slate-800/50 py-1.5">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500">Entry ₹</div>
                  <div className="text-xs font-semibold text-sky-300">{fmtPrice(s.plan.entryPremium)}</div>
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
                R:R {s.plan.rr} · risk {s.plan.riskInPremiumATR} premium-ATR
                {s.plan.valid === false && <span className="text-amber-400"> · below threshold</span>}
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
      })}
      </div>
    );
  }

  return (
    <div>
      <Playbook />
      {body}
    </div>
  );
}
