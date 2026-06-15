// Layer 3 — archetypes. Each is a positioning-event detector that, given the
// allowed regime, emits a directional hypothesis with structural stop/target
// (on the underlying) and an evidence vector. Scoring (Layer 5) turns the
// evidence into a number; lifecycle (Layer 4) appends persistence and manages
// stage transitions. Detectors stay pure and instantaneous.
import {
  ChainSnapshot,
  PositioningAnalytics,
  RegimeResult,
  ArchetypeName,
  Side,
  SessionPhase
} from '../types';
import { Evidence, clamp01, zStrength } from '../scoring/scoring';

export interface ArchetypeContext {
  analytics: PositioningAnalytics;
  regime: RegimeResult;
  snapshot: ChainSnapshot;
  futParticipation?: number; // 0..1 time-of-day percentile of futures volume
}

export interface ArchetypeSignal {
  archetype: ArchetypeName;
  direction: Side;
  evidence: Evidence[];
  structuralStop: number;    // underlying
  structuralTarget: number;  // underlying
  entryRef: number;          // underlying reference (spot)
  thesis: string;
}

export interface Archetype {
  name: ArchetypeName;
  evaluate(ctx: ArchetypeContext): ArchetypeSignal | null;
}

// --- helpers ---
const tol = (spot: number) => spot * 0.0015;
const fallbackMove = (spot: number) => spot * 0.004;
const fit = (map: Record<SessionPhase, number>, p: SessionPhase) => map[p] ?? 0;

const BREAK_FIT: Record<SessionPhase, number> =
  { PRE: 0, OPEN: 0.3, MORNING: 1, MIDDAY: 0.7, AFTERNOON: 0.5, CLOSE: 0.2, POST: 0 };
const FADE_FIT: Record<SessionPhase, number> =
  { PRE: 0, OPEN: 0.2, MORNING: 0.6, MIDDAY: 1, AFTERNOON: 0.7, CLOSE: 0.3, POST: 0 };
const TREND_FIT: Record<SessionPhase, number> =
  { PRE: 0, OPEN: 0.3, MORNING: 1, MIDDAY: 0.8, AFTERNOON: 0.6, CLOSE: 0.3, POST: 0 };
const EXPIRY_FIT: Record<SessionPhase, number> =
  { PRE: 0, OPEN: 0, MORNING: 0, MIDDAY: 0.5, AFTERNOON: 1, CLOSE: 0.8, POST: 0 };

function fut(ctx: ArchetypeContext): number {
  return clamp01(ctx.futParticipation ?? 0);
}

// 1. Wall Capitulation Break — price breaks a wall whose writers are fleeing.
export const wallCapitulationBreak: Archetype = {
  name: 'WALL_CAPITULATION_BREAK',
  evaluate(ctx) {
    const { analytics: a, regime: r, snapshot: s } = ctx;
    if (!a.ready || !r.allowed.includes('WALL_CAPITULATION_BREAK')) return null;

    if (a.flowState === 'SQUEEZE_FUEL_BULL' && r.corridor.resistance != null && s.spot >= r.corridor.resistance - tol(s.spot)) {
      const wall = r.corridor.resistance;
      const target = wall + (r.corridor.width ?? fallbackMove(s.spot));
      return {
        archetype: 'WALL_CAPITULATION_BREAK', direction: 'CE', entryRef: s.spot,
        structuralStop: wall, structuralTarget: target,
        thesis: `Break above ${wall} — call writers capitulating`,
        evidence: [
          { component: 'wallBehavior', strength: zStrength(a.zvCE), detail: `CE wall ${wall} OI capitulating` },
          { component: 'writerFlow', strength: clamp01(a.netWriterFlow / 3), detail: `net put writing (NWF ${a.netWriterFlow.toFixed(1)})` },
          { component: 'futuresParticipation', strength: fut(ctx), detail: 'futures volume burst' },
          { component: 'structureQuality', strength: clamp01((target - s.spot) / fallbackMove(s.spot)), detail: 'room to next level' },
          { component: 'centroidMigration', strength: 0.5, detail: 'support following' },
          { component: 'iv', strength: 0.4, detail: 'IV not collapsing' },
          { component: 'sessionFitness', strength: fit(BREAK_FIT, r.sessionPhase), detail: `session ${r.sessionPhase}` }
        ]
      };
    }

    if (a.flowState === 'CAPITULATION_BEAR' && r.corridor.support != null && s.spot <= r.corridor.support + tol(s.spot)) {
      const wall = r.corridor.support;
      const target = wall - (r.corridor.width ?? fallbackMove(s.spot));
      return {
        archetype: 'WALL_CAPITULATION_BREAK', direction: 'PE', entryRef: s.spot,
        structuralStop: wall, structuralTarget: target,
        thesis: `Break below ${wall} — put writers capitulating`,
        evidence: [
          { component: 'wallBehavior', strength: zStrength(a.zvPE), detail: `PE wall ${wall} OI capitulating` },
          { component: 'writerFlow', strength: clamp01(-a.netWriterFlow / 3), detail: `net call writing (NWF ${a.netWriterFlow.toFixed(1)})` },
          { component: 'futuresParticipation', strength: fut(ctx), detail: 'futures volume burst' },
          { component: 'structureQuality', strength: clamp01((s.spot - target) / fallbackMove(s.spot)), detail: 'room to next level' },
          { component: 'centroidMigration', strength: 0.5, detail: 'resistance following' },
          { component: 'iv', strength: 0.4, detail: 'IV not collapsing' },
          { component: 'sessionFitness', strength: fit(BREAK_FIT, r.sessionPhase), detail: `session ${r.sessionPhase}` }
        ]
      };
    }
    return null;
  }
};

