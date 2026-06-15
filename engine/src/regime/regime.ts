// Layer 2 — regime is derived from positioning structure (not EMA/ATR) and
// acts as an archetype SELECTOR: it decides which setups may exist, never a
// score multiplier. Stateful: tracks IV and corridor-width baselines plus
// centroid migration to read trend health.
import { RollingWindow } from '../math/rolling';
import {
  ChainSnapshot,
  PositioningAnalytics,
  Regime,
  RegimeResult,
  ArchetypeName
} from '../types';
import { corridor, atmIV, basis } from '../structure/structure';
import { sessionPhase, istDate } from '../structure/session';

export interface RegimeOptions {
  windowCapacity?: number;
  ivSpikeZ?: number;       // z above which IV = event/chaos
  ivJumpRatio?: number;    // relative-jump fallback (flat-baseline robust)
  trendNWF?: number;       // |net writer flow| for a one-sided trend
}

const ALLOW: Record<Regime, ArchetypeName[]> = {
  TREND_BULL: ['WRITER_MIGRATION_CONTINUATION', 'WALL_CAPITULATION_BREAK'],
  TREND_BEAR: ['WRITER_MIGRATION_CONTINUATION', 'WALL_CAPITULATION_BREAK'],
  CORRIDOR: ['WALL_ABSORPTION_FADE', 'BASIS_FLOW_DIVERGENCE_REVERSAL'],
  SQUEEZE_WATCH: ['WALL_CAPITULATION_BREAK'],
  EXPIRY_GRAVITY: ['EXPIRY_PIN'],
  EVENT_CHAOS: [], // stand down
  UNCLEAR: []
};

export class RegimeClassifier {
  private ivWin: RollingWindow;
  private widthWin: RollingWindow;
  private lastPeCentroid = 0;
  private lastCeCentroid = 0;
  private ivSpikeZ: number;
  private ivJumpRatio: number;
  private trendNWF: number;

  constructor(opts: RegimeOptions = {}) {
    const cap = opts.windowCapacity ?? 60;
    this.ivWin = new RollingWindow(cap);
    this.widthWin = new RollingWindow(cap);
    this.ivSpikeZ = opts.ivSpikeZ ?? 2.5;
    this.ivJumpRatio = opts.ivJumpRatio ?? 1.4;
    this.trendNWF = opts.trendNWF ?? 1.0;
  }

  classify(a: PositioningAnalytics, snap: ChainSnapshot): RegimeResult {
    const corr = corridor(a, snap.spot);
    const iv = atmIV(snap);
    const b = basis(snap);
    const phase = sessionPhase(snap.ts);
    const expiry = !!snap.expiry && istDate(snap.ts) === snap.expiry;

    // Spike via z-score OR relative jump (robust to a flat baseline where
    // variance is ~0 and z is undefined)
    const ivZ = this.ivWin.zscore(iv);
    const ivMean = this.ivWin.mean();
    const ivSpike =
      a.ready &&
      this.ivWin.size >= 5 &&
      (ivZ > this.ivSpikeZ || (ivMean > 0 && iv > ivMean * this.ivJumpRatio));
    this.ivWin.push(iv);
    if (corr.width != null) this.widthWin.push(corr.width);

    const peRatcheting = a.peCentroid > this.lastPeCentroid && this.lastPeCentroid > 0;
    const ceRatcheting = a.ceCentroid < this.lastCeCentroid && this.lastCeCentroid > 0;
    this.lastPeCentroid = a.peCentroid;
    this.lastCeCentroid = a.ceCentroid;

    const regime = this.decide(a, { ivSpike, expiry, phase, corr, peRatcheting, ceRatcheting });

    return {
      regime,
      allowed: ALLOW[regime],
      reason: this.reasonFor(regime, a, ivZ),
      corridor: corr,
      sessionPhase: phase,
      atmIV: iv,
      isExpiryDay: expiry,
      basis: b
    };
  }

  private decide(
    a: PositioningAnalytics,
    ctx: {
      ivSpike: boolean;
      expiry: boolean;
      phase: string;
      corr: { width: number | null };
      peRatcheting: boolean;
      ceRatcheting: boolean;
    }
  ): Regime {
    // Precedence matters: chaos and expiry override everything.
    if (ctx.ivSpike) return 'EVENT_CHAOS';
    if (ctx.expiry && (ctx.phase === 'AFTERNOON' || ctx.phase === 'CLOSE')) return 'EXPIRY_GRAVITY';

    if (!a.ready) return 'UNCLEAR';

    // Sustained one-sided writer flow with the supporting wall ratcheting.
    if (a.netWriterFlow >= this.trendNWF && a.priceDelta > 0 && ctx.peRatcheting) return 'TREND_BULL';
    if (a.netWriterFlow <= -this.trendNWF && a.priceDelta < 0 && ctx.ceRatcheting) return 'TREND_BEAR';

    // Both sides writing into a tightening range = coiling for a break.
    const narrowing = this.widthWin.size >= 5 && (a.flowState === 'CORRIDOR');
    if (narrowing && this.widthWin.zscore(ctx.corr.width ?? 0) < -0.5) return 'SQUEEZE_WATCH';

    if (a.flowState === 'CORRIDOR') return 'CORRIDOR';

    return 'UNCLEAR';
  }

  private reasonFor(regime: Regime, a: PositioningAnalytics, ivZ: number): string {
    switch (regime) {
      case 'EVENT_CHAOS': return `IV spiking (z=${ivZ.toFixed(1)}) — stand down`;
      case 'EXPIRY_GRAVITY': return 'Expiry afternoon — max-pain gravity';
      case 'TREND_BULL': return `One-sided put writing (NWF=${a.netWriterFlow.toFixed(1)}), support ratcheting up`;
      case 'TREND_BEAR': return `One-sided call writing (NWF=${a.netWriterFlow.toFixed(1)}), resistance ratcheting down`;
      case 'SQUEEZE_WATCH': return 'Both sides writing into a tightening corridor';
      case 'CORRIDOR': return 'Two-sided writing — range-bound';
      default: return 'No clear positioning structure';
    }
  }
}
