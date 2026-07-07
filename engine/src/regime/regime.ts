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
  ivStdFloorPct?: number;  // min IV std as fraction of mean IV (variance floor)
  spikePersistence?: number;   // consecutive spike snapshots before EVENT_CHAOS
  regimePersistence?: number;  // consecutive snapshots before a regime switch
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

// Defensive one-sided writing against the price move IS corridor behavior:
// CAPPED_FADE (rally sold into call writing) and PUT_KNIFE (dip bought into
// put writing) are the range-defending states the fade/reversal archetypes
// hunt. Previously CORRIDOR regime required flowState === 'CORRIDOR', which
// made BASIS_FLOW_DIVERGENCE_REVERSAL (needing CAPPED_FADE/PUT_KNIFE)
// logically impossible — zero detections in 12 prod sessions.
const CORRIDOR_STATES = ['CORRIDOR', 'CAPPED_FADE', 'PUT_KNIFE'];

export class RegimeClassifier {
  private ivWin: RollingWindow;
  private widthWin: RollingWindow;
  private lastPeCentroid = 0;
  private lastCeCentroid = 0;
  private ivSpikeZ: number;
  private ivJumpRatio: number;
  private trendNWF: number;
  private ivStdFloorPct: number;
  private spikePersistence: number;
  private regimePersistence: number;
  private spikeStreak = 0;
  private stableRegime: Regime = 'UNCLEAR';
  private candidateRegime: Regime = 'UNCLEAR';
  private candidateStreak = 0;

  constructor(opts: RegimeOptions = {}) {
    const cap = opts.windowCapacity ?? 60;
    this.ivWin = new RollingWindow(cap);
    this.widthWin = new RollingWindow(cap);
    this.ivSpikeZ = opts.ivSpikeZ ?? 2.5;
    this.ivJumpRatio = opts.ivJumpRatio ?? 1.4;
    this.trendNWF = opts.trendNWF ?? 1.0;
    this.ivStdFloorPct = opts.ivStdFloorPct ?? 0.02;
    this.spikePersistence = Math.max(1, opts.spikePersistence ?? 2);
    this.regimePersistence = Math.max(1, opts.regimePersistence ?? 2);
  }

  classify(a: PositioningAnalytics, snap: ChainSnapshot): RegimeResult {
    const corr = corridor(a, snap.spot);
    const iv = atmIV(snap);
    const b = basis(snap);
    const phase = sessionPhase(snap.ts);
    const expiry = !!snap.expiry && istDate(snap.ts) === snap.expiry;

    // Spike via z-score OR relative jump. The z uses a variance FLOOR: Dhan's
    // quantized ATM IV makes the rolling std collapse toward 0, and without a
    // floor a 0.2-vol-point tick z-scores >4 and nukes every open setup.
    const ivMean = this.ivWin.mean();
    const effStd = Math.max(this.ivWin.std(), ivMean * this.ivStdFloorPct);
    const ivZ = effStd > 0 ? (iv - ivMean) / effStd : 0;
    const spikeNow =
      a.ready &&
      this.ivWin.size >= 5 &&
      (ivZ > this.ivSpikeZ || (ivMean > 0 && iv > ivMean * this.ivJumpRatio));
    this.spikeStreak = spikeNow ? this.spikeStreak + 1 : 0;
    const ivSpike = this.spikeStreak >= this.spikePersistence;
    this.ivWin.push(iv);
    if (corr.width != null) this.widthWin.push(corr.width);

    const peRatcheting = a.peCentroid > this.lastPeCentroid && this.lastPeCentroid > 0;
    const ceRatcheting = a.ceCentroid < this.lastCeCentroid && this.lastCeCentroid > 0;
    this.lastPeCentroid = a.peCentroid;
    this.lastCeCentroid = a.ceCentroid;

    const candidate = this.decide(a, { ivSpike, expiry, phase, corr, peRatcheting, ceRatcheting });
    const regime = this.applyHysteresis(candidate);

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

  // A new regime must be seen `regimePersistence` consecutive snapshots before
  // it replaces the standing one. Regime flapping (UNCLEAR on any flat 20s
  // bar) was starving open hypotheses of detections and invalidating them in
  // ~60s. EVENT_CHAOS and EXPIRY_GRAVITY switch immediately: chaos already
  // carries its own persistence (spikeStreak) and expiry is clock-driven.
  private applyHysteresis(candidate: Regime): Regime {
    if (candidate === 'EVENT_CHAOS' || candidate === 'EXPIRY_GRAVITY') {
      this.stableRegime = candidate;
      this.candidateRegime = candidate;
      this.candidateStreak = 0;
      return candidate;
    }
    if (candidate === this.stableRegime) {
      this.candidateStreak = 0;
      return this.stableRegime;
    }
    if (candidate === this.candidateRegime) {
      this.candidateStreak += 1;
    } else {
      this.candidateRegime = candidate;
      this.candidateStreak = 1;
    }
    if (this.candidateStreak >= this.regimePersistence || this.stableRegime === 'UNCLEAR') {
      this.stableRegime = candidate;
      this.candidateStreak = 0;
    }
    return this.stableRegime;
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

    // The strongest directional flow states (writers fleeing into the move)
    // ARE a trend regime — they don't need the slower ratcheting confirmation.
    if (a.flowState === 'SQUEEZE_FUEL_BULL' && a.smoothedPriceDelta > 0) return 'TREND_BULL';
    if (a.flowState === 'CAPITULATION_BEAR' && a.smoothedPriceDelta < 0) return 'TREND_BEAR';

    // Sustained one-sided writer flow with the supporting wall ratcheting.
    if (a.netWriterFlow >= this.trendNWF && a.smoothedPriceDelta > 0 && ctx.peRatcheting) return 'TREND_BULL';
    if (a.netWriterFlow <= -this.trendNWF && a.smoothedPriceDelta < 0 && ctx.ceRatcheting) return 'TREND_BEAR';

    // Both sides writing into a tightening range = coiling for a break.
    const narrowing = this.widthWin.size >= 5 && (a.flowState === 'CORRIDOR');
    if (narrowing && ctx.corr.width != null && this.widthWin.zscore(ctx.corr.width) < -0.5) return 'SQUEEZE_WATCH';

    if (CORRIDOR_STATES.includes(a.flowState)) return 'CORRIDOR';

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
