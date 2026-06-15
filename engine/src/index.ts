// PTA V2 engine — public surface.
export * from './types';
export { RollingWindow } from './math/rolling';
export {
  PositioningTracker,
  localizedStrikes,
  splitOIVelocity,
  detectWalls,
  oiCentroid,
  easeOfMovement,
  classifyFlow
} from './analytics/positioning';
export type { TrackerOptions } from './analytics/positioning';
export { sessionPhase, istDate } from './structure/session';
export { corridor, atmIV, basis } from './structure/structure';
export { RegimeClassifier } from './regime/regime';
export type { RegimeOptions } from './regime/regime';
export { WEIGHTS, scoreEvidence, clamp01, zStrength } from './scoring/scoring';
export type { ScoreComponent, Evidence, ScoreResult } from './scoring/scoring';
export { buildRiskPlan, premiumATRfromUnderlying } from './risk/risk';
export type { RiskInputs, RiskPlan } from './risk/risk';
