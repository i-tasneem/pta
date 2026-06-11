// scanner/TickScanner.js
class TickScanner {
  constructor(instrument, eventBus, redisSchema) {
    this.instrument = instrument;
    this.eventBus = eventBus;
    this.schema = redisSchema;
    this.runningCandle = null;
    this.candleStartTime = null;
    this.tickCount = 0;
    this.cumulativeVolume = 0;
    this.cumulativeTypicalPriceVolume = 0;
  }

  async onTick(tick) {
    const now = tick.timestamp || Date.now();
    const minuteStart = Math.floor(now / 60000) * 60000;

    // Check if we need to start a new candle
    if (!this.runningCandle || minuteStart !== this.candleStartTime) {
      if (this.runningCandle) {
        await this.emitCandleClose(this.runningCandle, this.candleStartTime);
      }
      this.runningCandle = {
        open: tick.ltp,
        high: tick.ltp,
        low: tick.ltp,
        close: tick.ltp,
        volume: tick.volume || 0
      };
      this.candleStartTime = minuteStart;
      this.tickCount = 1;
      this.cumulativeVolume = tick.volume || 0;
      this.cumulativeTypicalPriceVolume = tick.ltp * (tick.volume || 0);
    } else {
      // Update running candle
      this.runningCandle.high = Math.max(this.runningCandle.high, tick.ltp);
      this.runningCandle.low = Math.min(this.runningCandle.low, tick.ltp);
      this.runningCandle.close = tick.ltp;
      this.runningCandle.volume += (tick.volume || 0);
      this.tickCount++;
      this.cumulativeVolume += (tick.volume || 0);
      this.cumulativeTypicalPriceVolume += tick.ltp * (tick.volume || 0);
    }

    // Update real-time VWAP in tick hash
    const vwap = this.cumulativeVolume > 0
      ? this.cumulativeTypicalPriceVolume / this.cumulativeVolume
      : tick.ltp;

    await this.eventBus.hset(this.schema.tick(this.instrument), {
      vwap: vwap.toFixed(2),
      lastTickTime: now
    });
  }

  async emitCandleClose(candle, startTime) {
    const closeTime = startTime + 60000;
    const key = this.schema.ohlc('1m', this.instrument);

    await this.eventBus.xadd(key, '*', {
      open: candle.open.toFixed(2),
      high: candle.high.toFixed(2),
      low: candle.low.toFixed(2),
      close: candle.close.toFixed(2),
      volume: candle.volume,
      timestamp: closeTime
    });

    // Trim stream
    await this.eventBus.xtrim(key, 'MAXLEN', 500);

    // Publish event
    await this.eventBus.publish('candle:close:1m', this.instrument, {
      ...candle,
      timestamp: closeTime
    });
  }

  getRunningCandle() {
    return this.runningCandle;
  }
}

module.exports = TickScanner;
