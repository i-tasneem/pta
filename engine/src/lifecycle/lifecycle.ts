// Layer 4 — setup lifecycle. Per instrument, runs the full pipeline each
// snapshot (analytics -> regime -> archetypes -> score) and manages hypothesis
// objects through FORMING -> STRENGTHENING -> READY -> TRIGGERED -> ACTIVE ->
// terminal. Evidence must PERSIST across snapshots; single-snapshot spikes are
// poll noise. All transitions are emitted with cause for explainability + audit.
import { ChainSnapshot, PositioningAnalytics, RegimeResult, ArchetypeName, Side } from '../types';
import { PositioningTracker, TrackerOptions } from '../analytics/positioning';
import { RegimeClassifier, RegimeOptions } from '../regime/regime';
import { evaluateArchetypes, ArchetypeSignal, Archetype, ALL_ARCHETYPES } from '../archetypes/archetypes';
import { scoreEvidence, Evidence, clamp01 } from '../scoring/scoring';

export type SetupStage =
  | 'FORMING'
  | 'STRENGTHENING'
  | 'READY'
  | 'TRIGGERED'
  | 'ACTIVE'
  | 'TARGET_HIT'
  | 'STOPLOSS_HIT'
  | 'INVALIDATED'
  | 'EXPIRED';

const TERMINAL: SetupStage[] = ['TARGET_HIT', 'STOPLOSS_HIT', 'INVALIDATED', 'EXPIRED'];

export interface Hypothesis {
  id: string;
  instrument: string;
  archetype: ArchetypeName;
  direction: Side;
  stage: SetupStage;
  score: number;
  reasons: string[];
  evidence: Evidence[];
  structuralStop: number;
  structuralTarget: number;
  entryRef: number;
  thesis: string;
  createdAt: number;
  updatedAt: number;
  readyAt?: number;
  readyPrice?: number;
  triggeredAt?: number;
  scoreHistory: number[];
  missCount: number;
  holds: number; // consecutive snapshots evidence has held
  stopViolations: number; // consecutive snapshots spot has sat beyond the structural stop (pre-trigger)
}

export interface Transition {
  id: string;
  instrument: string;
  archetype: ArchetypeName;
  direction: Side;
  from: SetupStage;
  to: SetupStage;
  score: number;
  reasons: string[];
  thesis: string;
  ts: number;
}

export interface SnapshotResult {
  analytics: PositioningAnalytics;
  regime: RegimeResult;
  hypotheses: Hypothesis[];
  transitions: Transition[];
}

export interface LifecycleOptions {
  tracker?: TrackerOptions;
  regime?: RegimeOptions;
  registry?: Archetype[];
  formingScore?: number;
  strengtheningScore?: number;
  readyScore?: number;
  triggerBufferPct?: number;   // favorable move from readyPrice to trigger
  breakMinParticipation?: number;
  missTolerance?: number;      // snapshots without detection before invalidation
  cadenceMs?: number;          // expected chain-poll interval; staleness scales off it
  staleMs?: number;            // snapshot gap that invalidates everything
  maxAgeMs?: number;           // unreached-READY hypotheses expire
  readyTimeoutMs?: number;     // READY decays back if no trigger
  stopBufferPct?: number;      // pre-trigger stop must be exceeded by this fraction of spot
  stopViolationTolerance?: number; // consecutive violating snapshots before invalidation
  // Final veto before a READY setup triggers — the host can reject entries
  // whose live trade plan no longer makes sense (e.g. R:R collapsed because
  // the premium already ran). Returning false leaves the setup READY.
  triggerGuard?: (h: Hypothesis) => boolean;
}

const BREAK_ARCHETYPES: ArchetypeName[] = ['WALL_CAPITULATION_BREAK'];

export class SetupEngine {
  private tracker: PositioningTracker;
  private regimeClf: RegimeClassifier;
  private registry: Archetype[];
  private active = new Map<string, Hypothesis>();
  private lastTs = 0;
  private triggerGuard?: (h: Hypothesis) => boolean;
  private o: Required<Omit<LifecycleOptions, 'tracker' | 'regime' | 'registry' | 'triggerGuard'>>;

