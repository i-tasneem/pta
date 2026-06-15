import { ChainSnapshot, Corridor, PositioningAnalytics } from '../types';

// The price corridor implied by the nearest walls on each side of spot.
export function corridor(a: PositioningAnalytics, spot: number): Corridor {
  const resistances = a.ceWalls
    .filter((w) => w.strike > spot)
    .sort((x, y) => x.strike - y.strike);
  const supports = a.peWalls
    .filter((w) => w.strike < spot)
    .sort((x, y) => y.strike - x.strike);

  const resistance = resistances.length ? resistances[0].strike : null;
  const support = supports.length ? supports[0].strike : null;
  const width = resistance != null && support != null ? resistance - support : null;
  const widthPct = width != null && spot > 0 ? width / spot : null;

  return { support, resistance, width, widthPct };
}

// Average implied vol of the ATM call/put — the engine's volatility gauge.
export function atmIV(snap: ChainSnapshot): number {
  if (snap.strikes.length === 0) return 0;
  let atm = snap.strikes[0];
  for (const s of snap.strikes) {
    if (Math.abs(s.strike - snap.atmStrike) < Math.abs(atm.strike - snap.atmStrike)) atm = s;
  }
  const ce = atm.ce.iv || 0;
  const pe = atm.pe.iv || 0;
  const both = (ce > 0 ? 1 : 0) + (pe > 0 ? 1 : 0);
  return both === 0 ? 0 : (ce + pe) / both;
}

// Futures premium/discount to spot.
export function basis(snap: ChainSnapshot): number {
  if (snap.fut == null || snap.fut === 0) return 0;
  return snap.fut - snap.spot;
}
