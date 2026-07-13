const test = require('node:test');
const assert = require('node:assert');
const Backtester = require('../../backtest/Backtester');

// A long flat warm-up (builds 5m/15m candles around 22980 so the resolver has
// EMA/BB levels) followed by a capitulation breakout that triggers a CE setup
// and runs to target. Because candle history exists at trigger time, the
// confluence resolver genuinely engages (not just the structural fallback), so
// before/after exits diverge — a real, measurable comparison.
function leg(oi) { return { ltp: 100, oi, volume: 0, iv: 12, delta: 0.5 }; }
const WARMUP = 120;

function chainAt(i) {
  const k = i - WARMUP;                 // steps into the breakout
  const breakout = i >= WARMUP;
  const spot = breakout ? 22980 + (k + 1) * 22 : 22980;
  const drop = breakout ? Math.min(4700, (k + 1) * 700) : 0;
  const ceWallOi = Math.max(300, 5000 - drop);
  const pe1 = breakout ? 1500 + (k + 1) * 160 : 1500;
  const pe2 = breakout ? 1500 + (k + 1) * 120 : 1500;
  return {
    instrument: 'NIFTY', ts: i * 60000, spot, atmStrike: 23000, pcr: 1.1,
    futVolume: breakout ? 8000 : 1000,
    totalCeOi: 0, totalPeOi: 0, expiry: '2026-06-30',
    strikes: [
      { strike: 22800, ce: leg(500), pe: leg(pe1) },
      { strike: 22900, ce: leg(500), pe: leg(pe2) },
      { strike: 23000, ce: leg(ceWallOi), pe: leg(800) },
      { strike: 23100, ce: leg(800), pe: leg(400) },
      { strike: 23200, ce: leg(700), pe: leg(300) }
    ]
  };
}

const OPTS = {
  lifecycle: {
    tracker: { minBaseline: 2, atmWindowSteps: 2, wallZ: 1.2 },
    regime: { trendNWF: 0.3 },
    // onset-sensitive z-scores peak at the break, so READY must catch the onset
    formingScore: 30, strengtheningScore: 40, readyScore: 45,
    breakMinParticipation: 0.4, triggerBufferPct: 0.0002
  }
};

const snapshots = Array.from({ length: 140 }, (_, i) => chainAt(i));

test('backtester compareExits returns well-formed before/after metric shapes', () => {
  const bt = new Backtester(null);
  const cmp = bt.compareExits('NIFTY', snapshots, OPTS);
  for (const side of [cmp.before, cmp.after]) {
    assert.ok(side.metrics, 'metrics present');
    for (const k of ['trades', 'wins', 'losses', 'winRate', 'avgR', 'expectancy', 'profitFactor', 'maxDrawdownR', 'unresolved']) {
      assert.ok(k in side.metrics, `metric ${k}`);
    }
    assert.ok(side.metrics.winRate >= 0 && side.metrics.winRate <= 1, 'winRate in [0,1]');
  }
});

test('backtester books/resolves trades and the confluence path actually engages', () => {
  const bt = new Backtester(null);
  const cmp = bt.compareExits('NIFTY', snapshots, OPTS);
  assert.ok(cmp.before.trades.length >= 1, 'structural exits book a trade; got ' + cmp.before.trades.length);
  assert.ok(cmp.after.trades.length >= 1, 'confluence exits book a trade; got ' + cmp.after.trades.length);

  for (const t of cmp.after.trades) {
    assert.strictEqual(typeof t.stopSource, 'string');
    assert.strictEqual(typeof t.targetSource, 'string');
    assert.ok(['TARGET_HIT', 'STOPLOSS_HIT'].includes(t.outcome));
  }
  // At least one confluence stop is an EMA/BB cluster, not the structural wall —
  // proving the resolver engaged rather than always falling back.
  const engaged = cmp.after.trades.some((t) => /EMA|BB/.test(t.stopSource));
  assert.ok(engaged, 'confluence should engage at least once; sources: ' +
    cmp.after.trades.map((t) => t.stopSource).join(' | '));

  // Different exit placement => measurably different aggregate R.
  assert.notStrictEqual(cmp.after.metrics.avgR, cmp.before.metrics.avgR);
});

test('runSnapshots (engine-transition harness) is unchanged and still runs', () => {
  const bt = new Backtester(null);
  const res = bt.runSnapshots('NIFTY', snapshots, OPTS);
  assert.ok(res.metrics && 'trades' in res.metrics, 'legacy harness intact');
  assert.ok(Array.isArray(res.openTrades), 'unresolved trades are explicit');
});

test('backtester applies strategy filter instead of silently ignoring it', () => {
  const bt = new Backtester(null);
  assert.throws(() => bt.runSnapshots('NIFTY', snapshots, { ...OPTS, strategy: 'DOES_NOT_EXIST' }), /unknown strategy/);
});