  constructor(private instrument: string, opts: LifecycleOptions = {}) {
    this.tracker = new PositioningTracker(opts.tracker);
    this.regimeClf = new RegimeClassifier(opts.regime);
    this.registry = opts.registry ?? ALL_ARCHETYPES;
    this.triggerGuard = opts.triggerGuard;
    this.o = {
      formingScore: opts.formingScore ?? 35,
      strengtheningScore: opts.strengtheningScore ?? 55,
      readyScore: opts.readyScore ?? 70,
      triggerBufferPct: opts.triggerBufferPct ?? 0.0008,
      breakMinParticipation: opts.breakMinParticipation ?? 0.5,
      // 2 was lethal at ~20s polling: any 3 flat snapshots (regime flap) killed
      // the setup — prod median lifetime was ~60s with a 100% invalidation rate.
      missTolerance: opts.missTolerance ?? 5,
      cadenceMs: opts.cadenceMs ?? 21000,
      // Staleness must scale with the poll cadence: a fixed 90s would kill
      // every slow-tier instrument (e.g. stocks at 60-90s polls) after two
      // perfectly normal gaps. 4 missed intervals ≈ genuinely frozen feed.
      staleMs: opts.staleMs ?? Math.max(90000, 4 * (opts.cadenceMs ?? 21000)),
      maxAgeMs: opts.maxAgeMs ?? 45 * 60000,
      readyTimeoutMs: opts.readyTimeoutMs ?? 15 * 60000,
      stopBufferPct: opts.stopBufferPct ?? 0.0005,
      stopViolationTolerance: opts.stopViolationTolerance ?? 2
    };
  }

  onSnapshot(snap: ChainSnapshot, futVolumeDelta = 0, futParticipation = 0): SnapshotResult {
    const analytics = this.tracker.update(snap, futVolumeDelta);
    const regime = this.regimeClf.classify(analytics, snap);
    const transitions: Transition[] = [];

    // Stale feed kills every open hypothesis — never act on frozen data.
    const stale = this.lastTs > 0 && snap.ts - this.lastTs > this.o.staleMs;
    this.lastTs = snap.ts;

    const signals = evaluateArchetypes({ analytics, regime, snapshot: snap, futParticipation }, this.registry);
    const detected = new Map<string, ArchetypeSignal>();
    for (const s of signals) detected.set(this.key(s.archetype, s.direction), s);

    // 1. update / create from detections
    for (const [k, sig] of detected) {
      const existing = this.active.get(k);
      const scored = this.scoreWith(sig, existing ? existing.holds + 1 : 1);
      if (!existing) {
        if (scored.score >= this.o.formingScore) {
          const h = this.create(snap, sig, scored);
          this.active.set(k, h);
          transitions.push(this.transition(h, 'FORMING', 'FORMING'));
        }
        continue;
      }
      const from = existing.stage;
      this.applyUpdate(existing, snap, sig, scored, futParticipation, regime, stale);
      if (existing.stage !== from) transitions.push(this.transition(existing, from, existing.stage));
    }

    // 2. handle hypotheses not detected this snapshot
    for (const [k, h] of this.active) {
      if (detected.has(k) || TERMINAL.includes(h.stage)) continue;
      const from = h.stage;
      this.applyMiss(h, snap, regime, stale);
      if (h.stage !== from) transitions.push(this.transition(h, from, h.stage));
    }

    // 3. sweep terminals
    for (const [k, h] of [...this.active]) {
      if (TERMINAL.includes(h.stage)) this.active.delete(k);
    }

    return { analytics, regime, hypotheses: [...this.active.values()], transitions };
  }

  // Install the resolved (confluence/pinned) exit levels on an OPEN trade so
  // the engine manages the position against the same levels the user sees.
  // Called by the host right after a TRIGGERED transition; levels are frozen
  // from then on (applyUpdate no longer overwrites open trades).
  setTradePlan(id: string, stopUnderlying: number, targetUnderlying: number): void {
    for (const h of this.active.values()) {
      if (h.id !== id) continue;
      if (h.stage !== 'TRIGGERED' && h.stage !== 'ACTIVE') return;
      if (Number.isFinite(stopUnderlying) && stopUnderlying > 0) h.structuralStop = stopUnderlying;
      if (Number.isFinite(targetUnderlying) && targetUnderlying > 0) h.structuralTarget = targetUnderlying;
      return;
    }
  }

