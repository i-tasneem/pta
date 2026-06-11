// signals/Gate3MomentumValidation.js
const DecisionGate = require('./DecisionGate');

class Gate3MomentumValidation extends DecisionGate {
  constructor(config) {
    super('Gate3_MomentumValidation', 3);
    this.config = config;
  }

  async evaluate(context) {
    const { state, opportunity } = context;
    const direction = opportunity.direction;

    // RSI check
    const rsi5m = parseFloat(state.rsi_5m || 50);
    const rsi15m = parseFloat(state.rsi_15m || 50);
    const maxRSI = this.config.maxRSI[direction] || (direction === 'CE' ? 75 : 25);

    if (direction === 'CE') {
      if (rsi5m > maxRSI || rsi15m > 70) {
        return this.createFailResult(`RSI overbought: 5m=${rsi5m.toFixed(1)}, 15m=${rsi15m.toFixed(1)}`);
      }
    } else {
      if (rsi5m < maxRSI || rsi15m < 30) {
        return this.createFailResult(`RSI oversold: 5m=${rsi5m.toFixed(1)}, 15m=${rsi15m.toFixed(1)}`);
      }
    }

    // Volume check
    const volumeStrength = parseFloat(state.volumeStrength_5m || 0);
    if (volumeStrength < this.config.minVolumeStrength) {
      return this.createFailResult(`Volume strength ${volumeStrength.toFixed(1)} below threshold ${this.config.minVolumeStrength}`);
    }

    // Candle pattern check
    const pattern = state.pattern_5m || 'NEUTRAL';
    const unfavorablePatterns = direction === 'CE'
      ? ['SHOOTING_STAR', 'BEARISH_ENGULFING', 'DOJI']
      : ['HAMMER', 'BULLISH_ENGULFING', 'DOJI'];

    if (unfavorablePatterns.includes(pattern)) {
      return this.createFailResult(`Unfavorable candle pattern: ${pattern}`);
    }

    return this.createPassResult();
  }
}

module.exports = Gate3MomentumValidation;
