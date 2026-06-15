// signals/V2Adapter.js
// Bridges the live JS app to the compiled TypeScript V2 engine. Owns one
// SetupEngine per instrument, converts each normalized chain into the engine's
// snapshot shape, runs the pipeline, attaches strike selection + a premium
// risk plan, persists signals/outcomes to Postgres, and surfaces active setups
// to the UI. Every entry point is guarded so it can never break the poll loop.

const ARCHETYPE_PRIORS = {
  WALL_CAPITULATION_BREAK: 0.55,
  WALL_ABSORPTION_FADE: 0.60,
  WRITER_MIGRATION_CONTINUATION: 0.62,
  BASIS_FLOW_DIVERGENCE_REVERSAL: 0.50,
  EXPIRY_PIN: 0.58
};

const NOTABLE = new Set(['READY', 'TRIGGERED', 'TARGET_HIT', 'STOPLOSS_HIT']);
const TERMINAL = new Set(['TARGET_HIT', 'STOPLOSS_HIT', 'INVALIDATED', 'EXPIRED']);

class V2Adapter {
  constructor(db, eventBus, schema, config, engine, broadcast) {
    this.db = db;
    this.eventBus = eventBus;
    this.schema = schema;
    this.config = config;
    this.engine = engine;            // compiled engine module (engine/dist)
    this.broadcast = broadcast || (() => {});
    this.engines = new Map();        // instrument -> SetupEngine
    this.futVol = new Map();         // instrument -> RollingWindow
    this.setups = new Map();         // instrument -> latest active setups (UI)
    this.lastKnown = new Map();      // hypothesis id -> { entry, stop, target, direction, archetype }
  }

  engineFor(instrument) {
    let e = this.engines.get(instrument);
    if (!e) {
      e = new this.engine.SetupEngine(instrument, {});
      this.engines.set(instrument, e);
      this.futVol.set(instrument, new this.engine.RollingWindow(120));
    }
    return e;
  }

  async onChain(chain) {
    try {
      if (!chain || !Array.isArray(chain.strikes) || chain.strikes.length === 0) return;

      const state = await this.readState(chain.instrument);
      const futVolumeDelta = Number(chain.futVolume) || 0;

      const win = this.futVol.get(chain.instrument) || new this.engine.RollingWindow(120);
      const participation = win.percentileRank(futVolumeDelta);
      win.push(futVolumeDelta);
      this.futVol.set(chain.instrument, win);

      const snapshot = this.toSnapshot(chain, state.maxPain);
      const result = this.engineFor(chain.instrument).onSnapshot(snapshot, futVolumeDelta, participation);

      // Build UI views (strike + risk plan) for active setups
      const views = result.hypotheses.map((h) => this.view(h, chain, state.atr));
      this.setups.set(chain.instrument, views);

      // Track entry/levels for outcome accounting
      for (const h of result.hypotheses) {
        this.lastKnown.set(h.id, {
          entry: h.entryRef, stop: h.structuralStop, target: h.structuralTarget,
          direction: h.direction, archetype: h.archetype, triggeredAt: h.triggeredAt
        });
      }

      for (const t of result.transitions) {
        await this.persistTransition(t, chain, state.atr);
        if (NOTABLE.has(t.to)) {
          this.broadcast({ type: 'v2:transition', instrument: t.instrument, data: t });
        }
        if (TERMINAL.has(t.to)) await this.persistOutcome(t, chain);
      }
    } catch (err) {
      console.error(`V2Adapter ${chain && chain.instrument}:`, err.message);
    }
  }

  async readState(instrument) {
    try {
      const s = await this.eventBus.hgetall(this.schema.marketState(instrument));
      return { maxPain: parseFloat(s.maxPain) || 0, atr: parseFloat(s.atr_5m) || 0 };
    } catch {
      return { maxPain: 0, atr: 0 };
    }
  }

  toSnapshot(chain, maxPain) {
    return {
      instrument: chain.instrument,
      ts: Number(chain.timestamp) || Date.now(),
      spot: Number(chain.spotLtp) || 0,
      fut: Number(chain.fut) || undefined,
      futVolume: Number(chain.futVolume) || undefined,
      atmStrike: Number(chain.atmStrike) || 0,
      pcr: Number(chain.pcr) || 0,
      maxPain: maxPain || undefined,
      totalCeOi: Number(chain.totalCeOi) || 0,
      totalPeOi: Number(chain.totalPeOi) || 0,
      expiry: chain.expiry || '',
      strikes: chain.strikes.map((s) => ({
        strike: Number(s.strike),
        ce: this.leg(s.ce),
        pe: this.leg(s.pe)
      }))
    };
  }

  leg(l) {
    l = l || {};
    return {
      ltp: Number(l.ltp) || 0, oi: Number(l.oi) || 0, volume: Number(l.volume) || 0,
      iv: Number(l.iv) || 0, delta: Number(l.delta) || 0
    };
  }

