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
const Auth = require('./utils/Auth');
const ChainArchiver = require('./archive/ChainArchiver');
const V2Adapter = require('./signals/V2Adapter');
const GateTelemetry = require('./signals/GateTelemetry');
const ChainScheduler = require('./scanner/ChainScheduler');
const config = require('./config/pta.config');

// Compiled TypeScript V2 engine (engine/dist). Guarded so a missing build
// can never crash the app — V2 simply stays disabled.
let v2engine = null;
try {
  v2engine = require('./engine/dist/index.js');
} catch (err) {
  console.warn('⚠ V2 engine not built (run "npm run build:engine"); V2 disabled:', err.message);
}

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
    this.v2 = null;
    this.gateTelemetry = null;
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

    this.auth = new Auth(process.env.AUTH_SECRET);
    if (!process.env.AUTH_SECRET) {
      console.warn('⚠ AUTH_SECRET not set — sessions reset on restart. Set it in .env');
    }
    await this.bootstrapAdmin();

    if (v2engine) {
      this.v2 = new V2Adapter(
        this.db, this.eventBus, this.schema, config, v2engine,
        (evt) => { this.eventBus.publish(evt.type, evt.instrument, evt.data).catch(() => {}); }
      );
      console.log('✓ V2 positioning engine enabled');
    }

    // Step 2: Generate/refresh Dhan access token (Railway-safe)
    if (process.env.USE_MOCK !== 'true' && config.provider.totpSecret) {
      this.tokenManager = new TokenManager({
  clientId: config.provider.clientId,
  pin: config.provider.pin,
  totpSecret: config.provider.totpSecret
}, this.eventBus.client);
      await this.tokenManager.initialize();
      config.provider.accessToken = await this.tokenManager.getToken();
      console.log('✓ Dhan token ready');
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

    // Keep the provider's token fresh. Scheduled refreshes previously updated
    // only the TokenManager, so REST/WS kept using the boot-time token until
    // it expired (~24h) and the app silently died before market open.
    if (this.tokenManager) {
      this.tokenManager.onToken = (t) => { if (this.provider) this.provider.accessToken = t; };
      // Single-flight 401 recovery: concurrent failures share one regeneration.
      this.provider.onAuthError = () => {
        if (this._tokenRecovery) return this._tokenRecovery;
        // Cooldown: if a fresh token didn't cure the 401s ten minutes ago,
        // the account itself is the problem (e.g. Data APIs unsubscribed) —
        // regenerating again only burns TOTP attempts.
        if (this._lastTokenRecoveryAt && Date.now() - this._lastTokenRecoveryAt < 10 * 60000) {
          return Promise.resolve(null);
        }
        this._lastTokenRecoveryAt = Date.now();
        this._tokenRecovery = this.tokenManager.invalidate()
          .finally(() => { this._tokenRecovery = null; });
        return this._tokenRecovery;
      };
    }
    this.normalizer = new EventNormalizer(this.schema, this.eventBus);

    // Step 4: Initialize all engines
    this.scanners = new ScannerOrchestrator(this.eventBus, this.schema, config);
    this.regime = new RegimeEngine(this.eventBus, this.schema);
    this.mtf = new MultiTimeframeEngine(this.eventBus, this.schema);
    this.opportunity = new OpportunityQualityEngine(this.eventBus, this.schema, config);
    this.ranking = new RankingEngine(this.eventBus, this.schema, config);
    this.gateTelemetry = new GateTelemetry(this.db);
    await this.gateTelemetry.init();
    this.entryTrigger = new EntryTriggerEngine(this.eventBus, this.schema, config, this.gateTelemetry);
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

    // Resolve current-month index futures (volume/spread source for indices).
    // Discovery used to run exactly once at boot; one bad download meant a
    // whole session with no futures volume/basis. Retry until it succeeds.
    this.futuresPairs = await this.discoverFutures(instruments);
    if (this.futuresPairs.length === 0) {
      console.warn('⚠ Index futures unresolved — volume/basis degraded; retrying every 10min');
      this.futuresRetryTimer = setInterval(async () => {
        try {
          const pairs = await this.discoverFutures(instruments);
          if (pairs.length === 0) return;
          this.futuresPairs = pairs;
          clearInterval(this.futuresRetryTimer);
          this.futuresRetryTimer = null;
          try {
            await this.provider.subscribeFutures(pairs);
            console.log('✓ Index futures resolved on retry and subscribed');
          } catch (e) {
            console.warn('Futures resolved; subscription deferred to next reconnect:', e.message);
          }
        } catch (e) {
          console.error('Futures discovery retry failed:', e.message);
        }
      }, 10 * 60000);
    }

    // Stocks: equity spot (chain underlying, real volume) + FUTSTK basis leg.
    this.stockPlumbing = await this.discoverStocks();
    for (const s of this.stockPlumbing.spots) {
      await this.scanners.addInstrument({ symbol: s.symbol, securityId: s.securityId, exchangeSegment: 'NSE_EQ' });
    }

    // MCX: front-month future subscribed as the tick instrument.
    this.mcxPlumbing = await this.discoverMcx();
    for (const m of this.mcxPlumbing.ticks) {
      await this.scanners.addInstrument({ symbol: m.symbol, securityId: m.securityId, exchangeSegment: 'MCX_COMM' });
    }

    const connectProvider = async () => {
      await this.provider.connect();
      await this.provider.subscribeTicks(instruments);
      if (this.stockPlumbing.spots.length > 0) {
        await this.provider.subscribeTicks(this.stockPlumbing.spots);
      }
      if (this.mcxPlumbing.ticks.length > 0) {
        await this.provider.subscribeTicks(this.mcxPlumbing.ticks);
      }
      const futLegs = [...this.futuresPairs, ...this.stockPlumbing.futures];
      if (futLegs.length > 0) {
        await this.provider.subscribeFutures(futLegs);
      }
      console.log(`✓ Provider connected (${instruments.length} indices, ${this.stockPlumbing.spots.length} stocks, ${this.mcxPlumbing.ticks.length} MCX)`);
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

    // Per-symbol accumulators drained by the chain poll. The engine needs the
    // futures volume over the WHOLE ~20s chain interval; reading the last tick
    // hash gave it a ~1-second slice, making ease-of-movement and the
    // participation percentile meaningless noise.
    this.futVolAccum = new Map();  // symbol -> futures volume since last chain poll
    this.futLtpLatest = new Map(); // symbol -> latest futures LTP (basis input)

    this.provider.on('tick', async (tick) => {
      const timer = this.perf.startTimer('tick_processing');
      const normalized = this.normalizer.normalizeTick(tick);
      this.futVolAccum.set(normalized.instrument,
        (this.futVolAccum.get(normalized.instrument) || 0) + (normalized.volume || 0));
      if (normalized.futLtp > 0) this.futLtpLatest.set(normalized.instrument, normalized.futLtp);
      await this.normalizer.writeTick(normalized);
      await this.scanners.onTickFromProvider(normalized);
      this.perf.endTimer(timer);
    });

    this.provider.on('ws:error', (err) => console.error('Provider WS error:', err.message));
    this.provider.on('ws:disconnected', () => console.warn('Provider WS disconnected'));

    // Seed candle streams from broker history so indicators are warm at
    // boot instead of hours into the session
    await this.bootstrapHistory([...instruments, ...this.stockPlumbing.spots, ...this.mcxPlumbing.ticks]);

    // Poll option chains via the budgeted, session-aware scheduler
    this.startChainPolling();

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
    const expressGateway = new ExpressGateway(this.eventBus, this.schema, this.presentation, this.ranking, config, this.archiver, this.v2, this.db, this.auth, this.gateTelemetry, this.chainScheduler);
    const port = process.env.PORT || 3000;
    const server = expressGateway.listen(port);

    this.wsGateway = new WebSocketGateway(
      server, this.eventBus, this.schema, config, this.auth, !!(this.db && this.db.enabled)
    );
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
          const opp = await this.opportunity.calculateScore(inst.symbol);
          if (opp) this.gateTelemetry?.recordOpportunity(opp); // observability only
        } catch (err) {
          console.error(`Analysis ${inst.symbol}:`, err.message);
        }
      }
    }, 10000);

    // Persist telemetry buffers periodically (restart-durable funnel)
    this.telemetryTimer = setInterval(() => {
      this.gateTelemetry?.flush().catch(() => {});
    }, 15000);
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
      } else {
        console.warn('⚠ Futures discovery returned no matches for', symbols.join(','));
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

  // Resolve enabled STOCK-class universe entries: NSE equity id (option-chain
  // underlying + spot tick, real volume) and nearest FUTSTK (basis leg).
  // Fills securityId on the universe entries in place, so the chain scheduler
  // picks them up. A failure leaves stocks dark for this boot — indices are
  // unaffected — and is logged loudly rather than retried.
  async discoverStocks() {
    const stocks = config.instruments.universe.filter(u => u.class === 'STOCK' && u.enabled);
    if (stocks.length === 0 || typeof this.provider.findStockInstruments !== 'function') {
      return { spots: [], futures: [] };
    }

    const cacheKey = `${config.redis.keyPrefix}sys:stocks:map`;
    try {
      let map = null;
      const cached = await this.eventBus.client.get(cacheKey);
      if (cached) {
        map = JSON.parse(cached);
        console.log(`✓ Stock instruments from cache (${Object.keys(map).length} symbols)`);
      } else {
        map = await this.provider.findStockInstruments(stocks.map(s => s.symbol));
        await this.eventBus.client.set(cacheKey, JSON.stringify(map), { EX: 24 * 60 * 60 });
        console.log('✓ Stock instruments resolved:',
          Object.entries(map).map(([s, v]) =>
            `${s}=eq${v.equity && v.equity.securityId}/fut${v.future ? v.future.securityId : '-'}`).join(', '));
      }

      const spots = [];
      const futures = [];
      for (const inst of stocks) {
        const m = map[inst.symbol];
        if (!m || !m.equity || !m.equity.securityId) {
          console.warn(`⚠ Stock unresolved, staying dark: ${inst.symbol}`);
          continue;
        }
        inst.securityId = String(m.equity.securityId);
        if (m.future && m.future.lotSize) inst.lotSize = m.future.lotSize;
        spots.push({ symbol: inst.symbol, securityId: inst.securityId, exchangeSegment: 'NSE_EQ' });
        if (m.future && m.future.securityId) {
          futures.push({ symbol: inst.symbol, securityId: String(m.future.securityId), exchangeSegment: 'NSE_FNO' });
        }
      }
      return { spots, futures };
    } catch (err) {
      console.error('⚠ Stock discovery failed — stocks stay dark until next restart:', err.message);
      return { spots: [], futures: [] };
    }
  }

  // Resolve enabled MCX-class entries: the chain underlying is the FRONT
  // monthly FUTURES contract (rolls monthly — pollChainOnce advances to
  // `mcxNext` when the front option series has no live expiry left). The
  // future is also subscribed as a plain tick instrument: its own volume
  // feeds participation via the spot-volume path, its LTP is the basis-free
  // underlying mark (basis archetype is masked for MCX anyway).
  async discoverMcx() {
    const mcx = config.instruments.universe.filter(u => u.class === 'MCX' && u.enabled);
    if (mcx.length === 0 || typeof this.provider.findCommodityFutures !== 'function') {
      return { ticks: [] };
    }

    const cacheKey = `${config.redis.keyPrefix}sys:mcx:map`;
    try {
      let map = null;
      const cached = await this.eventBus.client.get(cacheKey);
      if (cached) {
        map = JSON.parse(cached);
        console.log(`✓ MCX futures from cache (${Object.keys(map).length} symbols)`);
      } else {
        map = await this.provider.findCommodityFutures(mcx.map(s => s.symbol));
        await this.eventBus.client.set(cacheKey, JSON.stringify(map), { EX: 24 * 60 * 60 });
        console.log('✓ MCX futures resolved:',
          Object.entries(map).map(([s, v]) =>
            `${s}=${v.front.securityId}(${v.front.expiry})${v.next ? `→${v.next.securityId}` : ''}`).join(', '));
      }

      const ticks = [];
      for (const inst of mcx) {
        const m = map[inst.symbol];
        if (!m || !m.front) {
          console.warn(`⚠ MCX unresolved, staying dark: ${inst.symbol}`);
          continue;
        }
        inst.securityId = String(m.front.securityId);
        inst.mcxNext = m.next ? { securityId: String(m.next.securityId), expiry: m.next.expiry } : null;
        if (!inst.lotSize && m.front.lotSize) inst.lotSize = m.front.lotSize;
        ticks.push({ symbol: inst.symbol, securityId: inst.securityId, exchangeSegment: 'MCX_COMM' });
      }
      return { ticks };
    } catch (err) {
      console.error('⚠ MCX discovery failed — commodities stay dark until next restart:', err.message);
      return { ticks: [] };
    }
  }

  // Seed an admin from env on first boot so there's always a way in to issue
  // passwords to signups.
  async bootstrapAdmin() {
    if (!this.db || !this.db.enabled) return;
    const u = process.env.ADMIN_USERNAME;
    const p = process.env.ADMIN_PASSWORD;
    if (!u || !p) return;
    try {
      const exists = await this.db.query('SELECT 1 FROM users WHERE username = $1', [u.toLowerCase()]);
      if (exists.rows.length) return;
      await this.db.query(
        `INSERT INTO users (username, email, name, role, status, pw_hash)
         VALUES ($1, $2, 'Administrator', 'ADMIN', 'ACTIVE', $3)`,
        [u.toLowerCase(), `${u.toLowerCase()}@pta.local`, this.auth.hashPassword(p)]
      );
      console.log('✓ Admin user bootstrapped:', u.toLowerCase());
    } catch (err) {
      console.error('Admin bootstrap failed:', err.message);
    }
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
          inst.securityId, inst.exchangeSegment || 'IDX_I',
          historyType(inst), fromDate, toDate
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

        // Seed daily candles for the daily 200-EMA exit level (needs ~200 days).
        await this.seedDailyHistory(inst);

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

  // Seed ~250 trading days of daily candles into the 1d ohlc stream so the
  // engine's daily 200-EMA exit level is available. Degrades gracefully: a
  // failure is logged and the daily level is simply skipped (never blocks).
  async seedDailyHistory(inst) {
    if (typeof this.provider.getDailyCandles !== 'function') return;
    const toDate = new Date().toISOString().slice(0, 10);
    const fromDate = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
    try {
      await new Promise(r => setTimeout(r, 1200)); // pace vs the rate limit
      const daily = await this.provider.getDailyCandles(
        inst.securityId, inst.exchangeSegment || 'IDX_I',
        historyType(inst), fromDate, toDate
      );
      if (daily && daily.length) {
        await this.seedCandleStream('1d', inst.symbol, daily.slice(-300));
        console.log(`✓ Daily history: ${inst.symbol} (${daily.length} daily candles)`);
      } else {
        console.warn(`Daily history ${inst.symbol}: none returned — daily 200-EMA will be skipped`);
      }
    } catch (err) {
      const detail = err.response ? JSON.stringify(err.response.data) : err.message;
      console.warn(`Daily history ${inst.symbol}: ${detail} — daily 200-EMA will be skipped`);
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

  startChainPolling() {
    this.chainExpiries = new Map(); // symbol -> { value, day } — refetched daily

    // Priority scheduler instead of the old fixed 3.5s round-robin. Each
    // instrument declares its own cadence and exchange calendar; closed
    // exchanges cost nothing (no more weekend polls archiving frozen chains)
    // and after NSE close the whole budget serves MCX. Budget stays at the
    // old serial rate until the burst probe validates Dhan's documented
    // per-unique limit (see config.provider.chainBudgetRps).
    this.chainScheduler = new ChainScheduler({
      budgetRps: config.provider.chainBudgetRps,
      minUniqueGapMs: config.provider.chainMinUniqueGapMs
    });

    const pollable = config.instruments.universe.filter((u) => u.enabled && u.securityId);
    for (const inst of pollable) {
      this.chainScheduler.add({
        symbol: inst.symbol,
        class: inst.class || 'INDEX',
        calendar: inst.calendar || 'NSE',
        cadenceMs: inst.cadenceMs || 21000,
        securityId: inst.securityId,
        exchangeSegment: inst.exchangeSegment,
        mcxNext: inst.mcxNext || null // roll target for MCX option series
      });
    }
    this.chainScheduler.start((inst) => this.pollChainOnce(inst));
    console.log(`✓ Chain scheduler: ${pollable.length} instruments, budget ${config.provider.chainBudgetRps.toFixed(3)} req/s`);
  }

  async pollChainOnce(inst) {
    const istDay = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

    try {
      // Refresh the nearest expiry each IST day. Caching it forever meant
      // that after a weekly expiry passed, the poll kept requesting a dead
      // contract, got empty data, and the instrument silently went dark
      // until the next process restart.
      const cached = this.chainExpiries.get(inst.symbol);
      if (!cached || cached.day !== istDay()) {
        if (typeof this.provider.getExpiryList !== 'function') {
          this.chainExpiries.set(inst.symbol, { value: null, day: istDay() });
        } else {
          const list = await this.provider.getExpiryList(inst.securityId, inst.exchangeSegment);
          // Pick the first expiry that is TODAY or later — never list[0]
          // blindly. The daily refresh fires at midnight IST, when Dhan's
          // list can still carry the just-expired weekly contract in front;
          // caching that blacked out NIFTY for a full session (811 errors).
          const today = istDay();
          const next = (list || [])
            .map((e) => String(e).slice(0, 10))
            .filter((e) => e >= today)
            .sort()[0] || null;
          // MCX option series die ~2 days before their underlying future:
          // an empty expiry list means the front series is done — roll the
          // underlying to the next monthly future and refetch next slot.
          if (!next && inst.class === 'MCX' && inst.mcxNext && inst.securityId !== inst.mcxNext.securityId) {
            console.warn(`MCX roll ${inst.symbol}: underlying ${inst.securityId} -> ${inst.mcxNext.securityId} (fut exp ${inst.mcxNext.expiry})`);
            try {
              await this.provider.unsubscribeTicks([{ symbol: inst.symbol, securityId: inst.securityId, exchangeSegment: 'MCX_COMM' }]);
            } catch { /* resubscribe below matters more */ }
            inst.securityId = inst.mcxNext.securityId;
            try {
              await this.provider.subscribeTicks([{ symbol: inst.symbol, securityId: inst.securityId, exchangeSegment: 'MCX_COMM' }]);
            } catch (e) {
              console.warn(`MCX roll ${inst.symbol}: tick resubscribe deferred (${e.message})`);
            }
            // Drop the daily discovery cache so a restart re-resolves fresh
            // front/next instead of reviving the dead contract.
            await this.eventBus.client.del(`${config.redis.keyPrefix}sys:mcx:map`).catch(() => {});
            this.chainExpiries.delete(inst.symbol);
            return;
          }
          this.chainExpiries.set(inst.symbol, { value: next, day: today });
          if (!next) console.warn(`Chain poll ${inst.symbol}: no usable expiry in ${JSON.stringify(list)}`);
          return; // expiry list call shares the chain rate limit; fetch chain next slot
        }
      }

      const raw = await this.provider.getOptionChain(
        inst.securityId,
        inst.exchangeSegment,
        this.chainExpiries.get(inst.symbol).value
      );

      if (!raw || !raw.data || raw.data.length === 0) return;

      const chain = this.normalizer.normalizeOptionChain(raw, inst.symbol);
      chain.instClass = inst.class || 'INDEX'; // archive rows are self-describing

      // Futures flow over the full interval since the last chain poll for
      // this symbol, plus the future's LTP for basis (fut - spot).
      chain.futVolume = this.futVolAccum?.get(inst.symbol) || 0;
      this.futVolAccum?.set(inst.symbol, 0);
      chain.fut = this.futLtpLatest?.get(inst.symbol) || 0;

      await this.normalizer.writeOptionChain(chain);
      await this.scanners.onOptionChainFromProvider(chain);
      await this.chainArchiver.record(chain);
      if (this.v2) await this.v2.onChain(chain);
    } catch (err) {
      const detail = err.response ? JSON.stringify(err.response.data) : err.message;
      // Dhan rejected our expiry (code 811) — the cached date is wrong.
      // Drop it so the next slot refetches instead of failing all day.
      if (/expiry/i.test(detail)) this.chainExpiries.delete(inst.symbol);
      // Dhan 805 warns "further requests may result in the user being
      // blocked" — account-level risk. Stand down for a cool-off instead of
      // hammering; the scheduler catches every instrument up afterwards.
      if (/805|too many requests/i.test(detail)) this.chainScheduler?.pause(60000);
      // Dhan 806 = the account's Data-API subscription is inactive. No amount
      // of retrying fixes that — pause long and say exactly what to do.
      if (/806|not subscribed/i.test(detail)) {
        this.chainScheduler?.pause(15 * 60000);
        console.error('CRITICAL: Dhan Data APIs not subscribed (806) — renew the Data API plan in the Dhan console; polling paused 15min');
      }
      console.error(`Chain poll ${inst.symbol}:`, detail);
    }
  }

  async stop() {
    console.log('Shutting down PTA Server...');
    this.chainScheduler?.stop();
    if (this.providerRetryTimer) clearInterval(this.providerRetryTimer);
    if (this.futuresRetryTimer) clearInterval(this.futuresRetryTimer);
    if (this.analysisTimer) clearInterval(this.analysisTimer);
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
    await this.gateTelemetry?.flush().catch(() => {});
    this.health?.stop();
    this.scanners?.stop();
    this.ranking?.stop();
    this.entryTrigger?.stop();
    this.signalLifecycle?.stop();
    this.notification?.stop();
    this.archiver?.stop();
    await this.wsGateway?.stop().catch(() => {});
    this.tokenManager?.stop();
    await this.provider?.disconnect();
    await this.eventBus?.disconnect();
    await this.db?.close();
    console.log('✓ PTA Server stopped');
  }
}

// Dhan charts APIs want the instrument type of the security being queried.
function historyType(inst) {
  if (inst.exchangeSegment === 'NSE_EQ') return 'EQUITY';
  if (inst.exchangeSegment === 'MCX_COMM') return 'FUTCOM';
  return 'INDEX';
}

const server = new PTAServer();

process.on('SIGINT', async () => { await server.stop(); process.exit(0); });
process.on('SIGTERM', async () => { await server.stop(); process.exit(0); });

server.initialize().then(() => server.start()).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
