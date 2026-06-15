// backtest/Backtester.js
// Replays archived chain snapshots through the SAME SetupEngine the live app
// uses, so backtest and live can never diverge. Reconstructs snapshots from
// Postgres, runs the pipeline, books trades on TRIGGERED -> terminal, and
// computes performance metrics. Pure runSnapshots() is unit-testable without a DB.
const engine = require('../engine/dist/index.js');

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
              ce_ltp, pe_ltp, ce_iv, pe_iv, ce_delta, pe_delta
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
        ce: { ltp: Number(k.ce_ltp) || 0, oi: Number(k.ce_oi) || 0, volume: Number(k.ce_vol) || 0, iv: Number(k.ce_iv) || 0, delta: Number(k.ce_delta) || 0 },
        pe: { ltp: Number(k.pe_ltp) || 0, oi: Number(k.pe_oi) || 0, volume: Number(k.pe_vol) || 0, iv: Number(k.pe_iv) || 0, delta: Number(k.pe_delta) || 0 }
      }))
    }));
  }

  // Pure replay — deterministic, no DB. `snapshots` are in engine shape.
  runSnapshots(instrument, snapshots, opts = {}) {
    const eng = new engine.SetupEngine(instrument, opts.lifecycle || {});
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

    return { trades, metrics: Backtester.computeMetrics(trades) };
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

  async runFromDb(symbol, fromISO, toISO, opts = {}) {
    const snapshots = await this.loadSnapshots(symbol, fromISO, toISO);
    const result = this.runSnapshots(symbol, snapshots, opts);

    if (this.db && this.db.enabled) {
      try {
        await this.db.query(
          `INSERT INTO backtest_runs (strategy, params, period_start, period_end, metrics)
           VALUES ($1, $2, $3, $4, $5)`,
          [opts.strategy || 'ALL', JSON.stringify(opts), new Date(fromISO), new Date(toISO), JSON.stringify(result.metrics)]
        );
      } catch (err) {
        console.error('backtest_runs insert:', err.message);
      }
    }
    return { ...result, snapshots: snapshots.length };
  }
}

module.exports = Backtester;
