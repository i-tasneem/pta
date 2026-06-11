// signals/Gate2TrendValidation.js
const DecisionGate = require('./DecisionGate');

class Gate2TrendValidation extends DecisionGate {
  constructor(config) {
    super('Gate2_TrendValidation', 2);
    this.config = config;
  }

  async evaluate(context) {
    const { state, opportunity } = context;
    const direction = opportunity.direction;

    // Multi-timeframe EMA alignment
    const tfBreakdown = JSON.parse(state.tfBreakdown || '[]');
    const alignedCount = tfBreakdown.filter(d => d === direction).length;

    if (alignedCount < this.config.minTimeframesAligned) {
      return this.createFailResult(`Only ${alignedCount}/5 timeframes aligned ${direction}`);
    }

    // HTF (30m) must agree
    const ema30m = this.checkEMAAlignment(state, '30m');
    if (ema30m !== direction && ema30m !== 'NEUTRAL') {
      return this.createFailResult(`HTF (30m) trend ${ema30m} conflicts with ${direction}`);
    }

    return this.createPassResult();
  }

  checkEMAAlignment(state, tf) {
    const ema5 = parseFloat(state[`ema5_${tf}`] || 0);
    const ema13 = parseFloat(state[`ema13_${tf}`] || 0);
    const ema21 = parseFloat(state[`ema21_${tf}`] || 0);

    if (ema5 > ema13 && ema13 > ema21) return 'BULLISH';
    if (ema5 < ema13 && ema13 < ema21) return 'BEARISH';
    return 'NEUTRAL';
  }
}

module.exports = Gate2TrendValidation;
