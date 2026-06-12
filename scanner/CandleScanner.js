// scanner/CandleScanner.js
const IndicatorEngine = require('./IndicatorEngine');

class CandleScanner {
  constructor(instrument, eventBus, redisSchema, timeframes = ['1m', '3m', '5m', '15m', '30m']) {
    this.instrument = instrument;
    this.eventBus = eventBus;
    this.schema = redisSchema;
    this.timeframes = timeframes;
    this.indicators = new IndicatorEngine();
    this.runningCandles = new Map(); // tf -> {candle, startTime}
  }

  async onCandleClose(tf, candle) {
    // Build higher timeframes from 1m candles
    if (tf === '1m') {
      await this.buildHigherTimeframes(candle);
    }

    await this.recomputeIndicators(tf);
  }

  // Compute indicators from whatever is in the candle stream; also used to
  // prime indicators from bootstrapped history without synthetic candle events
  async recomputeIndicators(tf) {
    const streamKey = this.schema.ohlc(tf, this.instrument);
    const rawCandles = await this.eventBus.xlatest(streamKey, 50);
    if (!rawCandles || rawCandles.length === 0) return;

    // Calculate indicators
    const ema5 = this.indicators.EMA(rawCandles, 5);
    const ema13 = this.indicators.EMA(rawCandles, 13);
    const ema21 = this.indicators.EMA(rawCandles, 21);
    const rsi = this.indicators.RSI(rawCandles, 14);
    const bb = this.indicators.BollingerBands(rawCandles, 20, 2);
    const atr = this.indicators.ATR(rawCandles, 14);
    const vwap = this.indicators.VWAP(rawCandles);
    const pattern = this.indicators.detectCandlePattern(rawCandles);
    const volStrength = this.indicators.volumeStrength(rawCandles, 20);

    // Write to market_state
    await this.eventBus.hset(this.schema.marketState(this.instrument), {
      [`ema5_${tf}`]: ema5.toFixed(2),
      [`ema13_${tf}`]: ema13.toFixed(2),
      [`ema21_${tf}`]: ema21.toFixed(2),
      [`rsi_${tf}`]: rsi.toFixed(2),
      [`bbUpper_${tf}`]: bb.upper.toFixed(2),
      [`bbLower_${tf}`]: bb.lower.toFixed(2),
      [`bbWidth_${tf}`]: bb.width.toFixed(4),
      [`atr_${tf}`]: atr.toFixed(2),
      [`vwap_${tf}`]: vwap.toFixed(2),
      [`pattern_${tf}`]: pattern,
      [`volumeStrength_${tf}`]: volStrength.toFixed(2),
      [`timestamp_${tf}`]: Date.now()
    });

    // Publish indicator update
    await this.eventBus.publish('indicator:update', this.instrument, {
      timeframe: tf,
      ema5, ema13, ema21, rsi,
      bbUpper: bb.upper, bbLower: bb.lower, bbWidth: bb.width,
      atr, vwap, pattern, volumeStrength: volStrength
    });
  }

  async buildHigherTimeframes(candle1m) {
    const now = Date.now();
    const tfs = ['3m', '5m', '15m', '30m'];
    const intervals = { '3m': 180000, '5m': 300000, '15m': 900000, '30m': 1800000 };

    for (const tf of tfs) {
      const interval = intervals[tf];
      const periodStart = Math.floor(now / interval) * interval;

      if (!this.runningCandles.has(tf)) {
        this.runningCandles.set(tf, { candle: null, startTime: null });
      }

      const running = this.runningCandles.get(tf);

      if (running.startTime !== periodStart) {
        // Emit previous candle
        if (running.candle) {
          await this.emitHigherTfCandle(tf, running.candle, running.startTime);
        }
        // Start new candle
        running.candle = { ...candle1m };
        running.startTime = periodStart;
      } else {
        // Update running candle
        running.candle.high = Math.max(running.candle.high, candle1m.high);
        running.candle.low = Math.min(running.candle.low, candle1m.low);
        running.candle.close = candle1m.close;
        running.candle.volume += candle1m.volume;
      }
    }
  }

  async emitHigherTfCandle(tf, candle, startTime) {
    const interval = { '3m': 180000, '5m': 300000, '15m': 900000, '30m': 1800000 }[tf];
    const closeTime = startTime + interval;
    const key = this.schema.ohlc(tf, this.instrument);

    await this.eventBus.xadd(key, '*', {
      open: candle.open.toFixed(2),
      high: candle.high.toFixed(2),
      low: candle.low.toFixed(2),
      close: candle.close.toFixed(2),
      volume: candle.volume,
      timestamp: closeTime
    });

    await this.eventBus.xtrim(key, 'MAXLEN', 500);

    await this.eventBus.publish(`candle:close:${tf}`, this.instrument, {
      ...candle,
      timestamp: closeTime
    });
  }
}

module.exports = CandleScanner;
