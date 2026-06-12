import React, { useState } from 'react';
import { Badge, Stat, ScoreBar, Card } from './ui';
import { fmtOI, fmtPrice, regimeStyle, scoreColor, OI_PATTERN_LABELS } from '../lib/format';

// Every instrument shows: Signal, Confidence, Regime, PCR, Max Pain,
// ATM Strike, OI Build-Up, Volume Activity, Liquidity Score.
export default function InstrumentCard({ card, onAnalyze }) {
  const [expanded, setExpanded] = useState(false);
  const regime = regimeStyle(card.regime);
  const oiPattern = OI_PATTERN_LABELS[card.oiPattern] || OI_PATTERN_LABELS.NEUTRAL;
  const up = card.changePercent >= 0;

  return (
    <Card className="hover:border-slate-700 transition">
      {/* Header: name, price, regime */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-bold text-slate-100">{card.instrument}</span>
            {card.signal && (
              <Badge cls={card.signal.direction === 'CE'
                ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                : 'bg-rose-500/20 text-rose-300 border-rose-500/40'}>
                {card.signal.type} · {card.signal.status}
              </Badge>
            )}
          </div>
          <div className="flex items-baseline gap-2 mt-0.5">
            <span className="text-lg font-semibold text-slate-200">{fmtPrice(card.ltp)}</span>
            <span className={`text-xs font-medium ${up ? 'text-emerald-400' : 'text-rose-400'}`}>
              {up ? '+' : ''}{(card.changePercent || 0).toFixed(2)}%
            </span>
          </div>
        </div>

        <div className="text-right">
          <div className={`text-2xl font-bold ${scoreColor(card.score)}`}>
            {card.score > 0 ? card.score.toFixed(0) : '--'}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500">Score</div>
        </div>
      </div>

      {/* Regime + opportunity state */}
      <div className="flex flex-wrap items-center gap-1.5 mt-2">
        <Badge cls={regime.cls}>{regime.label}</Badge>
        {card.regimeConfidence > 0 && (
          <span className="text-[11px] text-slate-500">{(card.regimeConfidence * 100).toFixed(0)}% conf</span>
        )}
        {card.opportunityState === 'HIGH_POTENTIAL' && (
          <Badge cls="bg-amber-500/20 text-amber-300 border-amber-500/40">⚡ High Potential</Badge>
        )}
        {card.direction && (
          <Badge cls={card.direction === 'CE'
            ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
            : 'bg-rose-500/15 text-rose-400 border-rose-500/30'}>
            {card.direction === 'CE' ? '▲ Call Bias' : '▼ Put Bias'}
          </Badge>
        )}
      </div>

      {/* Core metrics grid */}
      <div className="grid grid-cols-3 gap-x-3 gap-y-2 mt-3 pt-3 border-t border-slate-800">
        <Stat label="PCR" value={card.pcr ? card.pcr.toFixed(2) : '--'}
          valueCls={card.pcr > 1 ? 'text-emerald-400' : card.pcr > 0 ? 'text-rose-400' : 'text-slate-500'} />
        <Stat label="Max Pain" value={card.maxPain ? fmtPrice(card.maxPain) : '--'} />
        <Stat label="ATM" value={card.atmStrike ? fmtPrice(card.atmStrike) : '--'} />
        <Stat label="OI Build-Up" value={oiPattern.label} valueCls={oiPattern.cls} />
        <Stat label="PCR Trend" value={card.pcrTrend}
          valueCls={card.pcrTrend === 'RISING' ? 'text-emerald-400' : card.pcrTrend === 'FALLING' ? 'text-rose-400' : 'text-slate-400'} />
        <Stat label="OI Velocity" value={fmtOI(card.oiVelocity) + '/m'} />
      </div>

      {/* Volume + Liquidity bars */}
      <div className="grid grid-cols-2 gap-3 mt-3">
        <ScoreBar score={card.volumeStrength} label="Volume Activity" />
        <ScoreBar score={card.liquidityScore} label="Liquidity" />
      </div>

      {/* Signal confidence + reason */}
      {card.signal && (
        <div className="mt-3 p-2 rounded-lg bg-slate-800/60 text-xs">
          <span className="text-slate-400">Signal confidence </span>
          <span className="font-semibold text-slate-200">{card.signal.confidence}%</span>
          {card.signal.reason && <span className="text-slate-400"> — {card.signal.reason}</span>}
        </div>
      )}

      {/* Expandable: component scores + walls */}
      {expanded && (
        <div className="mt-3 pt-3 border-t border-slate-800 space-y-3">
          {card.componentScores && (
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <ScoreBar score={card.componentScores.trend} label="Trend" />
              <ScoreBar score={card.componentScores.momentum} label="Momentum" />
              <ScoreBar score={card.componentScores.oi} label="OI Strength" />
              <ScoreBar score={card.componentScores.breakout} label="Breakout Prob" />
              <ScoreBar score={card.componentScores.reversal} label="Reversal Prob" />
              <ScoreBar score={card.componentScores.riskReward} label="Risk : Reward" />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Support Walls (PE OI)</div>
              {(card.supportWalls || []).slice(0, 3).map(w => (
                <div key={w.strike} className="flex justify-between text-emerald-400/90">
                  <span>{fmtPrice(w.strike)}</span>
                  <span className="text-slate-500">{fmtOI(w.oi)}</span>
                </div>
              ))}
              {(!card.supportWalls || card.supportWalls.length === 0) && <span className="text-slate-600">--</span>}
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Resistance Walls (CE OI)</div>
              {(card.resistanceWalls || []).slice(0, 3).map(w => (
                <div key={w.strike} className="flex justify-between text-rose-400/90">
                  <span>{fmtPrice(w.strike)}</span>
                  <span className="text-slate-500">{fmtOI(w.oi)}</span>
                </div>
              ))}
              {(!card.resistanceWalls || card.resistanceWalls.length === 0) && <span className="text-slate-600">--</span>}
            </div>
          </div>

          {card.regimeReason && (
            <div className="text-xs text-slate-500">
              <span className="text-slate-400 font-medium">Regime: </span>{card.regimeReason}
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 mt-3">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex-1 py-1.5 text-xs font-medium rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 transition">
          {expanded ? 'Less' : 'Details'}
        </button>
        <button
          onClick={() => onAnalyze(card.instrument)}
          className="flex-1 py-1.5 text-xs font-medium rounded-lg bg-sky-600/20 text-sky-300 border border-sky-600/30 hover:bg-sky-600/30 transition">
          Analyze
        </button>
      </div>
    </Card>
  );
}
