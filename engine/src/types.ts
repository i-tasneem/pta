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

export interface PositioningAnalytics {
  ts: number;
  vCE: number;          // localized CE OI velocity (contracts/min)
  vPE: number;          // localized PE OI velocity
  zvCE: number;         // z-scored vs rolling baseline
  zvPE: number;
  netWriterFlow: number; // zvPE - zvCE; >0 bullish writer bias
  flowState: FlowState;
  priceDelta: number;
  easeOfMovement: number; // |price move| per future-volume unit; low = absorption
  ceWalls: Wall[];
  peWalls: Wall[];
  ceCentroid: number;   // OI-weighted CE strike (resistance anchor)
  peCentroid: number;   // OI-weighted PE strike (support anchor)
  ready: boolean;       // false during baseline warmup
}
