// opportunity/OpportunityQualityEngine.js
class OpportunityQualityEngine {
  constructor(eventBus, redisSchema, config) {
    this.eventBus = eventBus;
    this.schema = redisSchema;
    this.config = config.opportunity;
    this.weights = config.opportunity.weights;
  }

  async calculateScore(instrument) {
    const state = await this.eventBus.hgetall(this.schema.marketState(instrument));
    const chain = await this.eventBus.hgetall(this.schema.optionChain(instrument));
    const tick = await this.eventBus.hgetall(this.schema.tick(instrument));

    if (!state || Object.keys(state).length === 0) return null;

    // Component scores (each 0-100)
    const trendScore = this.calculateTrendScore(state);
    const momentumScore = this.calculateMomentumScore(state);
    const volumeScore = this.calculateVolumeScore(state);
    const oiScore = this.calculateOIScore(state);
    const breakoutScore = this.calculateBreakoutScore(state);
    const reversalScore = this.calculateReversalScore(state);
    const liquidityScore = this.calculateLiquidityScore(tick, chain);
    const spreadScore = this.calculateSpreadScore(tick, chain);
    const riskRewardScore = this.calculateRiskRewardScore(state);

    // Weighted composite
    const score =
      trendScore * this.weights.trendStrength +
      momentumScore * this.weights.momentumStrength +
      volumeScore * this.weights.volumeStrength +
      oiScore * this.weights.oiStrength +
      breakoutScore * this.weights.breakoutProbability +
      reversalScore * this.weights.reversalProbability +
      liquidityScore * this.weights.liquidityScore +
      spreadScore * this.weights.spreadQuality +
      riskRewardScore * this.weights.riskRewardRatio;

    // Regime multiplier
    const regime = state.regime || 'CONSOLIDATING';
    const regimeMultiplier = this.getRegimeMultiplier(regime);
    const finalScore = Math.min(100, score * regimeMultiplier);

    // Determine direction
    const direction = this.inferDirection(state);

    // Determine opportunity state
    let opportunityState = 'WATCHING';
    if (finalScore >= this.config.highPotentialThreshold) opportunityState = 'HIGH_POTENTIAL';
    else if (finalScore >= this.config.triggerThreshold && this.isApproachingTrigger(state)) {
      opportunityState = 'HIGH_POTENTIAL';
    }

    // Calculate zones
    const atr = parseFloat(state.atr_5m || 50);
    const ltp = parseFloat(tick.ltp || 0);
    const entryZone = this.calculateEntryZone(ltp, atr, direction);
    const stopZone = this.calculateStopZone(ltp, atr, direction);
    const targetZone = this.calculateTargetZone(ltp, atr, direction);

    // Stable id (no timestamp): zadd updates the same member in place and
    // Gate 6 can look the entry up again
    const opportunityId = `${instrument}|${direction}`;
    const oppositeId = `${instrument}|${direction === 'CE' ? 'PE' : 'CE'}`;

    // Write to Redis
    await this.eventBus.hset(this.schema.opportunity(instrument), {
      instrument,
      opportunityId,
      score: finalScore.toFixed(2),
      direction,
      regime,
      trendScore: trendScore.toFixed(2),
      momentumScore: momentumScore.toFixed(2),
      volumeScore: volumeScore.toFixed(2),
      oiScore: oiScore.toFixed(2),
      breakoutScore: breakoutScore.toFixed(2),
      reversalScore: reversalScore.toFixed(2),
      liquidityScore: liquidityScore.toFixed(2),
      spreadScore: spreadScore.toFixed(2),
      riskRewardScore: riskRewardScore.toFixed(2),
      state: opportunityState,
      entryZone: JSON.stringify(entryZone),
      stopZone: JSON.stringify(stopZone),
      targetZone: JSON.stringify(targetZone),
      timestamp: Date.now(),
      lastUpdated: Date.now()
    });

    await this.eventBus.expire(this.schema.opportunity(instrument), 300);

    // Update leaderboard; the opposite direction can't be valid simultaneously
    await this.eventBus.zrem(this.schema.leaderboard(), oppositeId);
    if (finalScore >= this.config.minScore) {
      await this.eventBus.zadd(this.schema.leaderboard(), finalScore, opportunityId);
    } else {
      await this.eventBus.zrem(this.schema.leaderboard(), opportunityId);
    }

    // Trim leaderboard
    await this.eventBus.zremrangebyrank(this.schema.leaderboard(), 0, -51);

    // Publish event
    await this.eventBus.publish('opportunity:score', instrument, {
      score: finalScore,
      direction,
      state: opportunityState,
      opportunityId
    });

    return { score: finalScore, direction, state: opportunityState, opportunityId };
  }

  calculateTrendScore(state) {
    const trendStrength = parseFloat(state.trendStrength || 0);
    const htfBias = state.htfBias || 'NEUTRAL';
    const tfAgreement = parseFloat(state.tfAgreement || 0);
    return Math.min(100, trendStrength * 0.6 + tfAgreement * 40);
  }

  calculateMomentumScore(state) {
    return parseFloat(state.momentumScore || 0);
  }

  calculateVolumeScore(state) {
    return parseFloat(state.volumeStrength_5m || 0);
  }