// 2. Wall Absorption Fade — defended wall eats flow; fade back to center.
export const wallAbsorptionFade: Archetype = {
  name: 'WALL_ABSORPTION_FADE',
  evaluate(ctx) {
    const { analytics: a, regime: r, snapshot: s } = ctx;
    if (!a.ready || !r.allowed.includes('WALL_ABSORPTION_FADE')) return null;
    const { support, resistance } = r.corridor;
    if (support == null || resistance == null) return null;
    const center = (support + resistance) / 2;

    // at resistance, call writers defending (vCE>0), low ease of movement -> fade PE
    if (s.spot >= resistance - tol(s.spot) && a.vCE > 0) {
      return {
        archetype: 'WALL_ABSORPTION_FADE', direction: 'PE', entryRef: s.spot,
        structuralStop: resistance + fallbackMove(s.spot) * 0.5, structuralTarget: center,
        thesis: `Resistance ${resistance} absorbing — fade to ${Math.round(center)}`,
        evidence: [
          { component: 'wallBehavior', strength: clamp01(a.vCE > 0 ? 0.7 : 0) * (a.easeOfMovement === 0 ? 1 : clamp01(1 - a.easeOfMovement)), detail: `resistance ${resistance} absorbing volume` },
          { component: 'writerFlow', strength: clamp01(a.vCE / Math.max(1, Math.abs(a.vCE) + Math.abs(a.vPE))), detail: 'call writers defending' },
          { component: 'structureQuality', strength: clamp01((s.spot - center) / fallbackMove(s.spot)), detail: 'room back to center' },
          { component: 'sessionFitness', strength: fit(FADE_FIT, r.sessionPhase), detail: `session ${r.sessionPhase}` }
        ]
      };
    }
    // at support, put writers defending (vPE>0) -> fade CE
    if (s.spot <= support + tol(s.spot) && a.vPE > 0) {
      return {
        archetype: 'WALL_ABSORPTION_FADE', direction: 'CE', entryRef: s.spot,
        structuralStop: support - fallbackMove(s.spot) * 0.5, structuralTarget: center,
        thesis: `Support ${support} absorbing — fade to ${Math.round(center)}`,
        evidence: [
          { component: 'wallBehavior', strength: clamp01(a.vPE > 0 ? 0.7 : 0), detail: `support ${support} absorbing volume` },
          { component: 'writerFlow', strength: clamp01(a.vPE / Math.max(1, Math.abs(a.vCE) + Math.abs(a.vPE))), detail: 'put writers defending' },
          { component: 'structureQuality', strength: clamp01((center - s.spot) / fallbackMove(s.spot)), detail: 'room back to center' },
          { component: 'sessionFitness', strength: fit(FADE_FIT, r.sessionPhase), detail: `session ${r.sessionPhase}` }
        ]
      };
    }
    return null;
  }
};

