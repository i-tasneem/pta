// scanner/ScannerOrchestrator.js
const TickScanner = require('./TickScanner');
const CandleScanner = require('./CandleScanner');
const TrendScanner = require('./TrendScanner');
const MomentumScanner = require('./MomentumScanner');
const OIScanner = require('./OIScanner');

class ScannerOrchestrator {
  constructor(eventBus, redisSchema, config) {
    this.eventBus = eventBus;
    this.schema = redisSchema;
    this.config = config;
    this.instruments = new Map(); // instrument -> scanners
    this.running = false;
    this.consumerGroup = 'cg-scanner';
  }

  async initialize(instruments) {
    for (const inst of instruments) {
      await this.addInstrument(inst);
    }
    await this.eventBus.createConsumerGroup(this.consumerGroup, '$');
  }

  async addInstrument(instrument) {
    const symbol = instrument.symbol || instrument;
    const scanners = {
      tick: new TickScanner(symbol, this.eventBus, this.schema),
      candle: new CandleScanner(symbol, this.eventBus, this.schema, this.config.scanners.candle.timeframes),
      trend: new TrendScanner(symbol, this.eventBus, this.schema),
      momentum: new MomentumScanner(symbol, this.eventBus, this.schema),
      oi: new OIScanner(symbol, this.eventBus, this.schema)
    };
    this.instruments.set(symbol, scanners);
  }

  async removeInstrument(instrument) {
    const symbol = instrument.symbol || instrument;
    this.instruments.delete(symbol);
  }

  async start() {
    this.running = true;
    this.processEvents();
  }

  async stop() {
    this.running = false;
  }

  async processEvents() {
    while (this.running) {
      try {
        const messages = await this.eventBus.readGroup(this.consumerGroup, 'scanner-1', 10, 1000);
        if (!messages || messages.length === 0) continue;

        for (const stream of messages) {
          for (const message of stream.messages) {
            await this.handleEvent(message.message);
            await this.eventBus.acknowledge(this.consumerGroup, message.id);
          }
        }
      } catch (err) {
        console.error('ScannerOrchestrator error:', err.message);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  async handleEvent(event) {
    const type = event.type;
    const instrument = event.instrument;
    const data = event.data ? JSON.parse(event.data) : {};

    const scanners = this.instruments.get(instrument);
    if (!scanners) return;

    switch (type) {
      case 'tick:update':
        await scanners.tick.onTick(data);
        break;
      case 'candle:close:1m':
        await scanners.candle.onCandleClose('1m', data);
        break;
      case 'candle:close:3m':
      case 'candle:close:5m':
      case 'candle:close:15m':
      case 'candle:close:30m':
        await scanners.candle.onCandleClose(type.split(':')[2], data);
        break;
      case 'indicator:update':
        await scanners.trend.onIndicatorUpdate(data);
        await scanners.momentum.onIndicatorUpdate(data);
        break;
      case 'oi:update':
        await scanners.oi.onOIUpdate(data);
        break;
    }
  }

  async onTickFromProvider(tick) {
    // Direct tick from provider (bypasses event bus for lower latency)
    const symbol = tick.instrument || tick.tradingSymbol || tick.securityId;
    const scanners = this.instruments.get(symbol);
    if (scanners) {
      await scanners.tick.onTick(tick);
    }
  }

  // After history bootstrap: compute indicators for every timeframe so the
  // pipeline is warm before the first live candle closes
  async primeIndicators(symbol) {
    const scanners = this.instruments.get(symbol);
    if (!scanners) return;

    for (const tf of this.config.scanners.candle.timeframes) {
      await scanners.candle.recomputeIndicators(tf);
    }

    // Derive trend/momentum state from the freshly written indicators
    await scanners.trend.onIndicatorUpdate({});
    await scanners.momentum.onIndicatorUpdate({});
  }

  async onOptionChainFromProvider(chain) {
    const symbol = chain.instrument;
    const scanners = this.instruments.get(symbol);
    if (scanners) {
      await scanners.oi.onOIUpdate(chain);
    }
  }

  getInstrumentCount() {
    return this.instruments.size;
  }

  getInstrumentList() {
    return Array.from(this.instruments.keys());
  }
}

module.exports = ScannerOrchestrator;
