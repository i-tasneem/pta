// Layer 1 — positioning measurement. Pure functions + a per-instrument
// stateful tracker that maintains rolling baselines for z-scoring.
import { RollingWindow } from '../math/rolling';
import { ChainSnapshot, Strike, Side, Wall, FlowState, PositioningAnalytics } from '../types';

// Strikes within +/- `steps` of the ATM (the strikes that actually carry
// directional information; far-OTM OI is hedging noise).
export function localizedStrikes(strikes: Strike[], atm: number, steps: number): Strike[] {
  if (strikes.length === 0) return [];
  const sorted = [...strikes].sort((a, b) => a.strike - b.strike);
  let idx = 0;
  let best = Infinity;
  sorted.forEach((s, i) => {
    const d = Math.abs(s.strike - atm);
    if (d < best) {
      best = d;
      idx = i;
    }
  });
  return sorted.slice(Math.max(0, idx - steps), idx + steps + 1);
}

// CE/PE OI change per minute across matched strikes. The SUM of these is
// meaningless; their signs and difference are the engine's compass.
export function splitOIVelocity(
  prev: Strike[],
  curr: Strike[],
  dtMin: number
): { vCE: number; vPE: number } {
  const prevMap = new Map(prev.map((s) => [s.strike, s]));
  let dCE = 0;
  let dPE = 0;
  for (const s of curr) {
    const p = prevMap.get(s.strike);
    if (!p) continue;
    dCE += s.ce.oi - p.ce.oi;
    dPE += s.pe.oi - p.pe.oi;
  }
  const dt = dtMin > 0 ? dtMin : 1;
  return { vCE: dCE / dt, vPE: dPE / dt };
}

// A wall is an OI concentration OUTLIER (z >= threshold) across the ladder,
// not merely the top-N by sort — a flat chain has no walls.
export function detectWalls(strikes: Strike[], side: Side, zThreshold = 2): Wall[] {
  if (strikes.length < 3) return [];
  const ois = strikes.map((s) => (side === 'CE' ? s.ce.oi : s.pe.oi));
  const n = ois.length;
  const mean = ois.reduce((a, b) => a + b, 0) / n;
  const variance = ois.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  const std = Math.sqrt(variance);
  const walls: Wall[] = [];
  strikes.forEach((s, i) => {
    const z = std === 0 ? 0 : (ois[i] - mean) / std;
    if (z >= zThreshold) walls.push({ strike: s.strike, oi: ois[i], z, side });
  });
  return walls.sort((a, b) => b.oi - a.oi);
}

// OI-weighted average strike — the support (PE) / resistance (CE) anchor
// whose migration tracks trend health.
export function oiCentroid(strikes: Strike[], side: Side): number {
  let num = 0;
  let den = 0;
  for (const s of strikes) {
    const oi = side === 'CE' ? s.ce.oi : s.pe.oi;
    num += s.strike * oi;
    den += oi;
  }
  return den > 0 ? num / den : 0;
}

// Price progress per unit of futures volume. Small magnitude under heavy
// volume = the level is absorbing flow (writers winning).
export function easeOfMovement(priceDelta: number, futVolumeDelta: number): number {
  if (!futVolumeDelta || futVolumeDelta <= 0) return 0;
  return Math.abs(priceDelta) / futVolumeDelta;
}

// The NWF x price read. Unwinding-into-the-move states are highest conviction.
export function classifyFlow(
  nwf: number,
  priceDelta: number,
  vCE: number,
  vPE: number,
  epsilon: number
): FlowState {
  const rising = priceDelta > epsilon;
  const falling = priceDelta < -epsilon;

  if (rising && vCE < 0) return 'SQUEEZE_FUEL_BULL';
  if (falling && vPE < 0) return 'CAPITULATION_BEAR';
  if (rising && nwf > 0) return 'BULL_CONFIRM';
  if (falling && nwf < 0) return 'BEAR_CONFIRM';
  if (rising && nwf < 0) return 'CAPPED_FADE';
  if (falling && nwf > 0) return 'PUT_KNIFE';
  if (vCE > 0 && vPE > 0) return 'CORRIDOR';
  return 'NEUTRAL';
}

