// signals/Gate1RegimeValidation.js
const DecisionGate = require('./DecisionGate');

class Gate1RegimeValidation extends DecisionGate {
  constructor(config) {
    super('Gate1_RegimeValidation', 1);
    this.config = config;
  }

  async evaluate(context) {
    const { state } = context;
    const regime = state.regime || 'CONSOLIDATING';
    const regimeConfidence = parseFloat(state.regimeConfidence || 0);

    // Check unfavorable regimes
    if (this.config.unfavorableRegimes.includes(regime)) {
      return this.createFailResult(`Regime ${regime} prohibits trading`);
    }

    // High volatility with low liquidity
    if (regime === 'HIGH_VOLATILITY') {
      const liquidityScore = parseFloat(state.liquidityScore || 0);
      if (liquidityScore < 50) {
        return this.createFailResult('High volatility with insufficient liquidity');
      }
    }

    // Low confidence regime
    if (regimeConfidence < this.config.minConfidence) {
      return this.createFailResult(`Regime confidence ${regimeConfidence} below threshold ${this.config.minConfidence}`);
    }

    return this.createPassResult();
  }
}

module.exports = Gate1RegimeValidation;
