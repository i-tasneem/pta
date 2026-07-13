// backtest/Backtester.js
// Replays archived chain snapshots through the SAME SetupEngine the live app
// uses, so backtest and live can never diverge. Reconstructs snapshots from
// Postgres, runs the pipeline, books trades on TRIGGERED -> terminal, and
// computes performance metrics. Pure runSnapshots() is unit-testable without a DB.
const engine = require('../engine/dist/index.js');

// Builds OHLC bars from the replayed spot path so the confluence resolver has
// EMA/BB levels during a backtest (archived snapshots carry spot, not candles).
class SpotCandles {
  constructor(intervalMs, cap = 600) {
    this.interval = intervalMs;
    this.cap = cap;
    this.bars = [];
    this.curStart = null;
  }
  update(ts, spot) {
    if (!(spot > 0)) return;
    const start = Math.floor(ts / this.interval) * this.interval;
    if (this.curStart === null || start !== this.curStart) {
      this.bars.push({ open: spot, high: spot, low: spot, close: spot });
      this.curStart = start;
      if (this.bars.length > this.cap) this.bars.shift();
    } else {
      const b = this.bars[this.bars.length - 1];
      b.high = Math.max(b.high, spot);
      b.low = Math.min(b.low, spot);
      b.close = spot;
    }
  }
  candles() { return this.bars; }
}

class Backtester {
  constructor(db) {
    this.db = db;
  }

  async loadSnapshots(symbol, fromISO, toISO) {
    const snaps = await this.db.query(
      `SELECT id, ts, spot, fut, fut_vol, atm_strike, pcr, max_pain,
              total_ce_oi, total_pe_oi, expiry
         FROM chain_snapshots
        WHERE symbol = $1 AND ts >= $2 AND ts < $3
        ORDER BY ts ASC`,
      [symbol, fromISO, toISO]
    );
    if (snaps.rows.length === 0) return [];

    const ids = snaps.rows.map((r) => r.id);
    const strikes = await this.db.query(
      `SELECT snapshot_id, strike, ce_oi, pe_oi, ce_vol, pe_vol,
              ce_ltp, pe_ltp, ce_bid, ce_ask, pe_bid, pe_ask,
              ce_iv, pe_iv, ce_delta, pe_delta
         FROM chain_strikes
        WHERE snapshot_id = ANY($1::bigint[])
        ORDER BY strike ASC`,
      [ids]
    );

    const byId = new Map();
    for (const r of strikes.rows) {
      if (!byId.has(r.snapshot_id)) byId.set(r.snapshot_id, []);
      byId.get(r.snapshot_id).push(r);
    }

    return snaps.rows.map((s) => ({
      instrument: symbol,
      ts: new Date(s.ts).getTime(),
      spot: Number(s.spot) || 0,
      fut: s.fut != null ? Number(s.fut) : undefined,
      futVolume: Number(s.fut_vol) || 0,
      atmStrike: Number(s.atm_strike) || 0,
      pcr: Number(s.pcr) || 0,
      maxPain: s.max_pain != null ? Number(s.max_pain) : undefined,
      totalCeOi: Number(s.total_ce_oi) || 0,
      totalPeOi: Number(s.total_pe_oi) || 0,
      expiry: s.expiry || '',
      strikes: (byId.get(s.id) || []).map((k) => ({
        strike: Number(k.strike),
        ce: { ltp: Number(k.ce_ltp) || 0, bid: Number(k.ce_bid) || 0, ask: Number(k.ce_ask) || 0, oi: Number(k.ce_oi) || 0, volume: Number(k.ce_vol) || 0, iv: Number(k.ce_iv) || 0, delta: Number(k.ce_delta) || 0 },
        pe: { ltp: Number(k.pe_ltp) || 0, bid: Number(k.pe_bid) || 0, ask: Number(k.pe_ask) || 0, oi: Number(k.pe_oi) || 0, volume: Number(k.pe_vol) || 0, iv: Number(k.pe_iv) || 0, delta: Number(k.pe_delta) || 0 }
      }))
    }));
  }

