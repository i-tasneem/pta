// scanner/ChainScheduler.js
// Replaces the fixed 3.5s round-robin chain poller. Dhan's option-chain
// limit is 1 request per UNIQUE underlying per 3s; the global bound is the
// Data-API bucket (5 req/s). Both are modeled here explicitly:
//
//   - a token bucket caps sustained request rate (budgetRps, config —
//     conservative 1/3.5s until the burst probe validates the docs)
//   - a per-instrument floor (minUniqueGapMs) enforces the 3s unique rule
//   - each instrument declares its own cadence target and exchange calendar,
//     so MCX inherits the whole budget after NSE close and closed exchanges
//     cost nothing (today's poller burns slots on frozen weekend chains)
//
// Scheduling is overdue-ratio priority: the instrument furthest past its
// cadence (relative to that cadence) goes first, which degrades gracefully
// under budget pressure instead of starving anyone.

const MarketCalendar = require('./MarketCalendar');

class ChainScheduler {
  constructor(opts = {}) {
    this.budgetRps = opts.budgetRps > 0 ? opts.budgetRps : 1 / 3.5;
    this.minUniqueGapMs = opts.minUniqueGapMs ?? 3000;
    this.slotMs = opts.slotMs ?? 500;
    this.isOpen = opts.isOpen || MarketCalendar.isOpen;
    this.now = opts.now || (() => Date.now());

    this.entries = new Map(); // symbol -> { symbol, calendar, cadenceMs, lastFetch, ...meta }
    this.capacity = Math.max(1, Math.floor(this.budgetRps));
    this.tokens = this.capacity; // allow one immediate fetch at boot
    this.lastRefill = this.now();
    this.timer = null;
  }

  add(entry) {
    if (!entry || !entry.symbol) throw new Error('ChainScheduler.add: symbol required');
    this.entries.set(entry.symbol, {
      calendar: 'NSE',
      cadenceMs: 21000,
      ...entry,
      lastFetch: null // never fetched
    });
  }

  remove(symbol) {
    this.entries.delete(symbol);
  }

  // Pick the instrument to fetch now, or null. Consumes a budget token and
  // stamps lastFetch, so the caller MUST perform the fetch it was given.
  pick(nowTs) {
    this._refill(nowTs);
    // Epsilon absorbs float drift from incremental refills so a token due
    // exactly now is spendable now, not one slot late.
    if (this.tokens + 1e-9 < 1) return null;

    let best = null;
    let bestRatio = 0;
    for (const e of this.entries.values()) {
      // Never-fetched instruments are immediately due; ties resolve by
      // insertion order, so boot fetches run in config order.
      const age = e.lastFetch === null ? Infinity : nowTs - e.lastFetch;
      if (age < Math.max(e.cadenceMs, this.minUniqueGapMs)) continue;
      if (!this.isOpen(e.calendar, nowTs)) continue;
      const ratio = age / e.cadenceMs;
      if (ratio > bestRatio) {
        bestRatio = ratio;
        best = e;
      }
    }
    if (!best) return null;

    this.tokens -= 1;
    best.lastFetch = nowTs;
    return best;
  }

  _refill(nowTs) {
    const elapsed = Math.max(0, nowTs - this.lastRefill);
    this.lastRefill = nowTs;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.budgetRps);
  }

  // fetchFn(entry) is fire-and-forget per slot; its own error handling owns
  // API failures, this catch only guards the loop itself.
  start(fetchFn) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const entry = this.pick(this.now());
      if (!entry) return;
      Promise.resolve(fetchFn(entry)).catch((err) =>
        console.error(`ChainScheduler ${entry.symbol}:`, err.message)
      );
    }, this.slotMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Diagnostics for /api/health: per-symbol chain age vs its cadence target.
  state(nowTs = this.now()) {
    const out = {};
    for (const e of this.entries.values()) {
      out[e.symbol] = {
        ageMs: e.lastFetch === null ? null : nowTs - e.lastFetch,
        cadenceMs: e.cadenceMs,
        calendar: e.calendar,
        open: this.isOpen(e.calendar, nowTs)
      };
    }
    return out;
  }
}

module.exports = ChainScheduler;
