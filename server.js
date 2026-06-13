// server.js

require('dotenv').config();



const DhanProvider = require('./providers/DhanProvider');
const MockProvider = require('./providers/MockProvider');
const EventNormalizer = require('./providers/EventNormalizer');
const EventBus = require('./utils/EventBus');
const RedisSchema = require('./utils/RedisSchema');
const PerformanceMonitor = require('./utils/PerformanceMonitor');
const TokenManager = require('./utils/TokenManager');
const ScannerOrchestrator = require('./scanner/ScannerOrchestrator');
const RegimeEngine = require('./regime/RegimeEngine');
const MultiTimeframeEngine = require('./regime/MultiTimeframeEngine');
const OpportunityQualityEngine = require('./opportunity/OpportunityQualityEngine');
const RankingEngine = require('./opportunity/RankingEngine');
const EntryTriggerEngine = require('./signals/EntryTriggerEngine');
const SignalLifecycleEngine = require('./signals/SignalLifecycleEngine');
const SignalPresentationService = require('./signals/SignalPresentationService');
const NotificationEngine = require('./notification/NotificationEngine');
const ExpressGateway = require('./gateway/ExpressGateway');
const WebSocketGateway = require('./gateway/WebSocketGateway');
const HealthMonitor = require('./gateway/HealthMonitor');
const SignalArchiver = require('./archive/SignalArchiver');
const Database = require('./utils/Database');
const ChainArchiver = require('./archive/ChainArchiver');
const config = require('./config/pta.config');

class PTAServer {
  constructor() {
    this.eventBus = new EventBus(config.redis.url, config.redis.keyPrefix);
    this.schema = new RedisSchema(config.redis.keyPrefix);
    this.perf = new PerformanceMonitor();
    this.tokenManager = null;
    this.provider = null;
    this.normalizer = null;
    this.scanners = null;
    this.regime = null;
    this.mtf = null;
    this.opportunity = null;
    this.ranking = null;
    this.entryTrigger = null;
    this.signalLifecycle = null;
    this.presentation = null;
    this.notification = null;
    this.archiver = null;
    this.db = null;
    this.chainArchiver = null;
    this.health = null;
    this.gateway = null;
    this.wsGateway = null;
  }

  async initialize() {
    console.log('Initializing PTA Server...');
    console.log('Environment:', process.env.NODE_ENV || 'development');

    // Step 1: Connect to Redis (ephemeral) and Postgres (system of record)
    await this.eventBus.connect();
    console.log('✓ Redis connected');

    this.db = new Database(config.postgres);
    await this.db.connect();
    this.chainArchiver = new ChainArchiver(this.db, this.eventBus, this.schema);

    // Step 2: Generate/refresh Dhan access token (Railway-safe)
    if (process.env.USE_MOCK !== 'true' && config.provider.totpSecret) {
      this.tokenManager = new TokenManager({
  clientId: config.provider.clientId,
  pin: config.provider.pin,
  totpSecret: config.provider.totpSecret
}, this.eventBus.client);
      await this.tokenManager.initialize();
      config.provider.accessToken = await this.tokenManager.getToken();
      console.log('✓ Dhan token generated via TOTP');
    } else if (process.env.USE_MOCK !== 'true' && !config.provider.accessToken) {
      console.warn('⚠ No Dhan access token or TOTP secret configured. Set DHAN_ACCESS_TOKEN or DHAN_TOTP_SECRET env var.');
    }

    // Step 3: Initialize market data provider
    if (process.env.USE_MOCK === 'true') {
      this.provider = new MockProvider(config.provider);
      console.log('✓ MockProvider initialized (test mode)');
    } else {
      this.provider = new DhanProvider(config.provider);
    }
    this.normalizer = new EventNormalizer(this.schema, this.eventBus);

    // Step 4: Initialize all engines
    this.scanners = new ScannerOrchestrator(this.eventBus, this.schema, config);
    this.regime = new RegimeEngine(this.eventBus, this.schema);
    this.mtf = new MultiTimeframeEngine(this.eventBus, this.schema);
    this.opportunity = new OpportunityQualityEngine(this.eventBus, this.schema, config);
    this.ranking = new RankingEngine(this.eventBus, this.schema, config);
    this.entryTrigger = new EntryTriggerEngine(this.eventBus, this.schema, config);
    this.archiver = new SignalArchiver(config);
    this.signalLifecycle = new SignalLifecycleEngine(this.eventBus, this.schema, config, this.archiver);
    this.presentation = new SignalPresentationService(this.schema, this.eventBus, config);
    this.notification = new NotificationEngine(this.eventBus, this.schema, config);

    await this.scanners.initialize(config.instruments.indices);
    await this.ranking.initialize();
    await this.entryTrigger.initialize();
    await this.signalLifecycle.initialize();
    await this.notification.initialize();
    await this.archiver.initialize();
    console.log('✓ All engines initialized');
  }

