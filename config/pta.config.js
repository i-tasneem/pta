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
    tokenRefreshInterval: 20 * 60 * 60 * 1000,
    // Chain-poll budget (requests/sec) fed to ChainScheduler. Dhan's limits:
    // Data-API bucket 5 req/s, plus 1 request per UNIQUE underlying+expiry
    // per 3s. Probe 2026-07-09 measured 9 unique chains inside one 3s window
    // (docs/probe-report-2026-07-09.json); 1.5 sustained is half that floor
    // and ~2x the full Phase 1+2 demand (0.8 req/s).
    chainBudgetRps: parseFloat(process.env.CHAIN_BUDGET_RPS) || 1.5,
    chainMinUniqueGapMs: parseInt(process.env.CHAIN_MIN_UNIQUE_GAP_MS) || 3000
  },

  instruments: {
    // One entry per chain-polled underlying. class: INDEX | STOCK | MCX.
    // calendar picks the exchange clock (scanner/MarketCalendar.js + engine
    // session phases). cadenceMs is the chain-poll target the scheduler aims
    // for. STOCK/MCX entries ship DISABLED: they activate in Phase 1/2 after
    // the probe verifies underlying-segment semantics and the resolver fills
    // securityIds (stocks: NSE_EQ equity id; MCX: front-month FUTURES id,
    // which rolls monthly — never hardcode it).
    universe: [
      // Dhan numeric security IDs (api-scrip-master), segment IDX_I for indices
      { symbol: 'NIFTY', class: 'INDEX', securityId: '13', exchangeSegment: 'IDX_I', calendar: 'NSE', cadenceMs: 21000, enabled: true },
      { symbol: 'BANKNIFTY', class: 'INDEX', securityId: '25', exchangeSegment: 'IDX_I', calendar: 'NSE', cadenceMs: 21000, enabled: true },
      { symbol: 'FINNIFTY', class: 'INDEX', securityId: '27', exchangeSegment: 'IDX_I', calendar: 'NSE', cadenceMs: 21000, enabled: true },
      { symbol: 'MIDCPNIFTY', class: 'INDEX', securityId: '442', exchangeSegment: 'IDX_I', calendar: 'NSE', cadenceMs: 21000, enabled: true },
      { symbol: 'SENSEX', class: 'INDEX', securityId: '51', exchangeSegment: 'IDX_I', calendar: 'NSE', cadenceMs: 21000, enabled: true },
      { symbol: 'BANKEX', class: 'INDEX', securityId: '69', exchangeSegment: 'IDX_I', calendar: 'NSE', cadenceMs: 21000, enabled: true },

      // Phase 1 seed (12 by option liquidity; the nightly universe job
      // replaces this with a data-driven ranking — do not curate by hand).
      // signalMode 'shadow': full engine lifecycle + outcomes recorded, but
      // never surfaced as live signals — flips to 'live' per-name after the
      // shadow window validates thresholds (design §5 Phase 1).
      // securityId resolved from the scrip master at boot (NSE_EQ equity id
      // is the chain underlying — probe-verified 2026-07-09).
      ...['RELIANCE', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'AXISBANK', 'BAJFINANCE',
          'TATAMOTORS', 'TATASTEEL', 'INFY', 'ADANIENT', 'TCS', 'LT']
        .map((symbol) => ({
          symbol, class: 'STOCK', securityId: null, exchangeSegment: 'NSE_EQ',
          calendar: 'NSE', cadenceMs: 30000, enabled: true, signalMode: 'shadow'
        })),

      // Phase 2. Underlyings are futures contracts (securityId resolved at
      // runtime and rolled monthly). NG signals derive from the liquid full
      // NATURALGAS chain; NATGASMINI (lot 250 mmBtu) is the execution
      // contract shown on cards. CRUDEOIL options are both signal and
      // execution (lot 100 bbl).
      { symbol: 'CRUDEOIL', class: 'MCX', securityId: null, exchangeSegment: 'MCX_COMM', calendar: 'MCX', cadenceMs: 20000, enabled: false, lotSize: 100 },
      { symbol: 'NATURALGAS', class: 'MCX', securityId: null, exchangeSegment: 'MCX_COMM', calendar: 'MCX', cadenceMs: 20000, enabled: false, execContract: 'NATGASMINI', execLotSize: 250 }
    ],

    // Back-compat view: everything that consumed instruments.indices keeps
    // working (scanners, gateway, futures pairing).
    get indices() {
      return this.universe.filter((u) => u.class === 'INDEX');
    }
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

  // V2 positioning engine — lifecycle thresholds (env-overridable so they can
  // be tuned without code changes). readyScore lowered 70 -> 65.
  v2: {
    lifecycle: {
      formingScore: parseFloat(process.env.V2_FORMING_SCORE) || 35,
      strengtheningScore: parseFloat(process.env.V2_STRENGTHENING_SCORE) || 55,
      readyScore: parseFloat(process.env.V2_READY_SCORE) || 65,
      triggerBufferPct: parseFloat(process.env.V2_TRIGGER_BUFFER_PCT) || 0.0008,
      breakMinParticipation: parseFloat(process.env.V2_BREAK_MIN_PARTICIPATION) || 0.5,
      // consecutive undetected/weak snapshots tolerated before invalidation
      missTolerance: parseInt(process.env.V2_MISS_TOLERANCE) || 5,
      // pre-trigger stop: fraction of spot beyond the stop + consecutive
      // violating snapshots required (touch-kills were executing setups
      // created inside their own detection tolerance)
      stopBufferPct: parseFloat(process.env.V2_STOP_BUFFER_PCT) || 0.0005,
      stopViolationTolerance: parseInt(process.env.V2_STOP_VIOLATION_TOL) || 2
    },
    // Minimum live reward:risk (in premium terms, at trigger time) for a
    // READY setup to become a signal. Below this it stays READY.
    minTriggerRR: parseFloat(process.env.V2_MIN_TRIGGER_RR) || 1.8,
    // Per-class engine overrides (V2Adapter.engineFor + trigger guard).
    // Stocks: slower chain cadence (staleness scales via lifecycle cadenceMs)
    // and a higher R:R floor to pay for wider spreads + gap risk.
    perClass: {
      STOCK: {
        cadenceMs: 30000,
        minTriggerRR: parseFloat(process.env.V2_STOCK_MIN_TRIGGER_RR) || 2.2
      }
    },
    // How long to keep shadowing a non-triggered setup to see if its target
    // or stop would have been hit (missed-setup tracking).
    shadowWindowMs: parseInt(process.env.V2_SHADOW_WINDOW_MS) || 90 * 60000
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