  // Pure replay — deterministic, no DB. `snapshots` are in engine shape.
  runSnapshots(instrument, snapshots, opts = {}) {
    const eng = new engine.SetupEngine(instrument, Backtester.engineOptions(opts));
    const futWin = new engine.RollingWindow(120);
    const open = new Map();
    const trades = [];

    for (const snap of snapshots) {
      const fv = snap.futVolume || 0;
      const participation = futWin.percentileRank(fv);
      futWin.push(fv);

      const res = eng.onSnapshot(snap, fv, participation);
      for (const t of res.transitions) {
        if (t.to === 'TRIGGERED') {
          const h = res.hypotheses.find((x) => x.id === t.id);
          if (h) {
            open.set(t.id, {
              entry: snap.spot, stop: h.structuralStop, target: h.structuralTarget,
              direction: h.direction, archetype: h.archetype, ts: snap.ts
            });
          }
        } else if (t.to === 'TARGET_HIT' || t.to === 'STOPLOSS_HIT') {
          const o = open.get(t.id);
          if (!o) continue;
          open.delete(t.id);
          const riskU = Math.abs(o.entry - o.stop) || 1;
          const rewardR = Math.abs(o.target - o.entry) / riskU;
          const r = t.to === 'TARGET_HIT' ? rewardR : -1;
          trades.push({
            id: t.id, archetype: o.archetype, direction: o.direction, outcome: t.to,
            entry: o.entry, exit: snap.spot, r, durationMs: snap.ts - o.ts
          });
        }
      }
    }

    const openTrades = Backtester.markOpen(open, snapshots.at(-1));
    return { trades, openTrades, metrics: { ...Backtester.computeMetrics(trades), unresolved: openTrades.length } };
  }

  // Forward-simulated exits: book on TRIGGERED, then walk the spot path and close
  // when the chosen target/stop is touched. With useConfluence the stop/target
  // come from the confluence resolver (EMA/BB + walls) on spot-derived candles;
  // otherwise they are the raw structural wall levels. Both modes share this exit
  // walk, so the only difference is WHERE the levels sit — a fair before/after.
  simulateExits(instrument, snapshots, opts = {}, useConfluence = false) {
    const eng = new engine.SetupEngine(instrument, Backtester.engineOptions(opts));
    const futWin = new engine.RollingWindow(120);
    const agg5 = new SpotCandles(300000);
    const agg15 = new SpotCandles(900000);
    const aggD = new SpotCandles(86400000);
    const open = new Map();
    const trades = [];

    for (const snap of snapshots) {
      agg5.update(snap.ts, snap.spot);
      agg15.update(snap.ts, snap.spot);
      aggD.update(snap.ts, snap.spot);

      const fv = snap.futVolume || 0;
      const participation = futWin.percentileRank(fv);
      futWin.push(fv);

      const res = eng.onSnapshot(snap, fv, participation);

      // Close any open trade whose target/stop the spot has now touched.
      for (const [id, o] of [...open]) {
        const hit = o.direction === 'CE'
          ? (snap.spot >= o.target ? 'TARGET_HIT' : snap.spot <= o.stop ? 'STOPLOSS_HIT' : null)
          : (snap.spot <= o.target ? 'TARGET_HIT' : snap.spot >= o.stop ? 'STOPLOSS_HIT' : null);
        if (!hit) continue;
        open.delete(id);
        const riskU = Math.abs(o.entry - o.stop) || 1;
        const r = hit === 'TARGET_HIT' ? Math.abs(o.target - o.entry) / riskU : -1;
        trades.push({
          id, archetype: o.archetype, direction: o.direction, outcome: hit,
          entry: o.entry, exit: snap.spot, r, durationMs: snap.ts - o.ts,
          stopSource: o.stopSource, targetSource: o.targetSource
        });
      }

      // Book new entries on TRIGGERED with the chosen exit levels.
      for (const t of res.transitions) {
        if (t.to !== 'TRIGGERED' || open.has(t.id)) continue;
        const h = res.hypotheses.find((x) => x.id === t.id);
        if (!h) continue;
        let stop = h.structuralStop, target = h.structuralTarget;
        let stopSource = 'wall (structural)', targetSource = 'wall (structural)';
        if (useConfluence) {
          const { levels } = engine.computeLevels({ fiveMin: agg5.candles(), fifteenMin: agg15.candles(), daily: aggD.candles() });
          const ex = engine.resolveExits({
            direction: h.direction, price: snap.spot,
            structuralStop: h.structuralStop, structuralTarget: h.structuralTarget, levels
          });
          stop = ex.stop.price; target = ex.target.price;
          stopSource = ex.stop.source; targetSource = ex.target.source;
        }
        open.set(t.id, {
          entry: snap.spot, stop, target, direction: h.direction,
          archetype: h.archetype, ts: snap.ts, stopSource, targetSource
        });
      }
    }

    const openTrades = Backtester.markOpen(open, snapshots.at(-1));
    return { trades, openTrades, metrics: { ...Backtester.computeMetrics(trades), unresolved: openTrades.length } };
  }

