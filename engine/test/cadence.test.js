const test = require('node:test');
const assert = require('node:assert');
const { SetupEngine } = require('../dist/index.js');

// Same bull-squeeze fixture as lifecycle.test.js, with controllable timestamps:
// quiet baseline, then a CE wall capitulating while puts build and price breaks.
function leg(oi, iv = 12) { return { ltp: 100, oi, volume: 0, iv, delta: 0.5 }; }
const DROPS = [0, 0, 0, 400, 900, 1300, 1900, 2500, 3100, 3700];
function chainAt(i, ts) {
  const quiet = i < 3;
  const spot = quiet ? 22980 : 22980 + (i - 2) * 15;
  const ceWallOi = Math.max(300, 5000 - (DROPS[Math.min(i, DROPS.length - 1)]));
  const pe1 = quiet ? 1500 : 1500 + (i - 2) * 140;
  const pe2 = quiet ? 1500 : 1500 + (i - 2) * 100;
  return {
    instrument: 'NIFTY', ts, spot, atmStrike: 23000, pcr: 1.1,
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
  tracker: { minBaseline: 2, atmWindowSteps: 2, wallZ: 1.2 },
  regime: { trendNWF: 0.3 },
  formingScore: 30
};

// Feed 7 snapshots 60s apart, then one more after `gapMs`. Returns the result
// of the post-gap snapshot plus whether hypotheses existed before the gap.
function runWithGap(engine, gapMs) {
  let ts = 0;
  let hadHypotheses = false;
  for (let i = 0; i < 7; i++) {
    const res = engine.onSnapshot(chainAt(i, ts), 0, 0.8);
    if (res.hypotheses.length > 0) hadHypotheses = true;
    ts += 60000;
  }
  const after = engine.onSnapshot(chainAt(7, ts - 60000 + gapMs), 0, 0.8);
  return { hadHypotheses, after };
}

test('default cadence: a 100s gap exceeds 90s staleness and clears hypotheses', () => {
  const { hadHypotheses, after } = runWithGap(new SetupEngine('NIFTY', OPTS), 100000);
  assert.ok(hadHypotheses, 'fixture must form hypotheses before the gap');
  const invalidated = after.transitions.some((t) => t.to === 'INVALIDATED');
  assert.ok(invalidated || after.hypotheses.length === 0,
    '100s gap should stale-kill at the default 21s cadence');
});

test('slow-tier cadence stretches staleness: 100s gap survives at cadenceMs 30000', () => {
  const eng = new SetupEngine('RELIANCE', { ...OPTS, cadenceMs: 30000 }); // staleMs -> 120s
  const { hadHypotheses, after } = runWithGap(eng, 100000);
  assert.ok(hadHypotheses, 'fixture must form hypotheses before the gap');
  assert.ok(after.hypotheses.length > 0,
    'a normal slow-tier gap must not be treated as a frozen feed');
  assert.ok(!after.transitions.some((t) => t.to === 'INVALIDATED'),
    'no stale invalidation expected within 4x cadence');
});

test('explicit staleMs still wins over cadence-derived staleness', () => {
  const eng = new SetupEngine('NIFTY', { ...OPTS, cadenceMs: 30000, staleMs: 90000 });
  const { hadHypotheses, after } = runWithGap(eng, 100000);
  assert.ok(hadHypotheses, 'fixture must form hypotheses before the gap');
  const invalidated = after.transitions.some((t) => t.to === 'INVALIDATED');
  assert.ok(invalidated || after.hypotheses.length === 0,
    'explicit staleMs=90s should kill on a 100s gap regardless of cadence');
});
