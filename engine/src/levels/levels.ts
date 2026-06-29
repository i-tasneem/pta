// Exit-level computation on the UNDERLYING. Pure functions: candle closes in,
// named price levels out. These are EMA(5,9,15,50,200) + BB(20,2) on 5m and 15m,
// plus a daily 200-EMA as a major level. They are EXITS ONLY — used by the
// confluence resolver to place SL/target. They never feed signal generation,
// archetype detection, regime, or scoring.
//
// EMA/BB semantics deliberately mirror scanner/IndicatorEngine.js so the engine
// and the live indicator path agree: EMA is SMA-seeded then exponentially
// smoothed; BB uses a population standard deviation over the last `period` closes.

export type LevelKind = 'EMA' | 'BB';
export type LevelTimeframe = '5m' | '15m' | 'daily';

export interface Candle {
  open?: number;
  high?: number;
  low?: number;
  close: number;
  volume?: number;
  timestamp?: number;
}

export interface Level {
  price: number;
  label: string;           // human-readable, e.g. "5m 50-EMA", "15m BB lower"
  kind: LevelKind;
  timeframe: LevelTimeframe;
}

export interface LevelInputs {
  fiveMin?: Candle[];
  fifteenMin?: Candle[];
  daily?: Candle[];
}

export const EMA_PERIODS = [5, 9, 15, 50, 200] as const;
export const BB_PERIOD = 20;
export const BB_STDDEV = 2;

// SMA-seeded exponential moving average. Returns null when there aren't enough
// closes (so a level simply doesn't appear, rather than reporting a fake 0).
export function ema(closes: number[], period: number): number | null {
  if (!closes || closes.length < period) return null;
  let acc = 0;
  for (let i = 0; i < period; i++) acc += closes[i];
  let val = acc / period;
  const k = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) {
    val = (closes[i] - val) * k + val;
  }
  return val;
}

export interface BollingerResult {
  upper: number;
  middle: number;
  lower: number;
}

// Bollinger Bands over the last `period` closes (population std dev), matching
// the live IndicatorEngine. Returns null when there aren't enough closes.
export function bollinger(closes: number[], period = BB_PERIOD, stdDev = BB_STDDEV): BollingerResult | null {
  if (!closes || closes.length < period) return null;
  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - middle) * (v - middle), 0) / period;
  const std = Math.sqrt(variance);
  return { upper: middle + stdDev * std, middle, lower: middle - stdDev * std };
}

function closesOf(candles?: Candle[]): number[] {
  if (!candles) return [];
  return candles.map((c) => Number(c.close)).filter((x) => Number.isFinite(x) && x > 0);
}

// Build the EMA(5,9,15,50,200)+BB(20,2) levels for one intraday timeframe.
function intradayLevels(closes: number[], tf: '5m' | '15m'): Level[] {
  const out: Level[] = [];
  for (const p of EMA_PERIODS) {
    const v = ema(closes, p);
    if (v != null) out.push({ price: v, label: `${tf} ${p}-EMA`, kind: 'EMA', timeframe: tf });
  }
  const bb = bollinger(closes);
  if (bb) {
    out.push({ price: bb.upper, label: `${tf} BB upper`, kind: 'BB', timeframe: tf });
    out.push({ price: bb.middle, label: `${tf} BB mid`, kind: 'BB', timeframe: tf });
    out.push({ price: bb.lower, label: `${tf} BB lower`, kind: 'BB', timeframe: tf });
  }
  return out;
}

// Compute every exit level from available candle history. Missing or too-short
// histories degrade gracefully — that timeframe's levels are simply omitted. The
// daily 200-EMA is the only daily level (the "major level"); skipped (and the
// reason recorded) when fewer than 200 daily candles exist.
export function computeLevels(input: LevelInputs): { levels: Level[]; notes: string[] } {
  const levels: Level[] = [];
  const notes: string[] = [];

  const fiveCloses = closesOf(input.fiveMin);
  const fifteenCloses = closesOf(input.fifteenMin);
  const dailyCloses = closesOf(input.daily);

  if (fiveCloses.length) levels.push(...intradayLevels(fiveCloses, '5m'));
  else notes.push('no 5m candles');
  if (fifteenCloses.length) levels.push(...intradayLevels(fifteenCloses, '15m'));
  else notes.push('no 15m candles');

  const dailyEma200 = ema(dailyCloses, 200);
  if (dailyEma200 != null) {
    levels.push({ price: dailyEma200, label: 'daily 200-EMA', kind: 'EMA', timeframe: 'daily' });
  } else {
    notes.push(`daily 200-EMA skipped (${dailyCloses.length} daily candles, need 200)`);
  }

  return { levels, notes };
}
