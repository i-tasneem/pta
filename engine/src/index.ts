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
