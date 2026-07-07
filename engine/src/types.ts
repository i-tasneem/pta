// Shared domain types for the V2 positioning engine.

export interface OptionLeg {
  ltp: number;
  oi: number;
  volume: number;
  iv: number;
  delta: number;
}

export interface Strike {
  strike: number;
  ce: OptionLeg;
  pe: OptionLeg;
}

export interface ChainSnapshot {
  instrument: string;
  ts: number; // epoch ms
  spot: number;
  fut?: number;
  futVolume?: number; // cumulative day volume of the paired future
  atmStrike: number;
  pcr: number;
  maxPain?: number;
  totalCeOi: number;
  totalPeOi: number;
  expiry: string;
  strikes: Strike[];
}

export type Side = 'CE' | 'PE';

// Directional positioning read (see pta-signal-engine-design).
export type FlowState =
  | 'SQUEEZE_FUEL_BULL'  // price up + CE writers fleeing — strongest bull
  | 'CAPITULATION_BEAR'  // price down + PE writers fleeing — strongest bear
  | 'BULL_CONFIRM'       // price up + net put writing
  | 'BEAR_CONFIRM'       // price down + net call writing
  | 'CAPPED_FADE'        // price up into call writing — rally being sold
  | 'PUT_KNIFE'          // price down into put writing — catching a knife
  | 'CORRIDOR'           // both sides writing — range forming
  | 'NEUTRAL'
  | 'WARMUP';            // not enough history yet

export interface Wall {
  strike: number;
  oi: number;
  z: number;
  side: Side;
}

export type SessionPhase = 'PRE' | 'OPEN' | 'MORNING' | 'MIDDAY' | 'AFTERNOON' | 'CLOSE' | 'POST';

export type Regime =
  | 'TREND_BULL'
  | 'TREND_BEAR'
  | 'CORRIDOR'
  | 'SQUEEZE_WATCH'
  | 'EVENT_CHAOS'
  | 'EXPIRY_GRAVITY'
  | 'UNCLEAR';

export type ArchetypeName =
  | 'WALL_CAPITULATION_BREAK'
  | 'WALL_ABSORPTION_FADE'
  | 'WRITER_MIGRATION_CONTINUATION'
  | 'BASIS_FLOW_DIVERGENCE_REVERSAL'
  | 'EXPIRY_PIN';

export interface Corridor {
  support: number | null;     // nearest PE wall below spot
  resistance: number | null;  // nearest CE wall above spot
  width: number | null;
  widthPct: number | null;
}

export interface RegimeResult {
  regime: Regime;
  allowed: ArchetypeName[];   // archetypes this regime permits to exist
  reason: string;
  corridor: Corridor;
  sessionPhase: SessionPhase;
  atmIV: number;
  isExpiryDay: boolean;
  basis: number;
}

export interface PositioningAnalytics {
  ts: number;
  vCE: number;          // localized CE OI velocity (contracts/min)
  vPE: number;          // localized PE OI velocity
  zvCE: number;         // z-scored vs rolling baseline
  zvPE: number;
  netWriterFlow: number; // zvPE - zvCE; >0 bullish writer bias
  flowState: FlowState;
  priceDelta: number;
  smoothedPriceDelta: number; // spot change over the last ~3 snapshots — flow/regime direction reads use this, not the single-snapshot delta
  easeOfMovement: number; // |price move| per future-volume unit; low = absorption
  ceWalls: Wall[];
  peWalls: Wall[];
  ceCentroid: number;   // OI-weighted CE strike (resistance anchor)
  peCentroid: number;   // OI-weighted PE strike (support anchor)
  ready: boolean;       // false during baseline warmup
}
