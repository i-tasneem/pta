const express = require('express');
const path = require('path');
const authRoutes = require('./AuthRoutes');

class ExpressGateway {
  constructor(
    eventBus,
    redisSchema,
    presentationService,
    rankingEngine,
    config,
    archiver,
    v2,
    db,
    auth,
    gateTelemetry
  ) {
    this.app = express();
    this.eventBus = eventBus;
    this.schema = redisSchema;
    this.presentation = presentationService;
    this.ranking = rankingEngine;
    this.config = config;
    this.archiver = archiver;
    this.v2 = v2;
    this.db = db;
    this.auth = auth;
    this.gateTelemetry = gateTelemetry;
  }

  setupRoutes() {
    this.app.set('trust proxy', true); // OCI LB sets X-Forwarded-Proto
    this.app.use(express.json());

    const frontendPath = path.join(
      process.cwd(),
      'frontend',
      'dist'
    );

    this.app.use(express.static(frontendPath));

    // Auth: identify the caller, expose /api/auth/*, and gate the data API.
    // /api/health and /api/auth stay public (LB health check + login flow).
    if (this.auth) {
      this.app.use(this.auth.middleware());
      this.app.use('/api/auth', authRoutes(this.db, this.auth));
      if (this.db && this.db.enabled) {
        this.app.use('/api', (req, res, next) => {
          if (req.path === '/health' || req.path.startsWith('/auth')) return next();
          return this.auth.requireAuth()(req, res, next);
        });
      }
    }

    this.app.get('/api/health', async (req, res) => {
      const health = await this.eventBus.hgetall(
        this.schema.health()
      );

      // Stream-depth + feed diagnostics so data gaps are visible without login
      const streams = {};
      const ticks = {};
      let futuresResolved = [];
      try {
        const symbols = (this.config.instruments.indices || []).map(i => i.symbol);

        // Did we resolve the paired index futures? (source of volume + spread)
        const prefix = this.config.redis.keyPrefix;
        const futRaw = await this.eventBus.client.get(`${prefix}sys:futures:map`).catch(() => null);
        if (futRaw) {
          const m = JSON.parse(futRaw);
          futuresResolved = Object.entries(m).map(([sym, f]) => `${sym}=${f.securityId}`);
        }

        for (const sym of symbols) {
          const oiLen = await this.eventBus.client.xLen(this.schema.oiHistory(sym)).catch(() => 0);
          const ohlcLen = await this.eventBus.client.xLen(this.schema.ohlc('5m', sym)).catch(() => 0);
          streams[sym] = { oiHistory: oiLen, ohlc5m: ohlcLen };

          // Live tick sample: 0 volume / 0 bid-ask = futures merge not flowing
          const t = await this.eventBus.hgetall(this.schema.tick(sym));
          // Latest 5m candle volume — the real input to volumeStrength
          const last5m = await this.eventBus.xlatest(this.schema.ohlc('5m', sym), 1).catch(() => []);
          ticks[sym] = {
            ltp: t.ltp || null, volume: t.volume || null, bid: t.bid || null, ask: t.ask || null,
            lastCandleVol: last5m.length ? (last5m[0].message.volume || '0') : null
          };
        }
      } catch { /* best effort */ }

      res.json({
        status: 'ok',
        ...health,
        futuresResolved,
        streams,
        ticks
      });
    });

    this.app.get('/api/opportunities', async (req, res) => {
      const n = parseInt(req.query.limit) || 10;
      const opportunities =
        await this.ranking.getTopOpportunities(n);

      res.json({ opportunities });
    });

    this.app.get('/api/signals/active', async (req, res) => {
      const includeDetails =
        req.query.details === 'true';

      const signals =
        await this.presentation.getAllActiveSignals(
          includeDetails
        );

      res.json({ signals });
    });

    // Must be registered before /api/signals/:id
    this.app.get('/api/signals/history', async (req, res) => {
      try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const signals = req.query.instrument
          ? this.archiver.getSignalHistory(req.query.instrument, limit)
          : this.archiver.getAllSignalHistory(limit);
        res.json({ signals });
      } catch (err) {
        res.json({ signals: [] });
      }
    });

