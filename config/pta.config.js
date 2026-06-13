// config/pta.config.js
module.exports = {
  provider: {
    name: 'Dhan',
    clientId: process.env.DHAN_CLIENT_ID || '',
    accessToken: process.env.DHAN_ACCESS_TOKEN || '',
    pin: process.env.DHAN_PIN || '',
    totpSecret: process.env.DHAN_TOTP_SECRET || '',
    wsUrl: 'wss://api-feed.dhan.co',
    restUrl: 'https://api.dhan.co',
    rateLimit: 25,
    tokenRefreshInterval: 20 * 60 * 60 * 1000
  },

  instruments: {
    // Dhan numeric security IDs (api-scrip-master), segment IDX_I for indices
    indices: [
      { symbol: 'NIFTY', securityId: '13', exchangeSegment: 'IDX_I' },
      { symbol: 'BANKNIFTY', securityId: '25', exchangeSegment: 'IDX_I' },
      { symbol: 'FINNIFTY', securityId: '27', exchangeSegment: 'IDX_I' },
      { symbol: 'MIDCPNIFTY', securityId: '442', exchangeSegment: 'IDX_I' },
      { symbol: 'SENSEX', securityId: '51', exchangeSegment: 'IDX_I' },
      { symbol: 'BANKEX', securityId: '69', exchangeSegment: 'IDX_I' }
    ],
    stocks: [
      'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'AXISBANK', 'KOTAKBANK',
      'BAJFINANCE', 'BAJAJFINSV', 'HDFC', 'LT', 'ITC', 'HINDUNILVR', 'SBILIFE',
      'MARUTI', 'TATAMOTORS', 'TATASTEEL', 'SUNPHARMA', 'CIPLA', 'DRREDDY',
      'ADANIENT', 'ADANIPORTS', 'POWERGRID', 'NTPC', 'ONGC', 'COALINDIA',
      'JSWSTEEL', 'GRASIM', 'ULTRACEMCO', 'SHREECEM', 'AMBUJACEM', 'ACC',
      'WIPRO', 'HCLTECH', 'TECHM', 'M&M', 'EICHERMOT', 'HEROMOTOCO',
      'BPCL', 'IOC', 'HINDPETRO', 'GAIL', 'TATAPOWER', 'NHPC',
      'DLF', 'GODREJPROP', 'OBEROIRLTY', 'BRITANNIA', 'NESTLEIND', 'DABUR'
    ]
  },

  scanners: {
    tick: { enabled: true },
    candle: { timeframes: ['1m', '3m', '5m', '15m', '30m'], maxStreamLength: 500 },
    oi: { interval: 10000 },
    volume: { spikeThreshold: 1.5, lookbackPeriods: 20 }
  },

  indicators: {
    ema: { periods: [5, 13, 21] },
    rsi: { period: 14, overbought: 70, oversold: 30 },
    bb: { period: 20, stdDev: 2 },
    atr: { period: 14 },
    vwap: { enabled: true }
  },

  opportunity: {
    minScore: 50,
    highPotentialThreshold: 85,
    triggerThreshold: 70,
    ttl: 300000,
    weights: {
      trendStrength: 0.15,
      momentumStrength: 0.15,
      volumeStrength: 0.10,
      oiStrength: 0.15,
      breakoutProbability: 0.10,
      reversalProbability: 0.10,
      liquidityScore: 0.10,
      spreadQuality: 0.05,
      riskRewardRatio: 0.10
    }
  },

  gates: {
    gate1: { unfavorableRegimes: ['EXTREME', 'DEAD'], minConfidence: 0.5 },
    gate2: { minTimeframesAligned: 3 },
    gate3: { minVolumeStrength: 60, maxRSI: { CE: 75, PE: 25 } },
    gate4: { minOIVelocity: 0, wallPinDistance: 0.5 },
    gate5: { maxSpread: 3.0, minVolumeConfirm: 80 },
    gate6: { minScore: 70, maxRank: 10 }
  },

  presentation: {
    defaultView: 'minimal',
    showReason: true,
    showDetailsButton: true,
    reasonLabels: {
      TREND: 'Strong Trend',
      BREAKOUT: 'Breakout Setup',
      REVERSAL: 'Reversal Setup',
      RANGE: 'Range Setup',
      MOMENTUM: 'Momentum Build-up',
      HIGH_CONVICTION: 'High Conviction',
      TREND_CONTINUATION: 'Trend Continuation'
    }
  },

  signal: {
    maxActivePerInstrument: 1,
    watchTimeout: 120000,
    holdTimeout: 180000,
    exitMonitorInterval: 1000,
    types: [
      'TREND_CE', 'TREND_PE',
      'BREAKOUT_CE', 'BREAKOUT_PE',
      'REVERSAL_CE', 'REVERSAL_PE',
      'RANGE_CE', 'RANGE_PE',
      'WATCHLIST_SETUP', 'WAIT', 'NO_TRADE'
    ]
  },

  ranking: { leaderboardSize: 50, topN: 10, updateInterval: 5000 },

  notification: {
    criticalThrottle: 0,
    highThrottle: 60000,
    mediumThrottle: 30000,
    lowThrottle: 5000,
    dedupWindow: 5000
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    keyPrefix: process.env.REDIS_PREFIX || 'pta:',
    streams: { ohlcMaxLen: 500, oiMaxLen: 1000, eventsMaxLen: 10000 }
  },

  postgres: {
    url: process.env.DATABASE_URL || ''
  },

  sqlite: {
    path: process.env.SQLITE_PATH || './pta_archive.db',
    archiveInterval: 60000,
    retentionDays: 90
  },

  performance: {
    tickProcessingMaxMs: 50,
    signalEvalMaxMs: 100,
    rankingUpdateMaxMs: 10,
    dashboardRefreshMaxMs: 250
  }
};
