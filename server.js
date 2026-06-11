// server.js
const DhanProvider = require('./providers/DhanProvider');
const MockProvider = require('./providers/MockProvider');
const EventNormalizer = require('./providers/EventNormalizer');
const EventBus = require('./utils/EventBus');
const RedisSchema = require('./utils/RedisSchema');
const PerformanceMonitor = require('./utils/PerformanceMonitor');
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
    await this.eventBus.connect();
    console.log('✓ Redis connected');

    if (process.env.USE_MOCK === 'true') {
      this.provider = new MockProvider(config.provider);
    } else {
      this.provider = new DhanProvider(config.provider);
    }
    this.normalizer = new EventNormalizer(this.schema, this.eventBus);

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

    await this.scanners.start();
    await this.ranking.start();
    await this.entryTrigger.start();
    await this.signalLifecycle.start();
    await this.notification.start();
    await this.archiver.start();

    const expressGateway = new ExpressGateway(this.eventBus, this.schema, this.presentation, this.ranking, config);
    const server = expressGateway.listen(process.env.PORT || 3000);

    this.wsGateway = new WebSocketGateway(server, this.eventBus, this.schema, config);
    await this.wsGateway.initialize();
    this.wsGateway.startEventStreaming();

    this.health = new HealthMonitor(this.eventBus, this.schema, this.provider, this.scanners);
    await this.health.start();

    console.log('✓ PTA Server fully operational');
    console.log(`  Dashboard: http://localhost:${process.env.PORT || 3000}`);
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