    this.app.get('/api/signals/:id', async (req, res) => {
      const includeDetails =
        req.query.details === 'true';

      const signal =
        await this.presentation.getSignal(
          req.params.id,
          includeDetails
        );

      if (!signal) {
        return res
          .status(404)
          .json({ error: 'Signal not found' });
      }

      res.json({ signal });
    });

    this.app.get('/api/scanner/status', async (req, res) => {
      const health = await this.eventBus.hgetall(
        this.schema.health()
      );

      res.json({
        status: 'ok',
        ...health
      });
    });

    // Diagnostics — gate conversion funnel (today, restart-durable)
    this.app.get('/api/diag/funnel', async (req, res) => {
      if (!this.gateTelemetry) return res.json({ enabled: false });
      res.json({ enabled: true, ...this.gateTelemetry.getFunnel() });
    });

    // Diagnostics — rejection analytics over a recent window (default 24h)
    this.app.get('/api/diag/rejections', async (req, res) => {
      if (!this.db || !this.db.enabled) return res.json({ enabled: false });
      const hours = Math.min(parseInt(req.query.hours) || 24, 720);
      const since = new Date(Date.now() - hours * 3600000);
      try {
        const [byGate, byReason, bySymbol, byRegime, totals] = await Promise.all([
          this.db.query(
            `SELECT failed_at_gate AS gate, count(*)::int AS n FROM gate_audit
              WHERE ts >= $1 AND failed_at_gate IS NOT NULL
              GROUP BY failed_at_gate ORDER BY n DESC`, [since]),
          this.db.query(
            `SELECT failed_at_gate AS gate, reason, count(*)::int AS n FROM gate_audit
              WHERE ts >= $1 AND reason IS NOT NULL
              GROUP BY failed_at_gate, reason ORDER BY n DESC LIMIT 25`, [since]),
          this.db.query(
            `SELECT symbol, failed_at_gate AS gate, count(*)::int AS n FROM gate_audit
              WHERE ts >= $1 AND failed_at_gate IS NOT NULL
              GROUP BY symbol, failed_at_gate ORDER BY n DESC LIMIT 50`, [since]),
          this.db.query(
            `SELECT regime, failed_at_gate AS gate, count(*)::int AS n FROM gate_audit
              WHERE ts >= $1 AND failed_at_gate IS NOT NULL
              GROUP BY regime, failed_at_gate ORDER BY n DESC LIMIT 50`, [since]),
          this.db.query(
            `SELECT count(*)::int AS runs,
                    count(*) FILTER (WHERE generated)::int AS generated,
                    count(*) FILTER (WHERE NOT generated)::int AS rejected
               FROM gate_audit WHERE ts >= $1`, [since])
        ]);
        res.json({
          enabled: true, windowHours: hours,
          totals: totals.rows[0],
          mostCommonRejectionGate: byGate.rows[0] || null,
          byGate: byGate.rows,
          topReasons: byReason.rows,
          bySymbol: bySymbol.rows,
          byRegime: byRegime.rows
        });
      } catch (err) {
        res.json({ enabled: true, error: err.message });
      }
    });

