// scanner/IndicatorEngine.js
class IndicatorEngine {
  constructor() {
    this.cache = new Map();
  }

  // Exponential Moving Average
  EMA(candles, period) {
    if (!candles || candles.length < period) return 0;
    const closes = candles.map(c => parseFloat(c.close || c.message?.close || c[1]?.close || 0)).filter(Boolean);
    if (closes.length < period) return 0;

    const multiplier = 2 / (period + 1);
    let ema = this.SMA(closes.slice(0, period), period);

    for (let i = period; i < closes.length; i++) {
      ema = (closes[i] - ema) * multiplier + ema;
    }
    return ema;
  }

  // Simple Moving Average
  SMA(values, period) {
    if (!values || values.length < period) return 0;
    const sum = values.slice(-period).reduce((a, b) => a + b, 0);
    return sum / period;
  }

  // Relative Strength Index
  RSI(candles, period = 14) {
    if (!candles || candles.length < period + 1) return 50;
    const closes = candles.map(c => parseFloat(c.close || c.message?.close || c[1]?.close || 0)).filter(Boolean);
    if (closes.length < period + 1) return 50;

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
      const change = closes[closes.length - i] - closes[closes.length - i - 1];
      if (change > 0) gains += change;
      else losses += Math.abs(change);
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  // Bollinger Bands
  BollingerBands(candles, period = 20, stdDev = 2) {
    if (!candles || candles.length < period) {
      return { upper: 0, middle: 0, lower: 0, width: 0 };
    }
    const closes = candles.map(c => parseFloat(c.close || c.message?.close || c[1]?.close || 0)).filter(Boolean);
    if (closes.length < period) return { upper: 0, middle: 0, lower: 0, width: 0 };

    const slice = closes.slice(-period);
    const middle = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - middle, 2), 0) / period;
    const std = Math.sqrt(variance);
    const upper = middle + stdDev * std;
    const lower = middle - stdDev * std;

    return {
      upper,
      middle,
      lower,
      width: (upper - lower) / middle
    };
  }

  // Average True Range
  ATR(candles, period = 14) {
    if (!candles || candles.length < period + 1) return 0;

    const trValues = [];
    for (let i = 1; i < candles.length; i++) {
      const curr = this._extractCandle(candles[i]);
      const prev = this._extractCandle(candles[i - 1]);
      if (!curr || !prev) continue;

      const tr1 = curr.high - curr.low;
      const tr2 = Math.abs(curr.high - prev.close);
      const tr3 = Math.abs(curr.low - prev.close);
      trValues.push(Math.max(tr1, tr2, tr3));
    }

    if (trValues.length < period) return 0;
    return this.SMA(trValues.slice(-period), period);
  }

  // Volume Weighted Average Price
  VWAP(candles) {
    if (!candles || candles.length === 0) return 0;

    let cumulativeTPV = 0;
    let cumulativeVolume = 0;

    for (const c of candles) {
      const candle = this._extractCandle(c);
      if (!candle || candle.volume === 0) continue;
      const typicalPrice = (candle.high + candle.low + candle.close) / 3;
      cumulativeTPV += typicalPrice * candle.volume;
      cumulativeVolume += candle.volume;
    }

    return cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : 0;
  }

  // Candle pattern detection
  detectCandlePattern(candles) {
    if (!candles || candles.length < 3) return 'NEUTRAL';

    const curr = this._extractCandle(candles[candles.length - 1]);
    const prev = this._extractCandle(candles[candles.length - 2]);
    const prev2 = this._extractCandle(candles[candles.length - 3]);

    if (!curr || !prev) return 'NEUTRAL';

    const body = Math.abs(curr.close - curr.open);
    const range = curr.high - curr.low;
    const upperWick = curr.high - Math.max(curr.open, curr.close);
    const lowerWick = Math.min(curr.open, curr.close) - curr.low;

    // Doji
    if (body < range * 0.1) return 'DOJI';

    // Hammer
    if (lowerWick > body * 2 && upperWick < body * 0.5 && curr.close > curr.open) return 'HAMMER';

    // Shooting Star
    if (upperWick > body * 2 && lowerWick < body * 0.5 && curr.close < curr.open) return 'SHOOTING_STAR';

    // Bullish Engulfing
    if (prev.close < prev.open && curr.close > curr.open &&
        curr.open < prev.close && curr.close > prev.open) return 'BULLISH_ENGULFING';

    // Bearish Engulfing
    if (prev.close > prev.open && curr.close < curr.open &&
        curr.open > prev.close && curr.close < prev.open) return 'BEARISH_ENGULFING';

    // Morning Star
    if (prev2 && prev2.close < prev2.open && prev.close < prev.open &&
        body < range * 0.3 && curr.close > curr.open) return 'MORNING_STAR';

    // Evening Star
    if (prev2 && prev2.close > prev2.open && prev.close > prev.open &&
        body < range * 0.3 && curr.close < curr.open) return 'EVENING_STAR';

    return 'NEUTRAL';
  }

  // Volume strength vs average
  volumeStrength(candles, lookback = 20) {
    if (!candles || candles.length < lookback + 1) return 50;

    const volumes = candles.map(c => {
      const candle = this._extractCandle(c);
      return candle ? candle.volume : 0;
    }).filter(v => v > 0);

    if (volumes.length < lookback + 1) return 50;

    const current = volumes[volumes.length - 1];
    const avg = this.SMA(volumes.slice(0, -1), lookback);

    if (avg === 0) return 50;
    const ratio = current / avg;
    return Math.min(100, Math.max(0, ratio * 50));
  }

  _extractCandle(c) {
    if (!c) return null;
    if (c.message) {
      return {
        open: parseFloat(c.message.open || 0),
        high: parseFloat(c.message.high || 0),
        low: parseFloat(c.message.low || 0),
        close: parseFloat(c.message.close || 0),
        volume: parseInt(c.message.volume || 0, 10)
      };
    }
    return {
      open: parseFloat(c.open || 0),
      high: parseFloat(c.high || 0),
      low: parseFloat(c.low || 0),
      close: parseFloat(c.close || 0),
      volume: parseInt(c.volume || 0, 10)
    };
  }
}

module.exports = IndicatorEngine;
