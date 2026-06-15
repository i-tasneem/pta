// Golden-fixture tests for Layer 1. Run against compiled dist with:
//   node --test engine/test
const test = require('node:test');
const assert = require('node:assert');
const {
  RollingWindow,
  PositioningTracker,
  splitOIVelocity,
  detectWalls,
  oiCentroid,
  easeOfMovement,
  classifyFlow
} = require('../dist/index.js');

// --- helpers ---
function leg(oi, extra = {}) {
  return { ltp: 100, oi, volume: 0, iv: 12, delta: 0.5, ...extra };
}
function ladder(spec) {
  // spec: { strike: [ceOi, peOi] }
  return Object.entries(spec).map(([strike, [ce, pe]]) => ({
    strike: Number(strike),
    ce: leg(ce),
    pe: leg(pe)
  }));
}
function snap(over) {
  return {
    instrument: 'NIFTY', ts: 0, spot: 23000, atmStrike: 23000,
    pcr: 1, totalCeOi: 0, totalPeOi: 0, expiry: '2026-06-16',
    strikes: [], ...over
  };
}

test('RollingWindow mean/std/zscore', () => {
  const w = new RollingWindow(10);
  [2, 4, 4, 4, 5, 5, 7, 9].forEach((x) => w.push(x));
  assert.strictEqual(w.mean(), 5);
  // sample std of this classic set is ~2.138
  assert.ok(Math.abs(w.std() - 2.138) < 0.01, 'std ' + w.std());
  assert.ok(w.zscore(5) === 0);
  assert.ok(w.zscore(9) > 0);
});

test('RollingWindow respects capacity', () => {
  const w = new RollingWindow(3);
  [1, 2, 3, 4, 5].forEach((x) => w.push(x));
  assert.strictEqual(w.size, 3);
  assert.strictEqual(w.mean(), 4); // last three: 3,4,5
});

test('splitOIVelocity computes signed CE/PE deltas per minute', () => {
  const prev = ladder({ 22900: [100, 100], 23000: [100, 100], 23100: [100, 100] });
  const curr = ladder({ 22900: [80, 130], 23000: [90, 160], 23100: [100, 100] });
  // dCE = -20 -10 +0 = -30 ; dPE = +30 +60 +0 = +90 ; over 2 minutes
  const { vCE, vPE } = splitOIVelocity(prev, curr, 2);
  assert.strictEqual(vCE, -15);
  assert.strictEqual(vPE, 45);
});

test('detectWalls flags only outlier concentrations', () => {
  const strikes = ladder({
    22800: [100, 100], 22900: [100, 100], 23000: [100, 100],
    23100: [100, 100], 23200: [1000, 100] // CE wall here
  });
  const ceWalls = detectWalls(strikes, 'CE', 1.5);
  assert.strictEqual(ceWalls.length, 1);
  assert.strictEqual(ceWalls[0].strike, 23200);
  // a flat PE ladder yields no walls
  assert.strictEqual(detectWalls(strikes, 'PE', 2).length, 0);
});

test('oiCentroid is OI-weighted', () => {
  const strikes = ladder({ 23000: [100, 0], 23100: [300, 0] });
  // (23000*100 + 23100*300)/400 = 23075
  assert.strictEqual(oiCentroid(strikes, 'CE'), 23075);
});

test('easeOfMovement guards zero volume', () => {
  assert.strictEqual(easeOfMovement(10, 0), 0);
  assert.strictEqual(easeOfMovement(10, 5), 2);
});

test('classifyFlow identifies the high-conviction unwinding states', () => {
  // price rising + CE writers fleeing (vCE<0) => squeeze fuel
  assert.strictEqual(classifyFlow(0.5, 10, -50, 20, 1), 'SQUEEZE_FUEL_BULL');
  // price falling + PE writers fleeing => capitulation
  assert.strictEqual(classifyFlow(-0.5, -10, 20, -50, 1), 'CAPITULATION_BEAR');
  // rising into call writing => capped fade
  assert.strictEqual(classifyFlow(-1, 10, 80, 10, 1), 'CAPPED_FADE');
  // both writing, flat => corridor
  assert.strictEqual(classifyFlow(0, 0, 50, 50, 1), 'CORRIDOR');
});

test('PositioningTracker warms up then classifies a squeeze', () => {
  const tr = new PositioningTracker({ minBaseline: 2, atmWindowSteps: 2 });

  const first = tr.update(snap({
    ts: 0, spot: 23000, atmStrike: 23000,
    strikes: ladder({ 22900: [500, 500], 23000: [500, 500], 23100: [500, 500] })
  }));
  assert.strictEqual(first.flowState, 'WARMUP');
  assert.strictEqual(first.ready, false);

  // price up, CE OI dropping (writers covering) across the next snapshots
  let last;
  for (let i = 1; i <= 3; i++) {
    last = tr.update(snap({
      ts: i * 60000,
      spot: 23000 + i * 20,
      atmStrike: 23000,
      strikes: ladder({
        22900: [500, 500 + i * 10],
        23000: [500 - i * 40, 500 + i * 20],
        23100: [500 - i * 30, 500]
      })
    }));
  }
  assert.strictEqual(last.flowState, 'SQUEEZE_FUEL_BULL');
  assert.strictEqual(last.ready, true);
  assert.ok(last.vCE < 0, 'CE velocity should be negative');
  assert.ok(last.priceDelta > 0, 'price should be rising');
});
