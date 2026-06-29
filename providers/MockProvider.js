// providers/MockProvider.js
const MarketDataProvider = require('./MarketDataProvider');
const fs = require('fs');
const path = require('path');

class MockProvider extends MarketDataProvider {
  constructor(config) {
    super(config);
    this.tickData = [];
    this.currentIndex = 0;
    this.speed = 1.0;
    this.playing = false;
    this.timer = null;
    this.instruments = new Map();
  }

  async connect() {
    this.connected = true;
    this.emit('connected');
  }

  async disconnect() {
    this.stopReplay();
    this.connected = false;
    this.emit('disconnected');
  }

  async loadHistoricalData(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.json') {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      this.tickData = Array.isArray(data) ? data : [data];
    } else if (ext === '.csv') {
      this.tickData = this.parseCSV(fs.readFileSync(filePath, 'utf8'));
    } else {
      throw new Error('Unsupported file format. Use .json or .csv');
    }
    this.currentIndex = 0;
  }

  parseCSV(csvText) {
    const lines = csvText.split('\n').filter(l => l.trim());
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const records = [];

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',');
      const record = { timestamp: Date.now() };
      for (let j = 0; j < headers.length; j++) {
        const val = values[j]?.trim();
        if (val !== undefined) {
          const num = parseFloat(val);
          record[headers[j]] = isNaN(num) ? val : num;
        }
      }
      records.push(record);
    }
    return records;
  }

  async replay(speed = 1.0) {
    this.speed = speed;
    this.playing = true;
    this.emit('replay:started', { totalTicks: this.tickData.length, speed });
    this.scheduleNextTick();
  }

  scheduleNextTick() {
    if (!this.playing || this.currentIndex >= this.tickData.length) {
      this.emit('replay:finished');
      return;
    }

    const tick = this.tickData[this.currentIndex];
    this.currentIndex++;

    this.emit('tick', tick);

    // Calculate delay based on timestamp difference
    let delay = 1000; // Default 1 second
    if (this.currentIndex < this.tickData.length) {
      const nextTick = this.tickData[this.currentIndex];
      const timeDiff = nextTick.timestamp - tick.timestamp;
      if (timeDiff > 0 && timeDiff < 60000) {
        delay = timeDiff / this.speed;
      }
    }

    this.timer = setTimeout(() => this.scheduleNextTick(), delay);
  }

  async pause() {
    this.playing = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.emit('replay:paused', { currentIndex: this.currentIndex });
  }

  async resume() {
    if (!this.playing) {
      this.playing = true;
      this.scheduleNextTick();
      this.emit('replay:resumed');
    }
  }

  async seekTo(timestamp) {
    this.currentIndex = this.tickData.findIndex(t => t.timestamp >= timestamp);
    if (this.currentIndex === -1) this.currentIndex = this.tickData.length;
    this.emit('replay:seeked', { index: this.currentIndex, timestamp });
  }

  stopReplay() {
    this.playing = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async subscribeTicks(instruments) {
    for (const inst of instruments) {
      this.instruments.set(inst.symbol || inst, inst);
    }
  }

  async unsubscribeTicks(instruments) {
    for (const inst of instruments) {
      this.instruments.delete(inst.symbol || inst);
    }
  }

  async getLTP(securityIds) {
    const ids = Array.isArray(securityIds) ? securityIds : [securityIds];
    return ids.map(id => ({
      securityId: id,
      lastPrice: 23450 + Math.random() * 100,
      bidPrice: 23449,
      askPrice: 23451
    }));
  }

  async getOptionChain(securityId) {
    return {
      underlyingPrice: 23450,
      expiryDate: '2026-06-25',
      data: this.generateMockOptionChain(23450)
    };
  }

  async getHistoricalData(securityId, interval, from, to) {
    return this.generateMockHistoricalData(interval);
  }

  async getIntradayCandles(securityId, exchangeSegment, instrumentType, fromDate, toDate, interval = '1') {
    return this.generateMockHistoricalData(`${interval}m`);
  }

  // ~250 synthetic daily candles so the daily 200-EMA exit level is available
  // in mock mode (otherwise it degrades gracefully and is skipped).
  async getDailyCandles(securityId, exchangeSegment, instrumentType, fromDate, toDate) {
    const candles = [];
    const dayMs = 86400000;
    const now = Date.now();
    let price = 22000;
    for (let i = 250; i >= 0; i--) {
      const change = (Math.random() - 0.5) * 120;
      price += change;
      candles.push({
        timestamp: now - i * dayMs,
        open: price - change / 2,
        high: price + Math.abs(change) + Math.random() * 40,
        low: price - Math.abs(change) - Math.random() * 40,
        close: price,
        volume: Math.floor(Math.random() * 5000000)
      });
    }
    return candles;
  }

  async findIndexFutures(symbols) {
    return {};
  }

  async subscribeFutures(pairs) {
    // No futures in mock mode
  }

  async getInstrumentMaster() {
    return [];
  }

  async validateToken() {
    return { status: 'ok' };
  }

  generateMockOptionChain(spotPrice) {
    const strikes = [];
    const baseStrike = Math.round(spotPrice / 50) * 50;
    for (let i = -5; i <= 5; i++) {
      const strike = baseStrike + i * 50;
      const distance = Math.abs(strike - spotPrice);
      const iv = 15 + distance / 50 + Math.random() * 5;
      const oi = Math.floor(100000 + Math.random() * 500000);
      strikes.push({
        strikePrice: strike,
        CE: {
          lastPrice: Math.max(1, (spotPrice - strike) * 0.8 + Math.random() * 10),
          bidPrice: Math.max(0.5, (spotPrice - strike) * 0.8 - 1),
          askPrice: Math.max(1, (spotPrice - strike) * 0.8 + 1),
          totalTradedVolume: Math.floor(Math.random() * 10000),
          openInterest: oi,
          change: Math.random() * 10 - 5,
          impliedVolatility: iv,
          delta: 0.5 + (spotPrice - strike) / 200
        },
        PE: {
          lastPrice: Math.max(1, (strike - spotPrice) * 0.8 + Math.random() * 10),
          bidPrice: Math.max(0.5, (strike - spotPrice) * 0.8 - 1),
          askPrice: Math.max(1, (strike - spotPrice) * 0.8 + 1),
          totalTradedVolume: Math.floor(Math.random() * 10000),
          openInterest: oi * 0.8,
          change: Math.random() * 10 - 5,
          impliedVolatility: iv,
          delta: 0.5 - (spotPrice - strike) / 200
        }
      });
    }
    return strikes;
  }

  generateMockHistoricalData(interval) {
    const candles = [];
    const now = Date.now();
    const intervalMs = this.intervalToMs(interval);
    let price = 23400;

    for (let i = 100; i >= 0; i--) {
      const change = (Math.random() - 0.5) * 50;
      price += change;
      const candle = {
        timestamp: now - i * intervalMs,
        open: price - change / 2,
        high: price + Math.abs(change) + Math.random() * 20,
        low: price - Math.abs(change) - Math.random() * 20,
        close: price,
        volume: Math.floor(Math.random() * 1000000)
      };
      candles.push(candle);
    }
    return candles;
  }

  intervalToMs(interval) {
    const map = { '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000, '30m': 1800000 };
    return map[interval] || 300000;
  }
}

module.exports = MockProvider;
