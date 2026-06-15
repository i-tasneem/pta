// Premium-space risk. Stops/targets are STRUCTURAL on the underlying (the
// price that proves the thesis wrong / the next objective), then translated
// into option-premium terms via delta+gamma. All risk is expressed in
// premium-ATR units, so each instrument self-calibrates — no fixed points.
import { Side } from '../types';

export interface RiskInputs {
  direction: Side;
  entryUnderlying: number;
  structuralStop: number;     // underlying price that invalidates the thesis
  structuralTarget: number;   // underlying objective (next wall, corridor edge)
  optionPremium: number;      // chosen strike LTP
  deltaSigned: number;        // CE > 0, PE < 0
  gamma: number;
  premiumATR: number;         // rolling premium-volatility unit for instrument
  minRR?: number;             // default 1.8
  maxRiskATR?: number;        // default 2.5 premium-ATR of risk allowed
}

export interface RiskPlan {
  entryPremium: number;
  stopPremium: number;
  targetPremium: number;
  riskPremium: number;
  rewardPremium: number;
  rr: number;
  riskInPremiumATR: number;
  valid: boolean;
  reason: string;
}

// Second-order premium change for an underlying move dS (signed).
function premiumDelta(dS: number, deltaSigned: number, gamma: number): number {
  return deltaSigned * dS + 0.5 * gamma * dS * dS;
}

export function buildRiskPlan(i: RiskInputs): RiskPlan {
  const minRR = i.minRR ?? 1.8;
  const maxRiskATR = i.maxRiskATR ?? 2.5;

  const stopDS = i.structuralStop - i.entryUnderlying;
  const targetDS = i.structuralTarget - i.entryUnderlying;

  const stopPremium = Math.max(0, i.optionPremium + premiumDelta(stopDS, i.deltaSigned, i.gamma));
  const targetPremium = Math.max(0, i.optionPremium + premiumDelta(targetDS, i.deltaSigned, i.gamma));

  const riskPremium = i.optionPremium - stopPremium;
  const rewardPremium = targetPremium - i.optionPremium;
  const rr = riskPremium > 0 ? rewardPremium / riskPremium : 0;
  const riskInPremiumATR = i.premiumATR > 0 ? riskPremium / i.premiumATR : Infinity;

  let valid = true;
  let reason = 'ok';
  if (riskPremium <= 0) {
    valid = false;
    reason = 'stop not adverse to entry in premium space';
  } else if (rr < minRR) {
    valid = false;
    reason = `R:R ${rr.toFixed(2)} < ${minRR}`;
  } else if (riskInPremiumATR > maxRiskATR) {
    valid = false;
    reason = `risk ${riskInPremiumATR.toFixed(1)} premium-ATR > ${maxRiskATR}`;
  }

  return {
    entryPremium: i.optionPremium,
    stopPremium: round2(stopPremium),
    targetPremium: round2(targetPremium),
    riskPremium: round2(riskPremium),
    rewardPremium: round2(rewardPremium),
    rr: round2(rr),
    riskInPremiumATR: round2(riskInPremiumATR),
    valid,
    reason
  };
}

// A simple premium-ATR proxy when a measured one isn't available yet.
export function premiumATRfromUnderlying(underlyingATR: number, deltaSigned: number): number {
  return Math.abs(underlyingATR * deltaSigned);
}

function round2(x: number): number {
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : 0;
}
