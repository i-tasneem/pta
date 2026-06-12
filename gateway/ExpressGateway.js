const express = require('express');
const path = require('path');

class ExpressGateway {
  constructor(
    eventBus,
    redisSchema,
    presentationService,
    rankingEngine,
    config,
    archiver
  ) {
    this.app = express();
    this.eventBus = eventBus;
    this.schema = redisSchema;
    this.presentation = presentationService;
    this.ranking = rankingEngine;
    this.config = config;
    this.archiver = archiver;
  }

  setupRoutes() {
    this.app.use(express.json());

    const frontendPath = path.join(
      process.cwd(),
      'frontend',
      'dist'
    );

    this.app.use(express.static(frontendPath));

    this.app.get('/api/health', async (req, res) => {
      const health = await this.eventBus.hgetall(
        this.schema.health()
      );

      res.json({
        status: 'ok',
        ...health
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
      const entries = await this.eventBus.xrange(
        this.schema.oiHistory(req.params.instrument),
        '-', '+', limit
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
      const entries = await this.eventBus.xrange(
        this.schema.ohlc(tf, req.params.instrument),
        '-', '+', limit
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

  async buildInstrumentCard(symbol) {
    const [state, opp, tick, signal] = await Promise.all([
      this.eventBus.hgetall(this.schema.marketState(symbol)),
      this.eventBus.hgetall(this.schema.opportunity(symbol)),
      this.eventBus.hgetall(this.schema.tick(symbol)),
      this.eventBus.hgetall(this.schema.activeSignal(symbol))
    ]);

    const hasSignal = signal && Object.keys(signal).length > 0;

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
      liquidityScore: parseFloat(opp.liquidityScore) || 0,
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