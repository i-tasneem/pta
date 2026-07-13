// signals/StockGuards.js
// Pre-engine vetoes for single-stock options (design §1.4). Both gates fail
// CLOSED for the affected name only — a vetoed stock forms no setups but the
// chain keeps being archived upstream, and other instruments are untouched.
//
//   1. MWPL ban veto — in-ban F&O stocks can only unwind positions, which
//      mechanically distorts every ΔOI read the engine relies on.
//      Source: NSE's daily fo_secban.csv (public). A failed fetch serves the
//      last known list from Redis rather than blocking (bans persist across
//      days far more often than they appear overnight).
//   2. Earnings blackout T-2..T+1 — IV-pumped baselines + a binary event are
//      the z-score machinery's blind spot. Source: earnings_calendar table,
//      manually maintained via scripts/add-earnings.js.

const axios = require('axios');

const BAN_URL = 'https://nsearchives.nseindia.com/content/fo/fo_secban.csv';

class StockGuards {
  constructor(db, eventBus, keyPrefix = 'pta:') {
    this.db = db;
    this.eventBus = eventBus;
    this.keyPrefix = keyPrefix;
    this.banCache = { day: null, set: new Set() };
    this.earningsCache = new Map(); // `${symbol}|${day}` -> boolean
  }

  static istDay(ts = Date.now()) {
    return new Date(ts + 330 * 60000).toISOString().slice(0, 10);
  }

  // First line is a header sentence ("Securities in Ban For Trade Date
  // 09-JUL-2026: NIL"); banned symbols follow one per line, sometimes
  // numbered ("2,GNFC"). Take the trailing token of each line.
  static parseBanCsv(text) {
    const out = new Set();
    const lines = String(text || '').split(/\r?\n/);
    for (const line of lines.slice(1)) {
      const m = line.trim().toUpperCase().match(/([A-Z0-9&-]+)\s*$/);
      if (m && m[1] && m[1] !== 'NIL') out.add(m[1]);
    }
    return out;
  }

  async banSet() {
    const day = StockGuards.istDay();
    if (this.banCache.day === day) return this.banCache.set;

    const redisKey = `${this.keyPrefix}sys:fo_ban`;
    try {
      const res = await axios.get(BAN_URL, {
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      const set = StockGuards.parseBanCsv(res.data);
      this.banCache = { day, set };
      try {
        await this.eventBus.client.set(redisKey, JSON.stringify({ day, symbols: [...set] }));
      } catch { /* cache best-effort */ }
      console.log(`✓ F&O ban list ${day}: ${set.size === 0 ? 'NIL' : [...set].join(',')}`);
      return set;
    } catch (err) {
      try {
        const raw = await this.eventBus.client.get(redisKey);
        if (raw) {
          const j = JSON.parse(raw);
          if (j.day === day) {
            this.banCache = { day, set: new Set(j.symbols || []) };
            console.warn(`Ban list fetch failed (${err.message}); using same-day cached list`);
            return this.banCache.set;
          }
        }
      } catch { /* fall through */ }
      throw new Error(`MWPL data unavailable: ${err.message}`);
    }
  }

  // Blocked when today falls in [event-2, event+1] for any earnings event,
  // i.e. any event_date in [today-1, today+2].
  async inEarningsBlackout(symbol) {
    if (!this.db || !this.db.enabled) throw new Error('earnings calendar unavailable: database disabled');
    const day = StockGuards.istDay();
    const key = `${symbol}|${day}`;
    if (this.earningsCache.has(key)) return this.earningsCache.get(key);

    let blocked = false;
    try {
      const r = await this.db.query(
        `SELECT 1 FROM earnings_calendar
          WHERE symbol = $1 AND event_date BETWEEN $2::date - 1 AND $2::date + 2
          LIMIT 1`,
        [symbol, day]
      );
      blocked = r.rows.length > 0;
    } catch (err) {
      throw new Error(`earnings calendar unavailable: ${err.message}`);
    }
    if (this.earningsCache.size > 500) this.earningsCache.clear();
    this.earningsCache.set(key, blocked);
    return blocked;
  }

  // Single decision for the chain-poll hot path; null = no veto.
  async vetoReason(symbol) {
    try {
      if ((await this.banSet()).has(symbol)) return 'MWPL_BAN';
    } catch (err) {
      console.warn(`Stock guard ${symbol}:`, err.message);
      return 'MWPL_DATA_UNAVAILABLE';
    }
    try {
      if (await this.inEarningsBlackout(symbol)) return 'EARNINGS_BLACKOUT';
    } catch (err) {
      console.warn(`Stock guard ${symbol}:`, err.message);
      return 'EARNINGS_DATA_UNAVAILABLE';
    }
    return null;
  }
}

module.exports = StockGuards;