  // --- internals ---
  private key(a: ArchetypeName, d: Side): string {
    return `${a}|${d}`;
  }

  private hasOpenPosition(direction: Side): boolean {
    for (const h of this.active.values()) {
      if ((h.stage === 'TRIGGERED' || h.stage === 'ACTIVE') && h.direction === direction) return true;
    }
    return false;
  }

  private scoreWith(sig: ArchetypeSignal, holds: number): { score: number; reasons: string[]; evidence: Evidence[] } {
    const persistence: Evidence = {
      component: 'persistence',
      strength: clamp01(holds / 4),
      detail: `evidence held ${holds} snapshot(s)`
    };
    const evidence = [...sig.evidence, persistence];
    const { score, reasons } = scoreEvidence(evidence);
    return { score, reasons, evidence };
  }

  private create(snap: ChainSnapshot, sig: ArchetypeSignal, scored: { score: number; reasons: string[]; evidence: Evidence[] }): Hypothesis {
    return {
      id: `${this.instrument}|${sig.archetype}|${sig.direction}|${snap.ts}`,
      instrument: this.instrument,
      archetype: sig.archetype,
      direction: sig.direction,
      stage: 'FORMING',
      score: scored.score,
      reasons: scored.reasons,
      evidence: scored.evidence,
      structuralStop: sig.structuralStop,
      structuralTarget: sig.structuralTarget,
      entryRef: sig.entryRef,
      thesis: sig.thesis,
      createdAt: snap.ts,
      updatedAt: snap.ts,
      scoreHistory: [scored.score],
      missCount: 0,
      holds: 1,
      stopViolations: 0
    };
  }

  private applyUpdate(
    h: Hypothesis,
    snap: ChainSnapshot,
    sig: ArchetypeSignal,
    scored: { score: number; reasons: string[]; evidence: Evidence[] },
    futParticipation: number,
    regime: RegimeResult,
    stale: boolean
  ): void {
    h.updatedAt = snap.ts;
    h.holds += 1;
    h.score = scored.score;
    h.reasons = scored.reasons;
    h.evidence = scored.evidence;
    // The trade plan is FROZEN once the setup triggers. Re-deriving stop/
    // target/entry from each fresh detection moved the goalposts on open
    // trades — as price approached the target, walls re-derived and the
    // target ratcheted away, so winners never closed and outcome accounting
    // drifted with the entry reference.
    if (h.stage !== 'TRIGGERED' && h.stage !== 'ACTIVE') {
      h.structuralStop = sig.structuralStop;
      h.structuralTarget = sig.structuralTarget;
      h.entryRef = sig.entryRef;
    }
    h.scoreHistory.push(scored.score);
    if (h.scoreHistory.length > 6) h.scoreHistory.shift();

    if (this.invalidate(h, snap, regime, stale)) return;

    // post-trigger: manage to target/stop
    if (h.stage === 'TRIGGERED' || h.stage === 'ACTIVE') {
      h.missCount = 0;
      this.manageOpen(h, snap);
      return;
    }

    // pre-trigger stage machine
    const rising = h.scoreHistory.length >= 2 && h.scoreHistory[h.scoreHistory.length - 1] >= h.scoreHistory[h.scoreHistory.length - 2];

    if (h.stage === 'READY') {
      h.missCount = 0;
      // time-box READY; decay if the trigger never comes
      if (h.readyAt != null && snap.ts - h.readyAt > this.o.readyTimeoutMs) {
        h.stage = 'STRENGTHENING';
        return;
      }
      // One open position per direction: a second archetype reaching the same
      // conclusion is confirmation, not a second trade — presenting both as
      // signals doubles the position. The runner-up stays READY and may
      // trigger later if the open trade closes first.
      if (
        !this.hasOpenPosition(h.direction) &&
        this.triggerMet(h, snap, futParticipation) &&
        (!this.triggerGuard || this.triggerGuard(h))
      ) {
        h.stage = 'TRIGGERED';
        h.triggeredAt = snap.ts;
      }
      return;
    }

    // FORMING / STRENGTHENING advancement. missCount only resets on a
    // forming-or-better score — resetting it unconditionally at the top of
    // every detected update meant score decay could never invalidate.
    if (h.score >= this.o.readyScore) {
      h.missCount = 0;
      h.stage = 'READY';
      h.readyAt = snap.ts;
      h.readyPrice = snap.spot;
    } else if (h.score >= this.o.strengtheningScore && rising) {
      h.missCount = 0;
      h.stage = 'STRENGTHENING';
    } else if (h.score >= this.o.formingScore) {
      h.missCount = 0;
      h.stage = 'FORMING';
    } else {
      h.missCount += 1;
      if (h.missCount > this.o.missTolerance) h.stage = 'INVALIDATED';
    }
  }