// 3. Writer Migration Continuation — trend pullback that holds while writer
// flow stays one-sided (highest win-rate archetype).
export const writerMigrationContinuation: Archetype = {
  name: 'WRITER_MIGRATION_CONTINUATION',
  evaluate(ctx) {
    const { analytics: a, regime: r, snapshot: s } = ctx;
    if (!a.ready || !r.allowed.includes('WRITER_MIGRATION_CONTINUATION')) return null;

    if (r.regime === 'TREND_BULL' && a.netWriterFlow > 0) {
      const support = r.corridor.support ?? a.peCentroid;
      const resistance = r.corridor.resistance ?? s.spot + fallbackMove(s.spot);
      return {
        archetype: 'WRITER_MIGRATION_CONTINUATION', direction: 'CE', entryRef: s.spot,
        structuralStop: support, structuralTarget: resistance + fallbackMove(s.spot),
        thesis: 'Bull trend — put writers holding the floor on the pullback',
        evidence: [
          { component: 'writerFlow', strength: clamp01(a.netWriterFlow / 3), detail: `put writing intact (NWF ${a.netWriterFlow.toFixed(1)})` },
          { component: 'centroidMigration', strength: 0.7, detail: 'support centroid ratcheting up' },
          { component: 'wallBehavior', strength: 0.5, detail: 'floor defended' },
          { component: 'futuresParticipation', strength: fut(ctx), detail: 'futures aligned' },
          { component: 'structureQuality', strength: 0.6, detail: 'trend room above' },
          { component: 'sessionFitness', strength: fit(TREND_FIT, r.sessionPhase), detail: `session ${r.sessionPhase}` }
        ]
      };
    }
    if (r.regime === 'TREND_BEAR' && a.netWriterFlow < 0) {
      const resistance = r.corridor.resistance ?? a.ceCentroid;
      const support = r.corridor.support ?? s.spot - fallbackMove(s.spot);
      return {
        archetype: 'WRITER_MIGRATION_CONTINUATION', direction: 'PE', entryRef: s.spot,
        structuralStop: resistance, structuralTarget: support - fallbackMove(s.spot),
        thesis: 'Bear trend — call writers capping the bounce',
        evidence: [
          { component: 'writerFlow', strength: clamp01(-a.netWriterFlow / 3), detail: `call writing intact (NWF ${a.netWriterFlow.toFixed(1)})` },
          { component: 'centroidMigration', strength: 0.7, detail: 'resistance centroid ratcheting down' },
          { component: 'wallBehavior', strength: 0.5, detail: 'cap defended' },
          { component: 'futuresParticipation', strength: fut(ctx), detail: 'futures aligned' },
          { component: 'structureQuality', strength: 0.6, detail: 'trend room below' },
          { component: 'sessionFitness', strength: fit(TREND_FIT, r.sessionPhase), detail: `session ${r.sessionPhase}` }
        ]
      };
    }
    return null;
  }
};

