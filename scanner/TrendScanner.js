// scanner/TrendScanner.js
class TrendScanner {
  constructor(instrument, eventBus, redisSchema) {
    this.instrument = instrument;
    this.eventBus = eventBus;
    this.schema = redisSchema;
  }

  async onIndicatorUpdate(data) {
    const state = await this.eventBus.hgetall(this.schema.marketState(this.instrument));

    // Calculate EMA alignment for each timeframe
    const tfs = ['1m', '3m', '5m', '15m', '30m'];
    const alignments = {};
    let bullishCount = 0;
    let bearishCount = 0;

    for (const tf of tfs) {
      const ema5 = parseFloat(state[`ema5_${tf}`] || 0);
      const ema13 = parseFloat(state[`ema13_${tf}`] || 0);
      const ema21 = parseFloat(state[`ema21_${tf}`] || 0);

      if (ema5 > ema13 && ema13 > ema21) {
        alignments[tf] = 'BULLISH';
        bullishCount++;
      } else if (ema5 < ema13 && ema13 < ema21) {
        alignments[tf] = 'BEARISH';
        bearishCount++;
      } else {
        alignments[tf] = 'NEUTRAL';
      }
    }

    // Overall trend direction
    const maxAligned = Math.max(bullishCount, bearishCount);
    const trendDirection = bullishCount > bearishCount ? 'BULLISH' :
                           bearishCount > bullishCount ? 'BEARISH' : 'NEUTRAL';

    // Trend strength (0-100)
    const trendStrength = (maxAligned / 5) * 100;

    // HTF bias (15m + 30m)
    const htfBullish = (alignments['15m'] === 'BULLISH' ? 1 : 0) + (alignments['30m'] === 'BULLISH' ? 1 : 0);
    const htfBearish = (alignments['15m'] === 'BEARISH' ? 1 : 0) + (alignments['30m'] === 'BEARISH' ? 1 : 0);
    const htfBias = htfBullish > htfBearish ? 'BULLISH' : htfBearish > htfBullish ? 'BEARISH' : 'NEUTRAL';

    // Write to market_state
    await this.eventBus.hset(this.schema.marketState(this.instrument), {
      trendDirection,
      trendStrength: trendStrength.toFixed(2),
      htfBias,
      emaAlignment: JSON.stringify(alignments),
      bullishTimeframes: bullishCount,
      bearishTimeframes: bearishCount
    });

    // Publish trend update
    await this.eventBus.publish('trend:strength', this.instrument, {
      direction: trendDirection,
      strength: trendStrength,
      htfBias,
      alignments
    });
  }
}

module.exports = TrendScanner;