  calculateOIScore(state) {
    const oiVelocity = parseFloat(state.oiVelocity || 0);
    const pcrTrend = state.pcrTrend || 'NEUTRAL';
    const oiPattern = state.oiPattern || 'NEUTRAL';

    let score = 50;
    score += Math.min(30, Math.abs(oiVelocity) / 100);
    if (pcrTrend !== 'NEUTRAL') score += 10;
    if (oiPattern === 'FRESH_BUILDUP') score += 15;
    if (oiPattern === 'UNWINDING') score -= 15;

    return Math.min(100, Math.max(0, score));
  }

  calculateBreakoutScore(state) {
    const bbWidth = parseFloat(state.bbWidth_5m || 0);
    const atr = parseFloat(state.atr_5m || 0);
    const volume = parseFloat(state.volumeStrength_5m || 0);

    if (bbWidth < 0.03 && volume > 70) return 85;
    if (bbWidth < 0.05 && volume > 60) return 70;
    return 40;
  }

  calculateReversalScore(state) {
    const rsi = parseFloat(state.rsi_5m || 50);
    const pattern = state.pattern_5m || 'NEUTRAL';
    const reversalPatterns = ['MORNING_STAR', 'EVENING_STAR', 'HAMMER', 'SHOOTING_STAR'];

    let score = 30;
    if (rsi > 70 || rsi < 30) score += 25;
    if (reversalPatterns.includes(pattern)) score += 30;
    return Math.min(100, score);
  }

  calculateLiquidityScore(tick, chain) {
    const bid = parseFloat(tick.bid || 0);
    const ask = parseFloat(tick.ask || 0);
    const ltp = parseFloat(tick.ltp || 1);
    const spread = ltp > 0 ? ((ask - bid) / ltp) * 100 : 0;

    if (spread < 1) return 95;
    if (spread < 2) return 80;
    if (spread < 3) return 65;
    if (spread < 5) return 45;
    return 25;
  }

  calculateSpreadScore(tick, chain) {
    return this.calculateLiquidityScore(tick, chain);
  }

  calculateRiskRewardScore(state) {
    const atr = parseFloat(state.atr_5m || 50);
    const bbUpper = parseFloat(state.bbUpper_5m || 0);
    const bbLower = parseFloat(state.bbLower_5m || 0);

    if (bbUpper === 0 || bbLower === 0) return 50;

    const range = bbUpper - bbLower;
    const risk = atr * 1.5;
    const reward = range * 0.5;

    if (risk === 0) return 50;
    const ratio = reward / risk;

    if (ratio >= 2.0) return 95;
    if (ratio >= 1.5) return 80;
    if (ratio >= 1.0) return 60;
    return 40;
  }

  inferDirection(state) {
    const trendDirection = state.trendDirection || 'NEUTRAL';
    const momentumDirection = state.momentumDirection || 'NEUTRAL';
    const htfBias = state.htfBias || 'NEUTRAL';

    const bullishSignals = [trendDirection, momentumDirection, htfBias].filter(d => d === 'BULLISH').length;
    const bearishSignals = [trendDirection, momentumDirection, htfBias].filter(d => d === 'BEARISH').length;

    if (bullishSignals > bearishSignals) return 'CE';
    if (bearishSignals > bullishSignals) return 'PE';
    return 'CE'; // Default
  }

  isApproachingTrigger(state) {
    const ltp = parseFloat(state.ltp || 0);
    const vwap = parseFloat(state.vwap_5m || 0);
    const bbUpper = parseFloat(state.bbUpper_5m || 0);
    const bbLower = parseFloat(state.bbLower_5m || 0);

    if (!ltp || !vwap) return false;

    const nearVWAP = Math.abs(ltp - vwap) < parseFloat(state.atr_5m || 50) * 0.3;
    const nearBB = Math.abs(ltp - bbUpper) < parseFloat(state.atr_5m || 50) * 0.3 ||
                   Math.abs(ltp - bbLower) < parseFloat(state.atr_5m || 50) * 0.3;

    return nearVWAP || nearBB;
  }

  calculateEntryZone(ltp, atr, direction) {
    if (direction === 'CE') {
      return [ltp, ltp + atr * 0.3];
    } else {
      return [ltp - atr * 0.3, ltp];
    }
  }

  calculateStopZone(ltp, atr, direction) {
    if (direction === 'CE') {
      return [ltp - atr * 1.5, ltp - atr * 1.2];
    } else {
      return [ltp + atr * 1.2, ltp + atr * 1.5];
    }
  }

  calculateTargetZone(ltp, atr, direction) {
    if (direction === 'CE') {
      return [ltp + atr * 2.0, ltp + atr * 3.0];
    } else {
      return [ltp - atr * 3.0, ltp - atr * 2.0];
    }
  }

  getRegimeMultiplier(regime) {
    const multipliers = {
      'BULLISH': 1.0,
      'BEARISH': 1.0,
      'BREAKOUT_SETUP': 1.0,
      'REVERSAL_SETUP': 0.9,
      'CONSOLIDATING': 0.7,
      'RANGE_BOUND': 0.8,
      'HIGH_VOLATILITY': 0.6,
      'LOW_VOLATILITY': 0.8
    };
    return multipliers[regime] || 0.7;
  }
}

module.exports = OpportunityQualityEngine;