export interface TrackerOptions {
  atmWindowSteps?: number;   // strikes each side of ATM for localized flow
  windowCapacity?: number;   // rolling baseline length (samples)
  risingEpsilonBps?: number; // price deadband in basis points of spot
  wallZ?: number;            // wall outlier threshold
  minBaseline?: number;      // samples before `ready` flips true
  priceSmoothSpan?: number;  // snapshots the direction read spans (>=1)
}

// One per instrument. Feed it each chain snapshot (plus the future's volume
// delta over the interval) and it emits normalized positioning analytics.
export class PositioningTracker {
  private last: ChainSnapshot | null = null;
  private vceWin: RollingWindow;
  private vpeWin: RollingWindow;
  private spotHistory: number[] = [];
  private atmWindowSteps: number;
  private risingEpsilonBps: number;
  private wallZ: number;
  private minBaseline: number;
  private priceSmoothSpan: number;

  constructor(opts: TrackerOptions = {}) {
    this.atmWindowSteps = opts.atmWindowSteps ?? 5;
    this.risingEpsilonBps = opts.risingEpsilonBps ?? 2;
    this.wallZ = opts.wallZ ?? 2;
    this.minBaseline = opts.minBaseline ?? 5;
    this.priceSmoothSpan = Math.max(1, opts.priceSmoothSpan ?? 3);
    const cap = opts.windowCapacity ?? 60;
    this.vceWin = new RollingWindow(cap);
    this.vpeWin = new RollingWindow(cap);
  }

  update(snap: ChainSnapshot, futVolumeDelta = 0): PositioningAnalytics {
    const ceWalls = detectWalls(snap.strikes, 'CE', this.wallZ);
    const peWalls = detectWalls(snap.strikes, 'PE', this.wallZ);
    const ceCentroid = oiCentroid(snap.strikes, 'CE');
    const peCentroid = oiCentroid(snap.strikes, 'PE');

    if (!this.last) {
      this.last = snap;
      this.spotHistory.push(snap.spot);
      return {
        ts: snap.ts,
        vCE: 0, vPE: 0, zvCE: 0, zvPE: 0,
        netWriterFlow: 0,
        flowState: 'WARMUP',
        priceDelta: 0,
        smoothedPriceDelta: 0,
        easeOfMovement: 0,
        ceWalls, peWalls, ceCentroid, peCentroid,
        ready: false
      };
    }

    const dtMin = (snap.ts - this.last.ts) / 60000;
    const prevLocal = localizedStrikes(this.last.strikes, this.last.atmStrike, this.atmWindowSteps);
    const currLocal = localizedStrikes(snap.strikes, snap.atmStrike, this.atmWindowSteps);
    const { vCE, vPE } = splitOIVelocity(prevLocal, currLocal, dtMin);

    this.vceWin.push(vCE);
    this.vpeWin.push(vPE);
    const zvCE = this.vceWin.zscore(vCE);
    const zvPE = this.vpeWin.zscore(vPE);
    const nwf = zvPE - zvCE;

    const priceDelta = snap.spot - this.last.spot;

    // Direction over the last few snapshots, not one poll interval — a single
    // flat 20s bar must not flip the flow state (that flapping was killing
    // every setup within ~3 snapshots in prod).
    this.spotHistory.push(snap.spot);
    if (this.spotHistory.length > this.priceSmoothSpan + 1) this.spotHistory.shift();
    const smoothedPriceDelta = snap.spot - this.spotHistory[0];

    const epsilon = (snap.spot * this.risingEpsilonBps) / 10000;
    const flowState = classifyFlow(nwf, smoothedPriceDelta, vCE, vPE, epsilon);
    const eom = easeOfMovement(priceDelta, futVolumeDelta);

    this.last = snap;

    return {
      ts: snap.ts,
      vCE, vPE, zvCE, zvPE,
      netWriterFlow: nwf,
      flowState,
      priceDelta,
      smoothedPriceDelta,
      easeOfMovement: eom,
      ceWalls, peWalls, ceCentroid, peCentroid,
      ready: this.vceWin.size >= this.minBaseline
    };
  }
}