  async start() {
    // Pre-flight token check (Railway: token may expire during sleep)
    if (this.tokenManager && !this.tokenManager.isTokenValid()) {
      console.log('Token near expiry, refreshing before connect...');
      await this.tokenManager.generateToken();
      this.provider.accessToken = await this.tokenManager.getToken();
    }

    const instruments = config.instruments.indices;

    // Resolve current-month index futures (volume/spread source for indices)
    this.futuresPairs = await this.discoverFutures(instruments);

    const connectProvider = async () => {
      await this.provider.connect();
      await this.provider.subscribeTicks(instruments);
      if (this.futuresPairs.length > 0) {
        await this.provider.subscribeFutures(this.futuresPairs);
      }
      console.log('✓ Provider connected');
    };

    try {
      await connectProvider();
    } catch (err) {
      // Only regenerate when the broker rejected the token itself; a WS or
      // network failure with a fresh token would just burn the 2-min rate limit
      if (this.tokenManager && err.message.includes('Token validation failed')) {
        console.warn('Provider connect failed, regenerating token:', err.message);
        this.provider.accessToken = await this.tokenManager.invalidate();
        await connectProvider().catch(e => this.retryProviderInBackground(connectProvider, e));
      } else {
        // Feed may be throttling after restart storms; REST (option chains)
        // still works, so come up degraded and keep retrying the feed
        this.retryProviderInBackground(connectProvider, err);
      }
    }

    this.provider.on('tick', async (tick) => {
      const timer = this.perf.startTimer('tick_processing');
      const normalized = this.normalizer.normalizeTick(tick);
      await this.normalizer.writeTick(normalized);
      await this.scanners.onTickFromProvider(normalized);
      this.perf.endTimer(timer);
    });

    this.provider.on('ws:error', (err) => console.error('Provider WS error:', err.message));
    this.provider.on('ws:disconnected', () => console.warn('Provider WS disconnected'));

    // Seed candle streams from broker history so indicators are warm at
    // boot instead of hours into the session
    await this.bootstrapHistory(instruments);

    // Poll option chains round-robin (Dhan limit: 1 chain request / 3s)
    this.startChainPolling(instruments);

    // Regime + MTF + opportunity scoring; publishes opportunity:score,
    // which is what wakes the entry-trigger gates and the ranking engine
    this.startAnalysisLoop(instruments);

    // Start all engines
    await this.scanners.start();
    await this.ranking.start();
    await this.entryTrigger.start();
    await this.signalLifecycle.start();
    await this.notification.start();
    await this.archiver.start();

    // Start HTTP + WS gateway
    const expressGateway = new ExpressGateway(this.eventBus, this.schema, this.presentation, this.ranking, config, this.archiver);
    const port = process.env.PORT || 3000;
    const server = expressGateway.listen(port);

    this.wsGateway = new WebSocketGateway(server, this.eventBus, this.schema, config);
    await this.wsGateway.initialize();
    this.wsGateway.startEventStreaming();

    // Health monitor
    this.health = new HealthMonitor(this.eventBus, this.schema, this.provider, this.scanners);
    await this.health.start();

    console.log('✓ PTA Server fully operational');
    console.log(`  Health: http://localhost:${port}/api/health`);
  }

