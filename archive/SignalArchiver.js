// archive/SignalArchiver.js
const Database = require('better-sqlite3');

class SignalArchiver {
  constructor(config) {
    this.config = config.sqlite;
    this.db = null;
    this.queue = [];
    this.flushInterval = null;
  }

  async initialize() {
    this.db = new Database(this.config.path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS signal_audit (
        id TEXT PRIMARY KEY,
        instrument TEXT,
        type TEXT,
        direction TEXT,
        score REAL,
        confidence REAL,
        entry_zone TEXT,
        stop_zone TEXT,
        target_zone TEXT,
        triggered_at INTEGER,
        exited_at INTEGER,
        outcome TEXT,
        reason TEXT,
        gate_results TEXT,
        trend_analysis TEXT,
        oi_analysis TEXT,
        volume_analysis TEXT,
        regime_analysis TEXT,
        liquidity_analysis TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      );
      CREATE TABLE IF NOT EXISTS signal_outcomes (
        id TEXT PRIMARY KEY,
        instrument TEXT,
        type TEXT,
        direction TEXT,
        outcome TEXT,
        entry_price REAL,
        exit_price REAL,
        pnl REAL,
        duration_ms INTEGER,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_audit_instrument ON signal_audit(instrument);
      CREATE INDEX IF NOT EXISTS idx_audit_triggered ON signal_audit(triggered_at);
      CREATE INDEX IF NOT EXISTS idx_outcomes_instrument ON signal_outcomes(instrument);
    `);
  }

  async start() {
    this.flushInterval = setInterval(() => this.flush(), this.config.archiveInterval);
  }

  stop() {
    if (this.flushInterval) clearInterval(this.flushInterval);
    this.flush();
  }

  queueSignal(signal) {
    this.queue.push(signal);
  }

  flush() {
    if (this.queue.length === 0) return;
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO signal_audit (
        id, instrument, type, direction, score, confidence,
        entry_zone, stop_zone, target_zone, triggered_at,
        outcome, reason, gate_results, trend_analysis, oi_analysis,
        volume_analysis, regime_analysis, liquidity_analysis
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const transaction = this.db.transaction((signals) => {
      for (const s of signals) {
        insert.run(
          s.id, s.instrument, s.type, s.direction, s.score, s.confidence,
          s.entryZone, s.stopZone, s.targetZone, s.triggeredAt, s.outcome || null,
          s.userReason || null, s.gateResults || null, s.trendAnalysis || null,
          s.oiAnalysis || null, s.volumeAnalysis || null, s.regimeAnalysis || null,
          s.liquidityAnalysis || null
        );
      }
    });
    transaction(this.queue);
    this.queue = [];
  }

  recordOutcome(outcome) {
    this.db.prepare(`
      INSERT OR REPLACE INTO signal_outcomes (
        id, instrument, type, direction, outcome,
        entry_price, exit_price, pnl, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      outcome.id, outcome.instrument, outcome.type, outcome.direction,
      outcome.outcome, outcome.entryPrice ?? null, outcome.exitPrice ?? null,
      outcome.pnl ?? null, outcome.durationMs ?? null
    );
  }

  getAllSignalHistory(limit = 100) {
    return this.db.prepare('SELECT * FROM signal_audit ORDER BY triggered_at DESC LIMIT ?').all(limit);
  }

  getAllOutcomes(limit = 500) {
    return this.db.prepare('SELECT * FROM signal_outcomes ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  getSignalHistory(instrument, limit = 100) {
    return this.db.prepare('SELECT * FROM signal_audit WHERE instrument = ? ORDER BY triggered_at DESC LIMIT ?').all(instrument, limit);
  }

  getOutcomes(instrument, limit = 100) {
    return this.db.prepare('SELECT * FROM signal_outcomes WHERE instrument = ? ORDER BY created_at DESC LIMIT ?').all(instrument, limit);
  }
}

module.exports = SignalArchiver;
