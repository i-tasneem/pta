// regime/RegimeEngine.js
class RegimeEngine {
  constructor(eventBus, redisSchema) {
    this.eventBus = eventBus;
    this.schema = redisSchema;
  }

  async detectRegime(instrument) {
    const state = await this.eventBus.hgetall(this.schema.marketState(instrument));
    if (!state || Object.keys(state).length === 0) return { regime: 'CONSOLIDATING', confidence: 0.5 };

    // Multi-timeframe EMA alignment
    const ema5m = this.checkEMAAlignment(state, '5m');
    const ema15m = this.checkEMAAlignment(state, '15m');
    const ema30m = this.checkEMAAlignment(state, '30m');

    // ATR state
    const atr5m = parseFloat(state.atr_5m || 0);
    const atr30m = parseFloat(state.atr_30m || 0);
    const atrRatio = atr30m > 0 ? atr5m / atr30m : 1;

    // RSI state
    const rsi5m = parseFloat(state.rsi_5m || 50);
    const rsi15m = parseFloat(state.rsi_15m || 50);

    // Bollinger Band width
    const bbWidth5m = parseFloat(state.bbWidth_5m || 0);
    const bbWidth30m = parseFloat(state.bbWidth_30m || 0);
    const bbRatio = bbWidth30m > 0 ? bbWidth5m / bbWidth30m : 1;

    // Volume
    const volumeStrength = parseFloat(state.volumeStrength_5m || 0);

    // Trend strength
    const trendStrength = parseFloat(state.trendStrength || 0);

    // Decision tree
    let regime = 'CONSOLIDATING';
    let confidence = 0.5;

    if (atrRatio > 1.5 && bbRatio > 1.3) {
      regime = 'HIGH_VOLATILITY';
      confidence = 0.8;
    } else if (atrRatio < 0.7 && bbRatio < 0.7) {
      regime = 'LOW_VOLATILITY';
      confidence = 0.7;
    } else if (ema5m === 'BULLISH' && ema15m === 'BULLISH' && ema30m === 'BULLISH') {
      regime = 'BULLISH';
      confidence = trendStrength > 70 ? 0.9 : 0.7;
    } else if (ema5m === 'BEARISH' && ema15m === 'BEARISH' && ema30m === 'BEARISH') {
      regime = 'BEARISH';
      confidence = trendStrength > 70 ? 0.9 : 0.7;
    } else if (this.isRangeBound(state)) {
      regime = 'RANGE_BOUND';
      confidence = 0.6;
    } else if (this.isBreakoutSetup(state, volumeStrength, atrRatio)) {
      regime = 'BREAKOUT_SETUP';
      confidence = 0.7;
    } else if (this.isReversalSetup(state, rsi5m, rsi15m)) {
      regime = 'REVERSAL_SETUP';
      confidence = 0.6;
    }

    // Write to Redis
    await this.eventBus.hset(this.schema.marketState(instrument), {
      regime,
      regimeConfidence: confidence.toFixed(2),
      regimeReason: this.getRegimeReason(regime, state),
      atrRatio: atrRatio.toFixed(2),
      bbRatio: bbRatio.toFixed(2),
      timestamp: Date.now()
    });

    // Emit regime change if different
    const previousRegime = await this.eventBus.hget(this.schema.marketState(instrument), 'regime');
    if (previousRegime !== regime) {
      await this.eventBus.publish('regime:change', instrument, {
        from: previousRegime,
        to: regime,
        confidence
      });
    }

    return { regime, confidence };
  }

  checkEMAAlignment(state, tf) {
    const ema5 = parseFloat(state[`ema5_${tf}`] || 0);
    const ema13 = parseFloat(state[`ema13_${tf}`] || 0);
    const ema21 = parseFloat(state[`ema21_${tf}`] || 0);

    if (ema5 > ema13 && ema13 > ema21) return 'BULLISH';
    if (ema5 < ema13 && ema13 < ema21) return 'BEARISH';
    return 'NEUTRAL';
  }

  isRangeBound(state) {
    const trendStrength = parseFloat(state.trendStrength || 0);
    const bbWidth = parseFloat(state.bbWidth_5m || 0);
    return trendStrength < 30 && bbWidth < 0.05;
  }

  isBreakoutSetup(state, volumeStrength, atrRatio) {
    const bbWidth = parseFloat(state.bbWidth_5m || 0);
    const breakoutProb = parseFloat(state.breakoutProbability || 0);
    return bbWidth < 0.03 && volumeStrength > 60 && atrRatio < 1.0;
  }

  isReversalSetup(state, rsi5m, rsi15m) {
    const reversalProb = parseFloat(state.reversalProbability || 0);
    const pattern = state.pattern_5m || 'NEUTRAL';
    const reversalPatterns = ['MORNING_STAR', 'EVENING_STAR', 'HAMMER', 'SHOOTING_STAR'];
    return reversalProb > 60 || reversalPatterns.includes(pattern);
  }

  getRegimeReason(regime, state) {
    const reasons = {
      'BULLISH': 'EMA aligned bullish, momentum positive',
      'BEARISH': 'EMA aligned bearish, momentum negative',
      'CONSOLIDATING': 'Price moving sideways, low momentum',
      'RANGE_BOUND': 'Clear support/resistance levels',
      'BREAKOUT_SETUP': 'Compression pattern, volume building',
      'REVERSAL_SETUP': 'Divergence pattern, exhaustion signals',
      'HIGH_VOLATILITY': 'ATR expanding, wide BB',
      'LOW_VOLATILITY': 'ATR contracting, narrow BB'
    };
    return reasons[regime] || 'Indeterminate';
  }
}

module.exports = RegimeEngine;