  startAnalysisLoop(instruments) {
    this.analysisTimer = setInterval(async () => {
      for (const inst of instruments) {
        try {
          await this.mtf.calculateAgreement(inst.symbol);
          await this.regime.detectRegime(inst.symbol);
          await this.opportunity.calculateScore(inst.symbol);
        } catch (err) {
          console.error(`Analysis ${inst.symbol}:`, err.message);
        }
      }
    }, 10000);
  }

  async discoverFutures(instruments) {
    const cacheKey = `${config.redis.keyPrefix}sys:futures:map`;
    try {
      const cached = await this.eventBus.client.get(cacheKey);
      if (cached) {
        const map = JSON.parse(cached);
        return this.futuresMapToPairs(map, instruments);
      }

      const symbols = instruments.map(i => i.symbol);
      const map = await this.provider.findIndexFutures(symbols);
      if (Object.keys(map).length > 0) {
        await this.eventBus.client.set(cacheKey, JSON.stringify(map), { EX: 24 * 60 * 60 });
        console.log('✓ Index futures resolved:', Object.entries(map).map(([s, f]) => `${s}=${f.securityId}(${f.expiry})`).join(', '));
      }
      return this.futuresMapToPairs(map, instruments);
    } catch (err) {
      console.error('Futures discovery failed (volume/spread degraded):', err.message);
      return [];
    }
  }

  futuresMapToPairs(map, instruments) {
    return instruments
      .filter(i => map[i.symbol])
      .map(i => ({
        symbol: i.symbol,
        securityId: map[i.symbol].securityId,
        exchangeSegment: map[i.symbol].exchangeSegment
      }));
  }

  async bootstrapHistory(instruments) {
    if (typeof this.provider.getIntradayCandles !== 'function') return;

    const TFS = { '3m': 180000, '5m': 300000, '15m': 900000, '30m': 1800000 };
    const toDate = new Date().toISOString().slice(0, 10);
    const fromDate = new Date(Date.now() - 9 * 86400000).toISOString().slice(0, 10);
    const futBySymbol = Object.fromEntries((this.futuresPairs || []).map(p => [p.symbol, p]));

    for (const inst of instruments) {
      try {
        const candles = await this.provider.getIntradayCandles(
          inst.securityId, inst.exchangeSegment || 'IDX_I', 'INDEX', fromDate, toDate
        );
        if (!candles || candles.length === 0) continue;

        // Indices carry no volume; merge it from the paired future's history
        const fut = futBySymbol[inst.symbol];
        if (fut) {
          await new Promise(r => setTimeout(r, 1200));
          try {
            const futCandles = await this.provider.getIntradayCandles(
              fut.securityId, fut.exchangeSegment, 'FUTIDX', fromDate, toDate
            );
            const volByTs = new Map(futCandles.map(c => [c.timestamp, c.volume]));
            for (const c of candles) {
              c.volume = volByTs.get(c.timestamp) || c.volume;
            }
          } catch (err) {
            console.warn(`Futures history ${inst.symbol}:`, err.message);
          }
        }

        await this.seedCandleStream('1m', inst.symbol, candles.slice(-500));
        for (const [tf, intervalMs] of Object.entries(TFS)) {
          const aggregated = this.aggregateCandles(candles, intervalMs);
          await this.seedCandleStream(tf, inst.symbol, aggregated.slice(-500));
        }

        await this.scanners.primeIndicators(inst.symbol);
        console.log(`✓ History bootstrapped: ${inst.symbol} (${candles.length} 1m candles)`);
      } catch (err) {
        const detail = err.response ? JSON.stringify(err.response.data) : err.message;
        console.error(`History bootstrap ${inst.symbol}:`, detail);
      }

      // Historical data API is rate limited; pace the requests
      await new Promise(r => setTimeout(r, 1200));
    }
  }