    // Diagnostics — setups that never triggered but whose target/stop would
    // have hit, bucketed by peak score (evidence to calibrate readyScore)
    this.app.get('/api/diag/missed', async (req, res) => {
      if (!this.db || !this.db.enabled) return res.json({ enabled: false });
      const hours = Math.min(parseInt(req.query.hours) || 168, 2160);
      const since = new Date(Date.now() - hours * 3600000);
      try {
        const [buckets, recent] = await Promise.all([
          this.db.query(
            `SELECT
               CASE WHEN peak_score >= 80 THEN '80+'
                    WHEN peak_score >= 70 THEN '70-80'
                    WHEN peak_score >= 60 THEN '60-70'
                    WHEN peak_score >= 50 THEN '50-60'
                    ELSE '<50' END AS band,
               count(*) FILTER (WHERE shadow_outcome = 'WOULD_WIN')::int  AS would_win,
               count(*) FILTER (WHERE shadow_outcome = 'WOULD_LOSE')::int AS would_lose,
               count(*) FILTER (WHERE shadow_outcome = 'WOULD_EXPIRE')::int AS would_expire,
               count(*)::int AS total
             FROM missed_setups WHERE created_at >= $1
             GROUP BY band ORDER BY band DESC`, [since]),
          this.db.query(
            `SELECT id, symbol, archetype, direction, peak_score, peak_stage,
                    shadow_outcome, terminal_reason, created_at
               FROM missed_setups WHERE created_at >= $1
              ORDER BY created_at DESC LIMIT 100`, [since])
        ]);
        const bands = buckets.rows.map((b) => {
          const decided = b.would_win + b.would_lose;
          return { ...b, winRatePct: decided > 0 ? Math.round((b.would_win / decided) * 1000) / 10 : null };
        });
        res.json({ enabled: true, windowHours: hours, bands, recent: recent.rows });
      } catch (err) {
        res.json({ enabled: true, error: err.message });
      }
    });

    // Diagnostics — trace a single opportunity's recent gate runs
    this.app.get('/api/diag/opportunity/:id', async (req, res) => {
      if (!this.db || !this.db.enabled) return res.json({ enabled: false });
      try {
        const r = await this.db.query(
          `SELECT * FROM gate_audit WHERE opportunity_id = $1 ORDER BY ts DESC LIMIT 50`,
          [req.params.id]
        );
        res.json({ enabled: true, runs: r.rows });
      } catch (err) {
        res.json({ enabled: true, error: err.message });
      }
    });

    // V2 positioning engine — active setups across instruments (the
    // FORMING -> READY -> TRIGGERED lifecycle the UI renders)
    this.app.get('/api/v2/setups', async (req, res) => {
      if (!this.v2) return res.json({ enabled: false, setups: [] });
      res.json({ enabled: true, setups: this.v2.getActiveSetups() });
    });

