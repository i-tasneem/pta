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
export type { CalendarId } from './structure/session';
export { corridor, atmIV, basis } from './structure/structure';
export { RegimeClassifier } from './regime/regime';
export type { RegimeOptions } from './regime/regime';
export { WEIGHTS, scoreEvidence, clamp01, zStrength } from './scoring/scoring';
export type { ScoreComponent, Evidence, ScoreResult } from './scoring/scoring';
export { buildRiskPlan, premiumATRfromUnderlying } from './risk/risk';
export type { RiskInputs, RiskPlan } from './risk/risk';
export {
  ALL_ARCHETYPES,
  evaluateArchetypes,
  wallCapitulationBreak,
  wallAbsorptionFade,
  writerMigrationContinuation,
  basisFlowDivergenceReversal,
  expiryPin
} from './archetypes/archetypes';
export type { Archetype, ArchetypeContext, ArchetypeSignal } from './archetypes/archetypes';
export { SetupEngine } from './lifecycle/lifecycle';
export type { SetupStage, Hypothesis, Transition, SnapshotResult, LifecycleOptions, OpenEngineState } from './lifecycle/lifecycle';
export { ema, bollinger, computeLevels, EMA_PERIODS, BB_PERIOD, BB_STDDEV } from './levels/levels';
export type { Level, LevelKind, LevelTimeframe, LevelInputs, BollingerResult, Candle } from './levels/levels';
export { resolveExits } from './levels/confluence';
export type { ResolveInputs, ResolvedSide, ResolvedExits } from './levels/confluence';