  aggregateCandles(candles1m, intervalMs) {
    const buckets = new Map();
    for (const c of candles1m) {
      const start = Math.floor(c.timestamp / intervalMs) * intervalMs;
      const b = buckets.get(start);
      if (!b) {
        buckets.set(start, { timestamp: start, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
      } else {
        b.high = Math.max(b.high, c.high);
        b.low = Math.min(b.low, c.low);
        b.close = c.close;
        b.volume += c.volume;
      }
    }
    return Array.from(buckets.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  async seedCandleStream(tf, symbol, candles) {
    const key = this.schema.ohlc(tf, symbol);
    await this.eventBus.del(key);
    for (const c of candles) {
      await this.eventBus.xadd(key, '*', {
        open: c.open.toFixed(2),
        high: c.high.toFixed(2),
        low: c.low.toFixed(2),
        close: c.close.toFixed(2),
        volume: c.volume,
        timestamp: c.timestamp
      });
    }
  }

  retryProviderInBackground(connectProvider, err) {
    console.error('Provider unavailable, will retry every 60s:', err.message);
    if (this.providerRetryTimer) return;

    this.providerRetryTimer = setInterval(async () => {
      try {
        await connectProvider();
        clearInterval(this.providerRetryTimer);
        this.providerRetryTimer = null;
      } catch (e) {
        console.error('Provider retry failed:', e.message);
      }
    }, 60000);
  }

  startChainPolling(instruments) {
    const expiries = new Map(); // symbol -> nearest expiry
    let i = 0;

    this.chainTimer = setInterval(async () => {
      const inst = instruments[i % instruments.length];
      i++;

      try {
        if (!expiries.has(inst.symbol)) {
          if (typeof this.provider.getExpiryList !== 'function') {
            expiries.set(inst.symbol, null);
          } else {
            const list = await this.provider.getExpiryList(inst.securityId, inst.exchangeSegment);
            expiries.set(inst.symbol, list[0] || null);
            return; // expiry list call shares the chain rate limit; fetch chain next slot
          }
        }

        const raw = await this.provider.getOptionChain(
          inst.securityId,
          inst.exchangeSegment,
          expiries.get(inst.symbol)
        );

        if (!raw || !raw.data || raw.data.length === 0) return;

        const chain = this.normalizer.normalizeOptionChain(raw, inst.symbol);
        await this.normalizer.writeOptionChain(chain);
        await this.scanners.onOptionChainFromProvider(chain);
        await this.chainArchiver.record(chain);
      } catch (err) {
        const detail = err.response ? JSON.stringify(err.response.data) : err.message;
        console.error(`Chain poll ${inst.symbol}:`, detail);
      }
    }, 3500);
  }

  async stop() {
    console.log('Shutting down PTA Server...');
    if (this.chainTimer) clearInterval(this.chainTimer);
    if (this.providerRetryTimer) clearInterval(this.providerRetryTimer);
    if (this.analysisTimer) clearInterval(this.analysisTimer);
    this.health?.stop();
    this.scanners?.stop();
    this.ranking?.stop();
    this.entryTrigger?.stop();
    this.signalLifecycle?.stop();
    this.notification?.stop();
    this.archiver?.stop();
    this.tokenManager?.stop();
    await this.provider?.disconnect();
    await this.eventBus?.disconnect();
    await this.db?.close();
    console.log('✓ PTA Server stopped');
  }
}

const server = new PTAServer();

process.on('SIGINT', async () => { await server.stop(); process.exit(0); });
process.on('SIGTERM', async () => { await server.stop(); process.exit(0); });

server.initialize().then(() => server.start()).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