    // V2 signal history from Postgres
    this.app.get('/api/v2/signals', async (req, res) => {
      if (!this.db || !this.db.enabled) return res.json({ signals: [] });
      try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const r = await this.db.query(
          `SELECT s.*, o.outcome, o.pnl, o.duration_ms
             FROM signals s LEFT JOIN signal_outcomes o ON o.signal_id = s.id
            ORDER BY s.created_at DESC LIMIT $1`,
          [limit]
        );
        res.json({ signals: r.rows });
      } catch (err) {
        res.json({ signals: [] });
      }
    });

    // Screener: one intelligence card per tracked instrument
    this.app.get('/api/screener', async (req, res) => {
      const symbols = this.config.instruments.indices.map(i => i.symbol);
      const instruments = await Promise.all(
        symbols.map(symbol => this.buildInstrumentCard(symbol))
      );
      res.json({ instruments });
    });

    // OI / PCR history for trend charts
    this.app.get('/api/oi/:instrument/history', async (req, res) => {
      const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
      const entries = await this.eventBus.xlatest(
        this.schema.oiHistory(req.params.instrument),
        limit
      );

      const history = (entries || []).map(e => ({
        timestamp: parseInt(e.message.timestamp) || 0,
        totalCeOi: parseFloat(e.message.totalCeOi) || 0,
        totalPeOi: parseFloat(e.message.totalPeOi) || 0,
        pcr: parseFloat(e.message.pcr) || 0,
        supportWalls: this.safeParse(e.message.supportWalls, []),
        resistanceWalls: this.safeParse(e.message.resistanceWalls, [])
      }));

      res.json({ instrument: req.params.instrument, history });
    });

    // Volume trend from candle stream (volume bars only, no candle charting)
    this.app.get('/api/volume/:instrument', async (req, res) => {
      const tf = ['1m', '3m', '5m', '15m', '30m'].includes(req.query.tf)
        ? req.query.tf : '5m';
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const entries = await this.eventBus.xlatest(
        this.schema.ohlc(tf, req.params.instrument),
        limit
      );

      const volumes = (entries || []).map(e => ({
        timestamp: parseInt(e.message.timestamp) || 0,
        volume: parseFloat(e.message.volume) || 0,
        close: parseFloat(e.message.close) || 0
      }));

      res.json({ instrument: req.params.instrument, tf, volumes });
    });

    // Smart option chain
    this.app.get('/api/chain/:instrument', async (req, res) => {
      const raw = await this.eventBus.hgetall(
        this.schema.optionChain(req.params.instrument)
      );

      if (!raw || Object.keys(raw).length === 0) {
        return res.json({ instrument: req.params.instrument, strikes: [] });
      }

      const strikeMap = {};
      for (const [field, value] of Object.entries(raw)) {
        const match = field.match(/^(ce|pe):(.+)$/);
        if (!match) continue;
        const strike = parseFloat(match[2]);
        if (!strikeMap[strike]) strikeMap[strike] = { strike };
        strikeMap[strike][match[1]] = this.safeParse(value, {});
      }

      const strikes = Object.values(strikeMap).sort((a, b) => a.strike - b.strike);
      const state = await this.eventBus.hgetall(
        this.schema.marketState(req.params.instrument)
      );

      res.json({
        instrument: req.params.instrument,
        atmStrike: parseFloat(raw.atmStrike) || 0,
        spotLtp: parseFloat(raw.spotLtp) || 0,
        pcr: parseFloat(raw.pcr) || 0,
        totalCeOi: parseFloat(raw.totalCeOi) || 0,
        totalPeOi: parseFloat(raw.totalPeOi) || 0,
        maxPain: parseFloat(state.maxPain) || 0,
        expiry: raw.expiry || '',
        timestamp: parseInt(raw.timestamp) || 0,
        strikes
      });
    });

    // Performance analytics from archived outcomes
    this.app.get('/api/performance', async (req, res) => {
      try {
        const outcomes = this.archiver.getAllOutcomes(500);
        const wins = outcomes.filter(o => (o.pnl || 0) > 0);
        const losses = outcomes.filter(o => (o.pnl || 0) <= 0);
        const totalPnl = outcomes.reduce((a, o) => a + (o.pnl || 0), 0);

        res.json({
          total: outcomes.length,
          wins: wins.length,
          losses: losses.length,
          winRate: outcomes.length > 0 ? (wins.length / outcomes.length) * 100 : 0,
          totalPnl,
          avgPnl: outcomes.length > 0 ? totalPnl / outcomes.length : 0,
          avgDurationMs: outcomes.length > 0
            ? outcomes.reduce((a, o) => a + (o.duration_ms || 0), 0) / outcomes.length
            : 0,
          outcomes: outcomes.slice(0, 100)
        });
      } catch (err) {
        res.json({ total: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0, avgPnl: 0, avgDurationMs: 0, outcomes: [] });
      }
    });

    this.app.get('/api/market/:instrument', async (req, res) => {
      const state = await this.eventBus.hgetall(
        this.schema.marketState(req.params.instrument)
      );

      res.json({
        instrument: req.params.instrument,
        state
      });
    });

    // Disabled until notification engine is wired correctly
    this.app.get('/api/notifications', async (req, res) => {
      res.json({ notifications: [] });
    });

    // React SPA fallback
    this.app.get('*', (req, res) => {
      res.sendFile(
        path.join(frontendPath, 'index.html')
      );
    });
  }

  // Liquidity from the ATM OPTION's spread (the tradeable instrument), not the
  // underlying — index/futures spreads are always <1% so the old underlying-
  // based score pegged at 95 for everything.
  async optionLiquidity(symbol, atmStrike) {
    if (!atmStrike) return 0;
    try {
      const chain = await this.eventBus.hgetall(this.schema.optionChain(symbol));
      const ce = this.safeParse(chain[`ce:${atmStrike}`], null);
      const pe = this.safeParse(chain[`pe:${atmStrike}`], null);
      const spreadOf = (leg) => {
        if (!leg || !(leg.ltp > 0) || !(leg.ask > 0)) return null;
        return ((leg.ask - leg.bid) / leg.ltp) * 100;
      };
      const spreads = [spreadOf(ce), spreadOf(pe)].filter((s) => s != null);
      if (spreads.length === 0) return 0;
      const spread = spreads.reduce((a, b) => a + b, 0) / spreads.length;
      if (spread < 0.5) return 95;
      if (spread < 1) return 85;
      if (spread < 2) return 70;
      if (spread < 3.5) return 55;
      if (spread < 6) return 35;
      return 20;
    } catch {
      return 0;
    }
  }

  async buildInstrumentCard(symbol) {
    const [state, opp, tick, signal] = await Promise.all([
      this.eventBus.hgetall(this.schema.marketState(symbol)),
      this.eventBus.hgetall(this.schema.opportunity(symbol)),
      this.eventBus.hgetall(this.schema.tick(symbol)),
      this.eventBus.hgetall(this.schema.activeSignal(symbol))
    ]);

    const hasSignal = signal && Object.keys(signal).length > 0;
    const atmStrike = parseFloat(state.atmStrike) || 0;
    const optLiquidity = await this.optionLiquidity(symbol, atmStrike);

    return {
      instrument: symbol,
      ltp: parseFloat(tick.ltp) || 0,
      change: parseFloat(tick.change) || 0,
      changePercent: parseFloat(tick.changePercent) || 0,

      regime: state.regime || 'UNKNOWN',
      regimeConfidence: parseFloat(state.regimeConfidence) || 0,
      regimeReason: state.regimeReason || '',

      pcr: parseFloat(state.pcrValue) || 0,
      pcrTrend: state.pcrTrend || 'NEUTRAL',
      maxPain: parseFloat(state.maxPain) || 0,
      atmStrike: parseFloat(state.atmStrike) || 0,

      oiPattern: state.oiPattern || 'NEUTRAL',
      oiVelocity: parseFloat(state.oiVelocity) || 0,
      totalCeOi: parseFloat(state.totalCeOi) || 0,
      totalPeOi: parseFloat(state.totalPeOi) || 0,
      strikeConcentration: parseFloat(state.strikeConcentration) || 0,
      supportWalls: this.safeParse(state.supportWalls, []),
      resistanceWalls: this.safeParse(state.resistanceWalls, []),

      volumeStrength: parseFloat(state.volumeStrength_5m) || 0,
      trendStrength: parseFloat(state.trendStrength) || 0,
      trendDirection: state.trendDirection || 'NEUTRAL',

      score: parseFloat(opp.score) || 0,
      direction: opp.direction || null,
      opportunityState: opp.state || null,
      liquidityScore: optLiquidity || parseFloat(opp.liquidityScore) || 0,
      componentScores: opp.score ? {
        trend: parseFloat(opp.trendScore) || 0,
        momentum: parseFloat(opp.momentumScore) || 0,
        volume: parseFloat(opp.volumeScore) || 0,
        oi: parseFloat(opp.oiScore) || 0,
        breakout: parseFloat(opp.breakoutScore) || 0,
        reversal: parseFloat(opp.reversalScore) || 0,
        liquidity: parseFloat(opp.liquidityScore) || 0,
        riskReward: parseFloat(opp.riskRewardScore) || 0
      } : null,

      signal: hasSignal ? {
        id: signal.id,
        type: signal.type,
        direction: signal.direction,
        confidence: parseFloat(signal.confidence) || 0,
        status: signal.state,
        reason: signal.userReason || ''
      } : null
    };
  }

  safeParse(json, fallback) {
    if (!json || json === 'null') return fallback;
    try { return JSON.parse(json); } catch { return fallback; }
  }

  listen(port) {
    this.setupRoutes();

    this.server = this.app.listen(port, () => {
      console.log(
        `ExpressGateway listening on port ${port}`
      );
    });

    return this.server;
  }
}

module.exports = ExpressGateway;