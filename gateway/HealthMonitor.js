// gateway/HealthMonitor.js
class HealthMonitor {
  constructor(eventBus, redisSchema, provider, scannerOrchestrator) {
    this.eventBus = eventBus;
    this.schema = redisSchema;
    this.provider = provider;
    this.scanner = scannerOrchestrator;
  }

  async start() {
    this.interval = setInterval(async () => {
      try {
        const redisStart = Date.now();
        await this.eventBus.ping();
        const redisLatency = Date.now() - redisStart;

        const activeSignals = await this.eventBus.client.keys(`${this.schema.prefix}:signal:active:*`);
        const topOpps = await this.eventBus.zrevrange(this.schema.leaderboard(), 0, -1);

        await this.eventBus.hset(this.schema.health(), {
          wsConnected: this.provider.connected ? '1' : '0',
          lastTickTime: Date.now(),
          activeScanners: this.scanner.getInstrumentCount(),
          activeSignals: activeSignals.length,
          topOpportunities: topOpps.length,
          redisLatency: redisLatency.toFixed(2)
        });

        await this.eventBus.expire(this.schema.health(), 60);
      } catch (err) {
        console.error('HealthMonitor error:', err.message);
      }
    }, 5000);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
  }
}

module.exports = HealthMonitor;
