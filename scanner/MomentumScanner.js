// scanner/MomentumScanner.js
class MomentumScanner {
  constructor(instrument, eventBus, redisSchema) {
    this.instrument = instrument;
    this.eventBus = eventBus;
    this.schema = redisSchema;
    this.rsiHistory = [];
    this.volumeHistory = [];
  }

  async onIndicatorUpdate(data) {
    const state = await this.eventBus.hgetall(this.schema.marketState(this.instrument));
    const tick = await this.eventBus.hgetall(this.schema.tick(this.instrument));

    // RSI momentum
    const rsi5m = parseFloat(state.rsi_5m || 50);
    const rsi15m = parseFloat(state.rsi_15m || 50);
    this.rsiHistory.push({ tf: '5m', value: rsi5m, timestamp: Date.now() });
    if (this.rsiHistory.length > 20) this.rsiHistory.shift();

    const rsiSlope = this.calculateSlope(this.rsiHistory.map(h => h.value));

    // Volume momentum
    const volumeStrength = parseFloat(state.volumeStrength_5m || 50);
    this.volumeHistory.push({ value: volumeStrength, timestamp: Date.now() });
    if (this.volumeHistory.length > 20) this.volumeHistory.shift();

    const volumeSlope = this.calculateSlope(this.volumeHistory.map(h => h.value));

    // Candle pattern momentum
    const pattern = state.pattern_5m || 'NEUTRAL';
    const patternScore = this.scorePattern(pattern);

    // Composite momentum score (0-100)
    const momentumScore = Math.min(100, Math.max(0,
      (Math.abs(rsiSlope) * 20) +
      (Math.abs(volumeSlope) * 20) +
      (volumeStrength * 0.4) +
      (patternScore * 20)
    ));

    // Direction
    const momentumDirection = rsiSlope > 0 && volumeSlope > 0 ? 'BULLISH' :
                              rsiSlope < 0 && volumeSlope < 0 ? 'BEARISH' : 'MIXED';

    await this.eventBus.hset(this.schema.marketState(this.instrument), {
      momentumScore: momentumScore.toFixed(2),
      momentumDirection,
      rsiSlope: rsiSlope.toFixed(4),
      volumeSlope: volumeSlope.toFixed(4),
      patternScore: patternScore.toFixed(2)
    });

    await this.eventBus.publish('momentum:strength', this.instrument, {
      score: momentumScore,
      direction: momentumDirection,
      rsiSlope,
      volumeSlope
    });
  }

  calculateSlope(values) {
    if (values.length < 2) return 0;
    const n = values.length;
    const sumX = (n * (n - 1)) / 2;
    const sumY = values.reduce((a, b) => a + b, 0);
    const sumXY = values.reduce((sum, y, x) => sum + x * y, 0);
    const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;

    const denominator = n * sumX2 - sumX * sumX;
    if (denominator === 0) return 0;

    return (n * sumXY - sumX * sumY) / denominator;
  }

  scorePattern(pattern) {
    const scores = {
      'BULLISH_ENGULFING': 1.0,
      'HAMMER': 0.8,
      'MORNING_STAR': 0.9,
      'BEARISH_ENGULFING': -1.0,
      'SHOOTING_STAR': -0.8,
      'EVENING_STAR': -0.9,
      'DOJI': 0.0,
      'NEUTRAL': 0.0
    };
    return scores[pattern] || 0;
  }
}

module.exports = MomentumScanner;