  // Before/after exit comparison on the same snapshot stream.
  compareExits(instrument, snapshots, opts = {}) {
    return {
      before: this.simulateExits(instrument, snapshots, opts, false), // structural walls
      after: this.simulateExits(instrument, snapshots, opts, true)    // EMA/BB confluence
    };
  }

  static computeMetrics(trades) {
    const n = trades.length;
    if (n === 0) {
      return { trades: 0, wins: 0, losses: 0, winRate: 0, avgR: 0, expectancy: 0, profitFactor: 0, maxDrawdownR: 0 };
    }
    let wins = 0, grossWin = 0, grossLoss = 0, sumR = 0, cum = 0, peak = 0, maxDD = 0;
    for (const t of trades) {
      if (t.r > 0) { wins++; grossWin += t.r; } else { grossLoss += Math.abs(t.r); }
      sumR += t.r;
      cum += t.r;
      peak = Math.max(peak, cum);
      maxDD = Math.max(maxDD, peak - cum);
    }
    return {
      trades: n,
      wins,
      losses: n - wins,
      winRate: wins / n,
      avgR: sumR / n,
      expectancy: sumR / n,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
      maxDrawdownR: maxDD
    };
  }

  static engineOptions(opts = {}) {
    const lifecycle = { ...(opts.lifecycle || {}) };
    if (opts.strategy && opts.strategy !== 'ALL') {
      lifecycle.registry = engine.ALL_ARCHETYPES.filter((a) => a.name === opts.strategy);
      if (lifecycle.registry.length === 0) throw new Error(`unknown strategy: ${opts.strategy}`);
    }
    return lifecycle;
  }

  static markOpen(open, lastSnapshot) {
    if (!lastSnapshot) return [];
    return [...open].map(([id, o]) => {
      const riskU = Math.abs(o.entry - o.stop) || 1;
      const move = o.direction === 'CE' ? lastSnapshot.spot - o.entry : o.entry - lastSnapshot.spot;
      return {
        id, archetype: o.archetype, direction: o.direction, outcome: 'OPEN_AT_END',
        entry: o.entry, mark: lastSnapshot.spot, unrealizedR: move / riskU,
        durationMs: lastSnapshot.ts - o.ts
      };
    });
  }

  async runFromDb(symbol, fromISO, toISO, opts = {}) {
    const snapshots = await this.loadSnapshots(symbol, fromISO, toISO);
    const result = this.runSnapshots(symbol, snapshots, opts);
    // Before/after exit comparison (structural walls vs EMA/BB confluence).
    const comparison = this.compareExits(symbol, snapshots, opts);

    if (this.db && this.db.enabled) {
      try {
        await this.db.query(
          `INSERT INTO backtest_runs (strategy, params, period_start, period_end, metrics)
           VALUES ($1, $2, $3, $4, $5)`,
          [opts.strategy || 'ALL',
           JSON.stringify({ ...opts, exitComparison: true }),
           new Date(fromISO), new Date(toISO),
           JSON.stringify({ engineTransitions: result.metrics, exitsBefore: comparison.before.metrics, exitsAfter: comparison.after.metrics })]
        );
      } catch (err) {
        console.error('backtest_runs insert:', err.message);
      }
    }
    return { ...result, comparison, snapshots: snapshots.length };
  }
}

module.exports = Backtester;