  private applyMiss(h: Hypothesis, snap: ChainSnapshot, regime: RegimeResult, stale: boolean): void {
    h.updatedAt = snap.ts;
    h.holds = 0;
    if (this.invalidate(h, snap, regime, stale)) return;
    if (h.stage === 'TRIGGERED' || h.stage === 'ACTIVE') {
      this.manageOpen(h, snap);
      return;
    }
    h.missCount += 1;
    if (h.missCount > this.o.missTolerance) h.stage = 'INVALIDATED';
  }

  // Hard invalidations applicable at any pre-terminal stage.
  private invalidate(h: Hypothesis, snap: ChainSnapshot, regime: RegimeResult, stale: boolean): boolean {
    if (stale) { h.stage = 'INVALIDATED'; return true; }
    if (regime.regime === 'EVENT_CHAOS') { h.stage = 'INVALIDATED'; return true; }
    if (snap.ts - h.createdAt > this.o.maxAgeMs && h.stage !== 'TRIGGERED' && h.stage !== 'ACTIVE') {
      h.stage = 'EXPIRED'; return true;
    }
    // Structural stop violated before trigger = thesis already wrong. Requires
    // a buffer AND persistence: break setups legitimately form with spot inside
    // the detection tolerance just beyond their wall-stop, and a bare touch
    // test invalidated them on the very next snapshot (prod: 768 break setups
    // shadow-recorded WOULD_LOSE instantly for this reason).
    if (h.stage !== 'TRIGGERED' && h.stage !== 'ACTIVE') {
      const buf = snap.spot * this.o.stopBufferPct;
      const violated = h.direction === 'CE'
        ? snap.spot <= h.structuralStop - buf
        : snap.spot >= h.structuralStop + buf;
      if (violated) {
        h.stopViolations += 1;
        if (h.stopViolations >= this.o.stopViolationTolerance) {
          h.stage = 'INVALIDATED';
          return true;
        }
      } else {
        h.stopViolations = 0;
      }
    }
    return false;
  }

  private manageOpen(h: Hypothesis, snap: ChainSnapshot): void {
    if (h.stage === 'TRIGGERED') h.stage = 'ACTIVE';
    if (h.direction === 'CE') {
      if (snap.spot >= h.structuralTarget) h.stage = 'TARGET_HIT';
      else if (snap.spot <= h.structuralStop) h.stage = 'STOPLOSS_HIT';
    } else {
      if (snap.spot <= h.structuralTarget) h.stage = 'TARGET_HIT';
      else if (snap.spot >= h.structuralStop) h.stage = 'STOPLOSS_HIT';
    }
  }

  // A confirming move past the price at which READY was reached.
  private triggerMet(h: Hypothesis, snap: ChainSnapshot, futParticipation: number): boolean {
    if (h.readyPrice == null) return false;
    if (BREAK_ARCHETYPES.includes(h.archetype) && futParticipation < this.o.breakMinParticipation) return false;
    const buf = h.readyPrice * this.o.triggerBufferPct;
    return h.direction === 'CE'
      ? snap.spot >= h.readyPrice + buf
      : snap.spot <= h.readyPrice - buf;
  }

  private transition(h: Hypothesis, from: SetupStage, to: SetupStage): Transition {
    return {
      id: h.id, instrument: h.instrument, archetype: h.archetype, direction: h.direction,
      from, to, score: h.score, reasons: h.reasons, thesis: h.thesis, ts: h.updatedAt
    };
  }
}
