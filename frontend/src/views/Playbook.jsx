import React, { useState } from 'react';
import { Card, Badge } from '../components/ui';

const STAGES = [
  { stage: 'FORMING', tone: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
    meaning: 'A positioning setup exists (2+ evidence pieces).', action: 'Watch only — nothing to act on yet.' },
  { stage: 'STRENGTHENING', tone: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
    meaning: 'Evidence is building and persisting across snapshots.', action: 'Prepare — note the strike and levels.' },
  { stage: 'READY', tone: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    meaning: 'All primary conditions met; only the trigger is missing.', action: 'Decision point — be ready to act if it triggers.' },
  { stage: 'TRIGGERED', tone: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
    meaning: 'The confirming move happened. This is the actionable signal.', action: 'Act on the plan (strike / entry / SL / target) with your own sizing.' },
  { stage: 'ACTIVE', tone: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    meaning: 'Trade is in play.', action: 'Manage toward target; exit on SL. The engine trails behind structure.' },
  { stage: 'INVALIDATED / EXPIRED', tone: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
    meaning: 'Thesis broke before triggering, or the setup faded out.', action: 'Stand down — no trade.' }
];

const STRATEGIES = [
  {
    name: 'Wall Capitulation Break',
    when: 'Trend / Squeeze',
    detects: 'Price breaks through a major OI wall while that wall’s writers are fleeing (OI falling) and futures volume confirms.',
    means: 'The defending side is capitulating, which fuels continuation in the break direction.',
    act: 'Momentum continuation play in the break direction. SL if price reclaims the broken wall; target the next level.',
    fails: 'Wall OI starts rebuilding while price stalls — a false break.'
  },
  {
    name: 'Wall Absorption Fade',
    when: 'Range / Corridor',
    detects: 'Price hits a wall that is being defended — writers adding OI, heavy volume absorbed, little price progress.',
    means: 'The wall is holding; price likely reverts toward the range center.',
    act: 'Fade back toward the corridor centre / opposite wall.',
    fails: 'The wall breaks — its OI starts dropping and price pushes through.'
  },
  {
    name: 'Writer Migration Continuation',
    when: 'Established Trend',
    detects: 'A pullback in a trend that holds while the support/resistance OI centroid keeps ratcheting in the trend direction (writers re-anchoring).',
    means: 'The trend is healthy; writers are following price. Historically the highest-quality setup.',
    act: 'Join the trend on the pullback, in the trend direction.',
    fails: 'The centroid stops migrating or writer flow flips.'
  },
  {
    name: 'Basis–Flow Divergence Reversal',
    when: 'Range extreme (contrarian)',
    detects: 'Price grinds to a structural extreme against fading futures basis, opposite writer flow, and a PCR extreme.',
    means: 'The move is unsupported by leveraged money — a reversal is likely. Rare and counter-trend.',
    act: 'Counter-trend reversal at the extreme. Treat cautiously — lowest base rate.',
    fails: 'Basis re-confirms or price keeps trending through the level.'
  },
  {
    name: 'Expiry Pin',
    when: 'Expiry afternoon',
    detects: 'On expiry day, price sitting away from max pain after ~1pm.',
    means: 'Price tends to gravitate toward max pain into the close.',
    act: 'Fade moves away from max pain, toward it.',
    fails: 'A pin-break on fresh OI late in the session.'
  }
];

export default function Playbook() {
  const [open, setOpen] = useState(false);

  return (
    <Card className="mb-4">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between text-left">
        <span className="text-sm font-semibold text-slate-200">📖 Playbook — how to read &amp; act on setups</span>
        <span className="text-slate-500 text-xs">{open ? 'Hide' : 'Show'}</span>
      </button>

      {open && (
        <div className="mt-4 space-y-5">
          <div>
            <div className="text-xs font-semibold text-slate-300 mb-2">The lifecycle</div>
            <p className="text-xs text-slate-400 mb-3">
              A <b>setup</b> is a developing hypothesis; a <b>signal</b> is the moment it triggers. The score is how
              strong the evidence is right now — not a cue to act. A setup that never triggers is normal: PTA favours
              quality over quantity, and a quiet day may produce zero signals.
            </p>
            <div className="space-y-2">
              {STAGES.map((s) => (
                <div key={s.stage} className="flex flex-col sm:flex-row sm:items-start gap-1.5 sm:gap-3">
                  <div className="sm:w-44 shrink-0"><Badge cls={s.tone}>{s.stage}</Badge></div>
                  <div className="text-xs text-slate-400">
                    <span className="text-slate-300">{s.meaning}</span> {s.action}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs font-semibold text-slate-300 mb-2">The strategies</div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {STRATEGIES.map((st) => (
                <div key={st.name} className="rounded-lg border border-slate-800 p-3">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-sm font-semibold text-slate-200">{st.name}</span>
                    <Badge cls="bg-slate-500/15 text-slate-400 border-slate-500/30">{st.when}</Badge>
                  </div>
                  <p className="text-xs text-slate-400"><span className="text-slate-500">Detects: </span>{st.detects}</p>
                  <p className="text-xs text-slate-400 mt-1"><span className="text-slate-500">Means: </span>{st.means}</p>
                  <p className="text-xs text-emerald-400/90 mt-1"><span className="text-slate-500">Do: </span>{st.act}</p>
                  <p className="text-xs text-rose-400/90 mt-1"><span className="text-slate-500">Fails when: </span>{st.fails}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="text-[11px] text-slate-500 border-t border-slate-800 pt-3">
            PTA is an intelligence screener, not advice. It surfaces and explains opportunities — you decide, size your
            own position, and place orders in your broker. Premiums shown are indicative from the latest chain snapshot.
            Confidence is currently <b>prior-based</b> and becomes a real historical hit-rate once enough outcomes are
            recorded. Trade only what you can afford to lose.
          </div>
        </div>
      )}
    </Card>
  );
}
