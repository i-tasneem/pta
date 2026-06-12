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
    this.health = null;
    this.gateway = null;
    this.wsGateway = null;
  }

  async initialize() {
    console.log('Initializing PTA Server...');
    console.log('Environment:', process.env.NODE_ENV || 'development');

    // Step 1: Connect to Redis
    await this.eventBus.connect();
    console.log('✓ Redis connected');

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
    this.signalLifecycle = new SignalLifecycleEngine(this.eventBus, this.schema, config);
    this.presentation = new SignalPresentationService(this.schema, this.eventBus, config);
    this.notification = new NotificationEngine(this.eventBus, this.schema, config);
    this.archiver = new SignalArchiver(config);

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

    await this.provider.connect();
    console.log('✓ Provider connected');

    const instruments = config.instruments.indices;
    await this.provider.subscribeTicks(instruments);

    this.provider.on('tick', async (tick) => {
      const timer = this.perf.startTimer('tick_processing');
      const normalized = this.normalizer.normalizeTick(tick);
      await this.normalizer.writeTick(normalized);
      await this.scanners.onTickFromProvider(normalized);
      this.perf.endTimer(timer);
    });

    this.provider.on('ws:error', (err) => console.error('Provider WS error:', err.message));
    this.provider.on('ws:disconnected', () => console.warn('Provider WS disconnected'));

    // Start all engines
    await this.scanners.start();
    await this.ranking.start();
    await this.entryTrigger.start();
    await this.signalLifecycle.start();
    await this.notification.start();
    await this.archiver.start();

    // Start HTTP + WS gateway
    const expressGateway = new ExpressGateway(this.eventBus, this.schema, this.presentation, this.ranking, config);
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

  async stop() {
    console.log('Shutting down PTA Server...');
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
