// Weighted evidence scoring. An archetype emits strengths (0..1) for the
// components it can evaluate; the score is the weighted sum. Components it
// can't evaluate contribute 0 — so a setup missing, say, futures
// confirmation simply can't reach a top score. Weights sum to 100.
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
  score: number;        // 0..100
  reasons: string[];    // human-readable WHY
  byComponent: Partial<Record<ScoreComponent, number>>;
}

export function scoreEvidence(evidence: Evidence[]): ScoreResult {
  let score = 0;
  const byComponent: Partial<Record<ScoreComponent, number>> = {};
  const reasons: string[] = [];

  for (const e of evidence) {
    const w = WEIGHTS[e.component] ?? 0;
    const s = clamp01(e.strength);
    const contribution = w * s;
    score += contribution;
    byComponent[e.component] = (byComponent[e.component] ?? 0) + contribution;
    if (s > 0) reasons.push(e.detail);
  }

  return { score: Math.round(score * 10) / 10, reasons, byComponent };
}

// Squash a z-score into a 0..1 strength (saturating near |z| ~ 3).
export function zStrength(z: number): number {
  return clamp01(Math.abs(z) / 3);
}
