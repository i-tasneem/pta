// regime/MultiTimeframeEngine.js
class MultiTimeframeEngine {
  constructor(eventBus, redisSchema) {
    this.eventBus = eventBus;
    this.schema = redisSchema;
  }

  async calculateAgreement(instrument) {
    const state = await this.eventBus.hgetall(this.schema.marketState(instrument));
    const tfs = ['1m', '3m', '5m', '15m', '30m'];
    const directions = [];

    for (const tf of tfs) {
      const ema5 = parseFloat(state[`ema5_${tf}`] || 0);
      const ema13 = parseFloat(state[`ema13_${tf}`] || 0);
      const ema21 = parseFloat(state[`ema21_${tf}`] || 0);

      if (ema5 > ema13 && ema13 > ema21) directions.push('BULLISH');
      else if (ema5 < ema13 && ema13 < ema21) directions.push('BEARISH');
      else directions.push('NEUTRAL');
    }

    const bullishCount = directions.filter(d => d === 'BULLISH').length;
    const bearishCount = directions.filter(d => d === 'BEARISH').length;
    const neutralCount = directions.filter(d => d === 'NEUTRAL').length;

    const maxAgreement = Math.max(bullishCount, bearishCount);
    const agreementScore = maxAgreement / 5;

    const direction = bullishCount > bearishCount ? 'BULLISH' :
                      bearishCount > bullishCount ? 'BEARISH' : 'NEUTRAL';

    await this.eventBus.hset(this.schema.marketState(instrument), {
      tfAgreement: agreementScore.toFixed(2),
      tfDirection: direction,
      tfBreakdown: JSON.stringify(directions),
      bullishTimeframes: bullishCount,
      bearishTimeframes: bearishCount,
      neutralTimeframes: neutralCount
    });

    return { direction, agreementScore, breakdown: directions };
  }

  async validateTrendAlignment(instrument, requiredDirection) {
    const state = await this.eventBus.hgetall(this.schema.marketState(instrument));
    const breakdown = JSON.parse(state.tfBreakdown || '[]');
    const alignedCount = breakdown.filter(d => d === requiredDirection).length;
    return alignedCount >= 3;
  }
}

module.exports = MultiTimeframeEngine;