// 4. Basis-Flow Divergence Reversal — price grinding against fading basis and
// opposite writer flow at a structural extreme. Rare, contrarian.
export const basisFlowDivergenceReversal: Archetype = {
  name: 'BASIS_FLOW_DIVERGENCE_REVERSAL',
  evaluate(ctx) {
    const { analytics: a, regime: r, snapshot: s } = ctx;
    if (!a.ready || !r.allowed.includes('BASIS_FLOW_DIVERGENCE_REVERSAL')) return null;
    const { support, resistance } = r.corridor;

    // at resistance, rally into call writing while basis fades -> PE reversal
    if (resistance != null && s.spot >= resistance - tol(s.spot) && a.flowState === 'CAPPED_FADE' && r.basis <= 0 && s.pcr < 0.8) {
      return {
        archetype: 'BASIS_FLOW_DIVERGENCE_REVERSAL', direction: 'PE', entryRef: s.spot,
        structuralStop: resistance + fallbackMove(s.spot) * 0.5,
        structuralTarget: support ?? s.spot - fallbackMove(s.spot) * 2,
        thesis: 'Rally sold into call writing, futures not confirming',
        evidence: [
          { component: 'writerFlow', strength: clamp01(-a.netWriterFlow / 3), detail: 'call writing into strength' },
          { component: 'futuresParticipation', strength: clamp01(-r.basis), detail: 'futures discount (no confirmation)' },
          { component: 'pcrDecomposition', strength: clamp01((0.8 - s.pcr) / 0.3), detail: `PCR extreme ${s.pcr.toFixed(2)}` },
          { component: 'wallBehavior', strength: 0.5, detail: `resistance ${resistance} holding` },
          { component: 'sessionFitness', strength: fit(FADE_FIT, r.sessionPhase), detail: `session ${r.sessionPhase}` }
        ]
      };
    }
    if (support != null && s.spot <= support + tol(s.spot) && a.flowState === 'PUT_KNIFE' && r.basis >= 0 && s.pcr > 1.4) {
      return {
        archetype: 'BASIS_FLOW_DIVERGENCE_REVERSAL', direction: 'CE', entryRef: s.spot,
        structuralStop: support - fallbackMove(s.spot) * 0.5,
        structuralTarget: resistance ?? s.spot + fallbackMove(s.spot) * 2,
        thesis: 'Selloff into put writing, futures not confirming',
        evidence: [
          { component: 'writerFlow', strength: clamp01(a.netWriterFlow / 3), detail: 'put writing into weakness' },
          { component: 'futuresParticipation', strength: clamp01(r.basis), detail: 'futures premium (no confirmation)' },
          { component: 'pcrDecomposition', strength: clamp01((s.pcr - 1.4) / 0.3), detail: `PCR extreme ${s.pcr.toFixed(2)}` },
          { component: 'wallBehavior', strength: 0.5, detail: `support ${support} holding` },
          { component: 'sessionFitness', strength: fit(FADE_FIT, r.sessionPhase), detail: `session ${r.sessionPhase}` }
        ]
      };
    }
    return null;
  }
};

// 5. Expiry Pin — on expiry afternoon, fade pushes away from max pain.
export const expiryPin: Archetype = {
  name: 'EXPIRY_PIN',
  evaluate(ctx) {
    const { regime: r, snapshot: s } = ctx;
    if (!r.allowed.includes('EXPIRY_PIN')) return null;
    const mp = s.maxPain;
    if (mp == null || mp === 0) return null;
    const dist = Math.abs(s.spot - mp);
    if (dist < tol(s.spot)) return null; // already pinned

    const direction: Side = s.spot > mp ? 'PE' : 'CE';
    const stop = direction === 'PE' ? s.spot + fallbackMove(s.spot) : s.spot - fallbackMove(s.spot);
    return {
      archetype: 'EXPIRY_PIN', direction, entryRef: s.spot,
      structuralStop: stop, structuralTarget: mp,
      thesis: `Expiry pin toward max pain ${mp}`,
      evidence: [
        { component: 'structureQuality', strength: clamp01(dist / fallbackMove(s.spot)), detail: `distance to max pain ${mp}` },
        { component: 'pcrDecomposition', strength: 0.4, detail: 'expiry positioning' },
        { component: 'sessionFitness', strength: fit(EXPIRY_FIT, r.sessionPhase), detail: `session ${r.sessionPhase}` }
      ]
    };
  }
};

export const ALL_ARCHETYPES: Archetype[] = [
  wallCapitulationBreak,
  wallAbsorptionFade,
  writerMigrationContinuation,
  basisFlowDivergenceReversal,
  expiryPin
];

// Run only the archetypes the regime allows.
export function evaluateArchetypes(ctx: ArchetypeContext, registry: Archetype[] = ALL_ARCHETYPES): ArchetypeSignal[] {
  const out: ArchetypeSignal[] = [];
  for (const arch of registry) {
    if (!ctx.regime.allowed.includes(arch.name)) continue;
    const sig = arch.evaluate(ctx);
    if (sig) out.push(sig);
  }
  return out;
}
