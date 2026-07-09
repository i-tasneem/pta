// archive/ChainArchiver.js
// Persists every normalized option-chain snapshot to Postgres. This is the
// backtest dataset for the V2 positioning engine — it must run from day one,
// independent of whether signals are shown. Failures never propagate into the
// polling loop.
class ChainArchiver {
  constructor(db, eventBus, schema) {
    this.db = db;
    this.eventBus = eventBus;
    this.schema = schema;
    this.written = 0;
  }

  get enabled() {
    return this.db && this.db.enabled;
  }

  async record(chain) {
    if (!this.enabled || !chain || !Array.isArray(chain.strikes) || chain.strikes.length === 0) {
      return;
    }

    try {
      // max pain is computed by OIScanner into market_state
      let maxPain = null;
      try {
        const mp = await this.eventBus.hget(this.schema.marketState(chain.instrument), 'maxPain');
        maxPain = mp ? parseFloat(mp) : null;
      } catch { /* market_state may not be warm yet */ }

      await this.db.tx(async (client) => {
        const snap = await client.query(
          `INSERT INTO chain_snapshots
             (symbol, ts, spot, fut, fut_vol, expiry, atm_strike, pcr, max_pain, total_ce_oi, total_pe_oi, inst_class)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING id`,
          [
            chain.instrument,
            new Date(chain.timestamp || Date.now()),
            num(chain.spotLtp),
            num(chain.fut),
            int(chain.futVolume),
            chain.expiry || null,
            num(chain.atmStrike),
            num(chain.pcr),
            maxPain,
            int(chain.totalCeOi),
            int(chain.totalPeOi),
            chain.instClass || null
          ]
        );
        const snapshotId = snap.rows[0].id;

        // One multi-row insert for all strikes (12 columns each)
        const COLS = 12;
        const placeholders = [];
        const params = [];
        chain.strikes.forEach((s, i) => {
          const o = i * COLS;
          placeholders.push(
            `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10},$${o + 11},$${o + 12})`
          );
          const ce = s.ce || {};
          const pe = s.pe || {};
          params.push(
            snapshotId, num(s.strike),
            int(ce.oi), int(pe.oi),
            int(ce.volume), int(pe.volume),
            num(ce.ltp), num(pe.ltp),
            num(ce.iv), num(pe.iv),
            num(ce.delta), num(pe.delta)
          );
        });

        await client.query(
          `INSERT INTO chain_strikes
             (snapshot_id, strike, ce_oi, pe_oi, ce_vol, pe_vol,
              ce_ltp, pe_ltp, ce_iv, pe_iv, ce_delta, pe_delta)
           VALUES ${placeholders.join(',')}`,
          params
        );
      });

      this.written++;
    } catch (err) {
      console.error(`ChainArchiver ${chain.instrument}:`, err.message);
    }
  }
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function int(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

module.exports = ChainArchiver;
