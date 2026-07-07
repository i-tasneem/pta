// Weighted evidence scoring. An archetype emits strengths (0..1) for the
// components it can evaluate; the score is the weighted sum NORMALIZED by the
// weight the archetype could have earned (the components it actually emits).
// Without normalization, archetypes that structurally lack a component (e.g.
// fades have no futures-confirmation leg) had score ceilings below the READY
// threshold and could never signal — prod data 2026-06-15..07-07 showed
// FADE capped at 52.7 vs readyScore 65 with a 79% shadow win rate.
// Weights express relative importance and still sum to 100.
export type ScoreComponent =
  | 'wallBehavior'          // 25
  | 'writerFlow'            // 20
  | 'futuresParticipation'  // 15
  | 'structureQuality'      // 10
  | 'iv'                    // 8
  | 'centroidMigration'     // 8
  | 'pcrDecomposition'      // 5
  | 'sessionFitness'        // 5
  | 'persistence';          // 4

export const WEIGHTS: Record<ScoreComponent, number> = {
  wallBehavior: 25,
  writerFlow: 20,
  futuresParticipation: 15,
  structureQuality: 10,
  iv: 8,
  centroidMigration: 8,
  pcrDecomposition: 5,
  sessionFitness: 5,
  persistence: 4
};

export interface Evidence {
  component: ScoreComponent;
  strength: number; // 0..1
  detail: string;
}

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export interface ScoreResult {
  score: number;        // 0..100, normalized to the archetype's achievable weight
  rawScore: number;     // un-normalized weighted sum (for audit/comparison)
  achievableWeight: number; // sum of weights of the components this archetype emits
  reasons: string[];    // human-readable WHY
  byComponent: Partial<Record<ScoreComponent, number>>;
}

export function scoreEvidence(evidence: Evidence[]): ScoreResult {
  let raw = 0;
  let achievable = 0;
  const byComponent: Partial<Record<ScoreComponent, number>> = {};
  const reasons: string[] = [];

  for (const e of evidence) {
    const w = WEIGHTS[e.component] ?? 0;
    const s = clamp01(e.strength);
    const contribution = w * s;
    raw += contribution;
    achievable += w;
    byComponent[e.component] = (byComponent[e.component] ?? 0) + contribution;
    if (s > 0) reasons.push(e.detail);
  }

  const score = achievable > 0 ? (raw / achievable) * 100 : 0;
  return {
    score: Math.round(score * 10) / 10,
    rawScore: Math.round(raw * 10) / 10,
    achievableWeight: achievable,
    reasons,
    byComponent
  };
}

// Squash a z-score into a 0..1 strength (saturating near |z| ~ 3).
export function zStrength(z: number): number {
  return clamp01(Math.abs(z) / 3);
}
