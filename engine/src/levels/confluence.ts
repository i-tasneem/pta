// Confluence resolver — places SL/target on the UNDERLYING by picking the
// strongest level among {OI walls, EMAs, Bollinger Bands}, preferring where 2+
// agree (a cluster). This is EXITS ONLY: it consumes the wall-based structural
// stop/target from the archetype plus the EMA/BB levels and returns refined
// underlying SL/target. The chosen underlying levels are still translated to the
// pinned option's premium downstream (risk.ts). Signal generation / archetype /
// regime / score are untouched.
//
// Rules (documented so behavior is predictable):
//  - Candidates for the STOP are levels on the protective side of price (below
//    for CE, above for PE); for the TARGET, levels on the favorable side (above
//    for CE, below for PE). The structural OI wall is ALWAYS a candidate (walls
//    stay in the mix, never replaced).
//  - Levels are clustered: ascending sort, a cluster spans at most `tolerance`
//    (max of a %-of-price band and an optional absolute/ATR band).
//  - Cluster strength = number of agreeing sources. The strongest cluster wins.
//    Tie-breaks, in order: (1) prefer the cluster that contains the OI wall
//    (anchored to thesis invalidation / objective); (2) STOP prefers the cluster
//    nearest the structural wall, TARGET prefers the cluster nearest to price
//    (first realistic objective).
//  - The chosen price within a cluster: CE takes the cluster minimum, PE the
//    maximum — i.e. the most-protective member for a stop and the first-touch
//    member for a target (these coincide given the side filter).
//  - NO-CONFLUENCE FALLBACK: when no EMA/BB level sits on the relevant side, the
//    only candidate is the wall, so the resolver returns the structural level
//    unchanged (fallback=true). If even the wall is unusable, it returns the raw
//    structural number.
import { Side } from '../types';
import { Level } from './levels';

export interface ResolveInputs {
  direction: Side;
  price: number;            // entry reference / current underlying
  structuralStop: number;   // wall-based stop from the archetype (underlying)
  structuralTarget: number; // wall-based target from the archetype (underlying)
  levels: Level[];          // EMA/BB levels on the underlying
  tolerancePct?: number;    // cluster span as a fraction of price (default 0.0012)
  toleranceAbs?: number;    // optional absolute cluster span (e.g. ~0.25*ATR)
}

export interface ResolvedSide {
  price: number;
  source: string;     // e.g. "5m 50-EMA + PE wall"
  members: string[];  // member labels in the winning cluster
  agreement: number;  // cluster size (number of agreeing sources)
  hasWall: boolean;   // winning cluster includes the OI wall
  fallback: boolean;  // true when only the structural wall backed the level
}

export interface ResolvedExits {
  stop: ResolvedSide;
  target: ResolvedSide;
}

interface Candidate {
  price: number;
  label: string;
  isWall: boolean;
}

const DEFAULT_TOL_PCT = 0.0012;

function tolerance(i: ResolveInputs): number {
  const pct = (i.tolerancePct ?? DEFAULT_TOL_PCT) * Math.abs(i.price);
  return Math.max(pct, i.toleranceAbs ?? 0);
}

// Group sorted candidates so each cluster spans at most `tol`.
function clusterize(cands: Candidate[], tol: number): Candidate[][] {
  const sorted = [...cands].sort((a, b) => a.price - b.price);
  const groups: Candidate[][] = [];
  let cur: Candidate[] = [];
  for (const c of sorted) {
    if (cur.length === 0 || c.price - cur[0].price <= tol) cur.push(c);
    else { groups.push(cur); cur = [c]; }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

const mean = (g: Candidate[]) => g.reduce((s, c) => s + c.price, 0) / g.length;

// Pick the strongest cluster: size, then wall-containing, then nearest to anchor.
function pickCluster(groups: Candidate[][], anchor: number): Candidate[] {
  let best = groups[0];
  for (let k = 1; k < groups.length; k++) {
    const g = groups[k];
    if (g.length !== best.length) { if (g.length > best.length) best = g; continue; }
    const gWall = g.some((c) => c.isWall);
    const bWall = best.some((c) => c.isWall);
    if (gWall !== bWall) { if (gWall) best = g; continue; }
    if (Math.abs(mean(g) - anchor) < Math.abs(mean(best) - anchor)) best = g;
  }
  return best;
}

function resolveSide(
  i: ResolveInputs,
  which: 'stop' | 'target',
  wallPrice: number,
  wallLabel: string
): ResolvedSide {
  const { direction, price } = i;
  // Protective side for a stop, favorable side for a target.
  const wantAbove = which === 'stop' ? direction === 'PE' : direction === 'CE';
  const onSide = (p: number) => (wantAbove ? p > price : p < price);

  const cands: Candidate[] = [];
  for (const l of i.levels) {
    if (Number.isFinite(l.price) && l.price > 0 && onSide(l.price)) {
      cands.push({ price: l.price, label: l.label, isWall: false });
    }
  }
  const wallUsable = Number.isFinite(wallPrice) && wallPrice > 0 && onSide(wallPrice);
  if (wallUsable) cands.push({ price: wallPrice, label: wallLabel, isWall: true });

  // Even the wall is off-side (degenerate archetype geometry): return raw level.
  if (cands.length === 0) {
    return {
      price: wallPrice,
      source: 'structural (raw)',
      members: [wallLabel],
      agreement: 0,
      hasWall: true,
      fallback: true
    };
  }

  const tol = tolerance(i);
  const groups = clusterize(cands, tol);
  const anchor = which === 'stop' ? (wallUsable ? wallPrice : price) : price;
  const winner = pickCluster(groups, anchor);

  // Within the winner, CE takes the minimum, PE the maximum (most-protective for
  // a stop, first-touch for a target — they coincide given the side filter).
  const chosenPrice = direction === 'CE'
    ? Math.min(...winner.map((c) => c.price))
    : Math.max(...winner.map((c) => c.price));

  const hasWall = winner.some((c) => c.isWall);
  const isFallback = winner.length === 1 && hasWall; // lone wall = no confluence
  // Label: indicator members first (nearest price first), wall last.
  const nonWall = winner.filter((c) => !c.isWall).map((c) => c.label);
  const ordered = hasWall ? [...nonWall, wallLabel] : nonWall;

  return {
    price: chosenPrice,
    source: isFallback ? 'wall (structural)' : ordered.join(' + '),
    members: ordered,
    agreement: winner.length,
    hasWall,
    fallback: isFallback
  };
}

export function resolveExits(i: ResolveInputs): ResolvedExits {
  // Wall sides: for a CE trade the stop is a support (PE wall) and the target a
  // resistance (CE wall); reversed for PE.
  const stopWallLabel = i.direction === 'CE' ? 'PE wall' : 'CE wall';
  const targetWallLabel = i.direction === 'CE' ? 'CE wall' : 'PE wall';

  // Degenerate price — nothing to resolve against; pass structural through.
  if (!Number.isFinite(i.price) || i.price <= 0) {
    return {
      stop: { price: i.structuralStop, source: 'wall (structural)', members: [stopWallLabel], agreement: 1, hasWall: true, fallback: true },
      target: { price: i.structuralTarget, source: 'wall (structural)', members: [targetWallLabel], agreement: 1, hasWall: true, fallback: true }
    };
  }

  return {
    stop: resolveSide(i, 'stop', i.structuralStop, stopWallLabel),
    target: resolveSide(i, 'target', i.structuralTarget, targetWallLabel)
  };
}
