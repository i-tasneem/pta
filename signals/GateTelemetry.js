// signals/GateTelemetry.js
// Observability for the V1 gate pipeline. Records every gate run and rolls up
// a conversion funnel. Pure side-channel: it reads/records, never influences a
// signal decision. Lightweight (buffered, batched) and restart-durable
// (counters seeded from Postgres on boot; rejection rows persisted).
class GateTelemetry {
  constructor(db) {
    this.db = db;
    this.enabled = !!(db && db.enabled);
    this.counters = {};   // today's cumulative (seeded from DB)
    this.deltas = {};     // increments pending flush
    this.buffer = [];     // gate_audit rows pending flush
    this.day = this._istDay();
  }

  _istDay() {
    return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  }

  async init() {
    if (!this.enabled) return;
    try {
      const r = await this.db.query('SELECT metric, count FROM funnel_counters WHERE day = $1', [this.day]);
      for (const row of r.rows) this.counters[row.metric] = Number(row.count);
    } catch (err) {
      console.error('GateTelemetry init:', err.message);
    }
  }

  _inc(metric, n = 1) {
    this.counters[metric] = (this.counters[metric] || 0) + n;
    this.deltas[metric] = (this.deltas[metric] || 0) + n;
  }

  // Called once per opportunity score (server analysis loop).
  recordOpportunity(opp) {
    if (!this.enabled || !opp) return;
    this._rolloverIfNeeded();
    this._inc('opportunities');
    if (opp.state === 'HIGH_POTENTIAL') this._inc('high_potential');
  }

  // Called once per gate-pipeline run (EntryTriggerEngine.evaluate).
  recordGateRun(run) {
    if (!this.enabled || !run) return;
    this._rolloverIfNeeded();
    const gateResults = run.gateResults || [];
    for (const g of gateResults) {
      this._inc(`gate${g.gate}_eval`);
      if (g.pass) this._inc(`gate${g.gate}_pass`);
    }
    if (run.generated) this._inc('signals');

    this.buffer.push({
      ts: new Date(),
      opportunity_id: run.opportunityId || null,
      symbol: run.symbol || null,
      direction: run.direction || null,
      reached_gate: gateResults.length,
      failed_at_gate: run.failedAtGate || null,
      generated: !!run.generated,
      reason: run.reason || null,
      regime: run.regime || null,
      score: Number.isFinite(run.score) ? run.score : null,
      gate_results: gateResults,
      metrics: run.metrics || {}
    });
    if (this.buffer.length >= 50) this.flush().catch(() => {});
  }

  _rolloverIfNeeded() {
    const d = this._istDay();
    if (d !== this.day) {
      this.day = d;
      this.counters = {};
      this.deltas = {};
    }
  }

  async flush() {
    if (!this.enabled) return;
    // 1. gate_audit rows
    const rows = this.buffer.splice(0);
    if (rows.length) {
      try {
        const COLS = 12;
        const ph = [];
        const params = [];
        rows.forEach((r, i) => {
          const o = i * COLS;
          ph.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10},$${o + 11},$${o + 12})`);
          params.push(r.ts, r.opportunity_id, r.symbol, r.direction, r.reached_gate, r.failed_at_gate,
            r.generated, r.reason, r.regime, r.score, JSON.stringify(r.gate_results), JSON.stringify(r.metrics));
        });
        await this.db.query(
          `INSERT INTO gate_audit
             (ts, opportunity_id, symbol, direction, reached_gate, failed_at_gate,
              generated, reason, regime, score, gate_results, metrics)
           VALUES ${ph.join(',')}`,
          params
        );
      } catch (err) {
        console.error('GateTelemetry flush(rows):', err.message);
      }
    }
    // 2. funnel counters (daily rollup via atomic increment)
    const deltas = this.deltas;
    this.deltas = {};
    for (const [metric, n] of Object.entries(deltas)) {
      try {
        await this.db.query(
          `INSERT INTO funnel_counters (day, metric, count) VALUES ($1, $2, $3)
           ON CONFLICT (day, metric) DO UPDATE SET count = funnel_counters.count + $3`,
          [this.day, metric, n]
        );
      } catch (err) {
        // put the delta back so it isn't lost
        this.deltas[metric] = (this.deltas[metric] || 0) + n;
        console.error('GateTelemetry flush(counters):', err.message);
      }
    }
  }

  // Ordered conversion funnel from today's counters.
  getFunnel() {
    const c = this.counters;
    const stages = [
      { name: 'opportunities', label: 'Opportunities scored' },
      { name: 'high_potential', label: 'HIGH_POTENTIAL' },
      { name: 'gate1_pass', label: 'Passed Gate 1 (Regime)' },
      { name: 'gate2_pass', label: 'Passed Gate 2 (Trend)' },
      { name: 'gate3_pass', label: 'Passed Gate 3 (Momentum)' },
      { name: 'gate4_pass', label: 'Passed Gate 4 (Option Chain)' },
      { name: 'gate5_pass', label: 'Passed Gate 5 (Entry Trigger)' },
      { name: 'gate6_pass', label: 'Passed Gate 6 (Ranking)' },
      { name: 'signals', label: 'Signals generated' }
    ];
    let prev = null;
    const out = stages.map((s) => {
      const count = c[s.name] || 0;
      const conv = prev != null && prev > 0 ? Math.round((count / prev) * 1000) / 10 : null;
      prev = count;
      return { ...s, count, conversionFromPrevPct: conv };
    });
    return { day: this.day, stages: out, raw: c };
  }
}

module.exports = GateTelemetry;