  // Most liquid option near 0.5 delta for the signal direction.
  selectStrike(chain, direction) {
    let best = null;
    let bestScore = Infinity;
    for (const s of chain.strikes) {
      const leg = direction === 'CE' ? s.ce : s.pe;
      if (!leg || !(leg.ltp > 0)) continue;
      const deltaGap = Math.abs(Math.abs(Number(leg.delta) || 0.5) - 0.5);
      const spreadPct = leg.ask > 0 ? Math.max(0, leg.ask - leg.bid) / leg.ltp : 0.5;
      const score = deltaGap + spreadPct;
      if (score < bestScore) { bestScore = score; best = { strike: s.strike, leg }; }
    }
    if (!best && chain.strikes.length) {
      const atm = chain.strikes.reduce((b, s) =>
        Math.abs(s.strike - chain.atmStrike) < Math.abs(b.strike - chain.atmStrike) ? s : b, chain.strikes[0]);
      best = { strike: atm.strike, leg: direction === 'CE' ? atm.ce : atm.pe };
    }
    return best;
  }

  planFor(h, chain, atr) {
    const sel = this.selectStrike(chain, h.direction);
    if (!sel || !sel.leg || !(sel.leg.ltp > 0)) return null;
    const deltaSigned = h.direction === 'CE'
      ? Math.abs(Number(sel.leg.delta) || 0.5)
      : -Math.abs(Number(sel.leg.delta) || 0.5);
    const premiumATR = this.engine.premiumATRfromUnderlying(atr || 50, deltaSigned) || 10;
    const plan = this.engine.buildRiskPlan({
      direction: h.direction, entryUnderlying: h.entryRef,
      structuralStop: h.structuralStop, structuralTarget: h.structuralTarget,
      optionPremium: sel.leg.ltp, deltaSigned, gamma: 0, premiumATR
    });
    return { strike: sel.strike, entryPremium: sel.leg.ltp, ...plan };
  }

  view(h, chain, atr) {
    const plan = this.planFor(h, chain, atr);
    return {
      id: h.id, instrument: h.instrument, archetype: h.archetype, direction: h.direction,
      stage: h.stage, score: h.score, confidence: this.confidence(h),
      reasons: h.reasons, thesis: h.thesis,
      entryRef: h.entryRef, structuralStop: h.structuralStop, structuralTarget: h.structuralTarget,
      plan, updatedAt: h.updatedAt
    };
  }

  confidence(h) {
    // Prior-based until the learning loop populates strategy_performance.
    const prior = ARCHETYPE_PRIORS[h.archetype] ?? 0.5;
    return { value: Math.round(prior * 100), basis: 'prior', samples: 0 };
  }

  getActiveSetups() {
    const all = [];
    for (const views of this.setups.values()) all.push(...views);
    return all.sort((a, b) => b.score - a.score);
  }

  async persistTransition(t, chain, atr) {
    if (!this.db || !this.db.enabled) return;
    try {
      const view = this.view(
        { ...t, entryRef: (this.lastKnown.get(t.id) || {}).entry ?? chain.spotLtp,
          structuralStop: (this.lastKnown.get(t.id) || {}).stop ?? 0,
          structuralTarget: (this.lastKnown.get(t.id) || {}).target ?? 0,
          updatedAt: t.ts, reasons: t.reasons, thesis: t.thesis },
        chain, atr
      );
      await this.db.query(
        `INSERT INTO signals
           (id, symbol, strategy, regime, direction, state, score, confidence,
            entry_zone, sl, target, reason, evidence, triggered_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (id) DO UPDATE SET
           state = EXCLUDED.state, score = EXCLUDED.score, confidence = EXCLUDED.confidence,
           sl = EXCLUDED.sl, target = EXCLUDED.target, reason = EXCLUDED.reason,
           triggered_at = COALESCE(signals.triggered_at, EXCLUDED.triggered_at)`,
        [
          t.id, t.instrument, t.archetype, null, t.direction, t.to, t.score,
          (this.confidence(t).value),
          JSON.stringify({ ref: view.entryRef, strike: view.plan && view.plan.strike, premium: view.plan && view.plan.entryPremium }),
          JSON.stringify(view.plan ? { premium: view.plan.stopPremium, underlying: view.structuralStop } : null),
          JSON.stringify(view.plan ? { premium: view.plan.targetPremium, underlying: view.structuralTarget } : null),
          JSON.stringify(t.reasons || []),
          JSON.stringify([]),
          t.to === 'TRIGGERED' ? new Date(t.ts) : null
        ]
      );
    } catch (err) {
      console.error('V2 persistTransition:', err.message);
    }
  }

  async persistOutcome(t, chain) {
    if (!this.db || !this.db.enabled) return;
    const lk = this.lastKnown.get(t.id);
    this.lastKnown.delete(t.id);
    if (!lk) return;
    try {
      const exit = Number(chain.spotLtp) || 0;
      const entry = lk.entry;
      const pnl = lk.direction === 'CE' ? exit - entry : entry - exit;
      const duration = lk.triggeredAt ? t.ts - lk.triggeredAt : null;
      await this.db.query(
        `INSERT INTO signal_outcomes (signal_id, outcome, entry_px, exit_px, pnl, duration_ms)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (signal_id) DO UPDATE SET
           outcome = EXCLUDED.outcome, exit_px = EXCLUDED.exit_px,
           pnl = EXCLUDED.pnl, duration_ms = EXCLUDED.duration_ms`,
        [t.id, t.to, entry, exit, pnl, duration]
      );
    } catch (err) {
      console.error('V2 persistOutcome:', err.message);
    }
  }
}

module.exports = V2Adapter;
