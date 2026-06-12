const express = require('express');
const path = require('path');

class ExpressGateway {
  constructor(
    eventBus,
    redisSchema,
    presentationService,
    rankingEngine,
    config
  ) {
    this.app = express();
    this.eventBus = eventBus;
    this.schema = redisSchema;
    this.presentation = presentationService;
    this.ranking = rankingEngine;
    this.config = config;
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

    this.app.get('/api/signals/history', async (req, res) => {
      res.json({ signals: [] });
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