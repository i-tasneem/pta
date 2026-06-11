// utils/RedisSchema.js
class RedisSchema {
  constructor(prefix = 'pta') {
    this.prefix = prefix;
  }

  // Tick data
  tick(instrument) { return `${this.prefix}:tick:${instrument}`; }

  // OHLC streams
  ohlc(tf, instrument) { return `${this.prefix}:ohlc:${tf}:${instrument}`; }

  // Option chain
  optionChain(instrument, expiry) {
    return expiry
      ? `${this.prefix}:option_chain:${instrument}:${expiry}`
      : `${this.prefix}:option_chain:${instrument}`;
  }

  // OI history
  oiHistory(instrument) { return `${this.prefix}:oi_history:${instrument}`; }

  // Market state
  marketState(instrument) { return `${this.prefix}:market_state:${instrument}`; }

  // Regime
  regime(instrument) { return `${this.prefix}:regime:${instrument}`; }

  // Opportunity
  opportunity(instrument) { return `${this.prefix}:opportunity:${instrument}`; }

  // Signal
  signal(instrument, signalId) {
    return signalId
      ? `${this.prefix}:signal:${instrument}:${signalId}`
      : `${this.prefix}:signal:${instrument}`;
  }

  // Active signal
  activeSignal(instrument) { return `${this.prefix}:signal:active:${instrument}`; }

  // Ranking
  leaderboard() { return `${this.prefix}:ranking:leaderboard`; }

  // Events
  events() { return `${this.prefix}:market:events`; }

  // Notifications
  notificationQueue() { return `${this.prefix}:notification:queue`; }

  // System
  brokerToken() { return `${this.prefix}:sys:broker:token`; }
  instrumentMaster(securityId) { return `${this.prefix}:sys:instrument:${securityId}:master`; }
  health() { return `${this.prefix}:sys:health`; }

  // Consumer groups
  consumerGroups() {
    return {
      scanner: 'cg-scanner',
      opportunity: 'cg-opportunity',
      trigger: 'cg-trigger',
      signal: 'cg-signal',
      ranking: 'cg-ranking',
      notification: 'cg-notification',
      dashboard: 'cg-dashboard'
    };
  }
}

module.exports = RedisSchema;
